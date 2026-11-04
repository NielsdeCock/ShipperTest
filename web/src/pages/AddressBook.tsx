import { useEffect, useRef, useState } from 'react';
import { countryName, deliveryAddress, type Address, type AddressDefaults } from '../../../shared/model.ts';
import { api, getAddresses, getMeta, useLoad } from '../api.ts';
import { CC, IconCheck, Loading, Notice, PageHead, StatusBadge } from '../components/ui.tsx';

interface Stat { countryCode: string; tested: number; ok: number; okLive: number }

const empty = (cc: string): Address => ({
  countryCode: cc, company: '', street: '', houseNumber: '', houseNumberAddition: '', state: '',
  postalCode: '', city: '', phone: '', email: '',
});

export default function AddressBook() {
  const addresses = useLoad(getAddresses);
  const meta = useLoad(getMeta);
  const stats = useLoad(() => api.get<Stat[]>('/addresses/stats'));
  const [defaults, setDefaults] = useState<AddressDefaults>();
  const [sel, setSel] = useState<Address>();
  const [search, setSearch] = useState('');
  const [msg, setMsg] = useState<{ kind: 'info' | 'error'; text: string }>();
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (meta.data) setDefaults(meta.data.defaults); }, [meta.data]);
  useEffect(() => {
    if (addresses.data && !sel && addresses.data.length) setSel(addresses.data[0]);
  }, [addresses.data, sel]);

  if (addresses.error) return <Notice kind="error">{addresses.error}</Notice>;
  if (!addresses.data || !defaults) return <Loading />;

  const list = addresses.data.filter((a) => {
    const q = search.trim().toLowerCase();
    return !q || [a.countryCode, countryName(a.countryCode), a.city, a.street].some((v) => v.toLowerCase().includes(q));
  });
  const isNew = sel && !addresses.data.some((a) => a.countryCode === sel.countryCode);
  const field = (k: keyof Address) => ({
    value: sel?.[k] ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setSel((p) => (p ? { ...p, [k]: e.target.value } : p)),
  });

  const saveDefaults = async () => {
    try {
      await api.put('/settings', {
        default_company: defaults.company, default_first_name: defaults.firstName, default_last_name: defaults.lastName,
        default_phone: defaults.phone, default_email: defaults.email });
      setMsg({ kind: 'info', text: 'Defaults saved.' });
    } catch (e: any) { setMsg({ kind: 'error', text: e.message }); }
  };

  const save = async () => {
    if (!sel) return;
    try {
      addresses.setData(await api.put<Address[]>(`/addresses/${sel.countryCode}`, sel));
      setMsg({ kind: 'info', text: `Address for ${sel.countryCode} saved.` });
    } catch (e: any) { setMsg({ kind: 'error', text: e.message }); }
  };

  const remove = async () => {
    if (!sel || !window.confirm(`Remove the test address for ${countryName(sel.countryCode)}?`)) return;
    const next = await api.del<Address[]>(`/addresses/${sel.countryCode}`);
    addresses.setData(next);
    setSel(next[0]);
  };

  const addCountry = () => {
    const cc = window.prompt('ISO country code (2 letters), e.g. SE')?.trim().toUpperCase();
    if (!cc) return;
    if (!/^[A-Z]{2}$/.test(cc)) return setMsg({ kind: 'error', text: 'Use a 2-letter ISO country code.' });
    setSel(addresses.data!.find((a) => a.countryCode === cc) ?? empty(cc));
  };

  const importCsv = async (file: File) => {
    try {
      const r = await api.postText<{ imported: string[]; errors: string[]; addresses: Address[] }>('/addresses/import', await file.text());
      addresses.setData(r.addresses);
      setMsg({ kind: r.errors.length ? 'error' : 'info', text: `Imported ${r.imported.length} address(es): ${r.imported.join(', ') || '—'}.${r.errors.length ? ' ' + r.errors.join(' ') : ''}` });
    } catch (e: any) { setMsg({ kind: 'error', text: e.message }); }
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <>
      <PageHead
        title="Test address book"
        lead="One delivery address per destination country. Used for every combination to that country."
        actions={
          <>
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="sr-only" id="csv" onChange={(e) => e.target.files?.[0] && importCsv(e.target.files[0])} />
            <button className="btn" type="button" onClick={() => fileRef.current?.click()}
              title="Header row: CountryCode, Company, Street, HouseNumber, HouseNumberAddition, PostalCode, City, State, PhoneNumber, EmailAddress">Import CSV</button>
            <button className="btn btn-primary" type="button" onClick={addCountry}>+ Add country</button>
          </>
        }
      />
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}

      <section className="card" aria-labelledby="def">
        <div className="card-head">
          <h2 className="h2" id="def">Defaults for all countries</h2>
          <button className="btn btn-sm" type="button" onClick={saveDefaults}>Save defaults</button>
        </div>
        <div className="grid g3">
          <label className="lbl">Company<input className="input" value={defaults.company} onChange={(e) => setDefaults({ ...defaults, company: e.target.value })} /></label>
          <label className="lbl">First name<input className="input" value={defaults.firstName} onChange={(e) => setDefaults({ ...defaults, firstName: e.target.value })} /></label>
          <label className="lbl">Last name<input className="input" value={defaults.lastName} onChange={(e) => setDefaults({ ...defaults, lastName: e.target.value })} /></label>
          <label className="lbl">Phone (fallback)<input className="input" value={defaults.phone} placeholder="+31 …" onChange={(e) => setDefaults({ ...defaults, phone: e.target.value })} /></label>
          <label className="lbl">Email (fallback)<input className="input" type="email" value={defaults.email} placeholder="test@…" onChange={(e) => setDefaults({ ...defaults, email: e.target.value })} /></label>
        </div>
        <p className="hint">Used when an address leaves Company, Phone or Email empty.</p>
      </section>

      <div className="split">
        <section className="card flush wide" aria-labelledby="list" style={{ flex: '2 1 600px' }}>
          <div className="card-head">
            <h2 className="h2" id="list">Addresses <small>· {addresses.data.length} countries</small></h2>
            <input className="input" placeholder="Search country or city" aria-label="Search addresses" style={{ maxWidth: 240 }} value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="tbl-wrap">
            <table className="tbl" style={{ minWidth: 760 }}>
              <thead><tr><th>Country</th><th>Street</th><th>No.</th><th>Postal code</th><th>City</th><th>State</th><th>Status</th></tr></thead>
              <tbody>
                {list.map((a) => {
                  const st = stats.data?.find((x) => x.countryCode === a.countryCode);
                  return (
                    <tr key={a.countryCode} className={`clickable${sel?.countryCode === a.countryCode ? ' selected' : ''}`} onClick={() => setSel(a)}>
                      <td className="nowrap">
                        <button type="button" className="btn-ghost" style={{ border: 0, background: 'none', padding: 0, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 10, color: 'inherit', font: 'inherit' }}
                          aria-label={`Edit ${countryName(a.countryCode)}`}><CC cc={a.countryCode} />{countryName(a.countryCode)}</button>
                      </td>
                      <td className="nowrap">{a.street}</td>
                      <td>{a.houseNumber}{a.houseNumberAddition}</td>
                      <td className="mono nowrap" style={{ fontSize: 13 }}>{a.postalCode}</td>
                      <td className="nowrap">{a.city}</td>
                      <td className="mono">{a.state || '—'}</td>
                      <td>
                        {st?.okLive ? <StatusBadge status="ok" text="Label OK before" />
                          : st?.ok ? <StatusBadge status="ok" text="Label OK (dry run)" />
                          : st?.tested ? <StatusBadge status="failed" text="No label yet" />
                          : <span className="badge warn">Not tested yet</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {sel && (
          <aside className="card narrow" aria-labelledby="ed">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <CC cc={sel.countryCode} />
              <h2 className="h2" id="ed">{countryName(sel.countryCode)}{isNew && <small> · new</small>}</h2>
            </div>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
              <label className="lbl" style={{ gridColumn: 'span 3' }}>Street<input className="input" {...field('street')} /></label>
              <label className="lbl">No.<input className="input" {...field('houseNumber')} /></label>
              <label className="lbl" style={{ gridColumn: 'span 2' }}>Postal code<input className="input mono" {...field('postalCode')} /></label>
              <label className="lbl" style={{ gridColumn: 'span 2' }}>City<input className="input" {...field('city')} /></label>
              <label className="lbl" style={{ gridColumn: 'span 2' }}>Addition<input className="input" {...field('houseNumberAddition')} /></label>
              <label className="lbl" style={{ gridColumn: 'span 2' }}>State <small>US etc.</small><input className="input mono" placeholder="e.g. NY" {...field('state')} /></label>
              <label className="lbl" style={{ gridColumn: 'span 2' }}>Company<input className="input" placeholder={defaults.company} {...field('company')} /></label>
              <label className="lbl" style={{ gridColumn: 'span 2' }}>Phone<input className="input" placeholder={defaults.phone || 'default'} {...field('phone')} /></label>
              <label className="lbl" style={{ gridColumn: 'span 2' }}>Email<input className="input" placeholder={defaults.email || 'default'} {...field('email')} /></label>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span className="cap">Sent as DeliveryAddress</span>
              <pre className="code">{JSON.stringify(deliveryAddress(sel, defaults), null, 2)}</pre>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary" type="button" style={{ flex: 1 }} onClick={save}><IconCheck />Save</button>
              {!isNew && <button className="btn" type="button" onClick={remove}>Remove</button>}
            </div>
          </aside>
        )}
      </div>
    </>
  );
}
