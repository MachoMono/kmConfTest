import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { startApp, client } from '../helpers.js';

let t, admin, idp, idpUrl, llm, llmUrl;
const llmRequests = [];
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
let pendingNonce = null;
let tamper = false;

function signJwt(claims) {
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const s = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url');
  return `${h}.${p}.${tamper ? s.slice(0, -4) + 'AAAA' : s}`;
}

before(async () => {
  idp = http.createServer((req, res) => {
    const u = new URL(req.url, idpUrl);
    if (u.pathname === '/.well-known/openid-configuration') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ issuer: idpUrl, authorization_endpoint: idpUrl + '/authorize', token_endpoint: idpUrl + '/token', jwks_uri: idpUrl + '/jwks' }));
    }
    if (u.pathname === '/jwks') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ keys: [jwk] })); }
    if (u.pathname === '/token') {
      let body = ''; req.on('data', c => body += c); req.on('end', () => {
        const f = new URLSearchParams(body);
        if (f.get('code') !== 'good-code' || !f.get('code_verifier')) { res.statusCode = 400; return res.end('{}'); }
        const now = Math.floor(Date.now() / 1000);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id_token: signJwt({ iss: idpUrl, aud: 'gitwiki', sub: 'sub-123', nonce: pendingNonce, exp: now + 300, iat: now,
          preferred_username: 'frank', email: 'frank@example.com', name: 'Frank Lee', groups: ['engineering', 'km-team'] }) }));
      });
      return;
    }
    res.statusCode = 404; res.end();
  });
  await new Promise(r => idp.listen(0, '127.0.0.1', r));
  idpUrl = `http://127.0.0.1:${idp.address().port}`;
  llm = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      llmRequests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: 'The Payments Team owns billing [1].' }], usage: { input_tokens: 10, output_tokens: 8 } }));
    });
  });
  await new Promise(r => llm.listen(0, '127.0.0.1', r));
  llmUrl = `http://127.0.0.1:${llm.address().port}`;
  t = await startApp();
  admin = await t.as('admin');
});
after(async () => { await t.stop(); idp.close(); llm.close(); });

test('[F:oidc-sso] OIDC authorization-code + PKCE login with JIT provisioning and group mapping', async () => {
  await admin.ok('PUT', '/api/v1/admin/settings', { settings: { oidc: { issuer: idpUrl, clientId: 'gitwiki', clientSecret: 's3cret', label: 'Acme SSO', groupsClaim: 'groups', kmGroups: ['km-team'] } } });
  const cfg = await (await fetch(t.url + '/api/v1/config')).json();
  assert.equal(cfg.sso.label, 'Acme SSO');
  const start = await fetch(t.url + '/api/v1/auth/oidc/login?returnTo=/spaces', { redirect: 'manual' });
  assert.equal(start.status, 302);
  const loc = new URL(start.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, idpUrl + '/authorize');
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(loc.searchParams.get('client_id'), 'gitwiki');
  pendingNonce = loc.searchParams.get('nonce');
  const state = loc.searchParams.get('state');
  const cb = await fetch(`${t.url}/api/v1/auth/oidc/callback?code=good-code&state=${state}`, { redirect: 'manual' });
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('location'), '/spaces');
  const cookie = cb.headers.get('set-cookie').split(';')[0];
  const me = await (await fetch(t.url + '/api/v1/auth/me', { headers: { cookie } })).json();
  assert.equal(me.user.username, 'frank');
  assert.equal(me.user.role, 'km_admin', 'KM group mapped to role');
  assert.deepEqual(me.user.groups.sort(), ['engineering', 'km-team']);
  // replayed state is rejected
  assert.equal((await fetch(`${t.url}/api/v1/auth/oidc/callback?code=good-code&state=${state}`, { redirect: 'manual' })).status, 400);
  // tampered signature rejected
  const s2 = new URL((await fetch(t.url + '/api/v1/auth/oidc/login', { redirect: 'manual' })).headers.get('location'));
  pendingNonce = s2.searchParams.get('nonce'); tamper = true;
  const bad = await fetch(`${t.url}/api/v1/auth/oidc/callback?code=good-code&state=${s2.searchParams.get('state')}`, { redirect: 'manual' });
  assert.equal(bad.status, 401);
  tamper = false;
  // wrong nonce rejected
  const s3 = new URL((await fetch(t.url + '/api/v1/auth/oidc/login', { redirect: 'manual' })).headers.get('location'));
  pendingNonce = 'other';
  assert.equal((await fetch(`${t.url}/api/v1/auth/oidc/callback?code=good-code&state=${s3.searchParams.get('state')}`, { redirect: 'manual' })).status, 401);
});

