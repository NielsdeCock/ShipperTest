import { config } from '../config.ts';
import type { CallRecord, MontaClient } from './types.ts';

// Dry-run client: same interface as the real one, no network.

/** "3:FR, 2:DE, 1:*" → { FR: 3, DE: 2, '*': 1 }. "net:AT" simulates a timeout on step 1 for AT. */
export function parseMockFailures(spec: string): Record<string, number | 'net'> {
  const out: Record<string, number | 'net'> = {};
  for (const part of spec.split(/[,;\s]+/).filter(Boolean)) {
    const [step, cc] = part.split(':');
    if (!cc) continue;
    out[cc.toUpperCase()] = step === 'net' ? 'net' : Number(step);
  }
  return out;
}

const FAIL_RESPONSES: Record<number, [number, unknown]> = {
  1: [400, { Message: '[Dry run] Simulated: order rejected', Errors: ['Origin is not valid for this shipper'] }],
  2: [400, { Message: '[Dry run] Simulated: colli length exceeds carrier maximum' }],
  3: [422, { Message: '[Dry run] Simulated: shipper option not available for this destination' }],
  4: [404, { Message: '[Dry run] Simulated: label file not found' }],
};

function stepOf(method: string, path: string): number {
  if (method === 'POST' && path === '/order') return 1;
  if (method === 'POST' && path.endsWith('/colli')) return 2;
  if (method === 'POST' && path.includes('/shippinglabels')) return 3;
  if (method === 'GET' && path.includes('/shippinglabels/')) return 4;
  return 0; // GET /order/{nr} existence check
}

export function minimalPdf(text: string): Buffer {
  const content = `BT /F1 18 Tf 40 380 Td (${text.replace(/[()\\]/g, '')}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 288 432] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

export function createMockClient(opts: { to: string; failures: string }): MontaClient {
  const failures = parseMockFailures(opts.failures);
  const fail = failures[opts.to] ?? failures['*'];
  let netFailed = false;

  return {
    async send(method, path, body) {
      const url = config.apiBase + path;
      const requestBody = body === undefined ? null : JSON.stringify(body);
      const durationMs = 120 + Math.round(Math.random() * 480);
      await new Promise((r) => setTimeout(r, durationMs));
      const base = { method, url, requestBody, durationMs, networkError: null, bytes: null };
      const json = (status: number, data: unknown): CallRecord => ({
        ...base, status, contentType: 'application/json', responseBody: JSON.stringify(data),
      });

      const step = stepOf(method, path);
      const nr = decodeURIComponent(path.split('/')[2] ?? '');

      if (fail === 'net' && step === 1 && !netFailed) {
        netFailed = true;
        return { ...base, status: null, contentType: null, responseBody: '', networkError: 'Timeout after 30s (simulated)' };
      }
      if (typeof fail === 'number' && fail === step) {
        const [status, data] = FAIL_RESPONSES[step];
        return json(status, data);
      }

      switch (step) {
        case 0:
          return json(404, { Message: `Order ${nr} not found` });
        case 1:
          return json(201, { WebshopOrderId: nr || (body as any)?.WebshopOrderId, Status: 'Received' });
        case 2:
          return json(201, { Number: (body as any)?.Number ?? 1 });
        case 3: {
          const type = new URL(url).searchParams.get('labelfiletype') ?? 'pdf';
          return json(201, [{ FileName: `${nr}_1.${type}`, TrackAndTraceCode: `MOCK${Date.now() % 1e8}`, ShipperCode: 'DRYRUN' }]);
        }
        case 4: {
          const isZpl = path.endsWith('.zpl');
          const bytes = isZpl
            ? Buffer.from(`^XA^FO50,50^ADN,36,20^FDDRY RUN ${nr}^FS^XZ`)
            : minimalPdf(`DRY RUN ${nr}`);
          return {
            ...base, status: 200, bytes,
            contentType: isZpl ? 'text/plain' : 'application/pdf',
            responseBody: isZpl ? bytes.toString('utf8') : `<binary ${bytes.length} bytes, application/pdf>`,
          };
        }
      }
      return json(404, { Message: 'Not found' });
    },
  };
}
