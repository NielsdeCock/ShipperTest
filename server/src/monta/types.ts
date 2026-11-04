export interface CallRecord {
  method: string;
  url: string;
  requestBody: string | null;
  status: number | null;
  contentType: string | null;
  /** Response as text (binary responses are summarised, see `bytes`). */
  responseBody: string;
  bytes: Buffer | null;
  durationMs: number;
  /** Set for network errors and timeouts (no HTTP response). */
  networkError: string | null;
}

/** One HTTP attempt. Retrying is the caller's job (see runner.ts). */
export interface MontaClient {
  send(method: 'GET' | 'POST', path: string, body?: unknown): Promise<CallRecord>;
}

export const isOk = (c: CallRecord) => c.status !== null && c.status >= 200 && c.status < 300;

export function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