test('[F:scim] SCIM 2.0 provisioning with an admin token', async () => {
  const tok = (await admin.ok('POST', '/api/v1/auth/tokens', { name: 'scim' })).token;
  const scim = (method, p, body) => fetch(t.url + p, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/scim+json' }, body: body ? JSON.stringify(body) : undefined });
  const created = await scim('POST', '/scim/v2/Users', { userName: 'grace@example.com', displayName: 'Grace Hopper', externalId: 'ext-9', emails: [{ value: 'grace@example.com', primary: true }] });
  assert.equal(created.status, 201);
  const u = await created.json();
  assert.equal(u.userName, 'grace');
  assert.equal(u.active, true);
  const list = await (await scim('GET', '/scim/v2/Users?filter=' + encodeURIComponent('userName eq "grace"'))).json();
  assert.equal(list.totalResults, 1);
  const patched = await (await scim('PATCH', `/scim/v2/Users/${u.id}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'active', value: false }] })).json();
  assert.equal(patched.active, false);
  assert.equal((await scim('DELETE', `/scim/v2/Users/${u.id}`)).status, 204);
  assert.equal((await scim('GET', '/scim/v2/Users/999999')).status, 404);
  const bob = await t.as('bob');
  const btok = (await bob.ok('POST', '/api/v1/auth/tokens', { name: 'x' })).token;
  assert.equal((await fetch(t.url + '/scim/v2/Users', { headers: { authorization: `Bearer ${btok}` } })).status, 401);
});

test('[F:llm-answer] GraphRAG answer synthesis with Claude (mocked endpoint)', async () => {
  await admin.ok('PUT', '/api/v1/admin/settings', { settings: { llm: { provider: 'anthropic', apiKey: 'sk-test', baseUrl: llmUrl, effort: 'low' } } });
  const bob = await t.as('bob');
  const r = await bob.ok('POST', '/api/v1/graphrag/query', { query: 'Who owns the billing service?', answer: true });
  assert.equal(r.answer, 'The Payments Team owns billing [1].');
  assert.equal(r.model, 'claude-opus-5-5');
  const req = llmRequests.at(-1);
  assert.match(req.url, /\/v1\/messages/);
  assert.equal(req.headers['x-api-key'], 'sk-test');
  assert.equal(req.body.model, 'claude-opus-5-5');
  assert.deepEqual(req.body.thinking, { type: 'adaptive' });
  assert.equal(req.body.output_config.effort, 'low');
  assert.equal(req.body.fallbacks, 'default');
  assert.match(req.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.match(req.body.messages[0].content, /\[1\] .*Billing Service/);
  // flag off -> no answer synthesis
  await admin.ok('PUT', '/api/v1/admin/settings', { flags: { 'graphrag.answer': { enabled: false } } });
  const r2 = await bob.ok('POST', '/api/v1/graphrag/query', { query: 'Who owns the billing service?', answer: true });
  assert.equal(r2.answer, undefined);
  await admin.ok('PUT', '/api/v1/admin/settings', { flags: { 'graphrag.answer': { enabled: true } } });
  // LLM errors degrade gracefully
  await admin.ok('PUT', '/api/v1/admin/settings', { settings: { llm: { provider: 'anthropic', apiKey: 'sk-test', baseUrl: 'http://127.0.0.1:1' } } });
  const r3 = await bob.ok('POST', '/api/v1/graphrag/query', { query: 'billing', answer: true });
  assert.match(r3.error, /LLM/);
  assert.ok(r3.chunks.length > 0, 'retrieval still returned');
});
