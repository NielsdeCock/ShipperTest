import archiver from 'archiver';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_RUN_SETTINGS, STEP_NAMES, validateRun,
  type Address, type RunSettings,
} from '../../../shared/model.ts';
import { config, hasCredentials } from '../config.ts';
import { query } from '../db.ts';
import { createMontaClient } from '../monta/client.ts';
import { enqueue, pause, resume, runState, stop } from '../runner.ts';
import {
  bus, callsForResult, createRetry, createRun, getAddresses, getDefaults, getOrigins, getResult,
  getRun, getSettings, latestResults, listRuns, pairAttempts, recentCalls, setSetting, upsertAddress,
} from '../store.ts';
import { parseCsv } from './csv.ts';

export const api = express.Router();

type Handler = (req: Request, res: Response) => Promise<unknown>;
const ah = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
const id = (req: Request) => Number(req.params.id);
const cc = (v: unknown) => String(v ?? '').trim().toUpperCase();

// ---------- meta & settings ----------

api.get('/meta', ah(async (_req, res) => {
  const s = await getSettings();
  res.json({
    apiBase: config.apiBase,
    hasCredentials: hasCredentials(),
    authMethod: config.token ? 'Bearer token' : 'HTTP Basic',
    allowLive: config.allowLive,
    labelsDir: config.labelsDir,
    database: config.databaseUrl ? 'Postgres' : 'Embedded PGlite',
    concurrency: Number(s.concurrency ?? 1),
    defaults: await getDefaults(),
  });
}));

api.put('/settings', ah(async (req, res) => {
  const allowed = ['default_company', 'default_first_name', 'default_last_name', 'default_phone', 'default_email', 'concurrency'];
  for (const [k, v] of Object.entries(req.body ?? {})) {
    if (allowed.includes(k)) await setSetting(k, String(v ?? ''));
  }
  res.json(await getSettings());
}));

// ---------- shippers (from Monta GET /info) ----------

api.get('/shippers', ah(async (_req, res) => {
  if (!hasCredentials()) return res.json({ origins: [], error: 'No Monta credentials configured' });
  const call = await createMontaClient().send('GET', '/info');
  if (call.networkError || call.status !== 200) {
    return res.json({ origins: [], error: call.networkError ?? `GET /info → HTTP ${call.status}: ${call.responseBody.slice(0, 300)}` });
  }
  const info = JSON.parse(call.responseBody);
  res.json({
    origins: (info.Origins ?? []).map((o: any) => ({
      name: String(o.Name ?? ''),
      shippers: (o.ShipperOptions ?? []).map((x: any) => ({
        code: String(x.ShipperCode ?? ''),
        description: String(x.ShipperDescription ?? x.ShipperCode ?? ''),
        available: x.AvailableInShippingOptions !== false,
      })),
    })),
  });
}));

// ---------- origins ----------

api.get('/origins', ah(async (_req, res) => res.json(await getOrigins())));

api.put('/origins/:cc', ah(async (req, res) => {
  const code = cc(req.params.cc);
  if (!/^[A-Z]{2}$/.test(code)) return res.status(400).json({ error: 'Country code must be 2 letters' });
  await query(
    `INSERT INTO origins (country_code, origin_code) VALUES ($1, $2)
     ON CONFLICT (country_code) DO UPDATE SET origin_code = EXCLUDED.origin_code`,
    [code, String(req.body?.originCode ?? '').trim()],
  );
  res.json(await getOrigins());
}));

api.delete('/origins/:cc', ah(async (req, res) => {
  await query(`DELETE FROM origins WHERE country_code = $1`, [cc(req.params.cc)]);
  res.json(await getOrigins());
}));

// ---------- addresses ----------

const toAddress = (code: string, b: any): Address => ({
  countryCode: code,
  company: String(b.company ?? '').trim(),
  street: String(b.street ?? '').trim(),
  houseNumber: String(b.houseNumber ?? '').trim(),
  houseNumberAddition: String(b.houseNumberAddition ?? '').trim(),
  postalCode: String(b.postalCode ?? '').trim(),
  city: String(b.city ?? '').trim(),
  state: String(b.state ?? '').trim().toUpperCase(),
  phone: String(b.phone ?? '').trim(),
  email: String(b.email ?? '').trim(),
});

api.get('/addresses', ah(async (_req, res) => res.json(await getAddresses())));

/** Per destination: was a label ever received (any run, live or dry)? */
api.get('/addresses/stats', ah(async (_req, res) => {
  res.json(await query(
    `SELECT r.to_cc AS "countryCode", count(*)::int AS tested,
       count(*) FILTER (WHERE r.status = 'ok')::int AS ok,
       count(*) FILTER (WHERE r.status = 'ok' AND NOT runs.dry_run)::int AS "okLive"
     FROM results r JOIN runs ON runs.id = r.run_id WHERE r.status IN ('ok', 'failed') GROUP BY r.to_cc`,
  ));
}));

