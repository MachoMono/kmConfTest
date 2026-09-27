import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client } from '../helpers.js';

let t, admin, alice, bob, carol, dave;
before(async () => {
  t = await startApp();
  [admin, alice, bob, carol, dave] = await Promise.all(['admin', 'alice', 'bob', 'carol', 'dave'].map(u => t.as(u)));
});
after(async () => { await t.stop(); });
const P = (id) => `/api/v1/pages/${id}`;

test('[F:rbac-roles] [F:spaces-permissions] space roles gate view/comment/edit/admin', async () => {
  const fin = t.pages['Salary Bands'].id;
  assert.equal((await bob.get(P(fin))).status, 404, 'non-member cannot see restricted space pages');
  assert.equal((await carol.get(P(fin))).status, 200, 'group member can');
  assert.equal((await carol.ok('GET', P(fin))).perms.edit, true);
  const hr = t.pages['Travel Policy'].id;
  const v = await bob.ok('GET', P(hr));
  assert.deepEqual([v.perms.comment, v.perms.edit], [true, false], 'HR: all users are commenters');
  assert.equal((await bob.put(P(hr), { markdown: 'x' })).status, 403);
  assert.equal((await bob.post(P(hr) + '/comments', { body: 'question' })).status, 200);
  assert.equal((await carol.put(P(hr), { markdown: 'Book travel via the portal.' })).status, 200, 'explicit user editor');
  assert.equal((await bob.get('/api/v1/spaces/HR/permissions')).status, 403);
  const perms = await admin.ok('GET', '/api/v1/spaces/HR/permissions');
  assert.ok(perms.some(p => p.ptype === 'all' && p.role === 'commenter'));
  assert.equal((await bob.put('/api/v1/spaces/ENG/permissions', { entries: [] })).status, 403);
  assert.equal((await admin.put('/api/v1/spaces/ENG/permissions', { entries: [{ ptype: 'bogus', principal: 'x', role: 'viewer' }] })).status, 400);
});

test('[F:guest-role] guests are read-only everywhere', async () => {
  const id = t.pages['Billing Service'].id;
  const v = await dave.ok('GET', P(id));
  assert.equal(v.perms.edit, false);
  assert.equal(v.perms.comment, false);
  assert.equal((await dave.put(P(id), { markdown: 'x' })).status, 403);
  assert.equal((await dave.post('/api/v1/spaces', { key: 'GST', name: 'g' })).status, 403);
});

test('[F:page-restrictions] [F:restriction-inheritance] view restrictions inherit to children; edit restrictions do not', async () => {
  const parent = (await alice.ok('POST', '/api/v1/pages', { space: 'ENG', title: 'Secret Project', markdown: 'codename zebra' })).page;
  const child = (await alice.ok('POST', '/api/v1/pages', { space: 'ENG', title: 'Secret Child', parent: parent.id, markdown: 'zebra details' })).page;
  await alice.ok('PUT', P(parent.id) + '/restrictions', { view: [{ ptype: 'user', principal: 'carol' }], edit: [] });
  const r = await alice.ok('GET', P(parent.id) + '/restrictions');
  assert.deepEqual(r.view.map(x => x.principal), ['carol'], 'KM admin (space admin) not force-added');
  assert.equal((await bob.get(P(parent.id))).status, 404);
  assert.equal((await bob.get(P(child.id))).status, 404, 'inherits to child');
  assert.equal((await carol.get(P(child.id))).status, 200);
  assert.ok(!(await bob.ok('GET', '/api/v1/search?q=zebra')).results.length, 'search filtered');
  assert.ok((await carol.ok('GET', '/api/v1/search?q=zebra')).results.length >= 2);
  // edit restriction on an open page
  const open = (await alice.ok('POST', '/api/v1/pages', { space: 'ENG', title: 'Locked Page', markdown: 'read me' })).page;
  await t.app.perms.setSpacePerms('ENG', [...t.app.perms.spacePerms('ENG').filter(p => p.principal !== 'bob'), { ptype: 'user', principal: 'bob', role: 'editor' }]);
  await alice.ok('PUT', P(open.id) + '/restrictions', { view: [], edit: [{ ptype: 'user', principal: 'alice' }] });
  const bv = await bob.ok('GET', P(open.id));
  assert.equal(bv.perms.edit, false);
  assert.equal(bv.restricted, true);
  assert.equal((await bob.put(P(open.id), { markdown: 'x' })).status, 403);
  // group restriction; non-admin setter is always kept on the list
  await bob.ok('PUT', P(child.id).replace(child.id, t.pages['Glossary: Idempotency'].id) + '/restrictions', { view: [{ ptype: 'group', principal: 'finance' }] });
  const gr = await bob.ok('GET', P(t.pages['Glossary: Idempotency'].id) + '/restrictions');
  assert.deepEqual(gr.view.map(x => x.principal).sort(), ['bob', 'finance']);
  assert.equal((await carol.get(P(t.pages['Glossary: Idempotency'].id))).status, 200);
  assert.equal((await alice.get(P(t.pages['Glossary: Idempotency'].id))).status, 200, 'KM admins see everything');
});

