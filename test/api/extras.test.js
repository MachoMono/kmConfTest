import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startApp, until } from '../helpers.js';

let t, admin, alice, bob, carol;
before(async () => { t = await startApp(); [admin, alice, bob, carol] = await Promise.all(['admin', 'alice', 'bob', 'carol'].map(u => t.as(u))); });
after(async () => { await t.stop(); });
const P = (id) => `/api/v1/pages/${id}`;

test('[F:unlinked-mentions] unlinked mentions are listed and can be turned into links', async () => {
  const src = (await alice.ok('POST', '/api/v1/pages', { space: 'ENG', title: 'Capacity Notes', markdown: 'The postgres cluster needs more disk. `Postgres Cluster` in code is ignored.' })).page;
  const target = t.pages['Postgres Cluster'].id;
  let v = await alice.ok('GET', P(target));
  assert.ok(v.unlinked.some(u => u.id === src.id));
  await alice.ok('POST', P(target) + '/link-mention', { source: src.id });
  const md = (await alice.ok('GET', P(src.id))).markdown;
  assert.equal(md, 'The [[Postgres Cluster|postgres cluster]] needs more disk. `Postgres Cluster` in code is ignored.\n');
  v = await alice.ok('GET', P(target));
  assert.ok(!v.unlinked.some(u => u.id === src.id));
  assert.ok(v.backlinks.some(b => b.id === src.id));
  assert.equal((await alice.post(P(target) + '/link-mention', { source: src.id })).status, 409);
});

test('[F:share] sharing notifies people who can view the page', async () => {
  const fin = t.pages['Quarterly Close Process'].id;
  const r = await carol.ok('POST', P(fin) + '/share', { users: ['alice', 'bob', 'nobody'], message: 'Please review' });
  assert.deepEqual(r.delivered, ['alice']);
  assert.deepEqual(r.skipped.sort(), ['bob', 'nobody'], 'no leak to users without access');
  const n = (await alice.ok('GET', '/api/v1/notifications')).items.find(x => x.type === 'share');
  assert.equal(n.data.text, 'Please review');
  assert.equal(n.data.by, 'carol');
});

test('[F:page-status] [F:aliases] page status and aliases', async () => {
  const p = (await alice.ok('POST', '/api/v1/pages', { space: 'ENG', title: 'Kubernetes Platform', markdown: 'k8s', aliases: ['K8s', 'Kube'], props: { status: 'Rough draft' } })).page;
  assert.equal(p.status, 'Rough draft');
  assert.deepEqual(p.aliases, ['K8s', 'Kube']);
  assert.equal((await alice.ok('GET', '/api/v1/resolve?title=kube&space=ENG')).page.id, p.id, 'links resolve by alias');
  const linker = (await alice.ok('POST', '/api/v1/pages', { space: 'ENG', title: 'Uses Kube', markdown: 'Deployed on [[K8s]].' })).page;
  assert.match((await alice.ok('GET', P(linker.id))).html, new RegExp(`href="/p/${p.id}"`));
  await alice.ok('PUT', P(p.id), { props: { status: 'Verified' }, aliases: ['K8s'] });
  const v = await alice.ok('GET', P(p.id));
  assert.equal(v.page.status, 'Verified');
  assert.deepEqual(v.page.aliases, ['K8s']);
  assert.equal((await alice.ok('GET', '/api/v1/search?q=' + encodeURIComponent('status:verified'))).results[0].id, p.id);
});

test('[F:smtp-delivery] queued notification emails are delivered over SMTP', async () => {
  const received = [];
  const srv = net.createServer((sock) => {
    let data = false, buf = '', msg = '';
    sock.write('220 test ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data) { if (line === '.') { data = false; received.push(msg); msg = ''; sock.write('250 queued\r\n'); } else msg += line + '\n'; continue; }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-test\r\n250 OK\r\n');
        else if (cmd === 'DATA') { data = true; sock.write('354 go\r\n'); }
        else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 OK\r\n');
      }
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  srv.unref();
  try {
  const queued = t.app.db.get('SELECT COUNT(*) AS n FROM email_outbox WHERE sent_at IS NULL').n;
  assert.equal((await admin.ok('POST', '/api/v1/admin/outbox/flush')).configured, false);
  await admin.ok('PUT', '/api/v1/admin/settings', { settings: { smtp: { host: '127.0.0.1', port: srv.address().port, from: 'Wiki <wiki@example.com>' } } });
  // generate a fresh notification email
  const p = (await alice.ok('POST', '/api/v1/pages', { space: 'ENG', title: 'Mail Me', markdown: 'x' })).page;
  await bob.ok('POST', P(p.id) + '/watch', { watch: true });
  await alice.ok('PUT', P(p.id), { markdown: 'changed' });
  const r = await admin.ok('POST', '/api/v1/admin/outbox/flush');
  assert.equal(r.failed, 0);
  assert.ok(r.sent >= queued + 1);
  // subjects are RFC 2047 encoded (=?UTF-8?Q?...?=); decode before matching
  const subjects = () => received.map(m => (m.match(/^Subject: (.*(?:\n[ \t].*)*)/m) || [])[1] || '').map(v => v.replace(/\n[ \t]/g, ' ')
    .replace(/=\?UTF-8\?Q\?(.*?)\?=/gi, (_x, q) => q.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_y, h) => String.fromCharCode(parseInt(h, 16)))).replace(/\?= =\?UTF-8\?Q\?/gi, ''));
  await until(() => subjects().some(x => /\[GitWiki\] "Mail Me" was updated by alice/.test(x.replace(/\s+/g, ' ').replace(/" was/, '" was'))));
  assert.ok(received.some(m => /To: bob@example.com/.test(m)));
  assert.equal(t.app.db.get('SELECT COUNT(*) AS n FROM email_outbox WHERE sent_at IS NULL').n, 0);
  } finally { srv.close(); }
});

test('[F:access-log] structured JSON access logs', async () => {
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  t.app.cfg.quiet = false;
  process.stdout.write = (s, ...rest) => { if (String(s).startsWith('{"ts"')) { lines.push(JSON.parse(s)); return true; } return orig(s, ...rest); };
  try {
    await bob.ok('GET', '/api/v1/spaces');
    await until(() => lines.some(l => l.path === '/api/v1/spaces'));
  } finally { process.stdout.write = orig; t.app.cfg.quiet = true; }
  const l = lines.find(x => x.path === '/api/v1/spaces');
  assert.equal(l.status, 200);
  assert.equal(l.user, 'bob');
  assert.equal(l.method, 'GET');
  assert.equal(typeof l.ms, 'number');
});
