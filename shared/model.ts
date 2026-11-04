// Types and builders shared by the backend and the frontend.

export const COUNTRY_NAMES: Record<string, string> = {
  NL: 'Netherlands', BE: 'Belgium', DE: 'Germany', FR: 'France', AT: 'Austria',
  LU: 'Luxembourg', DK: 'Denmark', ES: 'Spain', IT: 'Italy', PL: 'Poland',
  SE: 'Sweden', GB: 'United Kingdom', IE: 'Ireland', PT: 'Portugal', CZ: 'Czechia',
  FI: 'Finland', HU: 'Hungary', SK: 'Slovakia', SI: 'Slovenia', HR: 'Croatia',
  RO: 'Romania', BG: 'Bulgaria', GR: 'Greece', EE: 'Estonia', LV: 'Latvia',
  LT: 'Lithuania', CH: 'Switzerland', NO: 'Norway', US: 'United States', CA: 'Canada',
};

export const EU_COUNTRIES = [
  'AT', 'BE', 'BG', 'HR', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT',
  'LV', 'LT', 'LU', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
];

export const countryName = (cc: string) => COUNTRY_NAMES[cc] ?? cc;

export interface Address {
  countryCode: string;
  company: string;
  street: string;
  houseNumber: string;
  houseNumberAddition: string;
  postalCode: string;
  city: string;
  /** Required by Monta for some countries (e.g. US), e.g. "NY". */
  state: string;
  phone: string;
  email: string;
}

export interface AddressDefaults {
  company: string;
  /** Contact person; carriers require a consignee name. */
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
}

export interface Origin {
  countryCode: string;
  originCode: string;
}

export interface ShipperOption {
  shipperCode: string;
  code: string;
}

export type LabelFileType = 'pdf' | 'zpl';

/** Sent as `Invoice` on every order (needed for customs on non-EU destinations). */
export interface InvoiceSettings {
  enabled: boolean;
  paymentMethodDescription: string;
  amountInclTax: number;
  totalTax: number;
  currency: string;
}

export interface RunSettings {
  shipperCode: string;
  labelFileType: LabelFileType;
  orderPrefix: string;
  shipperOptions: ShipperOption[];
  from: string[];
  to: string[];
  colli: { count: number; weightGrammes: number; lengthMm: number; widthMm: number; heightMm: number };
  sku: string;
  quantity: number;
  b2b: boolean;
  invoice: InvoiceSettings;
  concurrency: number;
  dryRun: boolean;
  /** Dry run only: e.g. "3:FR, 2:DE, 1:*" makes the mock fail that step for that destination. */
  mockFailures: string;
}

export const DEFAULT_RUN_SETTINGS: RunSettings = {
  shipperCode: '',
  labelFileType: 'zpl',
  orderPrefix: '',
  shipperOptions: [],
  from: [],
  to: [],
  colli: { count: 1, weightGrammes: 2000, lengthMm: 850, widthMm: 100, heightMm: 100 },
  sku: 'TestProduct1',
  quantity: 1,
  b2b: true,
  invoice: { enabled: true, paymentMethodDescription: 'Invoice', amountInclTax: 12.1, totalTax: 2.1, currency: 'EUR' },
  concurrency: 1,
  dryRun: false,
  mockFailures: '',
};

export type StepStatus = 'queued' | 'running' | 'ok' | 'failed' | 'skipped';
export interface StepState {
  status: StepStatus;
  http?: number | null;
}
export type ResultStatus = 'queued' | 'running' | 'ok' | 'failed' | 'skipped';
export type RunStatus = 'running' | 'paused' | 'stopped' | 'done';

export const STEP_NAMES = ['Create order', 'Create colli', 'Request label', 'Fetch label'];
export const STEP_SHORT = ['Order', 'Colli', 'Label', 'Fetch'];

export function deliveryAddress(a: Address, d: AddressDefaults) {
  const n = Number(a.houseNumber);
  return {
    Company: a.company || d.company,
    FirstName: d.firstName,
    LastName: d.lastName,
    Street: a.street,
    HouseNumber: a.houseNumber !== '' && Number.isFinite(n) ? n : a.houseNumber,
    HouseNumberAddition: a.houseNumberAddition ?? '',
    PostalCode: a.postalCode,
    City: a.city,
    ...(a.state ? { State: a.state } : {}),
    CountryCode: a.countryCode,
    PhoneNumber: a.phone || d.phone,
    EmailAddress: a.email || d.email,
  };
}

