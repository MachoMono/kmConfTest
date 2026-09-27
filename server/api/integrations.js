import crypto from 'node:crypto';
import { httpError } from '../auth.js';
import { handleMcp } from '../mcp.js';
import { send } from '../http.js';

export default function (r, app) {
  // ---- health probes --------------------------------------------------------------------------
  r.get('/healthz', () => ({ ok: true }), { public: true });
  r.get('/readyz', async () => {
    const head = await app.git.head();
    const pages = app.db.get('SELECT COUNT(*) AS n FROM pages').n;
    return { ok: !!head, head, pages };
  }, { public: true });

  // ---- MCP (Model Context Protocol) -----------------------------------------------------------
  r.post('/mcp', async (ctx) => {
    if (!ctx.user && !app.settings.get('anonymous_access', false)) {
      return ctx.send(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: send Authorization: Bearer <API token>' } },
        { 'www-authenticate': 'Bearer realm="gitwiki"' });
    }
    const out = await handleMcp(app, ctx.user, await ctx.json());
    if (out === null) return ctx.send(202, '');
    return out;
  }, { noCsrf: true, public: true });
  r.get('/mcp', (ctx) => ctx.send(405, { error: 'Use POST (Streamable HTTP, JSON responses)' }), { public: true });

  // ---- GitHub push webhook -> sync ------------------------------------------------------------
  r.post('/api/v1/webhooks/github', async (ctx) => {
    const secret = app.settings.get('github_webhook_secret', null);
    const raw = await ctx.raw();
    if (!secret) throw httpError(404, 'GitHub webhook not configured');
    const sig = String(ctx.req.headers['x-hub-signature-256'] || '');
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw httpError(401, 'Invalid signature');
    const event = ctx.req.headers['x-github-event'];
    if (event === 'ping') return { ok: true, pong: true };
    if (event !== 'push') return { ok: true, ignored: event };
    const res = await app.sync.syncNow();
    return { ok: true, result: res };
  }, { noCsrf: true, public: true });

  // ---- SCIM 2.0 user provisioning (admin API token) --------------------------------------------
  const scimUser = (u) => ({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], id: String(u.id), externalId: u.external_id || undefined, userName: u.username,
    name: { formatted: u.name }, displayName: u.name, active: !!u.active, emails: u.email ? [{ value: u.email, primary: true }] : [],
    groups: app.users.groupsOf(u.id).map(g => ({ value: String(g.id), display: g.name })),
    meta: { resourceType: 'User', created: u.created_at, location: `/scim/v2/Users/${u.id}` },
  });
  const scimAuth = (ctx) => {
    if (!ctx.user || ctx.via !== 'token' || ctx.user.role !== 'admin') throw httpError(401, 'SCIM requires an admin API token');
  };
  const scimErr = (ctx, status, detail) => send(ctx.res, status, { schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: String(status), detail }, { 'content-type': 'application/scim+json' });
  const wrap = (fn) => async (ctx) => {
    try { scimAuth(ctx); const out = await fn(ctx); if (out !== undefined) send(ctx.res, out.__status || 200, out.__status ? out.body : out, { 'content-type': 'application/scim+json' }); }
    catch (e) { scimErr(ctx, e.status || 500, e.message); }
  };

  r.get('/scim/v2/Users', wrap((ctx) => {
    let users = app.db.all('SELECT * FROM users ORDER BY id');
    const f = /^userName eq "([^"]+)"$/i.exec(ctx.query.filter || '');
    if (f) users = users.filter(u => u.username.toLowerCase() === f[1].toLowerCase());
    const start = Math.max(1, Number(ctx.query.startIndex) || 1), count = Math.min(Number(ctx.query.count) || 100, 500);
    return { schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: users.length, startIndex: start, itemsPerPage: count,
      Resources: users.slice(start - 1, start - 1 + count).map(scimUser) };
  }), { noCsrf: true, public: true });
  r.get('/scim/v2/Users/:id', wrap((ctx) => {
    const u = app.users.byId(Number(ctx.params.id));
    if (!u) throw httpError(404, 'User not found');
    return scimUser(u);
  }), { noCsrf: true, public: true });
  r.post('/scim/v2/Users', wrap(async (ctx) => {
    const b = await ctx.json();
    const username = String(b.userName || '').replace(/@.*$/, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '.');
    const email = (b.emails || []).find(e => e.primary)?.value || (b.emails || [])[0]?.value || (String(b.userName).includes('@') ? b.userName : null);
    const u = app.users.create({ username, email, name: b.displayName || b.name?.formatted || [b.name?.givenName, b.name?.familyName].filter(Boolean).join(' ') || username, external_id: b.externalId || null });
    if (b.active === false) app.users.update(u.id, { active: false });
    app.audit(ctx.user, 'scim.create', username, null, ctx.ip);
    return { __status: 201, body: scimUser(app.users.byId(u.id)) };
  }), { noCsrf: true, public: true });
  const patchUser = async (ctx) => {
    const u = app.users.byId(Number(ctx.params.id));
    if (!u) throw httpError(404, 'User not found');
    const b = await ctx.json();
    const patch = {};
    if (Array.isArray(b.Operations)) {
      for (const op of b.Operations) {
        const val = op.value;
        if ((op.path || '').toLowerCase() === 'active') patch.active = val === true || val === 'true' || val === 'True';
        else if (!op.path && val && typeof val === 'object') { if ('active' in val) patch.active = !!val.active; if (val.displayName) patch.name = val.displayName; }
        else if ((op.path || '').toLowerCase() === 'displayname') patch.name = val;
      }
    } else {
      if (b.active !== undefined) patch.active = !!b.active;
      if (b.displayName) patch.name = b.displayName;
      const email = (b.emails || [])[0]?.value; if (email) patch.email = email;
    }
    app.users.update(u.id, patch);
    app.audit(ctx.user, 'scim.update', u.username, patch, ctx.ip);
    return scimUser(app.users.byId(u.id));
  };
  r.patch('/scim/v2/Users/:id', wrap(patchUser), { noCsrf: true, public: true });
  r.put('/scim/v2/Users/:id', wrap(patchUser), { noCsrf: true, public: true });
  r.delete('/scim/v2/Users/:id', wrap((ctx) => {
    const u = app.users.byId(Number(ctx.params.id));
    if (!u) throw httpError(404, 'User not found');
    app.users.update(u.id, { active: false });
    app.audit(ctx.user, 'scim.deactivate', u.username, null, ctx.ip);
    return { __status: 204, body: '' };
  }), { noCsrf: true, public: true });
}
