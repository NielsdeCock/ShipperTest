import fs from 'node:fs';
import pg from 'pg';
import { config } from './config.ts';

// One tiny interface over node-postgres (real server) and PGlite (embedded fallback).
interface Driver {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

let driver: Driver;

export async function initDb() {
  if (config.databaseUrl) {
    const pool = new pg.Pool({ connectionString: config.databaseUrl });
    driver = { query: (sql, params) => pool.query(sql, params as any[]) };
    console.log('[db] Postgres', config.databaseUrl.replace(/:[^:@/]+@/, ':***@'));
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    fs.mkdirSync(config.pgliteDir, { recursive: true });
    const lite = new PGlite(config.pgliteDir);
    driver = { query: (sql, params) => lite.query(sql, params as any[]) };
    // Close cleanly on stop/restart (tsx watch, Ctrl+C); a hard kill can corrupt the data dir.
    const close = async () => {
      try { await lite.close(); } finally { process.exit(0); }
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    console.log('[db] embedded PGlite at', config.pgliteDir);
  }
  await migrate();
  await seed();
}

export async function query<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await driver.query(sql, params)).rows as T[];
}

export async function one<T = any>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await query<T>(sql, params))[0];
}

async function migrate() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS origins (
      country_code TEXT PRIMARY KEY,
      origin_code TEXT NOT NULL DEFAULT ''
    )`,
    `CREATE TABLE IF NOT EXISTS addresses (
      country_code TEXT PRIMARY KEY,
      company TEXT NOT NULL DEFAULT '',
      street TEXT NOT NULL DEFAULT '',
      house_number TEXT NOT NULL DEFAULT '',
      house_number_addition TEXT NOT NULL DEFAULT '',
      postal_code TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT ''
    )`,
    `ALTER TABLE addresses ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT ''`,
    `UPDATE addresses SET state = 'NY' WHERE country_code = 'US' AND state = ''`,
    // Destinations added after the first seed.
    `INSERT INTO addresses (country_code, street, house_number, postal_code, city) VALUES
      ('GB', 'Downing Street', '10', 'SW1A 2AA', 'London'),
      ('SE', 'Drottninggatan', '1', '111 51', 'Stockholm')
      ON CONFLICT DO NOTHING`,
    `INSERT INTO addresses (country_code, street, house_number, postal_code, city, state) VALUES
      ('CA', 'Wellington Street', '111', 'K1A 0A9', 'Ottawa', 'ON')
      ON CONFLICT DO NOTHING`,
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    `INSERT INTO settings (key, value) VALUES ('default_first_name', 'Carrier'), ('default_last_name', 'Test') ON CONFLICT DO NOTHING`,
    `CREATE TABLE IF NOT EXISTS templates (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      settings JSON NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS runs (
      id SERIAL PRIMARY KEY,
      shipper_code TEXT NOT NULL,
      settings JSON NOT NULL,
      dry_run BOOLEAN NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS results (
      id SERIAL PRIMARY KEY,
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      from_cc TEXT NOT NULL,
      to_cc TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT '',
      order_number TEXT,
      seq INTEGER,
      status TEXT NOT NULL,
      steps JSON NOT NULL,
      failed_step INTEGER,
      http_status INTEGER,
      error TEXT,
      label_path TEXT,
      label_file_name TEXT,
      order_body JSON,
      colli_body JSON,
      override JSON,
      retry_of INTEGER REFERENCES results(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS results_run ON results(run_id)`,
    `CREATE INDEX IF NOT EXISTS results_order ON results(order_number)`,
    `CREATE TABLE IF NOT EXISTS api_calls (
      id SERIAL PRIMARY KEY,
      result_id INTEGER NOT NULL REFERENCES results(id) ON DELETE CASCADE,
      run_id INTEGER NOT NULL,
      step INTEGER NOT NULL,
      purpose TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      method TEXT NOT NULL,
      url TEXT NOT NULL,
      request_body TEXT,
      http_status INTEGER,
      response_body TEXT,
      content_type TEXT,
      duration_ms INTEGER NOT NULL,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS api_calls_result ON api_calls(result_id)`,
    `CREATE INDEX IF NOT EXISTS api_calls_run ON api_calls(run_id)`,
  ];
  for (const s of statements) await query(s);
}

const SEED_ADDRESSES: [string, string, string, string, string][] = [
  ['NL', 'Nieuwe Noord', '4', '1621 EN', 'Hoorn'],
  ['BE', 'Grote Markt', '1', '1000', 'Brussel'],
  ['DE', 'Unter den Linden', '1', '10117', 'Berlin'],
  ['FR', 'Rue de Rivoli', '1', '75001', 'Paris'],
  ['AT', 'Stephansplatz', '1', '1010', 'Wien'],
  ['LU', 'Place Guillaume II', '1', '1648', 'Luxembourg'],
  ['DK', 'Rådhuspladsen', '1', '1550', 'København'],
  ['ES', 'Calle Mayor', '1', '28013', 'Madrid'],
  ['IT', 'Via del Corso', '1', '00186', 'Roma'],
  ['PL', 'ul. Marszałkowska', '1', '00-624', 'Warszawa'],
  ['US', 'Fifth Avenue', '350', '10118', 'New York'], // state NY is set in migrate()
  ['GB', 'Downing Street', '10', 'SW1A 2AA', 'London'],
  ['SE', 'Drottninggatan', '1', '111 51', 'Stockholm'],
];

// Test warehouses (From countries). UK uses its ISO code GB.
const SEED_ORIGINS: [string, string][] = [
  ['NL', 'ShipperTest NL'],
  ['DE', 'ShipperTest DE'],
  ['FR', 'ShipperTest FR'],
  ['GB', 'ShipperTest UK'],
  ['US', 'ShipperTest US'],
];

async function seed() {
  const seeded = await one(`SELECT value FROM settings WHERE key = 'seeded'`);
  if (seeded) return;
  for (const [cc, street, no, pc, city] of SEED_ADDRESSES) {
    await query(
      `INSERT INTO addresses (country_code, street, house_number, postal_code, city)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [cc, street, no, pc, city],
    );
  }
  for (const [cc, origin] of SEED_ORIGINS) {
    await query(`INSERT INTO origins (country_code, origin_code) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [cc, origin]);
  }
  const defaults: Record<string, string> = {
    default_company: 'Monta Carrier Test',
    default_phone: '',
    default_email: '',
    concurrency: '1',
    seeded: '1',
  };
  for (const [k, v] of Object.entries(defaults)) {
    await query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [k, v]);
  }
}
