import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../helpers.js';

let t, alice, bob;
before(async () => { t = await startApp(); alice = await t.as('alice'); bob = await t.as('bob'); });
after(async () => { await t.stop(); });

test('[F:search] [F:search-filters] full-text search with filters, phrases, sorting and snippets', async () => {
  let r = await bob.ok('GET', '/api/v1/search?q=invoices');
  assert.deepEqual(r.results.slice(0, 2).map(x => x.title).sort(), ['Billing Service', 'Legacy Invoicing']);
  assert.match(r.results.find(x => x.title === 'Billing Service').snippet, /<mark>invoices<\/mark>/);
  r = await bob.ok('GET', '/api/v1/search?q=' + encodeURIComponent('type:Process tag:runbook'));
  assert.deepEqual(r.results.map(x => x.title).sort(), ['Billing Incident Runbook', 'Database Failover Runbook']);
  r = await bob.ok('GET', '/api/v1/search?q=' + encodeURIComponent('replica -failover'));
  assert.ok(r.results.every(x => x.title !== 'Database Failover Runbook'));
  r = await bob.ok('GET', '/api/v1/search?q=' + encodeURIComponent('"double-entry source of truth"'));
  assert.equal(r.results[0].title, 'Ledger Service');
  r = await bob.ok('GET', '/api/v1/search?q=' + encodeURIComponent('space:HR sort:title'));
  assert.deepEqual(r.results.map(x => x.title), ['Onboarding Guide', 'People & HR', 'Security Policy', 'Travel Policy']);
  r = await bob.ok('GET', '/api/v1/search?q=' + encodeURIComponent('author:bob'));
  assert.ok(r.results.some(x => x.title === 'Billing Service 2.0 launched'));
  r = await bob.ok('GET', '/api/v1/search?q=' + encodeURIComponent('in:Runbooks'));
  assert.equal(r.total, 2);
  r = await bob.ok('GET', '/api/v1/search?q=' + encodeURIComponent('#team'));
  assert.deepEqual(r.results.map(x => x.title).sort(), ['Payments Team', 'Platform Team'], 'nested tag prefix matches');
  r = await bob.ok('GET', '/api/v1/search?q=' + encodeURIComponent('kind:blog'));
  assert.equal(r.results[0].kind, 'blog');
  r = await bob.ok('GET', '/api/v1/search?q=idempot');
  assert.equal(r.results[0].title, 'Glossary: Idempotency', 'prefix matching');
  r = await bob.ok('GET', '/api/v1/search?q=' + encodeURIComponent('"unterminated ((( AND'));
  assert.equal(r.status, undefined);
  assert.ok(t.app.db.get("SELECT COUNT(*) AS n FROM search_log").n >= 4, 'searches logged for analytics');
});

test('[F:search-suggest] [F:quick-search] title/alias suggestions', async () => {
  const s = await bob.ok('GET', '/api/v1/suggest/pages?q=led&space=ENG');
  assert.equal(s[0].title, 'Ledger Service');
  const tags = await bob.ok('GET', '/api/v1/suggest/tags?q=run');
  assert.equal(tags[0].tag, 'runbook');
  const users = await bob.ok('GET', '/api/v1/users?q=ali');
  assert.equal(users[0].username, 'alice');
  const person = await bob.ok('GET', '/api/v1/users/alice');
  assert.ok(person.recent.length > 0);
});

test('[F:tag-index] [F:tag-page] [F:nested-tags] tag index with hierarchy and tag page', async () => {
  const tags = await bob.ok('GET', '/api/v1/tags');
  const eng = tags.find(x => x.tag === 'engineering');
  assert.ok(eng.count >= 6);
  assert.equal(eng.description, 'Engineering and technical content.');
  assert.equal(tags.find(x => x.tag === 'team/platform').parent, 'team');
  const page = await bob.ok('GET', '/api/v1/tags/team');
  assert.equal(page.pages.length, 2);
  assert.deepEqual(page.children.sort(), ['team/payments', 'team/platform']);
  const pay = await bob.ok('GET', '/api/v1/tags/payments');
  assert.ok(pay.related.some(r => r.tag === 'engineering'));
});

test('[F:graph] [F:graph-neighbors] [F:pagerank] [F:communities] knowledge graph', async () => {
  const g = await bob.ok('GET', '/api/v1/graph');
  const billing = g.nodes.find(n => n.label === 'Billing Service');
  assert.equal(billing.type, 'System');
  assert.ok(g.nodes.some(n => n.kind === 'tag' && n.label === '#payments'));
  assert.ok(g.nodes.some(n => n.kind === 'person' && n.username === 'alice'));
  assert.ok(g.edges.some(e => e.source === billing.id && e.rel === 'depends_on'));
  assert.ok(g.edges.some(e => e.source === billing.id && e.rel === 'owner'));
  const ledger = g.nodes.find(n => n.label === 'Ledger Service');
  const legacy = g.nodes.find(n => n.label === 'Legacy Invoicing');
  assert.ok(ledger.rank > legacy.rank, 'well-linked pages rank higher');
  const local = await bob.ok('GET', `/api/v1/graph?page=${t.pages['Billing Service'].id}&depth=1&tags=0`);
  assert.ok(local.nodes.length < g.nodes.length && local.nodes.some(n => n.label === 'Ledger Service'));
  const n = await bob.ok('GET', `/api/v1/graph/neighbors/${t.pages['Ledger Service'].id}`);
  assert.ok(n.some(x => x.rel === 'required_by' && x.node.label === 'Billing Service'), 'inverse relation names from ontology');
  assert.ok(n.some(x => x.rel === 'depends_on' && x.node.label === 'Postgres Cluster'));
  const comms = await bob.ok('GET', '/api/v1/graph/communities');
  assert.ok(comms.length >= 2);
  assert.ok(comms.every(c => c.summary && c.pages.length));
});

