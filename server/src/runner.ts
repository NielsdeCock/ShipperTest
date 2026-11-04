import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildColliBody, buildOrderBody, orderNumber, orderNumberBase,
  type RunSettings, type StepState,
} from '../../shared/model.ts';
import { config } from './config.ts';
import { createMontaClient } from './monta/client.ts';
import { extractFileName, extractLabelBytes } from './monta/labels.ts';
import { createMockClient } from './monta/mock.ts';
import { isOk, parseJson, type CallRecord, type MontaClient } from './monta/types.ts';
import { query } from './db.ts';
import {
  getAddresses, getDefaults, getResult, getRun, insertCall, maxSeq,
  setRunStatus, updateResult, type ResultRow,
} from './store.ts';

// ---------- queue per run ----------

interface RunState {
  queue: number[];
  workers: number;
  paused: boolean;
  stopped: boolean;
}

const active = new Map<number, RunState>();
/** Order numbers handed out in this process but maybe not yet saved (parallel workers). */
const reserved = new Set<string>();

export function runState(runId: number) {
  return active.get(runId);
}

export async function enqueue(runId: number, resultIds: number[], opts: { paused?: boolean } = {}) {
  let st = active.get(runId);
  if (!st) {
    st = { queue: [], workers: 0, paused: false, stopped: false };
    active.set(runId, st);
  }
  st.queue.push(...resultIds);
  st.stopped = false;
  st.paused = Boolean(opts.paused);
  await setRunStatus(runId, st.paused ? 'paused' : 'running');
  void pump(runId);
}

async function pump(runId: number) {
  const st = active.get(runId);
  if (!st) return;
  const run = await getRun(runId);
  const concurrency = Math.min(3, Math.max(1, run?.settings.concurrency ?? 1));
  while (st.workers < concurrency && st.queue.length && !st.paused && !st.stopped) {
    const id = st.queue.shift()!;
    st.workers++;
    processPair(id)
      .catch(async (e) => {
        console.error('[runner] pair crashed', id, e);
        await updateResult(id, { status: 'failed', error: `Internal error: ${e?.message ?? e}`, endedAt: new Date().toISOString() });
      })
      .finally(() => {
        st.workers--;
        void pump(runId);
      });
  }
  if (st.workers === 0 && (st.queue.length === 0 || st.stopped)) {
    active.delete(runId);
    await setRunStatus(runId, st.stopped ? 'stopped' : 'done', true);
  }
}

export async function pause(runId: number) {
  const st = active.get(runId);
  if (!st) return false;
  st.paused = true;
  await setRunStatus(runId, 'paused');
  return true;
}

export async function resume(runId: number) {
  const st = active.get(runId);
  if (!st) return false;
  st.paused = false;
  await setRunStatus(runId, 'running');
  void pump(runId);
  return true;
}

/** Stops starting new pairs; pairs already in flight finish their steps. */
export async function stop(runId: number) {
  const st = active.get(runId);
  if (!st) return false;
  st.stopped = true;
  const skipped = st.queue.splice(0);
  for (const id of skipped) {
    await updateResult(id, {
      status: 'skipped',
      steps: [1, 2, 3, 4].map(() => ({ status: 'skipped' })),
      error: 'Run stopped before this pair started',
    });
  }
  st.paused = false;
  void pump(runId);
  return true;
}

/** After a server restart: half-finished pairs fail, queued pairs wait (paused) for Resume. */
export async function recoverAfterRestart() {
  const rows = await query(`SELECT id FROM runs WHERE status IN ('running', 'paused')`);
  for (const { id } of rows) {
    const inFlight = await query(`SELECT id FROM results WHERE run_id = $1 AND status = 'running'`, [id]);
    for (const r of inFlight) {
      const res = await getResult(r.id);
      await updateResult(r.id, {
        status: 'failed',
        steps: res!.steps.map((s) => (s.status === 'running' ? { status: 'failed' } : s.status === 'queued' ? { status: 'skipped' } : s)),
        failedStep: (res!.steps.findIndex((s) => s.status === 'running') + 1) || null,
        error: 'Interrupted: the server restarted while this pair was running. Check the order in Monta before retrying.',
        endedAt: new Date().toISOString(),
      });
    }
    const queued = await query(`SELECT id FROM results WHERE run_id = $1 AND status = 'queued' ORDER BY id`, [id]);
    if (queued.length) await enqueue(id, queued.map((q) => q.id), { paused: true });
    else await setRunStatus(id, 'done', true);
  }
}

