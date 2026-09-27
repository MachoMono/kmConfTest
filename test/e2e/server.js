// Seeded, isolated GitWiki instance for browser tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../server/app.js';
import { seed } from '../../scripts/seed-data.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitwiki-e2e-'));
const app = await createApp({ dataDir: dir, adminPassword: 'admin-password-1', quiet: true, syncIntervalSec: 0 });
await seed(app);
await app.listen(Number(process.env.E2E_PORT || 4799), '127.0.0.1');
console.log('e2e server ready', app.url);
const stop = async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
