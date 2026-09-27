import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { unzipSync } from 'fflate';
import { startApp, client, until } from '../helpers.js';

let t, admin, alice, bob;
before(async () => { t = await startApp(); [admin, alice, bob] = await Promise.all(['admin', 'alice', 'bob'].map(u => t.as(u))); });
after(async () => { await t.stop(); });

test('[F:admin-users] create, update role, deactivate and reset users', async () => {
  const u = await admin.ok('POST', '/api/v1/admin/users', { username: 'erin', password: 'password-erin', name: 'Erin', email: 'erin@example.com', groups: ['support'] });
  assert.deepEqual(u.groups, ['support']);
  assert.equal((await admin.post('/api/v1/admin/users', { username: 'erin', password: 'password-erin' })).status, 409);
  assert.equal((await admin.post('/api/v1/admin/users', { username: 'bad name!', password: 'password-x' })).status, 400);
  assert.equal((await admin.post('/api/v1/admin/users', { username: 'shorty', password: 'short' })).status, 400);
  const erin = client(t.url); await erin.login('erin', 'password-erin');
  await admin.ok('PUT', '/api/v1/admin/users/erin', { role: 'km_admin' });
  assert.equal((await erin.ok('GET', '/api/v1/auth/me')).user.isKm, true);
  await admin.ok('PUT', '/api/v1/admin/users/erin', { active: false });
  assert.equal((await erin.get('/api/v1/auth/me')).data.user, null, 'sessions revoked on deactivation');
  assert.equal((await client(t.url).post('/api/v1/auth/login', { username: 'erin', password: 'password-erin' })).status, 401);
  await admin.ok('PUT', '/api/v1/admin/users/erin', { active: true, password: 'another-password' });
  await client(t.url).login('erin', 'another-password');
  assert.equal((await admin.put('/api/v1/admin/users/admin', { role: 'user' })).status, 400, 'cannot demote yourself');
  const list = await alice.ok('GET', '/api/v1/admin/users');
  assert.ok(list.some(x => x.username === 'erin'));
});

test('[F:admin-groups] groups CRUD drive permissions', async () => {
  await admin.ok('POST', '/api/v1/admin/groups', { name: 'auditors', description: 'Audit team', users: ['bob'] });
  const groups = await admin.ok('GET', '/api/v1/admin/groups');
  assert.deepEqual(groups.find(g => g.name === 'auditors').users, ['bob']);
  const fin = t.pages['Quarterly Close Process'].id;
  assert.equal((await bob.get(`/api/v1/pages/${fin}`)).status, 404);
  await admin.ok('PUT', '/api/v1/spaces/FIN/permissions', { entries: [...await admin.ok('GET', '/api/v1/spaces/FIN/permissions'), { ptype: 'group', principal: 'auditors', role: 'viewer' }] });
  assert.equal((await bob.get(`/api/v1/pages/${fin}`)).status, 200);
  await admin.ok('PUT', '/api/v1/admin/groups/auditors', { users: [] });
  const bob2 = await t.as('bob');
  assert.equal((await bob2.get(`/api/v1/pages/${fin}`)).status, 404);
  await admin.ok('DELETE', '/api/v1/admin/groups/auditors');
  assert.ok(!(await admin.ok('GET', '/api/v1/spaces/FIN/permissions')).some(p => p.principal === 'auditors'));
});

test('[F:admin-settings] settings with secret redaction; banner and site name', async () => {
  await admin.ok('PUT', '/api/v1/admin/settings', { settings: { site_name: 'Acme Wiki', banner: { text: 'Maintenance Friday', kind: 'info' }, llm: { provider: 'anthropic', apiKey: 'sk-secret', model: 'claude-opus-5-5' } } });
  const s = await alice.ok('GET', '/api/v1/admin/settings');
  assert.equal(s.settings.site_name, 'Acme Wiki');
  assert.equal(s.settings.llm.apiKey, '••••••••', 'secrets redacted');
  await admin.ok('PUT', '/api/v1/admin/settings', { settings: { llm: { ...s.settings.llm, model: 'claude-opus-5-5' } } });
  assert.equal(t.app.settings.get('llm').apiKey, 'sk-secret', 'redacted placeholder keeps the stored secret');
  const cfg = await (await fetch(t.url + '/api/v1/config')).json();
  assert.equal(cfg.siteName, 'Acme Wiki');
  assert.equal(cfg.banner.text, 'Maintenance Friday');
  assert.equal(cfg.llm, true);
  assert.equal((await admin.put('/api/v1/admin/settings', { settings: { evil: 1 } })).status, 400);
  await admin.ok('PUT', '/api/v1/admin/settings', { settings: { site_name: 'GitWiki', banner: null, llm: { provider: '' } } });
});

