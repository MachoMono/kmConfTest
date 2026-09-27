import { httpError } from '../auth.js';
import { now } from '../db.js';
import { mimeOf } from '../http.js';
import { renderMarkdown, escapeHtml } from '../../shared/markdown.js';
import { importConfluence, importMarkdown, exportSpace } from '../importers.js';

export function pageDto(app, row) {
  if (!row) return null;
  return {
    id: row.id, title: row.title, space: row.space, kind: row.kind, type: row.type, parent: row.parent, sort: row.sort,
    tags: JSON.parse(row.tags || '[]'), aliases: JSON.parse(row.aliases || '[]'), props: JSON.parse(row.props || '{}'),
    excerpt: row.excerpt, status: row.status, owner: row.owner, rev: row.rev, path: row.path,
    created_at: row.created_at, created_by: row.created_by, updated_at: row.updated_at, updated_by: row.updated_by,
    archived: !!row.archived, review_by: row.review_by, words: row.words,
  };
}

function breadcrumbs(app, row) {
  const out = [];
  let cur = row, guard = 0;
  while (cur && cur.parent && guard++ < 30) { cur = app.pages.row(cur.parent); if (cur) out.unshift({ id: cur.id, title: cur.title }); }
  return out;
}

export function spaceTree(app, user, key) {
  const canView = app.perms.viewFilter(user);
  const rows = app.db.all("SELECT id, title, parent, sort, type, archived, kind, space FROM pages WHERE space = ? AND kind = 'page' ORDER BY sort, title", key)
    .filter(canView);
  const ids = new Set(rows.map(r => r.id));
  return rows.map(r => ({ id: r.id, title: r.title, parent: r.parent && ids.has(r.parent) ? r.parent : null, sort: r.sort, type: r.type, archived: !!r.archived }));
}

