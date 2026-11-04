import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { STEP_SHORT } from '../../../shared/model.ts';
import { api, fmtTime, useRunLive, type LogCall, type RunView } from '../api.ts';
import { Loading, Notice, PageHead, Pair, RunStatusBadge, StatusBadge, StepBadge } from '../components/ui.tsx';

export function runCounts(v: RunView) {
  const c = { ok: 0, failed: 0, running: 0, queued: 0, skipped: 0 };
  for (const r of v.results) c[r.status as keyof typeof c]++;
  return { ...c, total: v.results.length, finished: c.ok + c.failed + c.skipped };
}

export function runSubtitle(v: RunView) {
  const s = v.run.settings;
  return `${s.from.length} From × ${s.to.length} To · ${s.colli.count} colli, ${(s.colli.weightGrammes / 1000).toLocaleString('nl-NL')} kg · ${s.labelFileType.toUpperCase()}${v.run.dryRun ? ' · dry run' : ''}`;
}

function logLine(c: LogCall) {
  const path = c.url.replace(/^https?:\/\/[^/]+/, '');
  const status = c.httpStatus ?? 'ERR';
  const cls = c.error ? 'net' : c.httpStatus && c.httpStatus < 300 ? 'ok' : c.purpose.startsWith('exists') && c.httpStatus === 404 ? 'ok' : 'fail';
  return (
    <div key={c.id}>
      {fmtTime(c.createdAt)}  {c.pair.padEnd(6)} <span className={cls}>{String(status).padEnd(4)}</span> {c.method.padEnd(4)} {path}
      {c.attempt > 1 ? '  (retry)' : ''}{c.error ? `  ${c.error}` : ''}  {c.durationMs}ms
    </div>
  );
}

export default function RunProgress() {
  const runId = Number(useParams().id);
  const nav = useNavigate();
  const { view, error, refetch } = useRunLive(runId);
  const [busy, setBusy] = useState(false);

  if (error && !view) return <Notice kind="error">{error}</Notice>;
  if (!view) return <Loading />;

  const { run } = view;
  const c = runCounts(view);
  const pct = (n: number) => (c.total ? (n / c.total) * 100 : 0);
  const active = run.status === 'running' || run.status === 'paused';

  const act = async (what: 'pause' | 'resume' | 'stop') => {
    if (what === 'stop' && !window.confirm('Stop this run? Pairs already running finish; queued pairs are skipped.')) return;
    setBusy(true);
    try { await api.post(`/runs/${runId}/${what}`); refetch(); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHead
        crumbs={<><Link to="/runs">Test runs</Link> / Run #{run.id}</>}
        title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}><span className="mono">{run.shipperCode}</span> <RunStatusBadge status={run.status} /></span>}
        lead={`Started ${fmtTime(run.startedAt)} · ${runSubtitle(view)}`}
        actions={
          active ? (
            <>
              {run.status === 'paused'
                ? <button className="btn" type="button" disabled={busy} onClick={() => act('resume')}>Resume</button>
                : <button className="btn" type="button" disabled={busy} onClick={() => act('pause')}>Pause</button>}
              <button className="btn btn-danger" type="button" disabled={busy} onClick={() => act('stop')}>Stop run</button>
            </>
          ) : (
            <Link className="btn btn-primary" to={`/runs/${runId}/results`}>View results</Link>
          )
        }
      />
      {run.status === 'paused' && (
        <Notice kind="info">Paused. No new pairs start until you resume. {view.queue?.workers ? `${view.queue.workers} pair(s) still finishing.` : ''}</Notice>
      )}

      <section className="card" aria-label="Progress" style={{ gap: 14 }}>
        <div className="card-head">
          <span style={{ fontSize: 15, fontWeight: 600 }}>{c.finished} of {c.total} combinations finished</span>
          <span className="actions">
            <StatusBadge status="ok" text={`${c.ok} label OK`} />
            <StatusBadge status="failed" text={`${c.failed} failed`} />
            <StatusBadge status="running" text={`${c.running} running`} />
            <StatusBadge status="queued" text={`${c.queued} queued`} />
            {c.skipped > 0 && <StatusBadge status="skipped" text={`${c.skipped} skipped`} />}
          </span>
        </div>
        <div className="progress" role="progressbar" aria-valuenow={Math.round(pct(c.finished))} aria-valuemin={0} aria-valuemax={100} aria-label="Run progress">
          <div className="ok" style={{ width: `${pct(c.ok)}%` }} />
          <div className="failed" style={{ width: `${pct(c.failed)}%` }} />
          <div className="running" style={{ width: `${pct(c.running)}%` }} />
        </div>
      </section>

      <div className="split">
        <section className="card flush wide" aria-labelledby="combos" style={{ flex: '2 1 640px' }}>
          <div className="card-head"><h2 className="h2" id="combos">Combinations</h2></div>
          <div className="tbl-wrap">
            <table className="tbl" style={{ minWidth: 760 }}>
              <thead>
                <tr><th>From → To</th><th>Order</th>{STEP_SHORT.map((n, i) => <th key={n}>{i + 1} · {n}</th>)}</tr>
              </thead>
              <tbody>
                {view.results.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => nav(`/results/${r.id}`)}>
                    <td><Link to={`/results/${r.id}`} onClick={(e) => e.stopPropagation()} style={{ textDecoration: 'none' }}><Pair from={r.from} to={r.to} /></Link></td>
                    <td className="mono nowrap" style={{ fontSize: 13, color: 'var(--text-2)' }}>{r.orderNumber ?? '—'}</td>
                    {r.steps.map((st, i) => <td key={i}><StepBadge step={st} last={i === 3} /></td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card narrow" aria-labelledby="log" style={{ flex: '1 1 340px' }}>
          <h2 className="h2" id="log">Live log</h2>
          <pre className="code log" aria-live="polite">{view.log.length ? view.log.map(logLine) : 'Waiting for the first call…'}</pre>
          <Link to={`/runs/${runId}/results`} style={{ fontSize: 14, fontWeight: 600 }}>{active ? 'Open results so far' : 'Open results'}</Link>
        </section>
      </div>
    </>
  );
}
