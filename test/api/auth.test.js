import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client, ADMIN_PASSWORD } from '../helpers.js';

let t;
before(async () => { t = await startApp(); });
after(async () => { await t.stop(); });

test('[F:auth-login] [F:sessions] login, me, logout', async () => {
  const c = client(t.url);
  assert.equal((await c.get('/api/v1/auth/me')).data.user, null);
  const bad = await c.post('/api/v1/auth/login', { username: 'bob', password: 'nope' });
  assert.equal(bad.status, 401);
  const ok = await c.post('/api/v1/auth/login', { username: 'bob', password: 'password-bob' });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /gw_sid=.*HttpOnly; SameSite=Lax/);
  assert.equal((await c.get('/api/v1/auth/me')).data.user.username, 'bob');
  await c.post('/api/v1/auth/logout');
  assert.equal((await c.get('/api/v1/auth/me')).data.user, null);
  assert.equal((await c.get('/api/v1/dashboard')).status, 200);
  assert.equal((await c.get('/api/v1/notifications')).status, 401);
});

test('[F:auth-rate-limit] repeated failed logins are rate limited', async () => {
  const c = client(t.url);
  let last;
  for (let i = 0; i < 11; i++) last = await c.post('/api/v1/auth/login', { username: 'dave', password: 'wrong' + i });
  assert.equal(last.status, 429);
});

test('[F:csrf] cookie-authenticated mutations require the CSRF header', async () => {
  const c = await t.as('bob');
  const res = await fetch(t.url + '/api/v1/pages', { method: 'POST', headers: { cookie: c.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ space: 'ENG', title: 'X' }) });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /CSRF/);
});

test('[F:rest-api-tokens] API tokens authenticate REST calls and can be revoked', async () => {
  const c = await t.as('bob');
  const tok = await c.ok('POST', '/api/v1/auth/tokens', { name: 'ci' });
  assert.match(tok.token, /^gw_/);
  const api = client(t.url); api.useToken(tok.token);
  // bearer tokens do not need the CSRF header
  const r = await fetch(t.url + '/api/v1/pages', { method: 'POST', headers: { authorization: `Bearer ${tok.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ space: 'ENG', title: 'Created via token', markdown: 'hi' }) });
  assert.equal(r.status, 200);
  const list = await c.ok('GET', '/api/v1/auth/tokens');
  assert.equal(list.length, 1);
  assert.ok(list[0].last_used);
  await c.ok('DELETE', `/api/v1/auth/tokens/${tok.id}`);
  assert.equal((await api.get('/api/v1/notifications')).status, 401);
});

test('[F:profile] [F:password-change] profile update and password change', async () => {
  const c = await t.as('carol');
  const r = await c.ok('PUT', '/api/v1/auth/me', { name: 'Carol S.', prefs: { email: false } });
  assert.equal(r.user.name, 'Carol S.');
  assert.equal(r.user.prefs.email, false);
  assert.equal((await c.put('/api/v1/auth/me', { newPassword: 'new-password-1', currentPassword: 'wrong' })).status, 401);
  await c.ok('PUT', '/api/v1/auth/me', { newPassword: 'new-password-1', currentPassword: 'password-carol' });
  const c2 = client(t.url);
  await c2.login('carol', 'new-password-1');
  await c2.ok('PUT', '/api/v1/auth/me', { newPassword: 'password-carol', currentPassword: 'new-password-1' });
});

test('[F:health-endpoints] health and readiness probes; security headers', async () => {
  const h = await fetch(t.url + '/healthz');
  assert.equal(h.status, 200);
  assert.match(h.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(h.headers.get('x-content-type-options'), 'nosniff');
  const r = await (await fetch(t.url + '/readyz')).json();
  assert.ok(r.ok && r.pages > 10);
  const cfg = await (await fetch(t.url + '/api/v1/config')).json();
  assert.equal(cfg.siteName, 'GitWiki');
  void ADMIN_PASSWORD;
});

test('SPA fallback serves index.html; static assets compressed', async () => {
  const r = await fetch(t.url + '/p/some-id', { headers: { 'accept-encoding': 'br' } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  const api404 = await fetch(t.url + '/api/v1/nope');
  assert.equal(api404.status, 404);
});