// ---------- one From → To pair ----------

class StepFailure extends Error {
  constructor(public step: number, message: string, public http: number | null = null) {
    super(message);
  }
}

const VERIFY_RETRIES = 12;
const VERIFY_WAIT_MS = 10_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hasReason = (c: CallRecord, code: number) =>
  c.status === 400 && (parseJson(c.responseBody)?.OrderInvalidReasons ?? []).some((r: any) => r?.Code === code);
const isNotVerified = (c: CallRecord) => hasReason(c, 42);
const isBlocked = (c: CallRecord) => hasReason(c, 43);

const errorText = (c: CallRecord) =>
  c.networkError ? `Network error: ${c.networkError}` : c.responseBody || `HTTP ${c.status} (empty response body)`;

async function processPair(resultId: number) {
  const res = (await getResult(resultId))!;
  const run = (await getRun(res.runId))!;
  const s: RunSettings = run.settings;
  const client: MontaClient = run.dryRun
    ? createMockClient({ to: res.to, failures: s.mockFailures ?? '' })
    : createMontaClient();
  const pair = `${res.from}→${res.to}`;
  const steps: StepState[] = [1, 2, 3, 4].map(() => ({ status: 'queued' }));

  const setStep = async (n: number, st: StepState, extra: Partial<ResultRow> = {}) => {
    steps[n - 1] = st;
    await updateResult(resultId, { steps: [...steps], ...extra });
  };

  /** Sends one call and logs it; retries once on network errors only (never on an HTTP response). */
  const call = async (step: number, purpose: string, method: 'GET' | 'POST', p: string, body?: unknown) => {
    let rec!: CallRecord;
    for (let attempt = 1; attempt <= 2; attempt++) {
      rec = await client.send(method, p, body);
      await insertCall(
        {
          resultId, runId: res.runId, step, purpose, attempt, method, url: rec.url,
          requestBody: rec.requestBody, httpStatus: rec.status, responseBody: rec.responseBody,
          contentType: rec.contentType, durationMs: rec.durationMs, error: rec.networkError,
        },
        pair,
      );
      if (!rec.networkError) return { rec, retried: attempt > 1 };
    }
    return { rec, retried: true };
  };

  await updateResult(resultId, { status: 'running', startedAt: new Date().toISOString(), steps });

  try {
    // ---- Step 1: create order (with unique order number) ----
    await setStep(1, { status: 'running' });
    const defaults = await getDefaults();
    const address = (await getAddresses()).find((a) => a.countryCode === res.to);
    if (!address) throw new StepFailure(1, `No address for ${res.to} in the address book`);

    const base = orderNumberBase(s.orderPrefix, res.from, res.to);
    let seq = (await maxSeq(base)) + 1;
    let nr = '';
    for (let tries = 0; ; tries++) {
      while (reserved.has(orderNumber(base, seq))) seq++;
      nr = orderNumber(base, seq);
      reserved.add(nr);
      const { rec } = await call(1, 'exists-check', 'GET', `/order/${encodeURIComponent(nr)}`);
      if (rec.status === 404) break;
      if (rec.status === 200 && tries < 50) { seq++; continue; }
      throw new StepFailure(1, `Order number check failed: ${errorText(rec)}`, rec.status);
    }
    const order = res.override?.order
      ? { ...res.override.order, WebshopOrderId: nr, Reference: nr }
      : buildOrderBody(nr, res.origin, address, defaults, s);
    await updateResult(resultId, { orderNumber: nr, seq, orderBody: order });

    const created = await call(1, 'create', 'POST', '/order', order);
    if (!isOk(created.rec)) {
      // A timed-out POST may still have created the order; the retry then fails as a duplicate.
      let exists = false;
      if (created.retried) {
        const { rec } = await call(1, 'exists-after-retry', 'GET', `/order/${encodeURIComponent(nr)}`);
        exists = rec.status === 200;
      }
      if (!exists) throw new StepFailure(1, errorText(created.rec), created.rec.status);
    }
    await setStep(1, { status: 'ok', http: created.rec.status });

    // ---- Step 2: colli ----
    await setStep(2, { status: 'running' });
    const colli = res.override?.colli ?? buildColliBody(s);
    await updateResult(resultId, { colliBody: colli });
    const c2 = await call(2, 'colli', 'POST', `/order/${encodeURIComponent(nr)}/colli`, colli);
    if (!isOk(c2.rec)) throw new StepFailure(2, errorText(c2.rec), c2.rec.status);
    await setStep(2, { status: 'ok', http: c2.rec.status });

    // ---- Step 3: request label ----
    await setStep(3, { status: 'running' });
    const type = s.labelFileType;
    const labelPath = `/order/${encodeURIComponent(nr)}/shippinglabels?labelfiletype=${type}`;
    let c3 = await call(3, 'request-label', 'POST', labelPath);
    // A fresh order is verified by Monta shortly after creation; until then it answers code 42.
    for (let wait = 1; wait <= VERIFY_RETRIES && isNotVerified(c3.rec) && !active.get(res.runId)?.stopped; wait++) {
      await sleep(VERIFY_WAIT_MS);
      c3 = await call(3, `request-label (not verified, retry ${wait}/${VERIFY_RETRIES})`, 'POST', labelPath);
    }
    if (!isOk(c3.rec)) {
      let msg = errorText(c3.rec);
      // "Order is blocked" (code 43) does not say why; the order itself carries BlockedMessage.
      if (isBlocked(c3.rec)) {
        const { rec } = await call(3, 'blocked-reason', 'GET', `/order/${encodeURIComponent(nr)}`);
        const o = parseJson(rec.responseBody);
        const reason = o?.BlockedMessage || (isOk(rec) ? '(no BlockedMessage on the order)' : `(could not read the order: ${errorText(rec)})`);
        msg = `Blocked reason: ${reason}

${msg}`;
      }
      throw new StepFailure(3, msg, c3.rec.status);
    }
    await setStep(3, { status: 'ok', http: c3.rec.status });

    // ---- Step 4: fetch label ----
    await setStep(4, { status: 'running' });
    const fileName = extractFileName(c3.rec.responseBody, type);
    if (!fileName) {
      throw new StepFailure(4, `FILENAME not found in the step 3 response. Response was: ${c3.rec.responseBody || '(empty)'}`);
    }
    await updateResult(resultId, { labelFileName: fileName });
    // Use the name as returned; only add the extension when Monta gave none.
    const urlName = /.[a-z0-9]{2,4}$/i.test(fileName) ? fileName : `${fileName}.${type}`;
    const c4 = await call(4, 'fetch-label', 'GET', `/order/${encodeURIComponent(nr)}/shippinglabels/${encodeURIComponent(urlName)}/`); // Monta: a filename with a dot needs a trailing slash
    if (!isOk(c4.rec)) throw new StepFailure(4, errorText(c4.rec), c4.rec.status);
    const bytes = extractLabelBytes(c4.rec, type);
    if (!bytes) throw new StepFailure(4, `Response did not contain a ${type.toUpperCase()} label: ${c4.rec.responseBody.slice(0, 2000)}`, c4.rec.status);

    const dir = path.join(config.labelsDir, String(res.runId));
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${nr}.${type}`);
    await fs.writeFile(file, bytes);

    steps[3] = { status: 'ok', http: c4.rec.status };
    await updateResult(resultId, {
      steps: [...steps], status: 'ok', labelPath: file, endedAt: new Date().toISOString(),
    });
  } catch (e) {
    if (!(e instanceof StepFailure)) throw e;
    for (let i = 0; i < 4; i++) {
      if (i === e.step - 1) steps[i] = { status: 'failed', http: e.http };
      else if (i > e.step - 1) steps[i] = { status: 'skipped' };
    }
    await updateResult(resultId, {
      steps: [...steps], status: 'failed', failedStep: e.step, httpStatus: e.http,
      error: e.message, endedAt: new Date().toISOString(),
    });
  }
}