test('[F:graphrag-permissions] restricted content never leaks through graph, GraphRAG, tags, suggest or MCP', async () => {
  const fin = t.pages['Salary Bands'].id;
  const g = await bob.ok('GET', '/api/v1/graph');
  assert.ok(!g.nodes.some(n => n.pageId === fin));
  const rag = await bob.ok('GET', '/api/v1/graphrag/query?q=' + encodeURIComponent('confidential compensation salary bands'));
  assert.ok(!rag.chunks.some(c => c.page === fin));
  assert.ok(!rag.context.includes('Confidential compensation'));
  const carolRag = await carol.ok('GET', '/api/v1/graphrag/query?q=' + encodeURIComponent('confidential compensation salary bands'));
  assert.ok(carolRag.chunks.some(c => c.page === fin));
  assert.ok(!(await bob.ok('GET', '/api/v1/tags/confidential')).pages.length);
  assert.ok(!(await bob.ok('GET', '/api/v1/suggest/pages?q=salary')).length);
  const tok = await bob.ok('POST', '/api/v1/auth/tokens', { name: 'mcp' });
  const mcp = await fetch(t.url + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${tok.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_page', arguments: { id: fin } } }) });
  const body = await mcp.json();
  assert.equal(body.result.isError, true);
});

test('[F:anonymous-access] anonymous access requires global switch and space grant', async () => {
  const anon = client(t.url);
  const id = t.pages['Onboarding Guide'].id;
  assert.equal((await anon.get(P(id))).status, 401);
  await admin.ok('PUT', '/api/v1/spaces/HR/permissions', { entries: [...(await admin.ok('GET', '/api/v1/spaces/HR/permissions')), { ptype: 'anonymous', principal: '*', role: 'viewer' }] });
  assert.equal((await anon.get(P(id))).status, 401, 'global switch still off');
  await admin.ok('PUT', '/api/v1/admin/settings', { settings: { anonymous_access: true } });
  const v = await anon.get(P(id));
  assert.equal(v.status, 200);
  assert.equal(v.data.perms.comment, false);
  assert.equal((await anon.get(P(t.pages['Billing Service'].id))).status, 401, 'ENG not granted to anonymous');
  assert.equal((await anon.post(P(id) + '/comments', { body: 'x' })).status, 401);
  await admin.ok('PUT', '/api/v1/admin/settings', { settings: { anonymous_access: false } });
});

test('KM and admin boundaries', async () => {
  assert.equal((await bob.get('/api/v1/admin/overview')).status, 403);
  assert.equal((await alice.get('/api/v1/admin/overview')).status, 200, 'km_admin can use the KM panel');
  assert.equal((await alice.post('/api/v1/admin/users', { username: 'x1', password: 'password-x1' })).status, 403, 'only admins manage users');
  assert.equal((await alice.put('/api/v1/admin/settings', { settings: {} })).status, 403);
  assert.equal((await bob.put('/api/v1/ontology', { yaml: 'types: []' })).status, 403);
});
