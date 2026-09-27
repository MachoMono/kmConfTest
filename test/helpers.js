// Test harness: boots an isolated GitWiki (temp data dir) and provides per-user HTTP clients.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { seed } from '../scripts/seed-data.js';

export const ADMIN_PASSWORD = 'admin-password-1';

export async function startApp({ seeded = true, extra = {}, dataDir } = {}) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'gitwiki-test-'));
  const app = await createApp({ dataDir: dir, adminPassword: ADMIN_PASSWORD, quiet: true, syncIntervalSec: 0, ...extra });
  await app.listen(0, '127.0.0.1');
  const ctx = { app, dir, url: app.url };
  if (seeded) Object.assign(ctx, await seed(app));
  ctx.client = (username, password) => client(app.url, username, password);
  ctx.as = async (username) => {
    const pw = username === 'admin' ? ADMIN_PASSWORD : `password-${username}`;
    const c = client(app.url);
    await c.login(username, pw);
    return c;
  };
  ctx.stop = async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return ctx;
}

export function client(base, username, password) {
  let cookie = '';
  let token = null;
  const req = async (method, p, body, { raw, headers = {}, expect } = {}) => {
    const h = { 'x-gitwiki-csrf': '1', ...headers };
    if (cookie) h.cookie = cookie;
    if (token) h.authorization = `Bearer ${token}`;
    let payload;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const res = await fetch(base + p, { method, headers: h, body: payload, redirect: 'manual' });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    const data = ct.includes('json') ? (buf.length ? JSON.parse(buf.toString()) : null) : ct.startsWith('text') || ct.includes('xml') || ct.includes('turtle') ? buf.toString() : buf;
    if (expect !== undefined && res.status !== expect) throw new Error(`${method} ${p} expected ${expect} got ${res.status}: ${buf.toString().slice(0, 300)}`);
    return { status: res.status, data, headers: res.headers };
  };
  const c = {
    req,
    get: (p, o) => req('GET', p, undefined, o),
    post: (p, b, o) => req('POST', p, b ?? {}, o),
    put: (p, b, o) => req('PUT', p, b ?? {}, o),
    patch: (p, b, o) => req('PATCH', p, b ?? {}, o),
    del: (p, o) => req('DELETE', p, undefined, o),
    // JSON helpers that assert success
    async ok(method, p, b) { const r = await req(method, p, b); if (r.status >= 400) throw new Error(`${method} ${p} -> ${r.status} ${JSON.stringify(r.data)}`); return r.data; },
    async login(u, pw) { const r = await req('POST', '/api/v1/auth/login', { username: u, password: pw }); if (r.status !== 200) throw new Error('login failed ' + JSON.stringify(r.data)); return r.data; },
    useToken(t) { token = t; cookie = ''; },
    get cookie() { return cookie; },
  };
  if (username) c.ready = c.login(username, password);
  return c;
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export async function until(fn, { timeout = 5000, interval = 50 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('until: timed out');
    await sleep(interval);
  }
}