export function buildOrderBody(
  orderNumber: string,
  origin: string,
  address: Address,
  defaults: AddressDefaults,
  s: RunSettings,
  invoiceId: number = invoiceIdFor(),
) {
  const addr = deliveryAddress(address, defaults);
  const body: Record<string, unknown> = {
    WebshopOrderId: orderNumber,
    Reference: orderNumber,
    Origin: origin,
    ConsumerDetails: {
      DeliveryAddress: addr,
      InvoiceAddress: { ...addr },
      B2B: s.b2b ? 1 : 0,
    },
  };
  const options = s.shipperOptions.filter((o) => o.shipperCode && o.code);
  if (options.length) body.ShipperOptions = options.map((o) => ({ ShipperCode: o.shipperCode, Code: o.code }));
  body.AllowedShippers = [s.shipperCode];
  body.Lines = [{ sku: s.sku, OrderedQuantity: s.quantity, Description: 'Carrier test' }];
  const inv = { ...DEFAULT_RUN_SETTINGS.invoice, ...(s.invoice ?? {}) };
  if (inv.enabled) {
    const excl = round2(inv.amountInclTax - inv.totalTax);
    body.Invoice = {
      PaymentMethodDescription: inv.paymentMethodDescription,
      AmountInclTax: inv.amountInclTax,
      TotalTax: inv.totalTax,
      Paid: true,
      WebshopFactuurID: String(invoiceId),
      Currency: inv.currency,
      Lines: [{
        Quantity: s.quantity,
        Description: 'Carrier test',
        TaxPercentage: excl > 0 ? round2((inv.totalTax / excl) * 100) : 0,
        TaxAmount: inv.totalTax,
        TaxDescription: 'VAT',
        AmountInclTax: inv.amountInclTax,
        AmountExclTax: excl,
        Sku: s.sku,
        ShippingCost: false,
        Discount: false,
        PaymentCosts: false,
        Reference: orderNumber,
      }],
    };
  }
  return body;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Numeric invoice id (Monta expects an integer, sent as digits): seconds since 2025 plus a random tail, unique per order. */
export function invoiceIdFor(d = new Date()) {
  // Monta parses this as a 32-bit int (max 2147483647): seconds since 2025 × 10 stays below that until ~2031.
  return Math.floor((d.getTime() - Date.UTC(2025, 0, 1)) / 1000) * 10 + Math.floor(Math.random() * 10);
}

export function buildColliBody(s: RunSettings) {
  return {
    Number: s.colli.count,
    WeightGrammes: s.colli.weightGrammes,
    LengthMm: s.colli.lengthMm,
    WidthMm: s.colli.widthMm,
    HeightMm: s.colli.heightMm,
  };
}

export function mmdd(d = new Date()) {
  return String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}

export function orderNumberBase(prefix: string, from: string, to: string, d = new Date()) {
  return `${prefix}-${mmdd(d)}-${from}-${to}`;
}

export function orderNumber(base: string, seq: number) {
  return `${base}-${String(seq).padStart(2, '0')}`;
}

/** Problems that block starting a run. Empty list = OK to start. */
export function validateRun(
  s: RunSettings,
  origins: Origin[],
  addresses: Address[],
): string[] {
  const errors: string[] = [];
  if (!s.shipperCode.trim()) errors.push('Shipper code is required.');
  if (!s.orderPrefix.trim()) errors.push('Order prefix is required.');
  else if (!/^[A-Za-z0-9]+$/.test(s.orderPrefix.trim())) errors.push('Order prefix may only contain letters and digits.');
  if (!s.from.length) errors.push('Select at least one From country.');
  if (!s.to.length) errors.push('Select at least one To country.');
  for (const cc of s.from) {
    const o = origins.find((x) => x.countryCode === cc);
    if (!o || !o.originCode.trim()) errors.push(`From ${cc} has no Origin code.`);
  }
  for (const cc of s.to) {
    const a = addresses.find((x) => x.countryCode === cc);
    if (!a || !a.street.trim() || !a.postalCode.trim() || !a.city.trim()) errors.push(`To ${cc} has no address.`);
  }
  if (!s.sku.trim()) errors.push('SKU is required.');
  if (!(s.quantity >= 1)) errors.push('Quantity must be at least 1.');
  if (!(s.colli.count >= 1)) errors.push('Colli count must be at least 1.');
  if (!(s.concurrency >= 1 && s.concurrency <= 3)) errors.push('Parallel orders must be 1, 2 or 3.');
  return errors;
}
