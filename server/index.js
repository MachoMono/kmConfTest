#!/usr/bin/env node
import { createApp } from './app.js';

const app = await createApp();
await app.listen();
console.log(`GitWiki listening on ${app.url}  (data: ${app.cfg.dataDir})`);
const shutdown = async () => { await app.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