test('[F:feature-flags-ab] A/B rollouts are deterministic, proportional and group-targetable', async () => {
  const users = Array.from({ length: 400 }, (_, i) => ({ id: 10000 + i, username: 'u' + i }));
  await admin.ok('PUT', '/api/v1/admin/settings', { flags: { 'search.graph_boost': { enabled: true, rollout: 30 } } });
  const on = users.filter(u => t.app.flag('search.graph_boost', u)).length;
  assert.ok(on > 80 && on < 160, `~30% expected, got ${on}/400`);
  assert.deepEqual(users.map(u => t.app.flag('search.graph_boost', u)), users.map(u => t.app.flag('search.graph_boost', u)), 'stable per user');
  await admin.ok('PUT', '/api/v1/admin/settings', { flags: { 'search.graph_boost': { enabled: true, rollout: 0, groups: ['finance'] } } });
  const carol = t.app.users.byUsername('carol');
  const bobU = t.app.users.byUsername('bob');
  assert.equal(t.app.flag('search.graph_boost', carol), true, 'group always on');
  assert.equal(t.app.flag('search.graph_boost', bobU), false);
  await admin.ok('PUT', '/api/v1/admin/settings', { flags: { 'search.graph_boost': { enabled: false } } });
  assert.equal(t.app.flag('search.graph_boost', carol), false);
  assert.equal((await admin.put('/api/v1/admin/settings', { flags: { x: { enabled: true, rollout: 150 } } })).status, 400);
  await admin.ok('PUT', '/api/v1/admin/settings', { flags: { 'search.graph_boost': { enabled: true, rollout: 100 } } });
  const s = await admin.ok('GET', '/api/v1/admin/settings');
  assert.ok(s.flags['graphrag.answer'].description);
});

test('[F:audit-log] [F:audit-csv] audit log records actions and exports CSV', async () => {
  await bob.ok('POST', '/api/v1/pages', { space: 'ENG', title: 'Audited', markdown: 'x' });
  const rows = await alice.ok('GET', '/api/v1/admin/audit?user=bob&action=page.');
  assert.ok(rows.some(r => r.action === 'page.created' && r.details.title === 'Audited'));
  const all = await alice.ok('GET', '/api/v1/admin/audit?limit=1000');
  for (const a of ['auth.login', 'user.create', 'settings.update', 'group.create', 'space.permissions']) assert.ok(all.some(r => r.action === a), `missing audit ${a}`);
  const csv = await alice.get('/api/v1/admin/audit?format=csv');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.data, /^ts,username,action,target,ip,details\n/);
});

test('[F:content-health] [F:review-reminders] health report finds orphans, broken links, overdue reviews and ontology issues', async () => {
  const orphan = (await bob.ok('POST', '/api/v1/pages', { space: 'ENG', title: 'Orphan Note', markdown: 'Nobody links here and it links to [[Nowhere Page]].' })).page;
  await bob.ok('POST', `/api/v1/pages/${orphan.id}/move`, { parent: null });
  const h = await alice.ok('GET', '/api/v1/admin/health');
  assert.ok(h.orphans.some(p => p.id === orphan.id));
  assert.ok(h.broken.some(b => b.target === 'nowhere page'));
  assert.ok(h.reviewDue.some(p => p.title === 'Security Policy'), 'review_by 2026-01-31 is overdue');
  assert.ok(h.violations.some(v => v.title === 'Legacy Invoicing'));
  assert.ok(h.score >= 0 && h.score <= 100);
  assert.equal((await alice.ok('GET', '/api/v1/admin/health?staleDays=0')).totals.stale, h.totals.pages);
  const r = await alice.ok('POST', '/api/v1/admin/health/remind');
  assert.ok(r.notified >= 1);
  assert.equal((await alice.ok('POST', '/api/v1/admin/health/remind')).notified, 0, 'no duplicate reminders within a week');
});

test('[F:analytics] analytics: views, searches, content gaps, contributors', async () => {
  const id = t.pages['Billing Service'].id;
  for (let i = 0; i < 3; i++) await bob.ok('GET', `/api/v1/pages/${id}`);
  await bob.ok('GET', '/api/v1/search?q=kubernetes');
  const a = await alice.ok('GET', '/api/v1/admin/analytics?days=30');
  assert.equal(a.topPages[0].title, 'Billing Service');
  assert.ok(a.viewsByDay.length >= 1);
  assert.ok(a.zeroResultSearches.some(s => s.q === 'kubernetes'));
  assert.ok(a.contributors.length >= 1);
  assert.ok(a.totals.pages > 15);
});

