// Feature-coverage matrix: every feature in test/features.json must be exercised by at least
// one test tagged [F:<id>] in the unit, API, A/B or E2E suites — and every tag must be known.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('../..', import.meta.url).pathname);
const { features } = JSON.parse(fs.readFileSync(path.join(root, 'test/features.json'), 'utf8'));
const files = [];
for (const dir of ['test/unit', 'test/api', 'test/ab', 'test/e2e']) {
  const d = path.join(root, dir);
  if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) if (/\.(test|spec)\.js$/.test(f)) files.push(path.join(d, f));
}
const tagged = new Map();
for (const f of files) for (const m of fs.readFileSync(f, 'utf8').matchAll(/\[F:([a-z0-9-]+)\]/g)) {
  if (!tagged.has(m[1])) tagged.set(m[1], new Set());
  tagged.get(m[1]).add(path.relative(root, f));
}

test('every feature has at least one test', () => {
  const missing = Object.keys(features).filter(f => !tagged.has(f));
  assert.deepEqual(missing, [], `untested features: ${missing.join(', ')}`);
});

test('every feature tag refers to a known feature', () => {
  const unknown = [...tagged.keys()].filter(t => !features[t]);
  assert.deepEqual(unknown, [], `unknown feature tags: ${unknown.join(', ')}`);
});

test('coverage report', () => {
  const lines = Object.keys(features).map(f => `${f.padEnd(28)} ${[...(tagged.get(f) || [])].join(', ')}`);
  console.log(`# ${Object.keys(features).length} features, ${files.length} test files\n# ` + lines.join('\n# '));
});
