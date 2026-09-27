// Notifications (in-app + email outbox), watches, live events over SSE, presence, and
// outgoing webhooks (HMAC-signed).
import crypto from 'node:crypto';
import { now } from './db.js';

export class Notify {
  constructor(app) { this.app = app; this.clients = new Map(); /* userId|0 -> Set(res) */ }
  get db() { return this.app.db; }

  watch(userId, ttype, tid) { if (userId) this.db.run('INSERT OR IGNORE INTO watches (user_id, ttype, tid) VALUES (?,?,?)', userId, ttype, tid); }
  unwatch(userId, ttype, tid) { this.db.run('DELETE FROM watches WHERE user_id = ? AND ttype = ? AND tid = ?', userId, ttype, tid); }
  isWatching(userId, ttype, tid) { return !!this.db.get('SELECT 1 FROM watches WHERE user_id = ? AND ttype = ? AND tid = ?', userId, ttype, tid); }

  watchersOf(page) {
    return this.db.all(`SELECT DISTINCT user_id FROM watches WHERE (ttype = 'page' AND tid = ?) OR (ttype = 'space' AND tid = ?)`, page.id, page.space).map(r => r.user_id);
  }

  notify(userId, type, data, { email = true } = {}) {
    const u = this.app.users.byId(userId);
    if (!u || !u.active) return;
    const r = this.db.run('INSERT INTO notifications (user_id, type, data, created_at) VALUES (?,?,?,?)', userId, type, JSON.stringify(data), now());
    const n = { id: Number(r.lastInsertRowid), type, data, read: 0, created_at: now() };
    this.push(userId, 'notification', n);
    const prefs = JSON.parse(u.prefs || '{}');
    if (email && u.email && prefs.email !== false && this.app.settings.get('email_enabled', true)) {
      this.db.run('INSERT INTO email_outbox (to_addr, subject, body, created_at) VALUES (?,?,?,?)',
        u.email, this.subject(type, data), this.emailBody(type, data), now());
    }
  }

  subject(type, d) {
    const site = this.app.settings.get('site_name', 'GitWiki');
    return {
      mention: `[${site}] ${d.by} mentioned you in "${d.title}"`,
      comment: `[${site}] ${d.by} commented on "${d.title}"`,
      reply: `[${site}] ${d.by} replied to your comment on "${d.title}"`,
      task: `[${site}] ${d.by} assigned you a task in "${d.title}"`,
      'page.updated': `[${site}] "${d.title}" was updated by ${d.by}`,
      'page.created': `[${site}] New page "${d.title}" by ${d.by}`,
      merge: `[${site}] Your edit to "${d.title}" was merged`,
      review: `[${site}] "${d.title}" is due for review`,
      share: `[${site}] ${d.by} shared "${d.title}" with you`,
    }[type] || `[${site}] ${type}`;
  }
  emailBody(type, d) {
    const base = this.app.cfg.baseUrl || '';
    return `${this.subject(type, d)}\n\n${d.excerpt || d.text || ''}\n\n${base}/p/${d.page}\n`;
  }

