import { authHeader, config } from '../config.ts';
import type { CallRecord, MontaClient } from './types.ts';

const TEXT_TYPES = /json|text|xml|html|zpl/i;

export function createMontaClient(): MontaClient {
  return {
    async send(method, path, body) {
      const url = config.apiBase + path;
      const requestBody = body === undefined ? null : JSON.stringify(body);
      const headers: Record<string, string> = { Accept: 'application/json, application/pdf, */*' };
      const auth = authHeader();
      if (auth) headers.Authorization = auth;
      if (requestBody !== null) headers['Content-Type'] = 'application/json';

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), config.timeoutMs);
      const started = Date.now();
      try {
        const res = await fetch(url, { method, headers, body: requestBody ?? undefined, signal: ctrl.signal });
        const buf = Buffer.from(await res.arrayBuffer());
        const contentType = res.headers.get('content-type');
        const isText = !contentType || TEXT_TYPES.test(contentType);
        return {
          method, url, requestBody,
          status: res.status,
          contentType,
          responseBody: isText ? buf.toString('utf8') : `<binary ${buf.length} bytes, ${contentType}>`,
          bytes: buf,
          durationMs: Date.now() - started,
          networkError: null,
        } satisfies CallRecord;
      } catch (e: any) {
        const msg =
          e?.name === 'AbortError'
            ? `Timeout after ${config.timeoutMs / 1000}s`
            : [e?.message, e?.cause?.code ?? e?.cause?.message].filter(Boolean).join(': ');
        return {
          method, url, requestBody,
          status: null,
          contentType: null,
          responseBody: '',
          bytes: null,
          durationMs: Date.now() - started,
          networkError: msg || 'Network error',
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