api.put('/addresses/:cc', ah(async (req, res) => {
  const code = cc(req.params.cc);
  if (!/^[A-Z]{2}$/.test(code)) return res.status(400).json({ error: 'Country code must be 2 letters' });
  await upsertAddress(toAddress(code, req.body ?? {}));
  res.json(await getAddresses());
}));

api.delete('/addresses/:cc', ah(async (req, res) => {
  await query(`DELETE FROM addresses WHERE country_code = $1`, [cc(req.params.cc)]);
  res.json(await getAddresses());
}));

/** CSV with a header row. Columns (case-insensitive): CountryCode, Company, Street, HouseNumber,
 *  HouseNumberAddition, PostalCode, City, State, PhoneNumber, EmailAddress. Comma or semicolon. */
api.post('/addresses/import', express.text({ type: '*/*', limit: '2mb' }), ah(async (req, res) => {
  const rows = parseCsv(String(req.body ?? ''));
  if (rows.length < 2) return res.status(400).json({ error: 'CSV needs a header row and at least one address' });
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z]/g, ''));
  const col = (row: string[], ...names: string[]) => {
    const i = header.findIndex((h) => names.includes(h));
    return i >= 0 ? row[i] ?? '' : '';
  };
  const imported: string[] = [];
  const errors: string[] = [];
  for (const [n, row] of rows.slice(1).entries()) {
    if (row.every((v) => !v.trim())) continue;
    const code = cc(col(row, 'countrycode', 'country', 'cc'));
    if (!/^[A-Z]{2}$/.test(code)) { errors.push(`Row ${n + 2}: invalid country code "${code}"`); continue; }
    await upsertAddress(toAddress(code, {
      company: col(row, 'company'),
      street: col(row, 'street'),
      houseNumber: col(row, 'housenumber', 'number', 'no'),
      houseNumberAddition: col(row, 'housenumberaddition', 'addition'),
      postalCode: col(row, 'postalcode', 'postcode', 'zip'),
      city: col(row, 'city'),
      state: col(row, 'state', 'province'),
      phone: col(row, 'phonenumber', 'phone'),
      email: col(row, 'emailaddress', 'email'),
    }));
    imported.push(code);
  }
  res.json({ imported, errors, addresses: await getAddresses() });
}));

// ---------- templates ----------

api.get('/templates', ah(async (_req, res) => {
  res.json(await query(`SELECT id, name, settings, created_at AS "createdAt" FROM templates ORDER BY name`));
}));

api.post('/templates', ah(async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'Template name is required' });
  const settings = { ...DEFAULT_RUN_SETTINGS, ...(req.body?.settings ?? {}) };
  const existing = await query(`SELECT id FROM templates WHERE name = $1`, [name]);
  if (existing.length) {
    await query(`UPDATE templates SET settings = $2::json WHERE id = $1`, [existing[0].id, JSON.stringify(settings)]);
  } else {
    await query(`INSERT INTO templates (name, settings) VALUES ($1, $2::json)`, [name, JSON.stringify(settings)]);
  }
  res.json(await query(`SELECT id, name, settings, created_at AS "createdAt" FROM templates ORDER BY name`));
}));

api.delete('/templates/:id', ah(async (req, res) => {
  await query(`DELETE FROM templates WHERE id = $1`, [id(req)]);
  res.status(204).end();
}));

// ---------- runs ----------

api.get('/runs', ah(async (_req, res) => res.json(await listRuns())));

api.post('/runs', ah(async (req, res) => {
  const b = req.body ?? {};
  const s: RunSettings = {
    ...DEFAULT_RUN_SETTINGS,
    ...b,
    shipperCode: String(b.shipperCode ?? '').trim(),
    orderPrefix: String(b.orderPrefix ?? DEFAULT_RUN_SETTINGS.orderPrefix).trim(),
    labelFileType: b.labelFileType === 'pdf' ? 'pdf' : 'zpl',
    colli: { ...DEFAULT_RUN_SETTINGS.colli, ...(b.colli ?? {}) },
    invoice: { ...DEFAULT_RUN_SETTINGS.invoice, ...(b.invoice ?? {}) },
    from: [...new Set<string>((b.from ?? []).map(cc))],
    to: [...new Set<string>((b.to ?? []).map(cc))],
    dryRun: b.dryRun !== false,
  };
  const errors = validateRun(s, await getOrigins(), await getAddresses());
  if (!s.dryRun && !config.allowLive) {
    errors.push('Live runs are disabled. Set ALLOW_LIVE=true in .env and restart the server.');
  }
  if (!s.dryRun && !hasCredentials()) errors.push('No Monta API credentials configured in .env.');
  if (errors.length) return res.status(400).json({ error: errors.join(' '), errors });

  const { run, resultIds } = await createRun(s, await getOrigins());
  await enqueue(run.id, resultIds);
  res.status(201).json({ id: run.id });
}));

