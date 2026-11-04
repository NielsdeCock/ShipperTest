import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { STEP_NAMES, buildColliBody, countryName, deliveryAddress } from '../../../shared/model.ts';
import { api, copyText, fmtDateTime, pretty, useLoad, type CallRow, type ResultView } from '../api.ts';
import { CC, IconFile, Loading, Notice, PageHead, StatusBadge } from '../components/ui.tsx';

const ENDPOINTS = (nr: string, type: string) => [
  'POST /order',
  `POST /order/${nr}/colli`,
  `POST /order/${nr}/shippinglabels?labelfiletype=${type}`,
  `GET /order/${nr}/shippinglabels/{FILENAME}.${type}`,
];

const PURPOSE: Record<string, string> = {
  'exists-check': 'Order number check',
  'exists-after-retry': 'Check after network retry',
  create: 'Create order',
  colli: 'Create colli',
  'request-label': 'Request label',
  'fetch-label': 'Fetch label',
};

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function toCurl(c: CallRow) {
  const parts = [`curl -X ${c.method} ${shQuote(c.url)}`, `-u "$MONTA_USER:$MONTA_PASSWORD"`];
  if (c.requestBody) parts.push(`-H 'Content-Type: application/json'`, `-d ${shQuote(c.requestBody)}`);
  if (c.purpose === 'fetch-label') parts.push(`-o ${shQuote(c.url.split('/').pop()!.split('?')[0])}`);
  return parts.join(' \\\n  ');
}

const isGood = (c: CallRow) => !c.error && c.httpStatus !== null && (c.httpStatus < 300 || (c.purpose.startsWith('exists') && c.httpStatus === 404));

