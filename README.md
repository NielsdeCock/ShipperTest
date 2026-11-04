# Carrier Test Portal (Monta API v6)

Internal tool for testing a new carrier. You pick the From countries (origins), the To countries
(test addresses), a shipper code and optional shipper options. For every From → To pair the tool creates
one order through the Monta REST API v6 and tries to get a shipping label. The results screen shows,
per pair, whether a label came back and, if not, which step failed and the API's message.

- **Backend:** Node + TypeScript + Express (`server/`). All Monta calls go through the backend.
  Credentials never reach the browser.
- **Frontend:** React + Vite (`web/`).
- **Database:** Postgres. If `DATABASE_URL` is empty, the app uses an embedded Postgres
  ([PGlite](https://pglite.dev), runs in-process, no install) stored in `%LOCALAPPDATA%/carrier-test-portal/pglite`, outside OneDrive on purpose.
- **Labels:** saved to `labels/<runId>/<orderNumber>.pdf` (or `.zpl`).

## 1. Setup

Requires Node 20 or later.

```bash
npm install
cp .env.example .env
```

Edit `.env`:

| Variable | Meaning |
|---|---|
| `MONTA_API_BASE` | `https://api-v6.monta.nl` |
| `MONTA_USER`, `MONTA_PASSWORD` | Monta REST API user. Sent as HTTP Basic auth. |
| `MONTA_TOKEN` | Optional. If set, it is sent as `Authorization: Bearer …` instead of Basic auth. |
| `ALLOW_LIVE` | `false` (default) refuses every real run, so only dry runs are possible. Set to `true` to create real orders. |
| `DATABASE_URL` | e.g. `postgres://user:pass@localhost:5432/carrier_test`. Leave empty for the embedded database. |
| `PGLITE_DIR` | Folder for the embedded database (default `%LOCALAPPDATA%/carrier-test-portal/pglite`). Never inside OneDrive: syncing corrupts it. |
| `PORT` | API port (default `3001`). |
| `LABELS_DIR` | Where label files go (default `labels`). |

Tables are created automatically on first start. The first start also seeds the 10 test addresses
(incl. US) and the origins (`ShipperTest NL/DE/FR/UK/US`; UK uses the ISO code `GB`). Changes to `.env` restart the API automatically in `npm run dev`.

## 2. Start the app

```bash
npm run dev        # API on :3001 + frontend on http://localhost:5173
```

Production-style (one process, serves the built frontend):

```bash
npm run build
npm start          # http://localhost:3001
```

## 3. Dry run (no calls to Monta)

1. Open http://localhost:5173 → **New test run**.
2. Fill in a shipper code, select From and To countries.
3. Tick **Dry run** (off by default; locked on while `ALLOW_LIVE=false`).
4. Optional: in **Simulate failures**, enter something like `3:FR, 2:DE, net:AT`:
   - `3:FR`: step 3 (request label) fails for destination FR
   - `2:*`: step 2 fails for every destination
   - `net:AT`: the first `POST /order` for AT times out, which tests the network retry
5. Click **Start dry run**. The mock answers all 4 calls with realistic delays and writes a
   placeholder PDF/ZPL label, so the whole flow (progress, results, detail, CSV, zip) can be tested.

## 4. Live run

1. Fill in `MONTA_USER`/`MONTA_PASSWORD` and set `ALLOW_LIVE=true` in `.env`. Restart.
2. Check **Origins**: only test warehouses.
3. Leave **Dry run** unticked (the default). Start asks for confirmation: these are real orders.

## API flow per pair

Calls run in order. The first failure stops the pair, and the remaining steps are marked **Skipped**.

| Step | Call |
|---|---|
| 1 · Create order | `GET /order/{nr}` (is the number free? 404 = yes, otherwise seq+1), then `POST /order` |
| 2 · Create colli | `POST /order/{nr}/colli` |
| 3 · Request label | `POST /order/{nr}/shippinglabels?labelfiletype=pdf\|zpl` (no body) |
| 4 · Fetch label | `GET /order/{nr}/shippinglabels/{FileName}/` (FileName as returned by step 3, e.g. `…_Label_1_….txt` for ZPL; trailing slash required by Monta) |

- Order number: `{prefix}-{MMDD}-{FROM}-{TO}-{seq}`, e.g. `CT-1102-NL-DE-01`. A retry always creates
  a new order with the next seq.
- Every call is stored with method, URL, request body, HTTP status, response body and duration.
  See **Pair detail → API trace**.
- Step 3 answered with code 42 ("Order is not yet verified") is retried every 10 s, up to 12 times
  (2 min), because Monta verifies a new order shortly after it is created.
- Timeout 30 s per call. Retried once on network errors and timeouts only, never on an HTTP response.
  If a timed-out `POST /order` was in fact processed by Monta, the tool checks `GET /order/{nr}` and
  continues with that order instead of failing on a duplicate.
- **FILENAME** is taken from the step 3 response: the first `FileName`/`LabelFileName`/`Name`-like
  field, or a string ending in `.pdf`/`.zpl`. If none is found, step 4 fails and shows the raw step 3
  response. Check the first real responses in the trace to confirm the structure.
- Step 4 accepts a raw PDF/ZPL or base64 label content inside JSON.
- The order contains an `Invoice` block (payment method, amount incl. tax, tax, currency, generated
  `WebshopFactuurID`), editable per run. `InvoiceAddress` is sent as an object with the same address
  (Monta rejects an array).
- Server restart during a run: the pair that was running is marked failed ("Interrupted"). Check that
  order in Monta. Queued pairs wait. Press **Resume** on the run.

## Project layout

```
shared/model.ts         types + order/colli/address builders (used by server and web)
server/src/
  config.ts db.ts       .env, Postgres/PGlite, schema + seed
  monta/client.ts       real client (auth, 30 s timeout)
  monta/mock.ts         dry-run client
  monta/labels.ts       FILENAME + label extraction
  runner.ts             queue (1–3 parallel), pause/stop, the 4 steps
  store.ts              data access + live events (SSE)
  routes/api.ts         REST API under /api
web/src/pages/          New run, Runs, Run progress, Results, Pair detail, Address book, Origins, Settings
```