api.get('/runs/:id', ah(async (req, res) => {
  const run = await getRun(id(req));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const st = runState(run.id);
  res.json({
    run,
    results: await latestResults(run.id),
    log: await recentCalls(run.id),
    queue: st ? { queued: st.queue.length, workers: st.workers } : null,
  });
}));

api.get('/runs/:id/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = (evt: unknown) => res.write(`data: ${JSON.stringify(evt)}\n\n`);
  const channel = `run:${id(req)}`;
  bus.on(channel, send);
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(ping);
    bus.off(channel, send);
  });
});

api.post('/runs/:id/pause', ah(async (req, res) => res.json({ ok: await pause(id(req)) })));
api.post('/runs/:id/resume', ah(async (req, res) => res.json({ ok: await resume(id(req)) })));
api.post('/runs/:id/stop', ah(async (req, res) => res.json({ ok: await stop(id(req)) })));

api.post('/runs/:id/retry-failed', ah(async (req, res) => {
  const run = await getRun(id(req));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const failed = (await latestResults(run.id)).filter((r) => r.status === 'failed' || r.status === 'skipped');
  const ids: number[] = [];
  for (const r of failed) ids.push((await createRetry(r, r.override)).id);
  if (ids.length) await enqueue(run.id, ids);
  res.json({ retried: ids.length });
}));

api.get('/runs/:id/csv', ah(async (req, res) => {
  const run = await getRun(id(req));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const rows = await latestResults(run.id);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['From', 'To', 'Origin', 'OrderNumber', 'Label', 'FailedStep', 'HttpStatus', 'Error', 'LabelFile',
    ...STEP_NAMES.map((n, i) => `Step${i + 1} ${n}`)];
  const lines = rows.map((r) => [
    r.from, r.to, r.origin, r.orderNumber, r.status === 'ok' ? 'yes' : 'no',
    r.failedStep ? `${r.failedStep} ${STEP_NAMES[r.failedStep - 1]}` : '', r.httpStatus, r.error,
    r.labelPath ? path.basename(r.labelPath) : '',
    ...r.steps.map((s) => `${s.status}${s.http ? ` ${s.http}` : ''}`),
  ].map(esc).join(','));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="run-${run.id}-${run.shipperCode}.csv"`);
  res.send('﻿' + [header.join(','), ...lines].join('\r\n'));
}));

api.get('/runs/:id/labels.zip', ah(async (req, res) => {
  const run = await getRun(id(req));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const files = (await latestResults(run.id)).map((r) => r.labelPath).filter((p): p is string => !!p && fs.existsSync(p));
  if (!files.length) return res.status(404).json({ error: 'This run has no labels yet' });
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="run-${run.id}-labels.zip"`);
  const zip = archiver('zip');
  zip.on('error', (e) => res.destroy(e));
  zip.pipe(res);
  for (const f of files) zip.file(f, { name: path.basename(f) });
  await zip.finalize();
}));

// ---------- results ----------

api.get('/results/:id', ah(async (req, res) => {
  const result = await getResult(id(req));
  if (!result) return res.status(404).json({ error: 'Result not found' });
  const run = await getRun(result.runId);
  const address = (await getAddresses()).find((a) => a.countryCode === result.to) ?? null;
  res.json({
    result,
    run,
    address,
    defaults: await getDefaults(),
    calls: await callsForResult(result.id),
    attempts: (await pairAttempts(result.runId, result.from, result.to)).map((a) => ({
      id: a.id, orderNumber: a.orderNumber, status: a.status, failedStep: a.failedStep, createdAt: a.createdAt,
    })),
  });
}));

/** Retry = a new order with the next seq. Body may hold { order, colli } overrides (Edit & retry). */
api.post('/results/:id/retry', ah(async (req, res) => {
  const prev = await getResult(id(req));
  if (!prev) return res.status(404).json({ error: 'Result not found' });
  const run = (await getRun(prev.runId))!;
  if (!run.dryRun && !config.allowLive) {
    return res.status(400).json({ error: 'Live runs are disabled. Set ALLOW_LIVE=true in .env and restart the server.' });
  }
  const override = req.body?.order || req.body?.colli
    ? { order: req.body.order ?? undefined, colli: req.body.colli ?? undefined }
    : prev.override;
  const next = await createRetry(prev, override);
  await enqueue(prev.runId, [next.id]);
  res.status(201).json({ id: next.id });
}));

api.get('/results/:id/label', ah(async (req, res) => {
  const r = await getResult(id(req));
  if (!r?.labelPath || !fs.existsSync(r.labelPath)) return res.status(404).json({ error: 'No label for this result' });
  const isPdf = r.labelPath.endsWith('.pdf');
  res.set('Content-Type', isPdf ? 'application/pdf' : 'text/plain; charset=utf-8');
  res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${path.basename(r.labelPath)}"`);
  fs.createReadStream(r.labelPath).pipe(res);
}));
