import { useEffect, useState } from 'react';
import { api, getMeta, useLoad } from '../api.ts';
import { Loading, Notice, PageHead, StatusBadge } from '../components/ui.tsx';

export default function Settings() {
  const { data, error, reload } = useLoad(getMeta);
  const [conc, setConc] = useState(1);
  const [msg, setMsg] = useState<string>();
  useEffect(() => { if (data) setConc(data.concurrency); }, [data]);

  if (error) return <Notice kind="error">{error}</Notice>;
  if (!data) return <Loading />;

  const save = async () => {
    await api.put('/settings', { concurrency: conc });
    setMsg('Saved. New runs start with this value.');
    reload();
  };

  return (
    <>
      <PageHead title="API settings" lead="Connection settings come from .env on the server. Credentials are never sent to the browser." />
      {msg && <Notice kind="info">{msg}</Notice>}
      <section className="card">
        <h2 className="h2">Monta API</h2>
        <div className="kv"><span>Base URL</span><span className="mono">{data.apiBase}</span></div>
        <div className="kv"><span>Authentication</span><span>{data.authMethod}</span></div>
        <div className="kv"><span>Credentials</span><span>{data.hasCredentials ? <StatusBadge status="ok" text="Configured" /> : <StatusBadge status="failed" text="Missing in .env" />}</span></div>
        <div className="kv"><span>Live runs</span><span>{data.allowLive ? <StatusBadge status="ok" text="Allowed (ALLOW_LIVE=true)" /> : <StatusBadge status="skipped" text="Disabled: dry run only" />}</span></div>
        <div className="kv"><span>Timeout per call</span><span>30 s · 1 retry on network errors only</span></div>
      </section>
      <section className="card">
        <h2 className="h2">Storage</h2>
        <div className="kv"><span>Database</span><span>{data.database}</span></div>
        <div className="kv"><span>Label files</span><span className="mono" style={{ fontSize: 12 }}>{data.labelsDir}</span></div>
      </section>
      <section className="card">
        <h2 className="h2">Default parallel orders</h2>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label className="lbl">Orders at a time
            <select className="input" style={{ width: 200 }} value={conc} onChange={(e) => setConc(Number(e.target.value))}>
              <option value={1}>1 (in sequence)</option><option value={2}>2</option><option value={3}>3</option>
            </select>
          </label>
          <button className="btn" type="button" onClick={save}>Save</button>
        </div>
        <p className="hint">Maximum 3, so the API and the carrier are not overloaded. Can be changed per run.</p>
      </section>
    </>
  );
}
