import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../helpers.js';
import { joinFrontmatter } from '../../shared/doc.js';
import { newId } from '../../server/pages.js';
import { now } from '../../server/db.js';

const N = 2000;
let t, bob, ids = [];
const WORDS = 'service api database cache queue billing ledger auth deploy runbook incident policy review latency throughput cluster region failover backup restore metrics alert dashboard'.split(' ');

before(async () => {
  t = await startApp();
  bob = await t.as('bob');
  // bulk-create N pages in one commit (as an import would), then index them
  const writes = [];
  let seed = 1;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < N; i++) {
    const id = newId() + i;
    ids.push(id);
    const words = Array.from({ length: 180 }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(' ');
    const links = Array.from({ length: 3 }, () => `[[Perf Page ${Math.floor(rand() * N)}]]`).join(' ');
    writes.push({ path: `spaces/ENG/perf-page-${i}.md`, content: joinFrontmatter({ id, title: `Perf Page ${i}`, tags: [WORDS[i % WORDS.length], 'perf'], created: now() },
      `## Overview\n\n${words}\n\nSee ${links}.\n\n## Details\n\n${words.split(' ').reverse().join(' ')} unique${i}\n`) });
  }
  const t0 = Date.now();
  await t.app.git.commit({ writes, message: 'bulk', author: t.app.users.authorOf(t.users.alice) });
  const r = await t.app.indexer.rebuild();
  console.log(`# indexed ${r.pages} pages in ${Date.now() - t0} ms`);
});
after(async () => { await t.stop(); });

async function timeIt(n, fn) {
  const times = [];
  for (let i = 0; i < n; i++) { const t0 = performance.now(); await fn(i); times.push(performance.now() - t0); }
  times.sort((a, b) => a - b);
  return { p50: times[Math.floor(n * 0.5)], p95: times[Math.floor(n * 0.95)] };
}

test('[F:performance] latency budgets at 2,000+ pages', async () => {
  const search = await timeIt(40, (i) => bob.ok('GET', `/api/v1/search?q=${WORDS[i % WORDS.length]}+unique${i * 7}`));
  const view = await timeIt(40, (i) => bob.ok('GET', `/api/v1/pages/${ids[i * 13]}`));
  const suggest = await timeIt(40, (i) => bob.ok('GET', `/api/v1/suggest/pages?q=perf+page+${i}`));
  const rag = await timeIt(10, (i) => bob.ok('GET', `/api/v1/graphrag/query?q=${encodeURIComponent('how to restore backup after failover ' + i)}`));
  const save = await timeIt(10, (i) => bob.ok('PUT', `/api/v1/pages/${ids[i]}`, { markdown: `edited ${i} [[Perf Page 1]]` }));
  const fmt = (o) => `p50 ${o.p50.toFixed(1)} ms / p95 ${o.p95.toFixed(1)} ms`;
  console.log(`# search ${fmt(search)}\n# page view ${fmt(view)}\n# suggest ${fmt(suggest)}\n# graphrag ${fmt(rag)}\n# save ${fmt(save)}`);
  assert.ok(search.p95 < 150, `search p95 ${search.p95}`);
  assert.ok(view.p95 < 150, `view p95 ${view.p95}`);
  assert.ok(suggest.p95 < 100, `suggest p95 ${suggest.p95}`);
  assert.ok(rag.p95 < 1500, `graphrag p95 ${rag.p95}`);
  assert.ok(save.p95 < 1000, `save p95 ${save.p95}`);
  const g = await timeIt(3, () => bob.ok('GET', '/api/v1/graph?tags=0'));
  console.log(`# full graph ${fmt(g)}`);
  assert.ok(g.p95 < 3000);
});
