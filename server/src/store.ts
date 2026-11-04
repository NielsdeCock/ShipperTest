import { EventEmitter } from 'node:events';
import type { Address, AddressDefaults, Origin, RunSettings, StepState } from '../../shared/model.ts';
import { one, query } from './db.ts';

/** Live events per run, consumed by the SSE route: `bus.on('run:<id>', fn)`. */
export const bus = new EventEmitter();
bus.setMaxListeners(100);
export const emit = (runId: number, evt: { type: 'run' | 'result' | 'log'; [k: string]: unknown }) =>
  bus.emit(`run:${runId}`, evt);

// ---------- settings / origins / addresses ----------

export async function getSettings(): Promise<Record<string, string>> {
  const rows = await query<{ key: string; value: string }>(`SELECT key, value FROM settings`);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function setSetting(key: string, value: string) {
  await query(
    `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
}

export async function getDefaults(): Promise<AddressDefaults> {
  const s = await getSettings();
  return {
    company: s.default_company ?? '', firstName: s.default_first_name ?? '', lastName: s.default_last_name ?? '',
    phone: s.default_phone ?? '', email: s.default_email ?? '' };
}

export async function getOrigins(): Promise<Origin[]> {
  const rows = await query(`SELECT country_code, origin_code FROM origins ORDER BY country_code`);
  return rows.map((r) => ({ countryCode: r.country_code, originCode: r.origin_code }));
}

const toAddress = (r: any): Address => ({
  countryCode: r.country_code,
  company: r.company,
  street: r.street,
  houseNumber: r.house_number,
  houseNumberAddition: r.house_number_addition,
  postalCode: r.postal_code,
  city: r.city,
  state: r.state ?? '',
  phone: r.phone,
  email: r.email,
});

export async function getAddresses(): Promise<Address[]> {
  return (await query(`SELECT * FROM addresses ORDER BY country_code`)).map(toAddress);
}

export async function upsertAddress(a: Address) {
  await query(
    `INSERT INTO addresses (country_code, company, street, house_number, house_number_addition, postal_code, city, phone, email, state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (country_code) DO UPDATE SET company=$2, street=$3, house_number=$4, house_number_addition=$5,
       postal_code=$6, city=$7, phone=$8, email=$9, state=$10`,
    [a.countryCode, a.company, a.street, a.houseNumber, a.houseNumberAddition, a.postalCode, a.city, a.phone, a.email, a.state ?? ''],
  );
}

// ---------- runs / results ----------

export interface RunRow {
  id: number;
  shipperCode: string;
  settings: RunSettings;
  dryRun: boolean;
  status: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

const toRun = (r: any): RunRow => ({
  id: r.id,
  shipperCode: r.shipper_code,
  settings: r.settings,
  dryRun: r.dry_run,
  status: r.status,
  createdAt: r.created_at,
  startedAt: r.started_at,
  endedAt: r.ended_at,
});

export interface ResultRow {
  id: number;
  runId: number;
  from: string;
  to: string;
  origin: string;
  orderNumber: string | null;
  seq: number | null;
  status: string;
  steps: StepState[];
  failedStep: number | null;
  httpStatus: number | null;
  error: string | null;
  labelPath: string | null;
  labelFileName: string | null;
  orderBody: any;
  colliBody: any;
  override: { order?: any; colli?: any } | null;
  retryOf: number | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

const toResult = (r: any): ResultRow => ({
  id: r.id,
  runId: r.run_id,
  from: r.from_cc,
  to: r.to_cc,
  origin: r.origin,
  orderNumber: r.order_number,
  seq: r.seq,
  status: r.status,
  steps: r.steps,
  failedStep: r.failed_step,
  httpStatus: r.http_status,
  error: r.error,
  labelPath: r.label_path,
  labelFileName: r.label_file_name,
  orderBody: r.order_body,
  colliBody: r.colli_body,
  override: r.override,
  retryOf: r.retry_of,
  createdAt: r.created_at,
  startedAt: r.started_at,
  endedAt: r.ended_at,
});

export const queuedSteps = (): StepState[] => [1, 2, 3, 4].map(() => ({ status: 'queued' }));

export async function createRun(s: RunSettings, origins: Origin[]): Promise<{ run: RunRow; resultIds: number[] }> {
  const run = toRun(
    await one(
      `INSERT INTO runs (shipper_code, settings, dry_run, status, started_at) VALUES ($1, $2::json, $3, 'running', now()) RETURNING *`,
      [s.shipperCode, JSON.stringify(s), s.dryRun],
    ),
  );
  const resultIds: number[] = [];
  for (const from of s.from) {
    const origin = origins.find((o) => o.countryCode === from)?.originCode ?? '';
    for (const to of s.to) {
      const r = await one(
        `INSERT INTO results (run_id, from_cc, to_cc, origin, status, steps) VALUES ($1,$2,$3,$4,'queued',$5::json) RETURNING id`,
        [run.id, from, to, origin, JSON.stringify(queuedSteps())],
      );
      resultIds.push(r.id);
    }
  }
  return { run, resultIds };
}

export async function getRun(id: number) {
  const r = await one(`SELECT * FROM runs WHERE id = $1`, [id]);
  return r ? toRun(r) : undefined;
}

export async function listRuns() {
  const rows = await query(
    `SELECT r.*,
       (SELECT count(*) FROM latest_results lr WHERE lr.run_id = r.id)::int AS pairs,
       (SELECT count(*) FROM latest_results lr WHERE lr.run_id = r.id AND lr.status = 'ok')::int AS ok,
       (SELECT count(*) FROM latest_results lr WHERE lr.run_id = r.id AND lr.status = 'failed')::int AS failed
     FROM runs r ORDER BY r.id DESC LIMIT 200`.replace(/latest_results/g, LATEST_SQL),
  );
  return rows.map((r) => ({ ...toRun(r), pairs: r.pairs, ok: r.ok, failed: r.failed }));
}

export async function setRunStatus(id: number, status: string, ended = false) {
  await query(
    `UPDATE runs SET status = $2, ended_at = CASE WHEN $3::boolean THEN now() ELSE NULL END WHERE id = $1`,
    [id, status, ended],
  );
  const run = await getRun(id);
  emit(id, { type: 'run', run });
}

// The latest attempt per From→To pair (a retry adds a newer row for the same pair).
const LATEST_SQL = `(SELECT DISTINCT ON (run_id, from_cc, to_cc) * FROM results ORDER BY run_id, from_cc, to_cc, id DESC)`;

export async function latestResults(runId: number) {
  return (await query(`SELECT * FROM ${LATEST_SQL} lr WHERE run_id = $1 ORDER BY id`, [runId])).map(toResult);
}

export async function getResult(id: number) {
  const r = await one(`SELECT * FROM results WHERE id = $1`, [id]);
  return r ? toResult(r) : undefined;
}

export async function pairAttempts(runId: number, from: string, to: string) {
  return (
    await query(`SELECT * FROM results WHERE run_id = $1 AND from_cc = $2 AND to_cc = $3 ORDER BY id DESC`, [runId, from, to])
  ).map(toResult);
}

const RESULT_COLUMNS: Record<string, [string, boolean]> = {
  orderNumber: ['order_number', false],
  seq: ['seq', false],
  status: ['status', false],
  steps: ['steps', true],
  failedStep: ['failed_step', false],
  httpStatus: ['http_status', false],
  error: ['error', false],
  labelPath: ['label_path', false],
  labelFileName: ['label_file_name', false],
  orderBody: ['order_body', true],
  colliBody: ['colli_body', true],
  startedAt: ['started_at', false],
  endedAt: ['ended_at', false],
};

export async function updateResult(id: number, patch: Partial<ResultRow>) {
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const [k, v] of Object.entries(patch)) {
    const col = RESULT_COLUMNS[k];
    if (!col) throw new Error(`Unknown result field ${k}`);
    params.push(col[1] ? JSON.stringify(v) : v);
    sets.push(`${col[0]} = $${params.length}${col[1] ? '::json' : ''}`);
  }
  const row = toResult(await one(`UPDATE results SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params));
  emit(row.runId, { type: 'result', result: row });
  return row;
}

export async function createRetry(prev: ResultRow, override: ResultRow['override']) {
  const r = await one(
    `INSERT INTO results (run_id, from_cc, to_cc, origin, status, steps, retry_of, override)
     VALUES ($1,$2,$3,$4,'queued',$5::json,$6,$7::json) RETURNING *`,
    [prev.runId, prev.from, prev.to, prev.origin, JSON.stringify(queuedSteps()), prev.id, override ? JSON.stringify(override) : null],
  );
  const row = toResult(r);
  emit(row.runId, { type: 'result', result: row });
  return row;
}

/** Highest seq already used for an order number base, across all runs. */
export async function maxSeq(base: string): Promise<number> {
  const r = await one(`SELECT max(seq) AS m FROM results WHERE order_number LIKE $1`, [base.replace(/[%_]/g, '\\$&') + '-%']);
  return r?.m ?? 0;
}

// ---------- API call log ----------

export interface CallRow {
  id: number;
  resultId: number;
  runId: number;
  step: number;
  purpose: string;
  attempt: number;
  method: string;
  url: string;
  requestBody: string | null;
  httpStatus: number | null;
  responseBody: string | null;
  contentType: string | null;
  durationMs: number;
  error: string | null;
  createdAt: string;
}

const toCall = (r: any): CallRow => ({
  id: r.id,
  resultId: r.result_id,
  runId: r.run_id,
  step: r.step,
  purpose: r.purpose,
  attempt: r.attempt,
  method: r.method,
  url: r.url,
  requestBody: r.request_body,
  httpStatus: r.http_status,
  responseBody: r.response_body,
  contentType: r.content_type,
  durationMs: r.duration_ms,
  error: r.error,
  createdAt: r.created_at,
});

export async function insertCall(c: Omit<CallRow, 'id' | 'createdAt'>, pair: string) {
  const row = toCall(
    await one(
      `INSERT INTO api_calls (result_id, run_id, step, purpose, attempt, method, url, request_body, http_status, response_body, content_type, duration_ms, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [c.resultId, c.runId, c.step, c.purpose, c.attempt, c.method, c.url, c.requestBody, c.httpStatus,
        c.responseBody, c.contentType, c.durationMs, c.error],
    ),
  );
  emit(c.runId, { type: 'log', call: { ...row, pair } });
  return row;
}

export async function callsForResult(resultId: number) {
  return (await query(`SELECT * FROM api_calls WHERE result_id = $1 ORDER BY id`, [resultId])).map(toCall);
}

export async function recentCalls(runId: number, limit = 200) {
  return (
    await query(
      `SELECT c.*, r.from_cc || '→' || r.to_cc AS pair FROM api_calls c JOIN results r ON r.id = c.result_id
       WHERE c.run_id = $1 ORDER BY c.id DESC LIMIT $2`,
      [runId, limit],
    )
  ).map((r) => ({ ...toCall(r), pair: r.pair }));
}
