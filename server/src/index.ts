import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config, hasCredentials } from './config.ts';
import { initDb } from './db.ts';
import { api } from './routes/api.ts';
import { recoverAfterRestart } from './runner.ts';

await initDb();
await recoverAfterRestart();

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/api', api);

// Production: serve the built frontend (npm run build → dist/web).
const webDist = path.resolve('dist/web');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err?.message ?? String(err) });
});

app.listen(config.port, () => {
  console.log(`[api] http://localhost:${config.port}  →  ${config.apiBase}`);
  console.log(`[api] credentials: ${hasCredentials() ? 'configured' : 'missing'} · live runs: ${config.allowLive ? 'ALLOWED' : 'disabled (dry run only)'}`);
});