test('[F:graph-export-jsonld] [F:graph-export-ttl] [F:graph-export-graphml] graph exports', async () => {
  const j = await bob.ok('GET', '/api/v1/graph/export?format=jsonld');
  assert.equal(j['@context'].schema, 'https://schema.org/');
  const billing = j['@graph'].find(x => x['schema:name'] === 'Billing Service');
  assert.equal(billing['@type'], 'gw:System');
  assert.ok(billing['gw:depends_on'].length === 2);
  const ttl = await bob.get('/api/v1/graph/export?format=ttl');
  assert.match(ttl.data, /@prefix gw: /);
  assert.match(ttl.data, /gw:depends_on/);
  const gml = await bob.get('/api/v1/graph/export?format=graphml');
  assert.match(gml.data, /<graphml/);
  assert.match(gml.data, /<data key="rel">depends_on<\/data>/);
  assert.equal((await bob.get('/api/v1/graph/export?format=nope')).status, 400);
});

test('[F:graphrag-hybrid] [F:graphrag-local] [F:graphrag-global] GraphRAG retrieval modes', async () => {
  const q = (s, mode = 'hybrid') => bob.ok('GET', `/api/v1/graphrag/query?mode=${mode}&q=${encodeURIComponent(s)}`);
  let r = await q('What does the Billing Service depend on?');
  const titles = r.chunks.map(c => c.title);
  assert.ok(titles.includes('Billing Service'));
  assert.ok(r.relations.some(x => x.source === 'Billing Service' && x.rel === 'depends_on' && x.target === 'Ledger Service'));
  assert.ok(r.relations.some(x => x.target === 'Auth Service'));
  assert.ok(r.entities.some(e => e.seed && e.label === 'Billing Service'));
  assert.match(r.context, /\[1\] .*\/p\//);
  assert.match(r.context, /Known relations:/);
  r = await q('how do we recover when the primary database fails', 'local');
  assert.ok(r.chunks.slice(0, 3).some(c => c.title === 'Database Failover Runbook' || c.title === 'Postgres Cluster'));
  r = await q('payments', 'global');
  assert.ok(r.communities.length >= 1);
  assert.ok(r.chunks.length > 0);
  r = await q('nightly reconciliation bank statements', 'vector');
  assert.equal(r.chunks[0].title, 'Ledger Service');
  assert.equal(r.chunks[0].anchor, 'reconciliation');
  const post = await bob.ok('POST', '/api/v1/graphrag/query', { query: 'who leads the payments team', answer: true });
  assert.equal(post.answer, null);
  assert.match(post.note, /No LLM configured/);
  assert.ok(post.chunks.some(c => c.title === 'Payments Team'));
});

test('[F:ontology-edit] [F:ontology-validate] [F:tag-synonyms] ontology read, validate, update (versioned in git)', async () => {
  const o = await bob.ok('GET', '/api/v1/ontology');
  assert.ok(o.usage.System >= 5);
  assert.ok(o.relationUsage.depends_on >= 4);
  const bad = await alice.ok('POST', '/api/v1/ontology/validate', { yaml: 'types:\n  - name: A\nrelations:\n  - name: r\n    range: [Nope]\n' });
  assert.equal(bad.valid, false);
  assert.equal((await alice.put('/api/v1/ontology', { yaml: 'types: [' })).status, 400);
  const next = { ...o.ontology, types: [...o.ontology.types, { name: 'Vendor', description: 'External supplier', properties: [{ name: 'contract_end', datatype: 'date', required: true }] }],
    tags: [...o.ontology.tags, { name: 'security', description: 'Security topics', synonyms: ['sec', 'infosec'] }] };
  await alice.ok('PUT', '/api/v1/ontology', { ontology: next, message: 'Add Vendor type' });
  assert.match(await t.app.git.readFile('_system/ontology.yml'), /name: Vendor/);
  assert.equal((await t.app.git.log('_system/ontology.yml'))[0].message, 'Add Vendor type');
  const p = (await alice.ok('POST', '/api/v1/pages', { space: 'ENG', title: 'Acme Corp', type: 'Vendor', markdown: 'Supplier. #infosec' })).page;
  assert.deepEqual(p.tags, ['security'], 'synonym canonicalised');
  const v = await alice.ok('GET', `/api/v1/pages/${p.id}`);
  assert.ok(v.ontologyIssues.some(i => i.code === 'missing-property'));
  const schema = await bob.get('/api/v1/ontology/schema.ttl');
  assert.match(schema.data, /gw:Vendor a owl:Class/);
});
