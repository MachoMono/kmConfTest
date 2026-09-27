import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { zipSync } from 'fflate';
import { httpError } from '../auth.js';
import { now } from '../db.js';
import { DEFAULT_FLAGS } from '../app.js';
import { makeEmbedder } from '../embed.js';
import { splitFrontmatter, joinFrontmatter, normalizeTag } from '../../shared/doc.js';

const SETTING_KEYS = ['site_name', 'anonymous_access', 'space_creation', 'stale_days', 'max_attachment_mb', 'email_enabled', 'banner', 'maintenance', 'llm', 'embedding', 'oidc', 'smtp'];
const SECRET_PATHS = [['llm', 'apiKey'], ['embedding', 'apiKey'], ['oidc', 'clientSecret'], ['smtp', 'password']];

function redact(settings) {
  const out = JSON.parse(JSON.stringify(settings));
  for (const [k, f] of SECRET_PATHS) if (out[k] && out[k][f]) out[k][f] = '••••••••';
  return out;
}

/** Rename/merge (to != null) or delete (to == null) a tag across every page, in one commit. */
export function retag(app, user, from, to) { return app.pages.withLock(() => retagLocked(app, user, from, to)); }

async function retagLocked(app, user, from, to) {
  from = normalizeTag(from);
  to = to == null ? null : normalizeTag(to);
  if (!from) throw httpError(400, 'Tag required');
  const rows = app.db.all('SELECT DISTINCT p.id, p.path FROM page_tags t JOIN pages p ON p.id = t.page_id WHERE t.tag = ? OR t.tag LIKE ?', from, from + '/%');
  const esc = from.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const inline = new RegExp(`(^|[\\s([{,;:!?"'>])#${esc}(?=$|/|[^\\p{L}\\p{N}_\\-/])`, 'giu');
  const writes = [];
  for (const r of rows) {
    const text = await app.git.readFile(r.path);
    if (text == null) continue;
    const { data, body } = splitFrontmatter(text);
    const tags = [].concat(data.tags || []).map(String).map(t => {
      const n = normalizeTag(t);
      if (n === from) return to;
      if (n.startsWith(from + '/')) return to ? to + n.slice(from.length) : null;
      return t;
    }).filter(Boolean);
    // rewrite inline #tags outside of code fences
    const parts = body.split(/(^```[\s\S]*?^```[ \t]*$)/m);
    const nb = parts.map((seg, i) => i % 2 ? seg : seg.replace(inline, (_m, pre) => to ? `${pre}#${to}` : `${pre}${from}`)).join('');
    const nd = { ...data, tags: [...new Set(tags)] };
    const out = joinFrontmatter(nd, nb);
    if (out !== text) writes.push({ path: r.path, content: out });
  }
  if (!writes.length) return { pages: 0 };
  await app.pages.commitAndIndex({ writes, user, indexPaths: writes.map(w => w.path),
    message: to ? `Rename tag #${from} → #${to} on ${writes.length} page(s)` : `Remove tag #${from} from ${writes.length} page(s)` });
  app.audit(user, to ? 'tag.rename' : 'tag.delete', from, { to, pages: writes.length });
  return { pages: writes.length };
}

