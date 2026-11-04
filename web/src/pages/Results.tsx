import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { STEP_NAMES } from '../../../shared/model.ts';
import { api, fmtTime, useRunLive, type ResultRow } from '../api.ts';
import { CC, IconCheck, IconClock, IconMinus, IconSpinner, IconX, Loading, Notice, PageHead, Pair, RunStatusBadge, StatusBadge } from '../components/ui.tsx';
import { runCounts, runSubtitle } from './RunProgress.tsx';

type Filter = 'all' | 'ok' | 'failed';

/** First line of the API message, for the compact table; the full text is on the detail page. */
const shortMessage = (r: ResultRow) => {
  const e = r.error ?? '';
  try {
    const j = JSON.parse(e);
    const m = j.Message ?? j.message ?? j.title ?? j.error;
    if (typeof m === 'string') return m + (Array.isArray(j.Errors) && j.Errors.length ? ` — ${j.Errors.join('; ')}` : '');
  } catch { /* not JSON: show as-is */ }
  return e;
};

function Cell({ r, filter }: { r?: ResultRow; filter: Filter }) {
  if (!r) return <span className="cell queued"><span className="cell-t"><IconMinus />Not in run</span></span>;
  const dim = (filter === 'ok' && r.status !== 'ok') || (filter === 'failed' && r.status !== 'failed');
  const [icon, title, sub] =
    r.status === 'ok' ? [<IconCheck size={16} />, 'Label', r.labelPath?.split(/[\\/]/).pop() ?? r.orderNumber]
    : r.status === 'failed' ? [<IconX size={16} />, 'No label', r.failedStep ? `Step ${r.failedStep} · ${STEP_NAMES[r.failedStep - 1]}` : 'Failed']
    : r.status === 'running' ? [<IconSpinner size={16} />, 'Running', r.orderNumber ?? '']
    : r.status === 'skipped' ? [<IconMinus size={16} />, 'Skipped', 'Run stopped']
    : [<IconClock size={16} />, 'Queued', ''];
  const aria = `${r.from} to ${r.to}: ${r.status === 'ok' ? 'label received' : r.status === 'failed' ? `no label, failed at step ${r.failedStep}` : r.status}`;
  return (
    <Link className={`cell ${r.status}${dim ? ' dim' : ''}`} to={`/results/${r.id}`} aria-label={aria}>
      <span className="cell-t">{icon}{title}</span>
      <span className="cell-s">{sub}</span>
    </Link>
  );
}

