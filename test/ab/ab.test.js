// A/B comparison tests: each pits a baseline (A) against the approach GitWiki ships (B) on the
// same inputs and asserts B is at least as good — and meets an absolute quality bar.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDocument } from '../../server/merge.js';
import { startApp } from '../helpers.js';

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const WORDS = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon'.split(' ');

test('[F:ab-merge] A/B: silent 3-way merge (B) vs last-write-wins (A) on concurrent edits', () => {
  const rand = rng(2026);
  let aKept = 0, bKept = 0, total = 0, bConflictsOnDisjoint = 0;
  for (let iter = 0; iter < 500; iter++) {
    const n = 5 + Math.floor(rand() * 10);
    const paras = Array.from({ length: n }, (_, i) => Array.from({ length: 8 }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(' ') + ` #${i}.`);
    const base = paras.join('\n\n') + '\n';
    const editsA = Math.floor(rand() * 3) + 1, editsB = Math.floor(rand() * 3) + 1;
    const idx = [...Array(n).keys()].sort(() => rand() - 0.5);
    const mine = idx.slice(0, editsA), theirs = idx.slice(editsA, editsA + editsB);
    const apply = (ids, tag) => paras.map((p, i) => ids.includes(i) ? p + ` ${tag}${i}` : p).join('\n\n') + '\n';
    const ours = apply(mine, 'O'), their = apply(theirs, 'T');
    const markers = [...mine.map(i => `O${i}`), ...theirs.map(i => `T${i}`)];
    total += markers.length;
    // A: last write wins -> "ours" overwrites the file
    aKept += markers.filter(m => ours.includes(' ' + m)).length;
    // B: merge
    const r = mergeDocument(base, ours, their);
    bKept += markers.filter(m => r.text.includes(' ' + m)).length;
    if (r.conflicts.length) bConflictsOnDisjoint++;
  }
  const aRate = aKept / total, bRate = bKept / total;
  console.log(`# edits preserved: A (last-write-wins) ${(aRate * 100).toFixed(1)}%  B (merge) ${(bRate * 100).toFixed(1)}%`);
  assert.ok(bRate >= aRate);
  assert.equal(bRate, 1, 'B preserves every non-overlapping edit');
  assert.equal(bConflictsOnDisjoint, 0);
  assert.ok(aRate < 0.8, 'baseline really loses work (sanity check of the benchmark)');
});

// Labelled retrieval set over the seed knowledge base: question -> pages that answer it.
const QUESTIONS = [
  ['What does the billing service depend on?', ['Billing Service', 'Ledger Service', 'Auth Service']],
  ['who owns the ledger', ['Ledger Service', 'Payments Team']],
  ['how do I fail over the database', ['Database Failover Runbook', 'Postgres Cluster']],
  ['invoices are failing what should I do', ['Billing Incident Runbook', 'Billing Service']],
  ['why did we choose event sourcing', ['ADR 001 Use Event Sourcing for Ledger', 'Ledger Service']],
  ['password rules', ['Security Policy']],
  ['what is idempotency', ['Glossary: Idempotency']],
  ['new joiner first steps', ['Onboarding Guide']],
  ['which team runs shared infrastructure', ['Platform Team']],
  ['booking flights for work', ['Travel Policy']],
  ['bank statement reconciliation', ['Ledger Service']],
  ['replication and recovery of postgres', ['Postgres Cluster', 'Database Failover Runbook']],
];

let t, bob;
before(async () => { t = await startApp(); bob = await t.as('bob'); });
after(async () => { await t.stop(); });

const recallAt = (got, want, k) => want.filter(w => got.slice(0, k).includes(w)).length / want.length;

test('[F:ab-retrieval] A/B: hybrid GraphRAG (B) vs keyword search (A) — recall@5', async () => {
  let a = 0, b = 0;
  const rows = [];
  for (const [q, want] of QUESTIONS) {
    const s = await bob.ok('GET', `/api/v1/search?q=${encodeURIComponent(q.replace(/[?]/g, ''))}&limit=5`);
    const ga = s.results.map(r => r.title);
    const r = await bob.ok('GET', `/api/v1/graphrag/query?k=10&q=${encodeURIComponent(q)}`);
    const gb = [...new Set([...r.chunks.map(c => c.title), ...r.entities.filter(e => e.kind === 'page').map(e => e.label)])];
    const ra = recallAt(ga, want, 5), rb = recallAt(gb, want, 5);
    a += ra; b += rb;
    rows.push(`${q.padEnd(44)} A ${ra.toFixed(2)}  B ${rb.toFixed(2)}`);
  }
  a /= QUESTIONS.length; b /= QUESTIONS.length;
  console.log('# ' + rows.join('\n# '));
  console.log(`# mean recall@5: A (keyword) ${a.toFixed(3)}  B (GraphRAG hybrid) ${b.toFixed(3)}`);
  assert.ok(b >= a, `B ${b} < A ${a}`);
  assert.ok(b >= 0.8, `GraphRAG recall@5 ${b} below 0.8`);
});

test('[F:ab-search-boost] A/B: graph+recency boosted ranking (B) vs plain BM25 (A) — MRR', async () => {
  const queries = [['ledger', 'Ledger Service'], ['billing', 'Billing Service'], ['postgres', 'Postgres Cluster'], ['auth', 'Auth Service'], ['payments', 'Payments Team'], ['platform', 'Platform Team']];
  let a = 0, b = 0;
  for (const [q, want] of queries) {
    const u = t.app.users.byUsername('bob');
    const ra2 = t.app.search.query(u, q, { boost: false, log: false, limit: 10 }).results.map(r => r.title);
    const rb2 = t.app.search.query(u, q, { boost: true, log: false, limit: 10 }).results.map(r => r.title);
    const rr = (list) => { const i = list.indexOf(want); return i < 0 ? 0 : 1 / (i + 1); };
    a += rr(ra2); b += rr(rb2);
  }
  a /= queries.length; b /= queries.length;
  console.log(`# MRR: A (BM25) ${a.toFixed(3)}  B (boosted) ${b.toFixed(3)}`);
  assert.ok(b >= a);
  assert.ok(b >= 0.9);
});

test('[F:ab-flag-assignment] A/B assignment splits users stably by rollout percentage', async () => {
  t.app.settings.set('flags', { 'graphrag.answer': { enabled: true, rollout: 50 } });
  const users = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1 }));
  const inB = users.filter(u => t.app.flag('graphrag.answer', u)).length;
  assert.ok(Math.abs(inB - 500) < 60, `50/50 split expected, got ${inB}`);
  const again = users.filter(u => t.app.flag('graphrag.answer', u)).length;
  assert.equal(again, inB);
  t.app.settings.set('flags', {});
});