test('[F:tag-rename-merge] [F:tag-delete] rename, merge and delete tags across pages in one commit', async () => {
  const p = (await bob.ok('POST', '/api/v1/pages', { space: 'ENG', title: 'Tag Target', markdown: 'Uses #database inline and #database/replication too.\n\n```\n#database in code\n```\n', tags: ['database'] })).page;
  const before = Number((await t.app.git.run(['rev-list', '--count', 'HEAD'])).trim());
  const r = await alice.ok('POST', '/api/v1/admin/tags/rename', { from: 'database', to: 'data/storage' });
  assert.ok(r.pages >= 3);
  assert.equal(Number((await t.app.git.run(['rev-list', '--count', 'HEAD'])).trim()), before + 1, 'single commit');
  const md = (await bob.ok('GET', `/api/v1/pages/${p.id}`)).markdown;
  assert.match(md, /Uses #data\/storage inline and #data\/storage\/replication too/);
  assert.match(md, /#database in code/, 'code untouched');
  const tags = await bob.ok('GET', '/api/v1/tags');
  assert.ok(!tags.some(x => x.tag === 'database'));
  // merge into an existing tag
  await alice.ok('POST', '/api/v1/admin/tags/rename', { from: 'glossary', to: 'architecture' });
  assert.ok((await bob.ok('GET', `/api/v1/pages/${t.pages['Glossary: Idempotency'].id}`)).page.tags.includes('architecture'));
  await alice.ok('POST', '/api/v1/admin/tags/delete', { tag: 'confidential' });
  assert.ok(!(await admin.ok('GET', '/api/v1/tags')).some(x => x.tag === 'confidential'));
});

test('[F:webhooks-outgoing] signed outgoing webhooks fire on page events', async () => {
  const received = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { received.push({ headers: req.headers, body: b }); res.end('ok'); }); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  srv.unref();
  const url = `http://127.0.0.1:${srv.address().port}/hook`;
  const h = await admin.ok('POST', '/api/v1/admin/webhooks', { url, events: ['page.*'] });
  await bob.ok('POST', '/api/v1/pages', { space: 'ENG', title: 'Hooked', markdown: 'x' });
  await until(() => received.length >= 1);
  const ev = received[0];
  assert.equal(ev.headers['x-gitwiki-event'], 'page.created');
  const expected = 'sha256=' + crypto.createHmac('sha256', h.secret).update(ev.body).digest('hex');
  assert.equal(ev.headers['x-gitwiki-signature'], expected);
  assert.equal(JSON.parse(ev.body).page.title, 'Hooked');
  await until(() => (t.app.db.get('SELECT last_status FROM webhooks WHERE id = ?', h.id).last_status || '').startsWith('200'));
  // comment events are not subscribed
  await bob.ok('POST', `/api/v1/pages/${t.pages['Auth Service'].id}/comments`, { body: 'hi' });
  await new Promise(r => setTimeout(r, 200));
  assert.ok(received.every(x => x.headers['x-gitwiki-event'].startsWith('page.')));
  await admin.ok('DELETE', `/api/v1/admin/webhooks/${h.id}`);
  srv.close();
});

test('[F:reindex] [F:backup] [F:email-outbox] reindex from git and full backup', async () => {
  const before = t.app.db.get('SELECT COUNT(*) AS n FROM pages').n;
  t.app.db.exec('DELETE FROM pages_fts');
  assert.equal((await bob.ok('GET', '/api/v1/search?q=reconciliation')).total, 0);
  const r = await admin.ok('POST', '/api/v1/admin/reindex');
  assert.equal(r.pages, before);
  assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM pages').n, before);
  assert.ok((await bob.ok('GET', '/api/v1/search?q=reconciliation')).total >= 1);
  const zip = await admin.get('/api/v1/admin/backup');
  const files = unzipSync(new Uint8Array(zip.data));
  assert.ok(files['repo.bundle'].length > 1000);
  assert.ok(files['gitwiki.db'].length > 1000);
  assert.equal((await alice.get('/api/v1/admin/backup')).status, 403);
  assert.ok(Array.isArray(await admin.ok('GET', '/api/v1/admin/outbox')));
});

test('[F:maintenance-mode] maintenance mode makes the wiki read-only for non-admins', async () => {
  await admin.ok('PUT', '/api/v1/admin/settings', { settings: { maintenance: true } });
  assert.equal((await bob.post('/api/v1/pages', { space: 'ENG', title: 'Blocked', markdown: 'x' })).status, 503);
  assert.equal((await bob.get(`/api/v1/pages/${t.pages['Auth Service'].id}`)).status, 200);
  await admin.ok('PUT', '/api/v1/admin/settings', { settings: { maintenance: false } });
  assert.equal((await bob.post('/api/v1/pages', { space: 'ENG', title: 'Unblocked', markdown: 'x' })).status, 200);
});

test('[F:admin-panel-ui] overview and git status endpoints', async () => {
  const o = await alice.ok('GET', '/api/v1/admin/overview');
  assert.ok(o.health.score >= 0);
  assert.ok(o.git.commits > 20);
  const g = await alice.ok('GET', '/api/v1/admin/git');
  assert.equal(g.status.configured, false);
  assert.ok(g.log.length > 5);
  const spaces = await alice.ok('GET', '/api/v1/admin/spaces');
  assert.ok(spaces.find(s => s.key === 'FIN').permissions.some(p => p.principal === 'finance'));
});
