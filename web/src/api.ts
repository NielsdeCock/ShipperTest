import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address, AddressDefaults, Origin, RunSettings } from '../../shared/model.ts';
import type { CallRow, ResultRow, RunRow } from '../../server/src/store.ts';

export type { CallRow, ResultRow, RunRow };
export type LogCall = CallRow & { pair: string };

export interface Meta {
  apiBase: string;
  hasCredentials: boolean;
  authMethod: string;
  allowLive: boolean;
  labelsDir: string;
  database: string;
  concurrency: number;
  defaults: AddressDefaults;
}

export interface RunView {
  run: RunRow;
  results: ResultRow[];
  log: LogCall[];
  queue: { queued: number; workers: number } | null;
}

export interface ResultView {
  result: ResultRow;
  run: RunRow;
  address: Address | null;
  defaults: AddressDefaults;
  calls: CallRow[];
  attempts: { id: number; orderNumber: string | null; status: string; failedStep: number | null; createdAt: string }[];
}

export interface Template {
  id: number;
  name: string;
  settings: RunSettings;
}

export type RunListItem = RunRow & { pairs: number; ok: number; failed: number };

async function request<T>(method: string, url: string, body?: unknown, raw = false): Promise<T> {
  const res = await fetch('/api' + url, {
    method,
    headers: body !== undefined && !raw ? { 'Content-Type': 'application/json' } : undefined,
    body: body === undefined ? undefined : raw ? (body as string) : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
  postText: <T>(url: string, text: string) => request<T>('POST', url, text, true),
};

export const getOrigins = () => api.get<Origin[]>('/origins');
export const getAddresses = () => api.get<Address[]>('/addresses');
export const getMeta = () => api.get<Meta>('/meta');

export interface ShipperInfo { code: string; description: string; available: boolean }
export interface ShippersView { origins: { name: string; shippers: ShipperInfo[] }[]; error?: string }
export const getShippers = () => api.get<ShippersView>('/shippers');

/** Loads data once and exposes a reload; errors are kept for display. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const reload = useCallback(() => {
    fn().then(setData, (e) => setError(String(e.message ?? e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(reload, [reload]);
  return { data, error, reload, setData };
}

/** Run data that stays current: SSE events trigger a (debounced) refetch. */
export function useRunLive(runId: number) {
  const [view, setView] = useState<RunView>();
  const [error, setError] = useState<string>();
  const timer = useRef<number>();

  const refetch = useCallback(() => {
    api.get<RunView>(`/runs/${runId}`).then((v) => { setView(v); setError(undefined); }, (e) => setError(e.message));
  }, [runId]);

  useEffect(() => {
    refetch();
    const es = new EventSource(`/api/runs/${runId}/events`);
    es.onmessage = () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(refetch, 250);
    };
    // Fallback poll in case the event stream drops (proxies, sleep, ...).
    const poll = window.setInterval(refetch, 10_000);
    return () => {
      es.close();
      window.clearInterval(poll);
      window.clearTimeout(timer.current);
    };
  }, [runId, refetch]);

  return { view, error, refetch };
}

export const fmtTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
export const fmtDateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('nl-NL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

export function pretty(text: string | null | undefined) {
  if (!text) return '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
