#!/usr/bin/env node
// Seed a demo knowledge base into GITWIKI_DATA (default ./data).
import { createApp } from '../server/app.js';
import { seed } from './seed-data.js';

const app = await createApp({ quiet: false });
if (app.db.get("SELECT 1 FROM spaces WHERE key = 'ENG'")) {
  console.log('Demo content already present.');
} else {
  const { pages } = await seed(app);
  console.log(`Seeded ${Object.keys(pages).length} pages. Demo users: alice/password-alice (KM admin), bob/password-bob, carol/password-carol, dave/password-dave (guest).`);
}
await app.close();