export default function (r, app) {
  const P = app.pages;
  const viewable = (ctx, id, action = 'view') => { const row = P.row(id); app.perms.assert(ctx.user, action, row); return row; };

  // ---- spaces ------------------------------------------------------------------------------
  r.get('/api/v1/spaces', (ctx) => {
    const rows = app.db.all(`SELECT s.*, (SELECT COUNT(*) FROM pages p WHERE p.space = s.key AND p.archived = 0) AS pages,
      (SELECT MAX(updated_at) FROM pages p WHERE p.space = s.key) AS updated_at FROM spaces s ORDER BY s.name`);
    return rows.filter(s => app.perms.canSpace(ctx.user, 'view', s.key) && (ctx.query.archived === '1' || !s.archived))
      .map(s => ({ ...s, archived: !!s.archived, role: app.perms.spaceRole(ctx.user, s.key), watching: ctx.user ? app.notify.isWatching(ctx.user.id, 'space', s.key) : false }));
  }, { public: true });

  r.post('/api/v1/spaces', async (ctx) => {
    if (!ctx.user || ctx.user.role === 'guest') throw httpError(403, 'Guests cannot create spaces');
    if (app.settings.get('space_creation', 'all') === 'km' && !app.perms.isKm(ctx.user)) throw httpError(403, 'Only knowledge managers can create spaces');
    const b = await ctx.json();
    const res = await P.createSpace(ctx.user, b);
    app.audit(ctx.user, 'space.create', res.key, { name: b.name }, ctx.ip);
    return res;
  }, { auth: true });

  r.get('/api/v1/spaces/:key', (ctx) => {
    const key = ctx.params.key.toUpperCase();
    const s = app.db.get('SELECT * FROM spaces WHERE key = ?', key);
    if (!s) throw httpError(404, 'Space not found');
    app.perms.assertSpace(ctx.user, 'view', key);
    return { ...s, archived: !!s.archived, role: app.perms.spaceRole(ctx.user, key), tree: spaceTree(app, ctx.user, key),
      watching: ctx.user ? app.notify.isWatching(ctx.user.id, 'space', key) : false };
  }, { public: true });

  r.put('/api/v1/spaces/:key', async (ctx) => {
    const key = ctx.params.key.toUpperCase();
    app.perms.assertSpace(ctx.user, 'admin', key);
    const b = await ctx.json();
    if (b.home && (!P.row(b.home) || P.row(b.home).space !== key)) throw httpError(400, 'Home page must be in this space');
    const s = await P.updateSpace(ctx.user, key, b);
    app.audit(ctx.user, 'space.update', key, b, ctx.ip);
    return s;
  }, { auth: true });

  r.get('/api/v1/spaces/:key/permissions', (ctx) => {
    const key = ctx.params.key.toUpperCase();
    app.perms.assertSpace(ctx.user, 'admin', key);
    return app.perms.spacePerms(key);
  }, { auth: true });
  r.put('/api/v1/spaces/:key/permissions', async (ctx) => {
    const key = ctx.params.key.toUpperCase();
    app.perms.assertSpace(ctx.user, 'admin', key);
    const b = await ctx.json();
    if (!Array.isArray(b.entries)) throw httpError(400, 'entries[] required');
    if (!b.entries.some(e => e.role === 'admin') && !app.perms.isKm(ctx.user)) throw httpError(400, 'A space needs at least one administrator');
    app.perms.setSpacePerms(key, b.entries);
    app.audit(ctx.user, 'space.permissions', key, b.entries, ctx.ip);
    return app.perms.spacePerms(key);
  }, { auth: true });

  r.post('/api/v1/spaces/:key/watch', async (ctx) => {
    const key = ctx.params.key.toUpperCase();
    app.perms.assertSpace(ctx.user, 'view', key);
    const { watch = true } = await ctx.json();
    if (watch) app.notify.watch(ctx.user.id, 'space', key); else app.notify.unwatch(ctx.user.id, 'space', key);
    return { watching: !!watch };
  }, { auth: true });

  r.get('/api/v1/spaces/:key/blog', (ctx) => {
    const key = ctx.params.key.toUpperCase();
    app.perms.assertSpace(ctx.user, 'view', key);
    const canView = app.perms.viewFilter(ctx.user);
    return app.db.all("SELECT * FROM pages WHERE space = ? AND kind = 'blog' AND archived = 0 ORDER BY created_at DESC LIMIT 100", key).filter(canView).map(p => pageDto(app, p));
  }, { public: true });

  r.get('/api/v1/spaces/:key/export', async (ctx) => {
    const key = ctx.params.key.toUpperCase();
    app.perms.assertSpace(ctx.user, 'admin', key);
    const buf = await exportSpace(app, key);
    app.audit(ctx.user, 'space.export', key, { bytes: buf.length }, ctx.ip);
    ctx.send(200, buf, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${key}.zip"` });
  }, { auth: true });

  r.post('/api/v1/spaces/:key/import', async (ctx) => {
    const key = ctx.params.key.toUpperCase();
    app.perms.assertSpace(ctx.user, 'admin', key);
    const buf = await ctx.raw(200 * 1024 * 1024);
    const format = ctx.query.format || 'markdown';
    const res = format === 'confluence' ? await importConfluence(app, ctx.user, key, buf, { parent: ctx.query.parent })
      : await importMarkdown(app, ctx.user, key, buf, { parent: ctx.query.parent });
    return res;
  }, { auth: true });

  // ---- pages -------------------------------------------------------------------------------
  r.get('/api/v1/pages/:id', async (ctx) => {
    const row = viewable(ctx, ctx.params.id);
    const { data, body } = await P.read(row.id);
    const rendered = await app.renderer.render(row, body, ctx.user);
    const canView = app.perms.viewFilter(ctx.user);
    const children = app.db.all("SELECT id, title, type, excerpt FROM pages WHERE parent = ? AND archived = 0 AND kind = 'page' ORDER BY sort, title", row.id).filter(p => canView({ ...p, space: row.space, parent: row.id }));
    const backlinks = app.db.all(`SELECT DISTINCT p.id, p.title, p.space, p.parent, l.kind FROM links l JOIN pages p ON p.id = l.src
      WHERE l.target_id = ? AND l.src != ? AND p.archived = 0 ORDER BY p.title`, row.id, row.id).filter(canView)
      .reduce((acc, b) => {
        const rel = b.kind.startsWith('rel:') ? b.kind.slice(4) : b.kind;
        const prev = acc.find(x => x.id === b.id);
        if (!prev) acc.push({ id: b.id, title: b.title, space: b.space, rel });
        else if (prev.rel === 'link' || prev.rel === 'embed') prev.rel = rel;
        return acc;
      }, []);
    const outgoing = app.db.all(`SELECT l.kind, l.target, l.target_id, p.title, p.space, p.parent FROM links l LEFT JOIN pages p ON p.id = l.target_id WHERE l.src = ? AND l.kind LIKE 'rel:%'`, row.id)
      .map(o => {
        const props = JSON.parse(row.props || '{}');
        const orig = [].concat(props[o.kind.slice(4)] || []).find(t => String(t).toLowerCase().replace(/\s+/g, ' ') === o.target) || o.target;
        const visible = o.target_id && canView({ id: o.target_id, space: o.space, parent: o.parent });
        return { rel: o.kind.slice(4), label: app.ontology.relationLabel(o.kind.slice(4)), target: orig, id: visible ? o.target_id : null, title: visible ? o.title : orig };
      });
    // Obsidian-style unlinked mentions: pages naming this page's title/aliases without linking to it
    const names = [row.title, ...JSON.parse(row.aliases || '[]')].filter(n => n && n.length >= 4);
    let unlinked = [];
    if (names.length) {
      const expr = names.map(n => 'body : "' + n.replace(/"/g, '""') + '"').join(' OR ');
      try {
        unlinked = app.db.all(`SELECT p.id, p.title, p.space, p.parent FROM pages_fts JOIN pages p ON p.rowid = pages_fts.rowid
          WHERE pages_fts MATCH ? AND p.id != ? AND p.archived = 0 AND p.id NOT IN (SELECT src FROM links WHERE target_id = ?) LIMIT 50`, expr, row.id, row.id)
          .filter(canView).slice(0, 15).map(u => ({ id: u.id, title: u.title, space: u.space }));
      } catch { unlinked = []; }
    }
    const typeOf = (t) => { const h = app.indexer.resolve(t, row.space); return h ? h.type : null; };
    const rels = outgoing.map(o => ({ rel: o.rel, target: o.target }));
    const fmData = {};
    for (const [k, v] of Object.entries(data)) if (typeof v !== 'object' || v === null) fmData[k] = v instanceof Date ? v.toISOString().slice(0, 10) : v;
    const ontologyIssues = app.ontology.validate({ type: row.type === 'Document' ? (data.type ? String(data.type) : null) : row.type, data: fmData, relations: rels, tags: JSON.parse(row.tags) }, typeOf);
    if (ctx.user) {
      app.db.run('INSERT INTO recent (user_id, page_id, ts) VALUES (?,?,?) ON CONFLICT(user_id, page_id) DO UPDATE SET ts = excluded.ts', ctx.user.id, row.id, now());
    }
    if (ctx.query.track !== '0') app.db.run('INSERT INTO views (page_id, user_id, ts) VALUES (?,?,?)', row.id, ctx.user ? ctx.user.id : null, now());
    const reactions = app.db.all("SELECT emoji, COUNT(*) AS n, MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine FROM reactions WHERE ttype = 'page' AND tid = ? GROUP BY emoji", ctx.user ? ctx.user.id : -1, row.id);
    return {
      page: pageDto(app, row), frontmatter: fmData, markdown: body, html: rendered.html, headings: rendered.headings,
      breadcrumbs: breadcrumbs(app, row), children, backlinks, unlinked, relations: outgoing, ontologyIssues,
      space: app.db.get('SELECT key, name, home_id FROM spaces WHERE key = ?', row.space),
      perms: { view: true, comment: app.perms.can(ctx.user, 'comment', row), edit: app.perms.can(ctx.user, 'edit', row), admin: app.perms.canSpace(ctx.user, 'admin', row.space) },
      watching: ctx.user ? app.notify.isWatching(ctx.user.id, 'page', row.id) : false,
      favorite: ctx.user ? !!app.db.get('SELECT 1 FROM favorites WHERE user_id = ? AND page_id = ?', ctx.user.id, row.id) : false,
      reactions: reactions.map(x => ({ emoji: x.emoji, count: x.n, mine: !!x.mine })),
      views: app.db.get('SELECT COUNT(*) AS n FROM views WHERE page_id = ?', row.id).n,
      restricted: app.db.get('SELECT COUNT(*) AS n FROM page_restrictions WHERE page_id = ?', row.id).n > 0,
      presence: app.events.present(row.id),
      commentCount: app.db.get('SELECT COUNT(*) AS n FROM comments WHERE page_id = ? AND deleted = 0', row.id).n,
    };
  }, { public: true });

  r.get('/api/v1/pages/:id/source', async (ctx) => {
    const row = viewable(ctx, ctx.params.id);
    const { text } = await P.read(row.id);
    ctx.send(200, text, { 'content-type': 'text/markdown; charset=utf-8' });
  }, { public: true });

  r.post('/api/v1/pages', async (ctx) => {
    const b = await ctx.json();
    const space = String(b.space || '').toUpperCase();
    app.perms.assertSpace(ctx.user, 'edit', space);
    if (b.parent) app.perms.assert(ctx.user, 'edit', P.row(b.parent)) ;
    const res = await P.create(ctx.user, { ...b, space });
    return { page: pageDto(app, res.page), rev: res.rev };
  }, { auth: true });

  r.put('/api/v1/pages/:id', async (ctx) => {
    viewable(ctx, ctx.params.id, 'edit');
    const b = await ctx.json();
    const res = await P.update(ctx.user, ctx.params.id, b);
    return { page: pageDto(app, res.page), rev: res.rev, merged: res.merged, conflicts: res.conflicts, unchanged: !!res.unchanged, markdown: res.markdown };
  }, { auth: true });

  r.delete('/api/v1/pages/:id', async (ctx) => {
    viewable(ctx, ctx.params.id, 'edit');
    return P.remove(ctx.user, ctx.params.id);
  }, { auth: true });

  r.post('/api/v1/pages/:id/move', async (ctx) => {
    const row = viewable(ctx, ctx.params.id, 'edit');
    const b = await ctx.json();
    if (b.space && b.space.toUpperCase() !== row.space) { app.perms.assertSpace(ctx.user, 'edit', b.space.toUpperCase()); }
    const res = await P.move(ctx.user, row.id, b);
    return { page: pageDto(app, res.page) };
  }, { auth: true });

  r.post('/api/v1/pages/:id/copy', async (ctx) => {
    const row = viewable(ctx, ctx.params.id);
    const b = await ctx.json();
    app.perms.assertSpace(ctx.user, 'edit', (b.space || row.space).toUpperCase());
    const res = await P.copy(ctx.user, row.id, b);
    return { page: pageDto(app, res.page) };
  }, { auth: true });

  r.post('/api/v1/pages/:id/archive', async (ctx) => {
    viewable(ctx, ctx.params.id, 'edit');
    const { archived = true } = await ctx.json();
    return { page: pageDto(app, (await P.setArchived(ctx.user, ctx.params.id, archived)).page) };
  }, { auth: true });

  r.post('/api/v1/pages/:id/labels', async (ctx) => {
    const row = viewable(ctx, ctx.params.id, 'edit');
    const { add = [], remove = [] } = await ctx.json();
    const { data } = await P.read(row.id);
    const tags = new Set([].concat(data.tags || []).map(String));
    for (const t of add) tags.add(String(t).replace(/^#/, '').trim().toLowerCase());
    for (const t of remove) tags.delete(String(t).replace(/^#/, ''));
    tags.delete('');
    const res = await P.update(ctx.user, row.id, { tags: [...tags], baseRev: row.rev, message: `Update labels on "${row.title}"` });
    return { tags: pageDto(app, res.page).tags };
  }, { auth: true });

  // turn an unlinked mention in another page into a [[link]] (first plain-text occurrence)
  r.post('/api/v1/pages/:id/link-mention', async (ctx) => {
    const target = viewable(ctx, ctx.params.id);
    const { source } = await ctx.json();
    const src = viewable(ctx, source, 'edit');
    const cur = await P.read(src.id);
    const names = [target.title, ...JSON.parse(target.aliases || '[]')].sort((a, b) => b.length - a.length);
    const parts = cur.body.split(/(```[\s\S]*?```|`[^`\n]*`|!?\[\[[^\]]*\]\]|\[[^\]]*\]\([^)]*\))/);
    let done = false;
    for (let i = 0; i < parts.length && !done; i += 2) {
      for (const n of names) {
        const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=$|[^\\p{L}\\p{N}])`, 'iu');
        if (re.test(parts[i])) {
          parts[i] = parts[i].replace(re, (_m, pre, word) => `${pre}[[${target.title}${word === target.title ? '' : '|' + word}]]`);
          done = true; break;
        }
      }
    }
    if (!done) throw httpError(409, 'No unlinked mention found');
    const res = await P.update(ctx.user, src.id, { markdown: parts.join(''), baseRev: src.rev, message: `Link mention of "${target.title}"` });
    return { rev: res.rev };
  }, { auth: true });

  r.post('/api/v1/pages/:id/share', async (ctx) => {
    const row = viewable(ctx, ctx.params.id);
    const { users = [], message = '' } = await ctx.json();
    const delivered = [], skipped = [];
    for (const un of users.slice(0, 50)) {
      const u = app.users.byUsername(String(un).replace(/^@/, ''));
      if (!u || !u.active || !app.perms.can(u, 'view', row)) { skipped.push(un); continue; }
      app.notify.notify(u.id, 'share', { page: row.id, title: row.title, by: ctx.user.username, text: String(message).slice(0, 500) });
      delivered.push(u.username);
    }
    app.audit(ctx.user, 'page.share', row.id, { delivered, skipped }, ctx.ip);
    return { delivered, skipped };
  }, { auth: true });

  r.post('/api/v1/pages/:id/tasks/:line', async (ctx) => {
    const row = viewable(ctx, ctx.params.id, 'edit');
    const { done } = await ctx.json();
    const res = await P.toggleTask(ctx.user, row.id, Number(ctx.params.line), !!done);
    return { rev: res.rev };
  }, { auth: true });

  // ---- history ------------------------------------------------------------------------------
  r.get('/api/v1/pages/:id/history', async (ctx) => { viewable(ctx, ctx.params.id); return P.history(ctx.params.id); }, { public: true });
  r.get('/api/v1/pages/:id/versions/:rev', async (ctx) => {
    const row = viewable(ctx, ctx.params.id);
    const v = await P.version(row.id, ctx.params.rev);
    return { rev: ctx.params.rev, title: v.data.title || row.title, markdown: v.body, html: app.renderer.base(row, v.body).html, frontmatter: v.data };
  }, { public: true });
  r.get('/api/v1/pages/:id/diff', async (ctx) => {
    viewable(ctx, ctx.params.id);
    if (!ctx.query.from) throw httpError(400, 'from is required');
    return P.diff(ctx.params.id, ctx.query.from, ctx.query.to);
  }, { public: true });
  r.post('/api/v1/pages/:id/restore', async (ctx) => {
    viewable(ctx, ctx.params.id, 'edit');
    const { rev } = await ctx.json();
    const res = await P.restoreVersion(ctx.user, ctx.params.id, String(rev || ''));
    return { page: pageDto(app, res.page), rev: res.rev };
  }, { auth: true });

  // ---- export -------------------------------------------------------------------------------
  r.get('/api/v1/pages/:id/export', async (ctx) => {
    const row = viewable(ctx, ctx.params.id);
    const { text, body } = await P.read(row.id);
    const fmt = ctx.query.format || 'md';
    const fname = row.slug || 'page';
    if (fmt === 'md') return ctx.send(200, text, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="${fname}.md"` });
    const r2 = await app.renderer.render(row, body, ctx.user);
    const site = escapeHtml(app.settings.get('site_name', 'GitWiki'));
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(row.title)}</title><link rel="stylesheet" href="/print.css"></head>
<body class="export"><header><div class="site">${site} · ${escapeHtml(row.space)}</div><h1>${escapeHtml(row.title)}</h1>
<div class="meta">Last updated ${escapeHtml(String(row.updated_at || '').slice(0, 10))} by ${escapeHtml(row.updated_by || '')} · version ${escapeHtml(String(row.rev || '').slice(0, 7))}</div></header>
<main>${r2.html}</main>${fmt === 'pdf' ? '<script src="/print.js"></script>' : ''}</body></html>`;
    ctx.send(200, html, { 'content-type': 'text/html; charset=utf-8', ...(fmt === 'html' ? { 'content-disposition': `attachment; filename="${fname}.html"` } : {}) });
  }, { public: true });

  // ---- attachments ----------------------------------------------------------------------------
  r.get('/api/v1/pages/:id/attachments', async (ctx) => { viewable(ctx, ctx.params.id); return P.attachments(ctx.params.id); }, { public: true });
  r.post('/api/v1/pages/:id/attachments', async (ctx) => {
    viewable(ctx, ctx.params.id, 'edit');
    const name = ctx.query.name || ctx.req.headers['x-filename'];
    if (!name) throw httpError(400, 'File name required (?name=)');
    const buf = await ctx.raw(app.settings.get('max_attachment_mb', 25) * 1024 * 1024 + 1024);
    return P.addAttachment(ctx.user, ctx.params.id, decodeURIComponent(name), buf);
  }, { auth: true });
  r.delete('/api/v1/pages/:id/attachments/:name', async (ctx) => {
    viewable(ctx, ctx.params.id, 'edit');
    await P.removeAttachment(ctx.user, ctx.params.id, ctx.params.name);
    return { ok: true };
  }, { auth: true });

  // raw repository files under a space (attachments/images), permission-checked
  r.get('/api/v1/files/:space/:rest*', async (ctx) => {
    const space = ctx.params.space.toUpperCase();
    const rel = ctx.params.rest;
    if (rel.split('/').some(s => s === '..' || s === '')) throw httpError(400, 'Bad path');
    const m = /^_attachments\/([^/]+)\//.exec(rel);
    if (m && m[1] !== '_shared') viewable(ctx, m[1]); else app.perms.assertSpace(ctx.user, 'view', space);
    const buf = await app.git.readFile(`spaces/${space}/${rel}`, null);
    if (!buf) throw httpError(404, 'File not found');
    const type = mimeOf(rel);
    ctx.send(200, buf, { 'content-type': type, 'cache-control': 'private, max-age=300',
      'content-disposition': /^(image|text\/plain|application\/pdf)/.test(type) && !/svg/.test(type) ? 'inline' : 'attachment',
      ...(type.includes('svg') ? { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {}) });
  }, { public: true });

  // ---- trash --------------------------------------------------------------------------------
  r.get('/api/v1/trash', (ctx) => {
    const rows = app.db.all('SELECT * FROM trash ORDER BY deleted_at DESC');
    return rows.filter(t => app.perms.canSpace(ctx.user, 'admin', t.space) || t.deleted_by === ctx.user.username);
  }, { auth: true });
  r.post('/api/v1/trash/:id/restore', async (ctx) => {
    const t = app.db.get('SELECT * FROM trash WHERE page_id = ?', ctx.params.id);
    if (!t) throw httpError(404, 'Not in trash');
    if (!app.perms.canSpace(ctx.user, 'admin', t.space) && t.deleted_by !== ctx.user.username) throw httpError(403, 'Only space admins or the deleter can restore');
    const res = await P.restoreFromTrash(ctx.user, ctx.params.id);
    return { page: pageDto(app, res.page) };
  }, { auth: true });
  r.delete('/api/v1/trash/:id', (ctx) => {
    const t = app.db.get('SELECT * FROM trash WHERE page_id = ?', ctx.params.id);
    if (!t) throw httpError(404, 'Not in trash');
    app.perms.assertSpace(ctx.user, 'admin', t.space);
    app.db.run('DELETE FROM trash WHERE page_id = ?', ctx.params.id);
    app.audit(ctx.user, 'trash.purge', ctx.params.id, { title: t.title }, ctx.ip);
    return { ok: true };
  }, { auth: true });

  // ---- templates ----------------------------------------------------------------------------
  r.get('/api/v1/templates', async () => (await P.templates()).map(({ body, ...t }) => ({ ...t, preview: body.slice(0, 400) })), { auth: true });
  r.get('/api/v1/templates/:id', async (ctx) => {
    const t = (await P.templates()).find(x => x.id === ctx.params.id);
    if (!t) throw httpError(404, 'Template not found');
    return t;
  }, { auth: true });
  r.put('/api/v1/templates/:id', async (ctx) => {
    app.perms.assertKm(ctx.user);
    const b = await ctx.json();
    const res = await P.saveTemplate(ctx.user, { ...b, id: ctx.params.id });
    app.audit(ctx.user, 'template.save', res.id, null, ctx.ip);
    return res;
  }, { auth: true });
  r.delete('/api/v1/templates/:id', async (ctx) => {
    app.perms.assertKm(ctx.user);
    await P.deleteTemplate(ctx.user, ctx.params.id);
    app.audit(ctx.user, 'template.delete', ctx.params.id, null, ctx.ip);
    return { ok: true };
  }, { auth: true });

  // ---- drafts (autosave) ------------------------------------------------------------------------
  r.get('/api/v1/drafts', (ctx) => app.db.all('SELECT key, page_id, space, parent, title, updated_at FROM drafts WHERE user_id = ? ORDER BY updated_at DESC', ctx.user.id), { auth: true });
  r.get('/api/v1/drafts/:key', (ctx) => {
    const d = app.db.get('SELECT * FROM drafts WHERE key = ? AND user_id = ?', ctx.params.key, ctx.user.id);
    if (!d) throw httpError(404, 'No draft');
    return d;
  }, { auth: true });
  r.put('/api/v1/drafts/:key', async (ctx) => {
    const b = await ctx.json();
    if (b.page_id) viewable(ctx, b.page_id, 'edit');
    app.db.run(`INSERT INTO drafts (key, user_id, page_id, space, parent, title, markdown, base_rev, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(key, user_id) DO UPDATE SET title=excluded.title, markdown=excluded.markdown, base_rev=excluded.base_rev, updated_at=excluded.updated_at,
      space=excluded.space, parent=excluded.parent`,
      ctx.params.key, ctx.user.id, b.page_id || null, b.space || null, b.parent || null, String(b.title || '').slice(0, 200), String(b.markdown || ''), b.base_rev || null, now());
    return { saved: now() };
  }, { auth: true });
  r.delete('/api/v1/drafts/:key', (ctx) => { app.db.run('DELETE FROM drafts WHERE key = ? AND user_id = ?', ctx.params.key, ctx.user.id); return { ok: true }; }, { auth: true });

  // ---- misc ---------------------------------------------------------------------------------------
  r.get('/api/v1/resolve', (ctx) => {
    const hit = app.indexer.resolve(String(ctx.query.title || ''), ctx.query.space ? ctx.query.space.toUpperCase() : undefined);
    if (!hit || !app.perms.can(ctx.user, 'view', hit)) return { page: null };
    return { page: { id: hit.id, title: hit.title, space: hit.space } };
  }, { public: true });

  r.post('/api/v1/preview', async (ctx) => {
    const b = await ctx.json();
    const page = b.page ? viewable(ctx, b.page) : { id: 'preview', space: String(b.space || '').toUpperCase(), title: b.title || '' };
    const out = await app.renderer.render(page, String(b.markdown || ''), ctx.user);
    return { html: out.html };
  }, { auth: true });

  r.post('/api/v1/render', async (ctx) => {
    // client-side editor loading: markdown -> editor HTML (no macro expansion)
    const b = await ctx.json();
    return { html: renderMarkdown(String(b.markdown || ''), {}) };
  }, { auth: true });
}
