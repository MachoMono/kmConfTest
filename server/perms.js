// Authorisation: global roles -> space roles (users, groups, all users, anonymous) -> page
// restrictions (view restrictions inherit down the page tree; edit restrictions do not).
// Security-relevant data lives in SQLite, never in git, so a git push cannot escalate access.
import { httpError } from './auth.js';

export const SPACE_ROLES = ['none', 'viewer', 'commenter', 'editor', 'admin'];
const rank = (r) => SPACE_ROLES.indexOf(r);
const ACTION_ROLE = { view: 'viewer', comment: 'commenter', edit: 'editor', admin: 'admin' };

export class Perms {
  constructor(app) { this.app = app; }
  get db() { return this.app.db; }

  isAdmin(u) { return !!u && u.role === 'admin'; }
  isKm(u) { return !!u && (u.role === 'admin' || u.role === 'km_admin'); }

  groupNames(u) {
    if (!u) return [];
    if (!u._groups) u._groups = this.app.users.groupsOf(u.id).map(g => g.name.toLowerCase());
    return u._groups;
  }

  spaceRole(u, space) {
    if (this.isKm(u)) return 'admin';
    const anonymousOk = this.app.settings.get('anonymous_access', false);
    const rows = this.db.all('SELECT ptype, principal, role FROM space_perms WHERE space = ?', space);
    let best = 'none';
    const groups = this.groupNames(u);
    for (const r of rows) {
      let match = false;
      if (r.ptype === 'anonymous') match = anonymousOk;
      else if (!u) match = false;
      else if (r.ptype === 'all') match = true;
      else if (r.ptype === 'user') match = r.principal.toLowerCase() === u.username.toLowerCase();
      else if (r.ptype === 'group') match = groups.includes(r.principal.toLowerCase());
      if (match && rank(r.role) > rank(best)) best = r.role;
    }
    if (u && u.role === 'guest' && rank(best) > rank('viewer')) best = 'viewer';
    return best;
  }

  matchesPrincipals(u, rows) {
    if (!u) return false;
    const groups = this.groupNames(u);
    return rows.some(r => (r.ptype === 'user' && r.principal.toLowerCase() === u.username.toLowerCase()) ||
      (r.ptype === 'group' && groups.includes(r.principal.toLowerCase())));
  }

  ancestors(page) {
    const out = [];
    let cur = page, guard = 0;
    while (cur && cur.parent && guard++ < 50) {
      cur = this.db.get('SELECT id, parent, space FROM pages WHERE id = ?', cur.parent);
      if (cur) out.push(cur);
    }
    return out;
  }

  pageViewRestricted(u, page) {
    for (const p of [page, ...this.ancestors(page)]) {
      const rows = this.db.all("SELECT ptype, principal FROM page_restrictions WHERE page_id = ? AND kind = 'view'", p.id);
      if (rows.length && !this.matchesPrincipals(u, rows)) return true;
    }
    return false;
  }

  can(u, action, page) {
    if (!page) return false;
    const role = this.spaceRole(u, page.space);
    if (rank(role) < rank(ACTION_ROLE[action])) return false;
    if (role === 'admin') return true;
    if (this.pageViewRestricted(u, page)) return false;
    if (action === 'edit') {
      const rows = this.db.all("SELECT ptype, principal FROM page_restrictions WHERE page_id = ? AND kind = 'edit'", page.id);
      if (rows.length && !this.matchesPrincipals(u, rows)) return false;
    }
    return true;
  }

  canSpace(u, action, space) { return rank(this.spaceRole(u, space)) >= rank(ACTION_ROLE[action]); }

  assert(u, action, page) {
    if (!page) throw httpError(404, 'Page not found');
    if (!this.can(u, action, page)) {
      if (!this.can(u, 'view', page)) throw httpError(u ? 404 : 401, u ? 'Page not found' : 'Login required');
      throw httpError(403, `You do not have permission to ${action} this page`);
    }
  }
  assertSpace(u, action, space) {
    if (!this.canSpace(u, action, space)) throw httpError(u ? 403 : 401, u ? `You do not have ${action} access to space ${space}` : 'Login required');
  }
  assertKm(u) { if (!this.isKm(u)) throw httpError(u ? 403 : 401, 'Knowledge-management administrators only'); }
  assertAdmin(u) { if (!this.isAdmin(u)) throw httpError(u ? 403 : 401, 'Administrators only'); }

  /** Fast predicate for filtering many pages (search, graph, lists). */
  viewFilter(u) {
    const roles = new Map();
    const restricted = new Set(this.db.all("SELECT DISTINCT page_id FROM page_restrictions WHERE kind = 'view'").map(r => r.page_id));
    const cache = new Map();
    return (page) => {
      if (!page) return false;
      if (!roles.has(page.space)) roles.set(page.space, this.spaceRole(u, page.space));
      const role = roles.get(page.space);
      if (rank(role) < 1) return false;
      if (role === 'admin' || !restricted.size) return true;
      if (cache.has(page.id)) return cache.get(page.id);
      const full = page.parent !== undefined ? page : this.db.get('SELECT id, parent, space FROM pages WHERE id = ?', page.id);
      const ok = !this.pageViewRestricted(u, full || page);
      cache.set(page.id, ok);
      return ok;
    };
  }

  // ---- management ----------------------------------------------------------------------
  spacePerms(space) { return this.db.all('SELECT ptype, principal, role FROM space_perms WHERE space = ? ORDER BY ptype, principal', space); }
  setSpacePerms(space, entries) {
    for (const e of entries) {
      if (!['user', 'group', 'all', 'anonymous'].includes(e.ptype)) throw httpError(400, 'Invalid principal type');
      if (!SPACE_ROLES.includes(e.role) || e.role === 'none') throw httpError(400, 'Invalid role');
    }
    this.db.tx(() => {
      this.db.run('DELETE FROM space_perms WHERE space = ?', space);
      for (const e of entries) this.db.run('INSERT OR REPLACE INTO space_perms (space, ptype, principal, role) VALUES (?,?,?,?)',
        space, e.ptype, e.principal || '*', e.role);
    });
  }
  restrictions(pageId) {
    const rows = this.db.all('SELECT kind, ptype, principal FROM page_restrictions WHERE page_id = ? ORDER BY kind, ptype, principal', pageId);
    return { view: rows.filter(r => r.kind === 'view'), edit: rows.filter(r => r.kind === 'edit') };
  }
  setRestrictions(pageId, { view = [], edit = [] }) {
    this.db.tx(() => {
      this.db.run('DELETE FROM page_restrictions WHERE page_id = ?', pageId);
      for (const [kind, list] of [['view', view], ['edit', edit]]) for (const r of list) {
        if (!['user', 'group'].includes(r.ptype)) throw httpError(400, 'Invalid restriction principal');
        this.db.run('INSERT OR IGNORE INTO page_restrictions (page_id, kind, ptype, principal) VALUES (?,?,?,?)', pageId, kind, r.ptype, r.principal);
      }
    });
  }
}
