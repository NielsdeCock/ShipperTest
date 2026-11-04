import { useState } from 'react';
import { countryName, type Origin } from '../../../shared/model.ts';
import { api, getOrigins, useLoad } from '../api.ts';
import { CC, IconX, Loading, Notice, PageHead } from '../components/ui.tsx';

export default function Origins() {
  const { data, error, setData } = useLoad(getOrigins);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newCc, setNewCc] = useState('');
  const [newCode, setNewCode] = useState('');
  const [msg, setMsg] = useState<{ kind: 'info' | 'error'; text: string }>();

  if (error) return <Notice kind="error">{error}</Notice>;
  if (!data) return <Loading />;

  const save = async (cc: string, originCode: string) => {
    try {
      setData(await api.put<Origin[]>(`/origins/${cc}`, { originCode }));
      setDrafts(({ [cc]: _, ...rest }) => rest);
      setMsg({ kind: 'info', text: `Origin for ${cc} saved.` });
    } catch (e: any) { setMsg({ kind: 'error', text: e.message }); }
  };

  const add = async () => {
    const cc = newCc.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc)) return setMsg({ kind: 'error', text: 'Use a 2-letter ISO country code (UK = GB).' });
    await save(cc, newCode.trim());
    setNewCc('');
    setNewCode('');
  };

  const remove = async (cc: string) => {
    if (!window.confirm(`Remove ${cc} as a From country?`)) return;
    setData(await api.del<Origin[]>(`/origins/${cc}`));
  };

  return (
    <>
      <PageHead title="Origins" lead="Each From country maps to the Origin (warehouse) code sent in the order." />
      <Notice kind="warn">Orders are created in the live system. Use test origins only.</Notice>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <section className="card flush">
        <div className="tbl-wrap">
          <table className="tbl" style={{ minWidth: 560 }}>
            <thead><tr><th>From country</th><th>Origin code</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {data.map((o) => {
                const draft = drafts[o.countryCode];
                const value = draft ?? o.originCode;
                return (
                  <tr key={o.countryCode}>
                    <td className="nowrap"><span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}><CC cc={o.countryCode} />{countryName(o.countryCode)}</span></td>
                    <td style={{ width: '55%' }}>
                      <input className="input mono" aria-label={`Origin code for ${o.countryCode}`} value={value} placeholder="No Origin set"
                        aria-invalid={!value.trim()} onChange={(e) => setDrafts({ ...drafts, [o.countryCode]: e.target.value })}
                        onKeyDown={(e) => e.key === 'Enter' && save(o.countryCode, value)} />
                    </td>
                    <td className="nowrap" style={{ textAlign: 'right' }}>
                      <span className="actions" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                        <button className="btn btn-sm" type="button" disabled={draft === undefined} onClick={() => save(o.countryCode, value)}>Save</button>
                        <button className="btn btn-ghost icon-btn" type="button" aria-label={`Remove ${o.countryCode}`} onClick={() => remove(o.countryCode)}><IconX size={18} /></button>
                      </span>
                    </td>
                  </tr>
                );
              })}
              <tr>
                <td><input className="input mono" aria-label="New country code" placeholder="CC" maxLength={2} style={{ width: 80 }} value={newCc} onChange={(e) => setNewCc(e.target.value.toUpperCase())} /></td>
                <td><input className="input mono" aria-label="New origin code" placeholder="Origin code" value={newCode} onChange={(e) => setNewCode(e.target.value)} /></td>
                <td style={{ textAlign: 'right' }}><button className="btn btn-sm btn-primary" type="button" onClick={add}>+ Add</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