  // ---- SSE ----------------------------------------------------------------------------------
  subscribe(user, res) {
    const key = user ? user.id : 0;
    if (!this.clients.has(key)) this.clients.set(key, new Set());
    this.clients.get(key).add(res);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`event: hello\ndata: ${JSON.stringify({ user: user ? user.username : null })}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    res.on('close', () => { clearInterval(ping); this.clients.get(key)?.delete(res); });
  }
  push(userId, event, data) {
    for (const res of this.clients.get(userId) || []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  broadcast(event, data, filter = () => true) {
    for (const [uid, set] of this.clients) {
      if (!filter(uid)) continue;
      for (const res of set) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  }
  closeAll() { for (const set of this.clients.values()) for (const r of set) r.end(); this.clients.clear(); }
}

export class Events {
  constructor(app) { this.app = app; this.presence = new Map(); /* pageId -> Map(userId -> {username,name,editing,ts}) */ }

  /** Central fan-out after any page change: watchers, mentions, tasks, live refresh, webhooks. */
  pageChanged(type, page, user, { oldExtract, extract, merged } = {}) {
    const n = this.app.notify;
    const by = user ? user.username : 'system';
    const base = { page: page.id, title: page.title, space: page.space, by, excerpt: page.excerpt };
    if (type === 'page.created' || type === 'page.updated') {
      for (const uid of n.watchersOf(page)) {
        if (user && uid === user.id) continue;
        const u = this.app.users.byId(uid);
        if (u && this.app.perms.can(u, 'view', page)) n.notify(uid, type, base, { email: type === 'page.created' ? false : true });
      }
      if (extract) {
        const before = new Set(oldExtract ? oldExtract.mentions : []);
        for (const m of extract.mentions) {
          if (before.has(m)) continue;
          const u = this.app.users.byUsername(m);
          if (u && (!user || u.id !== user.id) && this.app.perms.can(u, 'view', page)) n.notify(u.id, 'mention', base);
        }
        const oldTasks = new Set((oldExtract ? oldExtract.tasks : []).filter(t => t.assignee).map(t => t.assignee + '|' + t.text));
        for (const t of extract.tasks) {
          if (!t.assignee || t.done || oldTasks.has(t.assignee + '|' + t.text)) continue;
          const u = this.app.users.byUsername(t.assignee);
          if (u && (!user || u.id !== user.id)) n.notify(u.id, 'task', { ...base, text: t.text, due: t.due });
        }
      }
    }
    n.broadcast('page', { type, id: page.id, space: page.space, rev: page.rev, by, merged: !!merged });
    this.app.audit(user, type, page.id, { title: page.title, space: page.space, rev: page.rev });
    this.fireWebhooks(type, { event: type, page: { id: page.id, title: page.title, space: page.space, rev: page.rev, path: page.path }, by, at: now() });
  }

  fireWebhooks(event, payload) {
    const hooks = this.app.db.all('SELECT * FROM webhooks WHERE active = 1');
    for (const h of hooks) {
      const events = (h.events || '*').split(',').map(s => s.trim());
      if (!events.includes('*') && !events.includes(event) && !events.some(e => e.endsWith('.*') && event.startsWith(e.slice(0, -1)))) continue;
      const body = JSON.stringify(payload);
      const sig = 'sha256=' + crypto.createHmac('sha256', h.secret || '').update(body).digest('hex');
      const p = fetch(h.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gitwiki-event': event, 'x-gitwiki-signature': sig }, body, signal: AbortSignal.timeout(5000) })
        .then(r => this.app.db.run('UPDATE webhooks SET last_status = ? WHERE id = ?', `${r.status} @ ${now()}`, h.id))
        .catch(e => this.app.db.run('UPDATE webhooks SET last_status = ? WHERE id = ?', `error: ${e.message} @ ${now()}`, h.id));
      this.app.pending.add(p);
      p.finally(() => this.app.pending.delete(p));
    }
  }

  // ---- presence ----------------------------------------------------------------------------
  heartbeat(pageId, user, editing) {
    if (!user) return this.present(pageId);
    if (!this.presence.has(pageId)) this.presence.set(pageId, new Map());
    const m = this.presence.get(pageId);
    const before = JSON.stringify(this.present(pageId));
    m.set(user.id, { username: user.username, name: user.name || user.username, editing: !!editing, ts: Date.now() });
    const list = this.present(pageId);
    if (JSON.stringify(list) !== before) this.app.notify.broadcast('presence', { page: pageId, users: list });
    return list;
  }
  leave(pageId, user) {
    const m = this.presence.get(pageId);
    if (m && user && m.delete(user.id)) this.app.notify.broadcast('presence', { page: pageId, users: this.present(pageId) });
  }
  present(pageId) {
    const m = this.presence.get(pageId);
    if (!m) return [];
    const cutoff = Date.now() - 45000;
    for (const [k, v] of m) if (v.ts < cutoff) m.delete(k);
    return [...m.values()].map(({ username, name, editing }) => ({ username, name, editing })).sort((a, b) => a.username.localeCompare(b.username));
  }
}