export default function (r, app) {
  const km = (ctx) => app.perms.assertKm(ctx.user);
  const admin = (ctx) => app.perms.assertAdmin(ctx.user);

  // ---- overview -------------------------------------------------------------------------------
  r.get('/api/v1/admin/overview', async (ctx) => {
    km(ctx);
    const h = app.health.report();
    const a = app.health.analytics({ days: 30 });
    const head = await app.git.head();
    const commits = Number((await app.git.run(['rev-list', '--count', 'HEAD'])).trim());
    return { health: { score: h.score, totals: h.totals }, totals: a.totals, activeUsers: a.activeUsers, git: { head, commits, sync: app.sync.publicStatus() },
      openConflicts: h.totals.openConflicts, uptime: process.uptime(), memory: process.memoryUsage().rss, node: process.version };
  }, { auth: true });

  // ---- users & groups ---------------------------------------------------------------------------
  r.get('/api/v1/admin/users', (ctx) => { km(ctx); return app.users.list(); }, { auth: true });
  r.post('/api/v1/admin/users', async (ctx) => {
    admin(ctx);
    const b = await ctx.json();
    const u = app.users.create({ username: b.username, password: b.password, email: b.email, name: b.name, role: b.role || 'user' });
    if (Array.isArray(b.groups)) for (const g of b.groups) app.users.addToGroup(g, u.id);
    app.audit(ctx.user, 'user.create', u.username, { role: u.role }, ctx.ip);
    return app.users.publicUser(u);
  }, { auth: true });
  r.put('/api/v1/admin/users/:username', async (ctx) => {
    admin(ctx);
    const u = app.users.byUsername(ctx.params.username);
    if (!u) throw httpError(404, 'User not found');
    const b = await ctx.json();
    if (u.id === ctx.user.id && (b.role && b.role !== 'admin' || b.active === false)) throw httpError(400, 'You cannot demote or deactivate yourself');
    const nu = app.users.update(u.id, { email: b.email, name: b.name, role: b.role, active: b.active, password: b.password });
    app.audit(ctx.user, 'user.update', u.username, { ...b, password: b.password ? '***' : undefined }, ctx.ip);
    return app.users.publicUser(nu);
  }, { auth: true });

  r.get('/api/v1/admin/groups', (ctx) => { km(ctx); return app.users.listGroups(); }, { auth: true });
  r.post('/api/v1/admin/groups', async (ctx) => {
    admin(ctx);
    const b = await ctx.json();
    const g = app.users.createGroup(String(b.name || ''), b.description || '');
    if (Array.isArray(b.users)) app.users.setGroupMembers(g.name, b.users);
    app.audit(ctx.user, 'group.create', g.name, null, ctx.ip);
    return g;
  }, { auth: true });
  r.put('/api/v1/admin/groups/:name', async (ctx) => {
    admin(ctx);
    const b = await ctx.json();
    const g = app.users.setGroupMembers(ctx.params.name, b.users || []);
    if (b.description !== undefined) app.db.run('UPDATE groups SET description = ? WHERE id = ?', b.description, g.id);
    app.audit(ctx.user, 'group.update', ctx.params.name, { users: b.users }, ctx.ip);
    return app.users.listGroups().find(x => x.name === g.name);
  }, { auth: true });
  r.delete('/api/v1/admin/groups/:name', (ctx) => { admin(ctx); app.users.deleteGroup(ctx.params.name); app.audit(ctx.user, 'group.delete', ctx.params.name, null, ctx.ip); return { ok: true }; }, { auth: true });

  // ---- spaces (KM view incl. archived) ---------------------------------------------------------
  r.get('/api/v1/admin/spaces', (ctx) => {
    km(ctx);
    return app.db.all(`SELECT s.*, (SELECT COUNT(*) FROM pages p WHERE p.space = s.key) AS pages FROM spaces s ORDER BY s.name`)
      .map(s => ({ ...s, archived: !!s.archived, permissions: app.perms.spacePerms(s.key) }));
  }, { auth: true });

  // ---- settings & feature flags -----------------------------------------------------------------
  r.get('/api/v1/admin/settings', (ctx) => {
    km(ctx);
    const s = {};
    for (const k of SETTING_KEYS) s[k] = app.settings.get(k, null);
    return { settings: redact(s), flags: { ...Object.fromEntries(Object.entries(DEFAULT_FLAGS).map(([k, v]) => [k, { ...v }])), ...app.settings.get('flags', {}) } };
  }, { auth: true });
  r.put('/api/v1/admin/settings', async (ctx) => {
    admin(ctx);
    const b = await ctx.json();
    for (const [k, v] of Object.entries(b.settings || {})) {
      if (!SETTING_KEYS.includes(k)) throw httpError(400, `Unknown setting ${k}`);
      let val = v;
      // keep existing secrets when the redacted placeholder is sent back
      for (const [sk, f] of SECRET_PATHS) if (sk === k && val && val[f] === '••••••••') val = { ...val, [f]: (app.settings.get(k, {}) || {})[f] };
      app.settings.set(k, val);
      if (k === 'embedding') app.embedder = makeEmbedder(val || { provider: 'local' });
    }
    if (b.flags) {
      for (const [k, f] of Object.entries(b.flags)) {
        if (f.rollout !== undefined && (f.rollout < 0 || f.rollout > 100)) throw httpError(400, 'rollout must be 0-100');
      }
      app.settings.set('flags', { ...app.settings.get('flags', {}), ...b.flags });
    }
    app.audit(ctx.user, 'settings.update', null, { keys: Object.keys(b.settings || {}), flags: Object.keys(b.flags || {}) }, ctx.ip);
    return { ok: true };
  }, { auth: true });

  // ---- audit -----------------------------------------------------------------------------------
  r.get('/api/v1/admin/audit', (ctx) => {
    km(ctx);
    const where = [], args = [];
    if (ctx.query.user) { where.push('username = ?'); args.push(ctx.query.user); }
    if (ctx.query.action) { where.push('action LIKE ?'); args.push(ctx.query.action + '%'); }
    if (ctx.query.target) { where.push('target = ?'); args.push(ctx.query.target); }
    if (ctx.query.since) { where.push('ts >= ?'); args.push(ctx.query.since); }
    const rows = app.db.all(`SELECT * FROM audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`, ...args, Math.min(Number(ctx.query.limit) || 200, 5000));
    if (ctx.query.format === 'csv') {
      const q = (s) => '"' + String(s ?? '').replace(/"/g, '""') + '"';
      const csv = 'ts,username,action,target,ip,details\n' + rows.map(x => [x.ts, x.username, x.action, x.target, x.ip, x.details].map(q).join(',')).join('\n');
      return ctx.send(200, csv, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="audit.csv"' });
    }
    return rows.map(x => ({ ...x, details: x.details ? JSON.parse(x.details) : null }));
  }, { auth: true });

  // ---- content health & analytics ----------------------------------------------------------------
  r.get('/api/v1/admin/health', (ctx) => { km(ctx); return app.health.report({ staleDays: ctx.query.staleDays }); }, { auth: true });
  r.post('/api/v1/admin/health/remind', (ctx) => { km(ctx); return { notified: app.health.remindReviews() }; }, { auth: true });
  r.get('/api/v1/admin/analytics', (ctx) => { km(ctx); return app.health.analytics({ days: Math.min(Number(ctx.query.days) || 30, 365) }); }, { auth: true });

  // ---- merge / conflict review ------------------------------------------------------------------
  r.get('/api/v1/admin/conflicts', (ctx) => {
    km(ctx);
    return app.db.all(`SELECT c.*, p.title, u.username FROM conflicts c LEFT JOIN pages p ON p.id = c.page_id LEFT JOIN users u ON u.id = c.user_id
      WHERE c.status = ? ORDER BY c.id DESC LIMIT 200`, ctx.query.status || 'open').map(c => ({ ...c, details: JSON.parse(c.details || '{}') }));
  }, { auth: true });
  r.post('/api/v1/admin/conflicts/:id', async (ctx) => {
    km(ctx);
    const c = app.db.get('SELECT * FROM conflicts WHERE id = ?', Number(ctx.params.id));
    if (!c) throw httpError(404, 'Conflict not found');
    const { action = 'dismiss' } = await ctx.json();
    if (action === 'restore') {
      const d = JSON.parse(c.details || '{}');
      const row = c.page_id && app.pages.row(c.page_id);
      if (!row) throw httpError(404, 'Page no longer exists');
      const cur = await app.pages.read(row.id);
      let body = cur.body;
      const recovered = [];
      const done = new Set();
      for (const x of d.conflicts || []) {
        if (x.field) continue;
        if (x.regionKept !== undefined) {
          if (done.has(x.regionKept)) continue;
          done.add(x.regionKept);
          if (x.regionKept && body.includes(x.regionKept)) body = body.replace(x.regionKept, x.regionDiscarded);
          else recovered.push(x.regionDiscarded);
        } else if (x.discarded) recovered.push(x.discarded);
      }
      if (recovered.length) body = body.replace(/\s*$/, '\n\n') + `> [!note] Recovered text\n${recovered.map(t => '> ' + t.replace(/\n/g, '\n> ')).join('\n>\n')}\n`;
      await app.pages.update(ctx.user, row.id, { markdown: body, baseRev: row.rev, message: `Restore overlapping edit on "${row.title}"` });
    }
    app.db.run('UPDATE conflicts SET status = ? WHERE id = ?', action === 'restore' ? 'restored' : 'dismissed', c.id);
    app.audit(ctx.user, 'conflict.' + action, c.page_id, { conflict: c.id }, ctx.ip);
    return { ok: true };
  }, { auth: true });

  // ---- git sync ---------------------------------------------------------------------------------
  r.get('/api/v1/admin/git', async (ctx) => {
    km(ctx);
    const log = await app.git.activity({ limit: 30, pathspec: '.' });
    return { status: app.sync.publicStatus(), log: log.map(c => ({ rev: c.rev, author: c.author, date: c.date, message: c.message, files: c.files.length })) };
  }, { auth: true });
  r.put('/api/v1/admin/git', async (ctx) => {
    admin(ctx);
    const b = await ctx.json();
    if (b.token === '••••••••') b.token = (app.settings.get('git_remote') || {}).token;
    const st = await app.sync.configure(b);
    app.audit(ctx.user, 'git.configure', null, { url: b.url, branch: b.branch }, ctx.ip);
    if (b.webhookSecret !== undefined) app.settings.set('github_webhook_secret', b.webhookSecret || null);
    return st;
  }, { auth: true });
  r.post('/api/v1/admin/git/sync', async (ctx) => { km(ctx); return app.sync.syncNow({ user: ctx.user }); }, { auth: true });

  // ---- tags -------------------------------------------------------------------------------------
  r.post('/api/v1/admin/tags/rename', async (ctx) => { km(ctx); const b = await ctx.json(); if (!b.to) throw httpError(400, 'Target tag required'); return retag(app, ctx.user, b.from, b.to); }, { auth: true });
  r.post('/api/v1/admin/tags/delete', async (ctx) => { km(ctx); const b = await ctx.json(); return retag(app, ctx.user, b.tag, null); }, { auth: true });

  // ---- webhooks ----------------------------------------------------------------------------------
  r.get('/api/v1/admin/webhooks', (ctx) => { admin(ctx); return app.db.all('SELECT id, url, events, active, created_at, last_status FROM webhooks ORDER BY id'); }, { auth: true });
  r.post('/api/v1/admin/webhooks', async (ctx) => {
    admin(ctx);
    const b = await ctx.json();
    if (!/^https?:\/\//.test(b.url || '')) throw httpError(400, 'Webhook URL must be http(s)');
    const secret = b.secret || crypto.randomBytes(16).toString('hex');
    const res = app.db.run('INSERT INTO webhooks (url, events, secret, active, created_at) VALUES (?,?,?,1,?)', b.url, (b.events || ['*']).join(','), secret, now());
    app.audit(ctx.user, 'webhook.create', b.url, null, ctx.ip);
    return { id: Number(res.lastInsertRowid), url: b.url, secret };
  }, { auth: true });
  r.delete('/api/v1/admin/webhooks/:id', (ctx) => { admin(ctx); app.db.run('DELETE FROM webhooks WHERE id = ?', Number(ctx.params.id)); app.audit(ctx.user, 'webhook.delete', ctx.params.id, null, ctx.ip); return { ok: true }; }, { auth: true });
  r.post('/api/v1/admin/webhooks/:id/test', (ctx) => {
    admin(ctx);
    app.events.fireWebhooks('ping', { event: 'ping', at: now() });
    return { sent: true };
  }, { auth: true });

  // ---- email outbox ------------------------------------------------------------------------------
  r.get('/api/v1/admin/outbox', (ctx) => { admin(ctx); return app.db.all('SELECT * FROM email_outbox ORDER BY id DESC LIMIT 200'); }, { auth: true });
  r.post('/api/v1/admin/outbox/flush', async (ctx) => { admin(ctx); return app.mailer.flush(500); }, { auth: true });

  // ---- maintenance -------------------------------------------------------------------------------
  r.post('/api/v1/admin/reindex', async (ctx) => {
    admin(ctx);
    await app.reloadOntology();
    app.embedder = makeEmbedder(app.settings.get('embedding', { provider: 'local' }));
    const res = await app.indexer.rebuild();
    app.settings.set('indexed_head', await app.git.head());
    app.audit(ctx.user, 'index.rebuild', null, res, ctx.ip);
    return res;
  }, { auth: true });
  r.get('/api/v1/admin/backup', async (ctx) => {
    admin(ctx);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gwbak-'));
    try {
      const bundle = path.join(tmp, 'repo.bundle');
      await app.git.exclusive(() => app.git.run(['bundle', 'create', bundle, '--all']));
      const dbFile = path.join(tmp, 'gitwiki.db');
      app.db.exec(`VACUUM INTO '${dbFile.replace(/'/g, "''")}'`);
      const zip = zipSync({ 'repo.bundle': fs.readFileSync(bundle), 'gitwiki.db': fs.readFileSync(dbFile),
        'RESTORE.txt': new TextEncoder().encode('git clone repo.bundle repo && copy gitwiki.db next to it in GITWIKI_DATA.\n') });
      app.audit(ctx.user, 'backup.download', null, { bytes: zip.length }, ctx.ip);
      ctx.send(200, Buffer.from(zip), { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="gitwiki-backup-${now().slice(0, 10)}.zip"` });
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }, { auth: true });
}
