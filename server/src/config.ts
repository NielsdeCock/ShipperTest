import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';

const env = (k: string, d = '') => (process.env[k] ?? d).trim();

// The embedded database must not live in a synced folder (OneDrive locks/rewrites its files).
const localData = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share'), 'carrier-test-portal');

export const config = {
  apiBase: env('MONTA_API_BASE', 'https://api-v6.monta.nl').replace(/\/+$/, ''),
  user: env('MONTA_USER'),
  password: env('MONTA_PASSWORD'),
  token: env('MONTA_TOKEN'),
  allowLive: env('ALLOW_LIVE') === 'true',
  databaseUrl: env('DATABASE_URL'),
  pgliteDir: path.resolve(env('PGLITE_DIR') || path.join(localData, 'pglite')),
  port: Number(env('PORT', '3001')),
  labelsDir: path.resolve(env('LABELS_DIR', 'labels')),
  timeoutMs: 30_000,
};

export const hasCredentials = () => Boolean(config.token || (config.user && config.password));

export function authHeader(): string | undefined {
  if (config.token) return `Bearer ${config.token}`;
  if (config.user && config.password) {
    return 'Basic ' + Buffer.from(`${config.user}:${config.password}`).toString('base64');
  }
  return undefined;
}
