import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startApp, until } from '../helpers.js';

let t, alice, bob, carol;
before(async () => { t = await startApp(); alice = await t.as('alice'); bob = await t.as('bob'); carol = await t.as('carol'); });
after(async () => { await t.stop(); });
const P = (id) => `/api/v1/pages/${id}`;

test('[F:comments] [F:comment-replies] [F:inline-comments] [F:comment-resolve] threaded, inline, editable, resolvable comments', async () => {
  const id = t.pages['Ledger Service'].id;
  const c = await bob.ok('POST', P(id) + '/comments', { body: 'Is the ledger **append-only**?' });
  assert.match(c.html, /<strong>append-only<\/strong>/);
  const reply = await alice.ok('POST', P(id) + '/comments', { body: 'Yes, see the ADR.', parent_id: c.id });
  assert.equal(reply.parent_id, c.id);
  const inline = await carol.ok('POST', P(id) + '/comments', { body: 'Which bank feeds?', anchor: { text: 'bank statements', prefix: 'with ', suffix: '.' } });
  assert.equal(inline.anchor.text, 'bank statements');
  assert.equal((await alice.put(`/api/v1/comments/${c.id}`, { body: 'hijack' })).status, 403);
  await bob.ok('PUT', `/api/v1/comments/${c.id}`, { body: 'Is the ledger append-only? (edited)' });
  await alice.ok('PUT', `/api/v1/comments/${c.id}`, { resolved: true });
  const list = await bob.ok('GET', P(id) + '/comments');
  assert.equal(list.length, 3);
  assert.equal(list.find(x => x.id === c.id).resolved, true);
  assert.match(list.find(x => x.id === c.id).body, /edited/);
  await carol.ok('DELETE', `/api/v1/comments/${inline.id}`);
  assert.equal((await bob.ok('GET', P(id) + '/comments')).find(x => x.id === inline.id).deleted, true);
  assert.equal((await bob.post(P(id) + '/comments', { body: '   ' })).status, 400);
  assert.equal((await bob.ok('GET', P(id))).commentCount, 2);
});

test('[F:reactions] page and comment reactions toggle', async () => {
  const id = t.pages['Auth Service'].id;
  let r = await bob.ok('POST', '/api/v1/reactions', { ttype: 'page', tid: id, emoji: '👍' });
  assert.equal(r.reacted, true);
  r = await alice.ok('POST', '/api/v1/reactions', { ttype: 'page', tid: id, emoji: '👍' });
  assert.deepEqual(r.reactions, [{ emoji: '👍', count: 2, mine: true }]);
  r = await alice.ok('POST', '/api/v1/reactions', { ttype: 'page', tid: id, emoji: '👍' });
  assert.equal(r.reacted, false);
  assert.equal((await bob.post('/api/v1/reactions', { ttype: 'page', tid: id, emoji: '💩' })).status, 400);
  assert.deepEqual((await bob.ok('GET', P(id))).reactions, [{ emoji: '👍', count: 1, mine: true }]);
});

test('[F:watch] [F:notifications] [F:mention-notify] [F:task-notify] [F:email-outbox] notifications for watchers, mentions and task assignment', async () => {
  const p = (await alice.ok('POST', '/api/v1/pages', { space: 'ENG', title: 'Notify Me', markdown: 'start' })).page;
  await bob.ok('POST', P(p.id) + '/watch', { watch: true });
  const before = (await bob.ok('GET', '/api/v1/notifications')).unread;
  await alice.ok('PUT', P(p.id), { markdown: 'start\n\nping @carol\n\n- [ ] review this @bob 📅 2026-12-01' });
  const bn = await bob.ok('GET', '/api/v1/notifications');
  const types = bn.items.map(n => n.type);
  assert.ok(types.includes('page.updated'), 'watcher notified');
  assert.ok(types.includes('task'), 'assignee notified');
  assert.ok(bn.unread >= before + 2);
  const cn = await carol.ok('GET', '/api/v1/notifications');
  assert.ok(cn.items.some(n => n.type === 'mention' && n.data.page === p.id));
  // re-saving does not re-notify existing mentions
  const count = cn.items.length;
  await alice.ok('PUT', P(p.id), { markdown: 'start\n\nping @carol again\n\n- [ ] review this @bob 📅 2026-12-01' });
  assert.equal((await carol.ok('GET', '/api/v1/notifications')).items.length, count);
  // comment notifications + replies
  await carol.ok('POST', P(p.id) + '/comments', { body: 'Looks good @bob' });
  assert.ok((await bob.ok('GET', '/api/v1/notifications')).items.some(n => n.type === 'mention' && n.data.by === 'carol'));
  const outbox = t.app.db.all('SELECT * FROM email_outbox');
  assert.ok(outbox.some(m => m.to_addr === 'bob@example.com' && /assigned you a task/.test(m.subject)));
  await bob.ok('POST', '/api/v1/notifications/read', {});
  assert.equal((await bob.ok('GET', '/api/v1/notifications')).unread, 0);
  await bob.ok('POST', P(p.id) + '/watch', { watch: false });
  assert.equal((await bob.ok('GET', P(p.id))).watching, false);
});

test('[F:favorites] [F:recent] [F:dashboard] [F:my-tasks] dashboard aggregates', async () => {
  const id = t.pages['Postgres Cluster'].id;
  await carol.ok('GET', P(id));
  await carol.ok('POST', P(id) + '/favorite', { favorite: true });
  const d = await carol.ok('GET', '/api/v1/dashboard');
  assert.equal(d.recentlyViewed[0].id, id);
  assert.equal(d.favorites[0].id, id);
  assert.ok(d.tasks.some(x => /Document retry policy/.test(x.text)), JSON.stringify(d.tasks.map(x => x.text)));
  assert.ok(d.activity.length > 5);
  assert.ok(d.activity.some(a => a.page.space === 'FIN'), 'finance member sees FIN activity');
  assert.ok((await bob.ok('GET', '/api/v1/dashboard')).activity.every(a => a.page.space !== 'FIN'), 'activity feed is permission filtered');
  const tasks = await carol.ok('GET', '/api/v1/tasks');
  assert.ok(tasks.some(x => x.title === 'Onboarding Guide'));
  await carol.ok('POST', P(id) + '/favorite', { favorite: false });
  assert.equal((await carol.ok('GET', '/api/v1/dashboard')).favorites.length, 0);
});

test('[F:sse-live] [F:presence] live events stream and presence', async () => {
  const id = t.pages['Auth Service'].id;
  const events = [];
  const req = http.get(t.url + '/api/v1/events', { headers: { cookie: bob.cookie } }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk) => { for (const m of chunk.matchAll(/event: (\w+)\ndata: (.*)\n/g)) events.push([m[1], JSON.parse(m[2])]); });
  });
  await until(() => events.some(e => e[0] === 'hello'));
  const pres = await alice.ok('POST', P(id) + '/presence', { editing: true });
  assert.deepEqual(pres.users, [{ username: 'alice', name: 'Alice Chen', editing: true }]);
  await alice.ok('PUT', P(id), { markdown: 'Issues OAuth tokens (updated live).' });
  await until(() => events.some(e => e[0] === 'page' && e[1].id === id && e[1].by === 'alice'));
  assert.ok(events.some(e => e[0] === 'presence' && e[1].page === id));
  await alice.ok('POST', P(id) + '/presence', { leave: true });
  assert.equal((await bob.ok('GET', P(id))).presence.length, 0);
  req.destroy();
});