export default function Results() {
  const runId = Number(useParams().id);
  const { view, error, refetch } = useRunLive(runId);
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();

  if (error && !view) return <Notice kind="error">{error}</Notice>;
  if (!view) return <Loading />;

  const { run, results } = view;
  const c = runCounts(view);
  const tested = c.ok + c.failed;
  const failed = results.filter((r) => r.status === 'failed' || r.status === 'skipped');
  const byPair = new Map(results.map((r) => [`${r.from}-${r.to}`, r]));
  const s = run.settings;
  const options = s.shipperOptions.filter((o) => o.code).map((o) => o.code);
  const active = run.status === 'running' || run.status === 'paused';

  const retry = async (url: string) => {
    setBusy(true);
    setMsg(undefined);
    try { await api.post(url); refetch(); setMsg('Retry queued: a new order with the next sequence number is created.'); }
    catch (e: any) { setMsg(e.message); }
    finally { setBusy(false); }
  };

  return (
    <>
      <PageHead
        crumbs={<><Link to="/runs">Test runs</Link> / <Link to={`/runs/${runId}`}>Run #{run.id}</Link></>}
        title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}><span className="mono">{run.shipperCode}</span> · results <RunStatusBadge status={run.status} /></span>}
        lead={`${run.endedAt ? `Finished ${fmtTime(run.endedAt)}` : `Started ${fmtTime(run.startedAt)}`} · ${runSubtitle(view)}${options.length ? ` · options: ${options.join(', ')}` : ''}`}
        actions={
          <>
            <a className="btn" href={`/api/runs/${runId}/csv`}>Export CSV</a>
            {c.ok > 0 ? <a className="btn" href={`/api/runs/${runId}/labels.zip`}>Download all labels</a>
              : <button className="btn" type="button" disabled>Download all labels</button>}
            <button className="btn btn-primary" type="button" disabled={busy || failed.length === 0} onClick={() => retry(`/runs/${runId}/retry-failed`)}>
              Retry failed ({failed.length})
            </button>
          </>
        }
      />
      {msg && <Notice kind="info">{msg}</Notice>}
      {active && <Notice kind="info">This run is still {run.status}. <Link to={`/runs/${runId}`}>Watch progress</Link>.</Notice>}

      <div className="grid g4">
        <div className="kpi"><span className="kpi-n">{tested}</span><span className="kpi-l">Combinations tested{c.total !== tested ? ` (of ${c.total})` : ''}</span></div>
        <div className="kpi"><span className="kpi-n" style={{ color: 'var(--ok-ink)' }}>{c.ok}</span><span className="kpi-l">✓ Label received</span></div>
        <div className="kpi"><span className="kpi-n" style={{ color: 'var(--fail-ink)' }}>{c.failed}</span><span className="kpi-l">✕ No label</span></div>
        <div className="kpi"><span className="kpi-n">{tested ? Math.round((c.ok / tested) * 100) : 0}%</span><span className="kpi-l">Success rate</span></div>
      </div>

      <section className="card" aria-labelledby="mx">
        <div className="card-head">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <h2 className="h2" id="mx">Label result per country combination</h2>
            <p className="hint">Rows = From (origin) · columns = To (destination). Select a cell for the full API trace.</p>
          </div>
          <div className="seg" role="group" aria-label="Filter">
            {(['all', 'ok', 'failed'] as Filter[]).map((f) => (
              <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {f === 'all' ? 'All' : f === 'ok' ? 'Label OK' : 'Failed'}
              </button>
            ))}
          </div>
        </div>
        <div className="tbl-wrap" style={{ padding: 8 }}>
          <table className="mx">
            <thead>
              <tr>
                <th scope="col" style={{ width: 120 }}>From ↓ / To →</th>
                {s.to.map((t) => <th scope="col" key={t}><CC cc={t} /></th>)}
              </tr>
            </thead>
            <tbody>
              {s.from.map((from) => (
                <tr key={from}>
                  <th scope="row" style={{ verticalAlign: 'middle' }}>
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span style={{ alignSelf: 'flex-start' }}><CC cc={from} /></span>
                      <span className="mono" style={{ fontSize: 11, fontWeight: 400 }}>{results.find((r) => r.from === from)?.origin}</span>
                    </span>
                  </th>
                  {s.to.map((to) => <td key={to}><Cell r={byPair.get(`${from}-${to}`)} filter={filter} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="legend">
          <span><span className="swatch" style={{ background: 'var(--ok-bg)', border: '1px solid #86EFAC' }} />✓ Label received</span>
          <span><span className="swatch" style={{ background: 'var(--fail-bg)', border: '1px solid #FCA5A5' }} />✕ No label — failed step shown</span>
          <span><span className="swatch" style={{ background: 'var(--wait-bg)', border: '1px solid var(--border)' }} />Queued / skipped</span>
        </div>
      </section>

      <section className="card flush" aria-labelledby="fl">
        <div className="card-head"><h2 className="h2" id="fl">Failed combinations <small>· {failed.length}</small></h2></div>
        {failed.length === 0 ? (
          <div style={{ padding: '0 24px 24px' }}><p className="hint">No failed combinations.</p></div>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl" style={{ minWidth: 820 }}>
              <thead><tr><th>From → To</th><th>Order</th><th>Failed at</th><th>Response</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {failed.map((r) => (
                  <tr key={r.id}>
                    <td><Pair from={r.from} to={r.to} /></td>
                    <td className="mono nowrap" style={{ fontSize: 13 }}>{r.orderNumber ?? '—'}</td>
                    <td>{r.status === 'skipped' ? <StatusBadge status="skipped" text="Not started" />
                      : <StatusBadge status="failed" text={r.failedStep ? `${r.failedStep} · ${STEP_NAMES[r.failedStep - 1]}` : 'Failed'} />}</td>
                    <td style={{ color: 'var(--text-2)', maxWidth: 420 }}>
                      {r.httpStatus && <span className="mono" style={{ fontSize: 13, fontWeight: 500, color: 'var(--fail-ink)' }}>{r.httpStatus} </span>}
                      <span style={{ overflowWrap: 'anywhere' }}>{shortMessage(r).slice(0, 300)}</span>
                    </td>
                    <td className="nowrap" style={{ textAlign: 'right' }}>
                      <span className="actions" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                        <Link className="btn btn-sm" to={`/results/${r.id}`}>View trace</Link>
                        <button className="btn btn-sm" type="button" disabled={busy} onClick={() => retry(`/results/${r.id}/retry`)}>Retry</button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
