import { httpError } from '../auth.js';
import { now } from '../db.js';
import { renderMarkdown } from '../../shared/markdown.js';
import { sanitize } from '../render.js';
import { pageDto } from './content.js';

const EMOJI = ['👍', '❤️', '🎉', '😄', '🤔', '👀', '🚀', '✅'];

export default function (r, app) {
  const viewable = (ctx, id, action = 'view') => { const row = app.pages.row(id); app.perms.assert(ctx.user, action, row); return row; };

  const commentDto = (c, userId) => {
    const u = app.users.byId(c.user_id);
    const reactions = app.db.all("SELECT emoji, COUNT(*) AS n, MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine FROM reactions WHERE ttype = 'comment' AND tid = ? GROUP BY emoji", userId ?? -1, String(c.id));
    return { id: c.id, parent_id: c.parent_id, body: c.deleted ? '' : c.body, html: c.deleted ? '<p class="muted">Comment deleted</p>' : sanitize(renderMarkdown(c.body, {})),
      anchor: c.anchor ? JSON.parse(c.anchor) : null, resolved: !!c.resolved, created_at: c.created_at, updated_at: c.updated_at, deleted: !!c.deleted,
      author: u ? { username: u.username, name: u.name } : null, reactions: reactions.map(x => ({ emoji: x.emoji, count: x.n, mine: !!x.mine })) };
  };

  // ---- comments -------------------------------------------------------------------------------
  r.get('/api/v1/pages/:id/comments', (ctx) => {
    viewable(ctx, ctx.params.id);
    return app.db.all('SELECT * FROM comments WHERE page_id = ? ORDER BY created_at, id', ctx.params.id).map(c => commentDto(c, ctx.user && ctx.user.id));
  }, { public: true });

  r.post('/api/v1/pages/:id/comments', async (ctx) => {
    const row = viewable(ctx, ctx.params.id, 'comment');
    const b = await ctx.json();
    const body = String(b.body || '').trim();
    if (!body) throw httpError(400, 'Comment cannot be empty');
    if (body.length > 20000) throw httpError(400, 'Comment too long');
    let parent = null;
    if (b.parent_id) {
      parent = app.db.get('SELECT * FROM comments WHERE id = ? AND page_id = ?', Number(b.parent_id), row.id);
      if (!parent) throw httpError(400, 'Parent comment not found');
    }
    let anchor = null;
    if (b.anchor && b.anchor.text) anchor = JSON.stringify({ text: String(b.anchor.text).slice(0, 500), prefix: String(b.anchor.prefix || '').slice(-60), suffix: String(b.anchor.suffix || '').slice(0, 60) });
    const res = app.db.run('INSERT INTO comments (page_id, parent_id, user_id, body, anchor, created_at) VALUES (?,?,?,?,?,?)',
      row.id, parent ? parent.id : null, ctx.user.id, body, anchor, now());
    const c = app.db.get('SELECT * FROM comments WHERE id = ?', Number(res.lastInsertRowid));
    const base = { page: row.id, title: row.title, by: ctx.user.username, text: body.slice(0, 300), comment: c.id };
    const notified = new Set([ctx.user.id]);
    if (parent && !notified.has(parent.user_id)) { app.notify.notify(parent.user_id, 'reply', base); notified.add(parent.user_id); }
    for (const m of body.matchAll(/(?:^|\s)@([A-Za-z0-9_][A-Za-z0-9._-]*[A-Za-z0-9_])/g)) {
      const u = app.users.byUsername(m[1]);
      if (u && !notified.has(u.id) && app.perms.can(u, 'view', row)) { app.notify.notify(u.id, 'mention', base); notified.add(u.id); }
    }
    for (const uid of app.notify.watchersOf(row)) if (!notified.has(uid)) { const u = app.users.byId(uid); if (u && app.perms.can(u, 'view', row)) app.notify.notify(uid, 'comment', base); }
    app.notify.watch(ctx.user.id, 'page', row.id);
    app.notify.broadcast('comment', { page: row.id, id: c.id });
    app.audit(ctx.user, 'comment.create', row.id, { comment: c.id }, ctx.ip);
    app.events.fireWebhooks('comment.created', { event: 'comment.created', page: { id: row.id, title: row.title, space: row.space }, comment: { id: c.id, body }, by: ctx.user.username, at: now() });
    return commentDto(c, ctx.user.id);
  }, { auth: true });

  const ownComment = (ctx) => {
    const c = app.db.get('SELECT * FROM comments WHERE id = ?', Number(ctx.params.cid));
    if (!c || c.deleted) throw httpError(404, 'Comment not found');
    const row = viewable(ctx, c.page_id);
    return { c, row };
  };
  r.put('/api/v1/comments/:cid', async (ctx) => {
    const { c, row } = ownComment(ctx);
    const b = await ctx.json();
    if (b.body !== undefined) {
      if (c.user_id !== ctx.user.id) throw httpError(403, 'You can only edit your own comments');
      if (!String(b.body).trim()) throw httpError(400, 'Comment cannot be empty');
      app.db.run('UPDATE comments SET body = ?, updated_at = ? WHERE id = ?', String(b.body), now(), c.id);
    }
    if (b.resolved !== undefined) {
      if (!app.perms.can(ctx.user, 'comment', row)) throw httpError(403, 'Cannot resolve');
      app.db.run('UPDATE comments SET resolved = ? WHERE id = ?', b.resolved ? 1 : 0, c.id);
      app.audit(ctx.user, b.resolved ? 'comment.resolve' : 'comment.reopen', row.id, { comment: c.id }, ctx.ip);
    }
    app.notify.broadcast('comment', { page: row.id, id: c.id });
    return commentDto(app.db.get('SELECT * FROM comments WHERE id = ?', c.id), ctx.user.id);
  }, { auth: true });
  r.delete('/api/v1/comments/:cid', (ctx) => {
    const { c, row } = ownComment(ctx);
    if (c.user_id !== ctx.user.id && !app.perms.canSpace(ctx.user, 'admin', row.space)) throw httpError(403, 'Cannot delete this comment');
    app.db.run('UPDATE comments SET deleted = 1, updated_at = ? WHERE id = ?', now(), c.id);
    app.audit(ctx.user, 'comment.delete', row.id, { comment: c.id }, ctx.ip);
    app.notify.broadcast('comment', { page: row.id, id: c.id });
    return { ok: true };
  }, { auth: true });

  // ---- reactions ------------------------------------------------------------------------------
  r.post('/api/v1/reactions', async (ctx) => {
    const { ttype, tid, emoji } = await ctx.json();
    if (!EMOJI.includes(emoji)) throw httpError(400, 'Unsupported reaction');
    if (ttype === 'page') viewable(ctx, tid);
    else if (ttype === 'comment') { const c = app.db.get('SELECT * FROM comments WHERE id = ?', Number(tid)); if (!c) throw httpError(404, 'Comment not found'); viewable(ctx, c.page_id); }
    else throw httpError(400, 'Invalid target');
    const existing = app.db.get('SELECT 1 FROM reactions WHERE ttype = ? AND tid = ? AND user_id = ? AND emoji = ?', ttype, String(tid), ctx.user.id, emoji);
    if (existing) app.db.run('DELETE FROM reactions WHERE ttype = ? AND tid = ? AND user_id = ? AND emoji = ?', ttype, String(tid), ctx.user.id, emoji);
    else app.db.run('INSERT INTO reactions (ttype, tid, user_id, emoji) VALUES (?,?,?,?)', ttype, String(tid), ctx.user.id, emoji);
    const rows = app.db.all('SELECT emoji, COUNT(*) AS n, MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine FROM reactions WHERE ttype = ? AND tid = ? GROUP BY emoji', ctx.user.id, ttype, String(tid));
    return { reacted: !existing, reactions: rows.map(x => ({ emoji: x.emoji, count: x.n, mine: !!x.mine })) };
  }, { auth: true });

  // ---- watch / favourite ------------------------------------------------------------------------
  r.post('/api/v1/pages/:id/watch', async (ctx) => {
    viewable(ctx, ctx.params.id);
    const { watch = true } = await ctx.json();
    if (watch) app.notify.watch(ctx.user.id, 'page', ctx.params.id); else app.notify.unwatch(ctx.user.id, 'page', ctx.params.id);
    return { watching: !!watch };
  }, { auth: true });
  r.post('/api/v1/pages/:id/favorite', async (ctx) => {
    viewable(ctx, ctx.params.id);
    const { favorite = true } = await ctx.json();
    if (favorite) app.db.run('INSERT OR IGNORE INTO favorites (user_id, page_id, created_at) VALUES (?,?,?)', ctx.user.id, ctx.params.id, now());
    else app.db.run('DELETE FROM favorites WHERE user_id = ? AND page_id = ?', ctx.user.id, ctx.params.id);
    return { favorite: !!favorite };
  }, { auth: true });

  // ---- restrictions -------------------------------------------------------------------------------
  r.get('/api/v1/pages/:id/restrictions', (ctx) => { viewable(ctx, ctx.params.id); return app.perms.restrictions(ctx.params.id); }, { auth: true });
  r.put('/api/v1/pages/:id/restrictions', async (ctx) => {
    const row = viewable(ctx, ctx.params.id, 'edit');
    const b = await ctx.json();
    // never lock yourself out: the acting user is always kept on non-empty lists
    const self = { ptype: 'user', principal: ctx.user.username };
    const fix = (l) => (l && l.length && !app.perms.canSpace(ctx.user, 'admin', row.space) && !l.some(x => x.ptype === 'user' && x.principal.toLowerCase() === ctx.user.username.toLowerCase())) ? [...l, self] : (l || []);
    app.perms.setRestrictions(row.id, { view: fix(b.view), edit: fix(b.edit) });
    app.audit(ctx.user, 'page.restrictions', row.id, b, ctx.ip);
    app.indexer.version++;
    return app.perms.restrictions(row.id);
  }, { auth: true });

  // ---- presence (who's viewing / editing) --------------------------------------------------------
  r.post('/api/v1/pages/:id/presence', async (ctx) => {
    viewable(ctx, ctx.params.id);
    const { editing = false, leave = false } = await ctx.json();
    if (leave) { app.events.leave(ctx.params.id, ctx.user); return { users: app.events.present(ctx.params.id) }; }
    return { users: app.events.heartbeat(ctx.params.id, ctx.user, editing) };
  }, { auth: true });

  // ---- live events --------------------------------------------------------------------------------
  r.get('/api/v1/events', (ctx) => { app.notify.subscribe(ctx.user, ctx.res); }, { public: true });

  // ---- notifications -------------------------------------------------------------------------------
  r.get('/api/v1/notifications', (ctx) => {
    const rows = app.db.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100', ctx.user.id);
    return { unread: app.db.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0', ctx.user.id).n,
      items: rows.map(n => ({ ...n, data: JSON.parse(n.data), read: !!n.read })) };
  }, { auth: true });
  r.post('/api/v1/notifications/read', async (ctx) => {
    const { ids } = await ctx.json();
    if (Array.isArray(ids)) for (const id of ids) app.db.run('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?', Number(id), ctx.user.id);
    else app.db.run('UPDATE notifications SET read = 1 WHERE user_id = ?', ctx.user.id);
    return { ok: true };
  }, { auth: true });

  // ---- dashboard -----------------------------------------------------------------------------------
  r.get('/api/v1/dashboard', async (ctx) => {
    const u = ctx.user;
    const canView = app.perms.viewFilter(u);
    const recentlyUpdated = app.db.all('SELECT * FROM pages WHERE archived = 0 ORDER BY updated_at DESC LIMIT 100').filter(canView).slice(0, 15).map(p => pageDto(app, p));
    const out = { recentlyUpdated };
    if (u) {
      out.recentlyViewed = app.db.all('SELECT p.* FROM recent r JOIN pages p ON p.id = r.page_id WHERE r.user_id = ? ORDER BY r.ts DESC LIMIT 30', u.id).filter(canView).slice(0, 10).map(p => pageDto(app, p));
      out.favorites = app.db.all('SELECT p.* FROM favorites f JOIN pages p ON p.id = f.page_id WHERE f.user_id = ? ORDER BY f.created_at DESC', u.id).filter(canView).map(p => pageDto(app, p));
      out.tasks = app.db.all(`SELECT t.*, p.title, p.space, p.parent FROM tasks t JOIN pages p ON p.id = t.page_id WHERE t.assignee = ? AND t.done = 0 AND p.archived = 0
        ORDER BY t.due IS NULL, t.due LIMIT 50`, u.username.toLowerCase()).filter(t => canView({ id: t.page_id, space: t.space, parent: t.parent }));
      out.drafts = app.db.all('SELECT key, page_id, space, title, updated_at FROM drafts WHERE user_id = ? ORDER BY updated_at DESC LIMIT 10', u.id);
    }
    const blog = app.db.all("SELECT * FROM pages WHERE kind = 'blog' AND archived = 0 ORDER BY created_at DESC LIMIT 30").filter(canView).slice(0, 5).map(p => pageDto(app, p));
    out.blog = blog;
    const feed = await app.git.activity({ limit: 60 });
    out.activity = feed.map(c => {
      const f = c.files.find(x => /\.md$/.test(x.path));
      const row = f ? app.db.get('SELECT * FROM pages WHERE path = ?', f.path) : null;
      if (!row || !canView(row)) return null;
      return { rev: c.rev, author: app.users.usernameForEmail(c.email, c.author), date: c.date, message: c.message, page: { id: row.id, title: row.title, space: row.space } };
    }).filter(Boolean).slice(0, 20);
    return out;
  }, { public: true });

  r.get('/api/v1/tasks', (ctx) => {
    const canView = app.perms.viewFilter(ctx.user);
    const who = (ctx.query.assignee || ctx.user.username).toLowerCase();
    const done = ctx.query.done === '1' ? 1 : 0;
    return app.db.all(`SELECT t.*, p.title, p.space, p.parent FROM tasks t JOIN pages p ON p.id = t.page_id WHERE t.assignee = ? AND t.done = ? AND p.archived = 0
      ORDER BY t.due IS NULL, t.due LIMIT 200`, who, done).filter(t => canView({ id: t.page_id, space: t.space, parent: t.parent }));
  }, { auth: true });
}