function CallBox({ c, open }: { c: CallRow; open: boolean }) {
  const good = isGood(c);
  return (
    <details className="call" open={open}>
      <summary style={{ cursor: 'pointer', listStyle: 'revert' }}>
        <span className="call-head" style={{ display: 'inline-flex', width: 'calc(100% - 20px)' }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {PURPOSE[c.purpose] ?? c.purpose}{c.attempt > 1 ? ` · attempt ${c.attempt}` : ''}
          </span>
          <StatusBadge status={good ? 'ok' : 'failed'} text={`${c.error ? 'Network error' : c.httpStatus} · ${c.durationMs} ms`} />
        </span>
      </summary>
      <span className="mono" style={{ fontSize: 12, color: 'var(--muted)', overflowWrap: 'anywhere' }}>{c.method} {c.url}</span>
      {c.error && <Notice kind="error">{c.error}</Notice>}
      <div className="io">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <span className="cap">Request</span>
          <pre className="code">{c.requestBody ? pretty(c.requestBody) : '(no body)'}</pre>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <span className="cap">Response {c.contentType ? <span style={{ textTransform: 'none', fontWeight: 400 }}>· {c.contentType}</span> : null}</span>
          <pre className={`code${good ? '' : ' error'}`}>{c.responseBody ? pretty(c.responseBody) : '(empty)'}</pre>
        </div>
      </div>
      <div><button className="btn btn-sm" type="button" onClick={() => copyText(toCurl(c))}>Copy as cURL</button></div>
    </details>
  );
}

function EditRetryDialog({ view, onClose }: { view: ResultView; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const nav = useNavigate();
  const r = view.result;
  const [order, setOrder] = useState(JSON.stringify(r.orderBody ?? {}, null, 2));
  const [colli, setColli] = useState(JSON.stringify(r.colliBody ?? buildColliBody(view.run.settings), null, 2));
  const [err, setErr] = useState<string>();
  useEffect(() => { ref.current?.showModal(); }, []);

  const submit = async () => {
    let o: unknown, c: unknown;
    try { o = JSON.parse(order); } catch (e: any) { return setErr(`Order JSON: ${e.message}`); }
    try { c = JSON.parse(colli); } catch (e: any) { return setErr(`Colli JSON: ${e.message}`); }
    try {
      const { id } = await api.post<{ id: number }>(`/results/${r.id}/retry`, { order: o, colli: c });
      onClose();
      nav(`/results/${id}`);
    } catch (e: any) { setErr(e.message); }
  };

  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="er-title">
      <div className="dialog-body">
        <h2 className="h2" id="er-title">Edit &amp; retry {r.from} → {r.to}</h2>
        <p className="hint">Creates a new order with the next sequence number. <span className="mono">WebshopOrderId</span> and <span className="mono">Reference</span> are replaced with the new order number.</p>
        <label className="lbl">Order body (step 1)<textarea className="input" rows={16} value={order} onChange={(e) => setOrder(e.target.value)} spellCheck={false} /></label>
        <label className="lbl">Colli body (step 2)<textarea className="input" rows={7} value={colli} onChange={(e) => setColli(e.target.value)} spellCheck={false} /></label>
        {err && <Notice kind="error">{err}</Notice>}
        <div className="actions" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" type="button" onClick={() => ref.current?.close()}>Cancel</button>
          <button className="btn btn-primary" type="button" onClick={submit}>Retry with these bodies</button>
        </div>
      </div>
    </dialog>
  );
}

function LabelPreview({ view }: { view: ResultView }) {
  const r = view.result;
  const [zpl, setZpl] = useState<string>();
  const isPdf = r.labelPath?.endsWith('.pdf');
  useEffect(() => {
    if (r.labelPath && !isPdf) fetch(`/api/results/${r.id}/label`).then((x) => x.text()).then(setZpl);
  }, [r.id, r.labelPath, isPdf]);

  if (!r.labelPath) {
    const why = r.status === 'failed' && r.failedStep ? `Run stopped at step ${r.failedStep} · ${STEP_NAMES[r.failedStep - 1]}`
      : r.status === 'running' || r.status === 'queued' ? 'Not finished yet' : 'No label for this pair';
    return (
      <div className="empty">
        <IconFile size={28} />
        <span style={{ fontSize: 14, fontWeight: 600 }}>No label generated</span>
        <span style={{ fontSize: 13 }}>{why}</span>
      </div>
    );
  }
  return (
    <>
      {isPdf ? <iframe className="label-frame" src={`/api/results/${r.id}/label`} title={`Label ${r.orderNumber}`} />
        : <pre className="code">{zpl ?? 'Loading…'}</pre>}
      <a className="btn btn-sm" href={`/api/results/${r.id}/label?download=1`} style={{ alignSelf: 'flex-start' }}>Download {r.labelPath.split(/[\\/]/).pop()}</a>
    </>
  );
}

export default function PairDetail() {
  const id = Number(useParams().id);
  const nav = useNavigate();
  const { data: view, error, reload } = useLoad(() => api.get<ResultView>(`/results/${id}`), [id]);
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState<string>();

  // Keep refreshing while this pair is still in progress.
  useEffect(() => {
    if (!view || (view.result.status !== 'running' && view.result.status !== 'queued')) return;
    const t = window.setInterval(reload, 1500);
    return () => window.clearInterval(t);
  }, [view, reload]);

  if (error) return <Notice kind="error">{error}</Notice>;
  if (!view) return <Loading />;

  const { result: r, run, calls } = view;
  const s = run.settings;
  const nr = r.orderNumber ?? '{ORDERNR}';
  const endpoints = ENDPOINTS(nr, s.labelFileType);
  const order = r.orderBody as any;
  const addr = order?.ConsumerDetails?.DeliveryAddress ?? (view.address ? deliveryAddress(view.address, view.defaults) : null);

  const headBadge = r.status === 'ok' ? <StatusBadge status="ok" text="Label received" />
    : r.status === 'failed' ? <StatusBadge status="failed" text={`No label · failed at step ${r.failedStep ?? '?'}`} />
    : <StatusBadge status={r.status} />;

  const retry = async () => {
    try {
      const { id: next } = await api.post<{ id: number }>(`/results/${r.id}/retry`);
      nav(`/results/${next}`);
    } catch (e: any) { setMsg(e.message); }
  };

  const copyAll = async () => {
    const text = calls.filter((c) => c.attempt === 1 && !c.purpose.startsWith('exists')).map(toCurl).join('\n\n');
    setMsg((await copyText(text || '# no calls yet')) ? 'cURL commands copied to the clipboard. Set MONTA_USER and MONTA_PASSWORD in your shell first.' : 'Could not access the clipboard.');
  };

  return (
    <>
      <PageHead
        crumbs={<><Link to={`/runs/${run.id}/results`}>Run #{run.id}</Link> / {r.from} → {r.to}</>}
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>{countryName(r.from)} <span aria-hidden="true" style={{ color: '#6B7280' }}>→</span><span className="sr-only">to</span> {countryName(r.to)}</span>
            {headBadge}
          </span>
        }
        lead={<span className="mono" style={{ fontSize: 13 }}>{r.orderNumber ?? 'No order number yet'} · {run.shipperCode}{run.dryRun ? ' · dry run' : ''}</span>}
        actions={
          <>
            <button className="btn" type="button" onClick={copyAll}>Copy as cURL</button>
            <button className="btn" type="button" disabled={!r.orderBody} onClick={() => setEditing(true)}>Edit &amp; retry</button>
            <button className="btn btn-primary" type="button" onClick={retry}>Retry combination</button>
          </>
        }
      />
      {msg && <Notice kind="info">{msg}</Notice>}
      {r.error && r.status === 'failed' && (
        <Notice kind="error"><b>API message (step {r.failedStep}{r.httpStatus ? ` · HTTP ${r.httpStatus}` : ''})</b><pre className="mono" style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', fontSize: 12 }}>{pretty(r.error)}</pre></Notice>
      )}
      {view.attempts.length > 1 && (
        <p className="hint">
          Attempts for this pair:{' '}
          {view.attempts.map((a, i) => (
            <span key={a.id}>{i > 0 && ' · '}{a.id === r.id ? <b className="mono">{a.orderNumber ?? `#${a.id}`}</b> : <Link className="mono" to={`/results/${a.id}`}>{a.orderNumber ?? `#${a.id}`}</Link>} ({a.status}, {fmtDateTime(a.createdAt)})</span>
          ))}
        </p>
      )}

      <div className="split">
        <section className="card wide" aria-labelledby="trace" style={{ gap: 0, padding: '8px 24px' }}>
          <h2 className="h2" id="trace" style={{ padding: '16px 0 8px' }}>API trace</h2>
          {r.steps.map((st, i) => {
            const stepCalls = calls.filter((c) => c.step === i + 1);
            const main = [...stepCalls].reverse().find((c) => !c.purpose.startsWith('exists')) ?? stepCalls[stepCalls.length - 1];
            const label = st.status === 'ok' || st.status === 'failed'
              ? `${main?.error ? 'Network error' : st.http ?? main?.httpStatus ?? ''} · ${stepCalls.reduce((n, c) => n + c.durationMs, 0)} ms`
              : undefined;
            return (
              <div className="trace-step" key={i}>
                <span className={`dot ${st.status}`} aria-hidden="true">{st.status === 'ok' ? '✓' : st.status === 'failed' ? '✕' : i + 1}</span>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div className="call-head">
                      <span style={{ fontWeight: 600, color: st.status === 'skipped' || st.status === 'queued' ? 'var(--muted)' : undefined }}>{i + 1} · {STEP_NAMES[i]}</span>
                      <StatusBadge status={st.status} text={label} />
                    </div>
                    <span className="mono" style={{ fontSize: 12, color: 'var(--muted)', overflowWrap: 'anywhere' }}>
                      {i === 3 && r.labelFileName ? endpoints[3].replace('{FILENAME}', r.labelFileName) : endpoints[i]}
                    </span>
                  </div>
                  {stepCalls.map((c) => <CallBox key={c.id} c={c} open={st.status === 'failed' && c === main} />)}
                </div>
              </div>
            );
          })}
        </section>

        <aside className="narrow">
          <section className="card" aria-labelledby="ord">
            <h2 className="h2" id="ord">Order sent</h2>
            <div className="kv"><span>WebshopOrderId</span><span className="mono" style={{ fontSize: 13 }}>{order?.WebshopOrderId ?? '—'}</span></div>
            <div className="kv"><span>Origin</span><span className="mono" style={{ fontSize: 13 }}>{order?.Origin ?? r.origin}</span></div>
            <div className="kv"><span>AllowedShippers</span><span className="mono" style={{ fontSize: 13 }}>{(order?.AllowedShippers ?? [s.shipperCode]).join(', ')}</span></div>
            <div className="kv"><span>ShipperOptions</span><span className="mono" style={{ fontSize: 13 }}>
              {order?.ShipperOptions?.length ? order.ShipperOptions.map((o: any) => <div key={o.Code}>{o.Code}</div>) : '—'}
            </span></div>
            <div className="kv"><span>Customer</span><span>{order?.ConsumerDetails?.B2B === 0 ? 'B2C' : 'B2B'}</span></div>
            <div className="kv"><span>Invoice</span><span>{order?.Invoice ? `${order.Invoice.AmountInclTax} ${order.Invoice.Currency}` : '—'}</span></div>
            <div className="kv"><span>Colli</span><span>{r.colliBody ? `${r.colliBody.Number} × ${r.colliBody.WeightGrammes} g · ${r.colliBody.LengthMm}×${r.colliBody.WidthMm}×${r.colliBody.HeightMm} mm` : '—'}</span></div>
            {addr && (
              <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="cap">Delivery address</span>
                <span style={{ fontSize: 14, lineHeight: '21px' }}>
                  {addr.Company}<br />{addr.Street} {addr.HouseNumber}{addr.HouseNumberAddition}<br />{addr.PostalCode} {addr.City}<br />
                  <span style={{ display: 'inline-block', marginTop: 4 }}><CC cc={addr.CountryCode} /></span>
                  {(addr.PhoneNumber || addr.EmailAddress) && <><br /><span className="muted" style={{ fontSize: 13 }}>{[addr.PhoneNumber, addr.EmailAddress].filter(Boolean).join(' · ')}</span></>}
                </span>
              </div>
            )}
            {order && (
              <details>
                <summary style={{ cursor: 'pointer', fontSize: 14, fontWeight: 600, color: 'var(--accent)' }}>Show full order JSON</summary>
                <pre className="code" style={{ marginTop: 10 }}>{JSON.stringify(order, null, 2)}</pre>
              </details>
            )}
          </section>
          <section className="card" aria-labelledby="lab">
            <h2 className="h2" id="lab">Shipping label</h2>
            <LabelPreview view={view} />
          </section>
        </aside>
      </div>
      {editing && <EditRetryDialog view={view} onClose={() => setEditing(false)} />}
    </>
  );
}
