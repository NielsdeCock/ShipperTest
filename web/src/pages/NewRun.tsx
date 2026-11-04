import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  COUNTRY_NAMES, DEFAULT_RUN_SETTINGS, EU_COUNTRIES, countryName, mmdd, validateRun,
  type RunSettings,
} from '../../../shared/model.ts';
import { api, getAddresses, getMeta, getOrigins, getShippers, useLoad, type Template } from '../api.ts';
import { CC, IconAlert, IconCheck, IconX, Loading, Notice, PageHead } from '../components/ui.tsx';

const DESIGN_TO = ['NL', 'BE', 'DE', 'FR', 'AT', 'LU', 'DK', 'ES', 'IT', 'PL', 'SE', 'GB'];

const toggle = (list: string[], cc: string) => (list.includes(cc) ? list.filter((x) => x !== cc) : [...list, cc]);
const num = (v: string) => (v === '' ? 0 : Number(v));

export default function NewRun() {
  const nav = useNavigate();
  const meta = useLoad(getMeta);
  const origins = useLoad(getOrigins);
  const addresses = useLoad(getAddresses);
  const templates = useLoad(() => api.get<Template[]>('/templates'));
  const shippers = useLoad(getShippers);
  const [s, setS] = useState<RunSettings>(DEFAULT_RUN_SETTINGS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [flash, setFlash] = useState<string>();

  useEffect(() => {
    if (meta.data) setS((p) => ({ ...p, concurrency: meta.data!.concurrency, dryRun: p.dryRun || !meta.data!.allowLive }));
  }, [meta.data]);

  const set = <K extends keyof RunSettings>(k: K, v: RunSettings[K]) => setS((p) => ({ ...p, [k]: v }));
  const setColli = (k: keyof RunSettings['colli'], v: number) => setS((p) => ({ ...p, colli: { ...p.colli, [k]: v } }));
  const setInvoice = <K extends keyof RunSettings['invoice']>(k: K, v: RunSettings['invoice'][K]) =>
    setS((p) => ({ ...p, invoice: { ...p.invoice, [k]: v } }));

  const toCountries = useMemo(() => {
    const set = new Set([...DESIGN_TO, ...(addresses.data ?? []).map((a) => a.countryCode), ...s.to]);
    return [...set];
  }, [addresses.data, s.to]);

  if (!meta.data || !origins.data || !addresses.data || !templates.data) {
    const err = meta.error ?? origins.error ?? addresses.error;
    return err ? <Notice kind="error">Could not load: {err}</Notice> : <Loading />;
  }

  const hasAddress = (cc: string) => {
    const a = addresses.data!.find((x) => x.countryCode === cc);
    return !!a && !!a.street && !!a.postalCode && !!a.city;
  };
  const errors = validateRun(s, origins.data, addresses.data);

  // Shippers from Monta /info, merged over all origins. Monta origin names may carry stray spaces.
  const montaOrigins = shippers.data?.origins ?? [];
  const shipperList = [...new Map(
    montaOrigins.flatMap((o) => o.shippers).filter((x) => x.available && x.code).map((x) => [x.code, x] as const),
  ).values()].sort((a, b) => a.description.localeCompare(b.description));
  const missingAt = !s.shipperCode || !montaOrigins.length ? [] : s.from
    .map((c) => origins.data!.find((o) => o.countryCode === c)?.originCode ?? '')
    .filter((name) => {
      const mo = montaOrigins.find((o) => o.name.trim() === name.trim());
      return mo && !mo.shippers.some((x) => x.code === s.shipperCode);
    });
  if (!s.dryRun && !meta.data.allowLive) errors.push('Live runs are disabled on the server (ALLOW_LIVE=false).');
  if (!s.dryRun && !meta.data.hasCredentials) errors.push('No Monta API credentials in .env.');
  const n = s.from.length * s.to.length;
  const options = s.shipperOptions.filter((o) => o.shipperCode && o.code);

  async function start() {
    if (!s.dryRun && !window.confirm(`This creates ${n} REAL orders in Monta (${meta.data!.apiBase}) for ${s.shipperCode}. Continue?`)) return;
    setBusy(true);
    setError(undefined);
    try {
      const { id } = await api.post<{ id: number }>('/runs', s);
      nav(`/runs/${id}`);
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }

  async function saveTemplate() {
    const name = window.prompt('Template name', s.shipperCode || 'Carrier test');
    if (!name?.trim()) return;
    try {
      templates.setData(await api.post<Template[]>('/templates', { name, settings: s }));
      setFlash(`Template "${name}" saved.`);
    } catch (e: any) {
      setError(e.message);
    }
  }

  function loadTemplate(id: string) {
    const t = templates.data!.find((x) => String(x.id) === id);
    if (!t) return;
    setS({ ...DEFAULT_RUN_SETTINGS, ...t.settings, dryRun: t.settings.dryRun || !meta.data!.allowLive });
    setFlash(`Loaded template "${t.name}".`);
  }

  return (
    <>
      <PageHead
        title="New test run"
        lead="Creates one order per From → To combination and requests a shipping label for each."
        actions={
          <>
            <span className="mono" style={{ fontSize: 12, color: 'var(--text-2)', background: '#fff', border: '1px solid var(--border)', borderRadius: 999, padding: '6px 12px' }}>
              {meta.data.apiBase.replace(/^https?:\/\//, '')}
            </span>
            <label className="sr-only" htmlFor="tpl">Load template</label>
            <select id="tpl" className="input" style={{ width: 'auto', height: 44 }} value="" onChange={(e) => loadTemplate(e.target.value)}>
              <option value="">Load template…</option>
              {templates.data.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </>
        }
      />
      {flash && <Notice kind="info">{flash}</Notice>}

      <div className="split">
        <div className="wide">
          <section className="card" aria-labelledby="s1">
            <h2 className="h2" id="s1"><span className="step-no">1</span>Carrier</h2>
            <div className="grid g3">
              <label className="lbl">Shipper
                {shipperList.length ? (
                  <select className="input mono" value={s.shipperCode} onChange={(e) => set('shipperCode', e.target.value)}>
                    <option value="">Choose a shipper…</option>
                    {s.shipperCode && !shipperList.some((x) => x.code === s.shipperCode) && <option value={s.shipperCode}>{s.shipperCode}</option>}
                    {shipperList.map((x) => (
                      <option key={x.code} value={x.code}>
                        {x.description === x.code ? x.code : `${x.description} (${x.code})`}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input className="input mono" value={s.shipperCode} placeholder={shippers.data ? 'e.g. DHLParcelConnect' : 'Loading shippers…'} onChange={(e) => set('shipperCode', e.target.value)} />
                )}
              </label>
              <label className="lbl">Label file type
                <select className="input" value={s.labelFileType} onChange={(e) => set('labelFileType', e.target.value as 'pdf' | 'zpl')}>
                  <option value="pdf">pdf</option><option value="zpl">zpl</option>
                </select>
              </label>
              <label className="lbl">Order number prefix
                <input className="input mono" value={s.orderPrefix} placeholder="e.g. Evri" onChange={(e) => set('orderPrefix', e.target.value.replace(/[^A-Za-z0-9]/g, ''))} />
              </label>
            </div>
            <p className="hint">
              Sent as <span className="mono">AllowedShippers</span> on every order. Order numbers become{' '}
              <span className="mono">{s.orderPrefix || '{prefix}'}-{mmdd()}-{s.from[0] ?? 'NL'}-{s.to[0] ?? 'DE'}-01</span>.
              {' '}Shippers come from Monta <span className="mono">GET /info</span>.
            </p>
            {shippers.data?.error && <Notice kind="warn">Could not load shippers from Monta: {shippers.data.error}. Type the code instead.</Notice>}
            {missingAt.length > 0 && (
              <Notice kind="warn">{s.shipperCode} is not set up for: {missingAt.join(', ')}. Those pairs will likely fail at step 1.</Notice>
            )}
          </section>

          <section className="card" aria-labelledby="s2">
            <div className="card-head">
              <h2 className="h2" id="s2"><span className="step-no">2</span>Shipper options <small>optional</small></h2>
              <button className="btn btn-ghost" type="button"
                onClick={() => set('shipperOptions', [...s.shipperOptions, { shipperCode: s.shipperCode, code: '' }])}>+ Add option</button>
            </div>
            {s.shipperOptions.length === 0 ? (
              <p className="hint">No shipper options. <span className="mono">ShipperOptions</span> is left out of the order.</p>
            ) : (
              <div className="tbl-wrap">
                <table className="tbl compact">
                  <thead><tr><th>Shipper code</th><th>Option code</th><th style={{ width: 48 }}><span className="sr-only">Remove</span></th></tr></thead>
                  <tbody>
                    {s.shipperOptions.map((o, i) => (
                      <tr key={i}>
                        <td><input className="input mono" aria-label="Shipper code" value={o.shipperCode}
                          onChange={(e) => set('shipperOptions', s.shipperOptions.map((x, j) => (j === i ? { ...x, shipperCode: e.target.value } : x)))} /></td>
                        <td><input className="input mono" aria-label="Option code" value={o.code}
                          onChange={(e) => set('shipperOptions', s.shipperOptions.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)))} /></td>
                        <td><button className="btn btn-ghost icon-btn" type="button" aria-label="Remove option"
                          onClick={() => set('shipperOptions', s.shipperOptions.filter((_, j) => j !== i))}><IconX size={18} /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card" aria-labelledby="s3">
            <div className="card-head">
              <h2 className="h2" id="s3"><span className="step-no">3</span>From — origin warehouse</h2>
              <Link to="/origins" style={{ fontSize: 14, fontWeight: 600 }}>Manage origins</Link>
            </div>
            <p className="hint">Each From country maps to an <span className="mono">Origin</span> in the order.</p>
            <div className="grid g3" style={{ gap: 12 }}>
              {origins.data.map((o) => {
                const on = s.from.includes(o.countryCode);
                return (
                  <button key={o.countryCode} className="origin" type="button" aria-pressed={on} onClick={() => set('from', toggle(s.from, o.countryCode))}>
                    <span className="box" aria-hidden="true">{on && <span style={{ color: '#fff', display: 'flex' }}><IconCheck /></span>}</span>
                    <CC cc={o.countryCode} />
                    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                      <span className="name">{countryName(o.countryCode)}</span>
                      {o.originCode
                        ? <span className="code" title={o.originCode}>{o.originCode}</span>
                        : <span className="code missing"><IconAlert size={12} />No Origin set</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="card" aria-labelledby="s4">
            <div className="card-head">
              <h2 className="h2" id="s4"><span className="step-no">4</span>To — destination countries</h2>
              <Link to="/addresses" style={{ fontSize: 14, fontWeight: 600 }}>Address book</Link>
            </div>
            <p className="hint">One test address per country is used as <span className="mono">DeliveryAddress</span> and <span className="mono">InvoiceAddress</span>.</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {toCountries.map((cc) => {
                const ok = hasAddress(cc);
                return (
                  <button key={cc} className="chip" type="button" aria-pressed={s.to.includes(cc)} onClick={() => set('to', toggle(s.to, cc))}
                    title={ok ? undefined : 'No address in the address book'}>
                    <span className="mono" style={{ fontWeight: 700 }}>{cc}</span>{COUNTRY_NAMES[cc] ?? cc}
                    {!ok && <><span className="warn-ico" style={{ display: 'flex' }}><IconAlert size={13} /></span><span className="sr-only">(no address)</span></>}
                  </button>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: 16 }}>
              <button className="btn btn-ghost" type="button" style={{ height: 32, padding: 0 }}
                onClick={() => set('to', toCountries.filter((cc) => EU_COUNTRIES.includes(cc) && hasAddress(cc)))}>Select EU</button>
              <button className="btn btn-ghost" type="button" style={{ height: 32, padding: 0 }} onClick={() => set('to', [])}>Clear</button>
            </div>
          </section>

          <section className="card" aria-labelledby="s5">
            <h2 className="h2" id="s5"><span className="step-no">5</span>Package &amp; order content</h2>
            <div className="grid g5">
              <label className="lbl">Colli<input className="input" type="number" min={1} value={s.colli.count} onChange={(e) => setColli('count', num(e.target.value))} /></label>
              <label className="lbl">Weight (g)<input className="input" type="number" min={0} value={s.colli.weightGrammes} onChange={(e) => setColli('weightGrammes', num(e.target.value))} /></label>
              <label className="lbl">Length (mm)<input className="input" type="number" min={0} value={s.colli.lengthMm} onChange={(e) => setColli('lengthMm', num(e.target.value))} /></label>
              <label className="lbl">Width (mm)<input className="input" type="number" min={0} value={s.colli.widthMm} onChange={(e) => setColli('widthMm', num(e.target.value))} /></label>
              <label className="lbl">Height (mm)<input className="input" type="number" min={0} value={s.colli.heightMm} onChange={(e) => setColli('heightMm', num(e.target.value))} /></label>
            </div>
            <div className="grid g3">
              <label className="lbl">SKU<input className="input mono" value={s.sku} onChange={(e) => set('sku', e.target.value)} /></label>
              <label className="lbl">Quantity<input className="input" type="number" min={1} value={s.quantity} onChange={(e) => set('quantity', num(e.target.value))} /></label>
              <label className="lbl">Customer type
                <select className="input" value={s.b2b ? 'B2B' : 'B2C'} onChange={(e) => set('b2b', e.target.value === 'B2B')}>
                  <option>B2B</option><option>B2C</option>
                </select>
              </label>
            </div>
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label className="check">
                <input type="checkbox" checked={s.invoice.enabled} onChange={(e) => setInvoice('enabled', e.target.checked)} />
                Send <span className="mono">Invoice</span> with the order
              </label>
              {s.invoice.enabled && (
                <div className="grid g4">
                  <label className="lbl">Payment method<input className="input" value={s.invoice.paymentMethodDescription} onChange={(e) => setInvoice('paymentMethodDescription', e.target.value)} /></label>
                  <label className="lbl">Amount incl. tax<input className="input" type="number" step="0.01" min={0} value={s.invoice.amountInclTax} onChange={(e) => setInvoice('amountInclTax', num(e.target.value))} /></label>
                  <label className="lbl">Total tax<input className="input" type="number" step="0.01" min={0} value={s.invoice.totalTax} onChange={(e) => setInvoice('totalTax', num(e.target.value))} /></label>
                  <label className="lbl">Currency<input className="input mono" value={s.invoice.currency} maxLength={3} onChange={(e) => setInvoice('currency', e.target.value.toUpperCase())} /></label>
                </div>
              )}
              <p className="hint"><span className="mono">WebshopFactuurID</span> is generated per order.</p>
            </div>
          </section>

          <section className="card" aria-labelledby="s6">
            <h2 className="h2" id="s6"><span className="step-no">6</span>Execution</h2>
            <div className="grid g3">
              <label className="lbl">Parallel orders
                <select className="input" value={s.concurrency} onChange={(e) => set('concurrency', Number(e.target.value))}>
                  <option value={1}>1 (in sequence)</option><option value={2}>2 at a time</option><option value={3}>3 at a time</option>
                </select>
              </label>
              <div className="lbl">Mode
                <label className="check" style={{ height: 40 }}>
                  <input type="checkbox" checked={s.dryRun} disabled={!meta.data.allowLive} onChange={(e) => set('dryRun', e.target.checked)} />
                  Dry run (mock API, no real orders)
                </label>
              </div>
              {s.dryRun && (
                <label className="lbl">Simulate failures
                  <input className="input mono" placeholder="3:FR, 2:DE, net:AT" value={s.mockFailures} onChange={(e) => set('mockFailures', e.target.value)} />
                </label>
              )}
            </div>
            {!meta.data.allowLive && <p className="hint">Live runs are off on the server. Set <span className="mono">ALLOW_LIVE=true</span> in <span className="mono">.env</span> to enable them.</p>}
            {s.dryRun && <p className="hint"><span className="mono">step:country</span> makes the mock fail that step for that destination (<span className="mono">*</span> = all). <span className="mono">net:CC</span> simulates a timeout on create order.</p>}
          </section>
        </div>

        <aside className="narrow sticky">
          <section className="card" aria-labelledby="sum" style={{ gap: 20 }}>
            <h2 className="h2" id="sum">This run {s.dryRun && <span className="badge queued">Dry run</span>}</h2>
            <div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <span style={{ fontSize: 48, lineHeight: '52px', fontWeight: 700 }}>{n}</span>
                <span style={{ fontSize: 15, color: 'var(--text-2)' }}>orders</span>
              </div>
              <p className="hint">{s.from.length} From × {s.to.length} To = {n} combinations</p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="kv"><span>Carrier</span><span className="mono" style={{ fontWeight: 500 }}>{s.shipperCode || '—'}</span></div>
              <div className="kv"><span>Options</span><span style={{ fontWeight: 500 }}>{options.length}</span></div>
              <div className="kv"><span>From</span><span style={{ fontWeight: 500 }}>{s.from.join(', ') || '—'}</span></div>
              <div className="kv"><span>To</span><span style={{ fontWeight: 500 }}>{s.to.join(', ') || '—'}</span></div>
              <div className="kv"><span>Package</span><span style={{ fontWeight: 500 }}>{s.colli.count} × {(s.colli.weightGrammes / 1000).toLocaleString('nl-NL')} kg</span></div>
              <div className="kv"><span>Parallel</span><span style={{ fontWeight: 500 }}>{s.concurrency}</span></div>
            </div>
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span className="cap">Per order · 4 API calls</span>
              <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: 'var(--text-2)' }}>
                <li><span className="mono">POST /order</span></li>
                <li><span className="mono">POST /order/{'{id}'}/colli</span></li>
                <li><span className="mono">POST …/shippinglabels</span></li>
                <li><span className="mono">GET …/shippinglabels/{'{file}'}</span></li>
              </ol>
            </div>
            {errors.length > 0 && (
              <Notice kind="warn"><b>Can't start yet</b><ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul></Notice>
            )}
            {error && <Notice kind="error">{error}</Notice>}
            <button className="btn btn-primary btn-lg" type="button" disabled={errors.length > 0 || busy} onClick={start}>
              {busy ? 'Starting…' : `Start ${s.dryRun ? 'dry run' : 'test run'} · ${n} orders`}
            </button>
            <button className="btn" type="button" onClick={saveTemplate}>Save as template</button>
          </section>
          <Notice kind="warn">
            {s.dryRun
              ? 'Dry run: no calls go to Monta. Untick Dry run to create real orders.'
              : 'Orders are created in the live system. Use test origins only.'}
          </Notice>
        </aside>
      </div>
    </>
  );
}
