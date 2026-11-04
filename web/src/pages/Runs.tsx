import { Link, useNavigate } from 'react-router-dom';
import { api, fmtDateTime, useLoad, type RunListItem } from '../api.ts';
import { Loading, Notice, PageHead, RunStatusBadge } from '../components/ui.tsx';

export default function Runs() {
  const nav = useNavigate();
  const { data, error } = useLoad(() => api.get<RunListItem[]>('/runs'));
  if (error) return <Notice kind="error">{error}</Notice>;
  if (!data) return <Loading />;

  return (
    <>
      <PageHead title="Test runs" lead="Every run with its label success rate." actions={<Link className="btn btn-primary" to="/">+ New test run</Link>} />
      <section className="card flush">
        {data.length === 0 ? (
          <div style={{ padding: 24 }}><p className="hint">No runs yet. <Link to="/">Start a test run</Link>.</p></div>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl" style={{ minWidth: 760 }}>
              <thead><tr><th>Run</th><th>Shipper</th><th>Started</th><th>Status</th><th>From → To</th><th>Label OK</th><th>Failed</th><th>Mode</th></tr></thead>
              <tbody>
                {data.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => nav(r.status === 'done' || r.status === 'stopped' ? `/runs/${r.id}/results` : `/runs/${r.id}`)}>
                    <td><Link to={`/runs/${r.id}`} onClick={(e) => e.stopPropagation()}>#{r.id}</Link></td>
                    <td className="mono">{r.shipperCode}</td>
                    <td className="nowrap">{fmtDateTime(r.startedAt)}</td>
                    <td><RunStatusBadge status={r.status} /></td>
                    <td className="nowrap">{r.settings.from.join(', ')} → {r.settings.to.join(', ')}</td>
                    <td>{r.ok} / {r.pairs}</td>
                    <td>{r.failed}</td>
                    <td>{r.dryRun ? <span className="badge queued">Dry run</span> : <span className="badge warn">Live</span>}</td>
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
