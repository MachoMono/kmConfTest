import { SESSION_COOKIE } from '../app.js';
import { httpError } from '../auth.js';

export function cookie(app, value, maxAgeSec) {
  const secure = app.cfg.secureCookies ? '; Secure' : '';
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

function me(app, u) {
  if (!u) return { user: null };
  const pub = app.users.publicUser(u);
  return { user: { ...pub, prefs: JSON.parse(u.prefs || '{}'), isKm: app.perms.isKm(u), isAdmin: app.perms.isAdmin(u) } };
}

export default function (r, app) {
  r.get('/api/v1/config', (ctx) => ({
    siteName: app.settings.get('site_name', 'GitWiki'),
    anonymous: app.settings.get('anonymous_access', false),
    sso: app.oidc.enabled() ? { label: app.settings.get('oidc', {}).label || 'Single sign-on' } : null,
    banner: app.settings.get('banner', null),
    flags: Object.fromEntries(['search.graph_boost', 'graphrag.answer', 'editor.slash_menu'].map(f => [f, app.flag(f, ctx.user)])),
    llm: app.settings.get('llm', {}).provider === 'anthropic',
    version: '1.0.0',
  }), { public: true });

  r.post('/api/v1/auth/login', async (ctx) => {
    const { username, password } = await ctx.json();
    if (!username || !password) throw httpError(400, 'Username and password required');
    const u = app.users.authenticate(String(username), String(password), ctx.ip);
    const s = app.users.createSession(u.id, ctx.ip);
    app.audit(u, 'auth.login', u.username, null, ctx.ip);
    ctx.res.setHeader('set-cookie', cookie(app, s.token, app.cfg.sessionTtlHours * 3600));
    return me(app, u);
  }, { noCsrf: true, public: true });

  r.post('/api/v1/auth/logout', (ctx) => {
    app.users.destroySession(ctx.sid);
    ctx.res.setHeader('set-cookie', cookie(app, '', 0));
    return { ok: true };
  }, { public: true });

  r.get('/api/v1/auth/me', (ctx) => me(app, ctx.user), { public: true });

  r.put('/api/v1/auth/me', async (ctx) => {
    const b = await ctx.json();
    const patch = {};
    if (b.name !== undefined) patch.name = String(b.name).slice(0, 100);
    if (b.email !== undefined) patch.email = String(b.email).slice(0, 200) || null;
    if (b.prefs) patch.prefs = { ...JSON.parse(ctx.user.prefs || '{}'), ...b.prefs };
    if (b.newPassword) {
      if (!ctx.user.password_hash || !b.currentPassword) throw httpError(400, 'Current password required');
      app.users.authenticate(ctx.user.username, b.currentPassword, ctx.ip);
      patch.password = b.newPassword;
    }
    const u = app.users.update(ctx.user.id, patch);
    app.audit(u, 'user.profile', u.username, { fields: Object.keys(patch) }, ctx.ip);
    return me(app, u);
  }, { auth: true });

  // ---- API tokens --------------------------------------------------------------------------
  r.get('/api/v1/auth/tokens', (ctx) => app.db.all('SELECT id, name, created_at, last_used, expires_at FROM api_tokens WHERE user_id = ? ORDER BY id DESC', ctx.user.id), { auth: true });
  r.post('/api/v1/auth/tokens', async (ctx) => {
    const b = await ctx.json();
    const t = app.users.createApiToken(ctx.user.id, String(b.name || 'API token').slice(0, 80), b.expiresDays ? Number(b.expiresDays) : null);
    app.audit(ctx.user, 'token.create', t.id, { name: t.name }, ctx.ip);
    return t;
  }, { auth: true });
  r.delete('/api/v1/auth/tokens/:id', (ctx) => {
    const res = app.db.run('DELETE FROM api_tokens WHERE id = ? AND user_id = ?', Number(ctx.params.id), ctx.user.id);
    if (!res.changes) throw httpError(404, 'Token not found');
    app.audit(ctx.user, 'token.revoke', ctx.params.id, null, ctx.ip);
    return { ok: true };
  }, { auth: true });

  // ---- OIDC SSO ----------------------------------------------------------------------------
  const redirectUri = (ctx) => (app.cfg.baseUrl || `http://${ctx.req.headers.host}`) + '/api/v1/auth/oidc/callback';
  r.get('/api/v1/auth/oidc/login', async (ctx) => {
    if (!app.oidc.enabled()) throw httpError(404, 'SSO not configured');
    const url = await app.oidc.authorizeUrl(redirectUri(ctx), String(ctx.query.returnTo || '/').startsWith('/') ? ctx.query.returnTo || '/' : '/');
    ctx.send(302, '', { location: url });
  }, { public: true });
  r.get('/api/v1/auth/oidc/callback', async (ctx) => {
    if (!app.oidc.enabled()) throw httpError(404, 'SSO not configured');
    if (ctx.query.error) throw httpError(401, 'SSO error: ' + ctx.query.error);
    const { user, returnTo } = await app.oidc.callback(ctx.query, redirectUri(ctx));
    const s = app.users.createSession(user.id, ctx.ip);
    ctx.send(302, '', { location: returnTo || '/', 'set-cookie': cookie(app, s.token, app.cfg.sessionTtlHours * 3600) });
  }, { public: true });

  // ---- people directory (for @mentions) -------------------------------------------------------
  r.get('/api/v1/users', (ctx) => {
    const q = String(ctx.query.q || '').toLowerCase();
    return app.db.all(`SELECT username, name FROM users WHERE active = 1 AND (lower(username) LIKE ? OR lower(name) LIKE ?) ORDER BY username LIMIT 20`, q + '%', '%' + q + '%');
  }, { auth: true });
  r.get('/api/v1/users/:username', (ctx) => {
    const u = app.users.byUsername(ctx.params.username);
    if (!u || !u.active) throw httpError(404, 'User not found');
    const canView = app.perms.viewFilter(ctx.user);
    const recent = app.db.all('SELECT * FROM pages WHERE (updated_by = ? OR created_by = ?) AND archived = 0 ORDER BY updated_at DESC LIMIT 50', u.username, u.username)
      .filter(canView).slice(0, 15).map(p => ({ id: p.id, title: p.title, space: p.space, updated_at: p.updated_at }));
    return { username: u.username, name: u.name, email: u.email, role: u.role, groups: app.users.groupsOf(u.id).map(g => g.name), recent };
  }, { auth: true });
}
