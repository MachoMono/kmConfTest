// Users, groups, sessions, API tokens, password hashing, login rate limiting.
import crypto from 'node:crypto';
import { now } from './db.js';

export const ROLES = ['guest', 'user', 'km_admin', 'admin'];

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export function verifyPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, n, salt, hash] = stored.split('$');
  const h = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), 32, { N: Number(n), r: 8, p: 1 });
  const expected = Buffer.from(hash, 'base64');
  return h.length === expected.length && crypto.timingSafeEqual(h, expected);
}
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (n = 32) => crypto.randomBytes(n).toString('base64url');

export function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

const USERNAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,62}[A-Za-z0-9_]$|^[A-Za-z0-9_]$/;

export class Users {
  constructor(app) { this.app = app; this.emailCache = new Map(); this.attempts = new Map(); }
  get db() { return this.app.db; }

  publicUser(u) {
    if (!u) return null;
    return { id: u.id, username: u.username, name: u.name || u.username, email: u.email, role: u.role, active: !!u.active,
      created_at: u.created_at, last_login: u.last_login, groups: this.groupsOf(u.id).map(g => g.name) };
  }

  create({ username, password, email, name, role = 'user', oidc_sub = null, external_id = null }) {
    if (!USERNAME_RE.test(username || '')) throw httpError(400, 'Invalid username (letters, digits, . _ - only)');
    if (!ROLES.includes(role)) throw httpError(400, 'Invalid role');
    if (this.db.get('SELECT 1 FROM users WHERE username = ?', username)) throw httpError(409, 'Username already exists');
    if (password != null && String(password).length < 8) throw httpError(400, 'Password must be at least 8 characters');
    const r = this.db.run(`INSERT INTO users (username, email, name, password_hash, role, active, oidc_sub, external_id, created_at)
      VALUES (?,?,?,?,?,1,?,?,?)`, username, email || null, name || username, password ? hashPassword(password) : null, role, oidc_sub, external_id, now());
    this.emailCache.clear();
    return this.byId(Number(r.lastInsertRowid));
  }

  update(id, patch) {
    const u = this.byId(id);
    if (!u) throw httpError(404, 'User not found');
    const fields = [];
    const vals = [];
    for (const k of ['email', 'name', 'role', 'active', 'external_id', 'oidc_sub']) {
      if (patch[k] === undefined) continue;
      if (k === 'role' && !ROLES.includes(patch.role)) throw httpError(400, 'Invalid role');
      fields.push(`${k} = ?`); vals.push(k === 'active' ? (patch.active ? 1 : 0) : patch[k]);
    }
    if (patch.password) {
      if (String(patch.password).length < 8) throw httpError(400, 'Password must be at least 8 characters');
      fields.push('password_hash = ?'); vals.push(hashPassword(patch.password));
    }
    if (patch.prefs) { fields.push('prefs = ?'); vals.push(JSON.stringify(patch.prefs)); }
    if (fields.length) this.db.run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, ...vals, id);
    if (patch.active === false) this.db.run('DELETE FROM sessions WHERE user_id = ?', id);
    this.emailCache.clear();
    return this.byId(id);
  }

  byId(id) { return this.db.get('SELECT * FROM users WHERE id = ?', id); }
  byUsername(u) { return this.db.get('SELECT * FROM users WHERE username = ?', u); }
  list() { return this.db.all('SELECT * FROM users ORDER BY username').map(u => this.publicUser(u)); }

  groupsOf(userId) {
    return this.db.all('SELECT g.* FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.user_id = ? ORDER BY g.name', userId);
  }

  /** Git author identity for a user. */
  authorOf(u) {
    if (!u) return { name: 'Anonymous', email: 'anonymous@gitwiki.local' };
    return { name: u.name || u.username, email: u.email || `${u.username}@users.gitwiki.local` };
  }

  usernameForEmail(email, fallbackName) {
    if (!this.emailCache.size) {
      for (const u of this.db.all('SELECT username, email FROM users')) {
        this.emailCache.set(`${u.username}@users.gitwiki.local`.toLowerCase(), u.username);
        if (u.email) this.emailCache.set(u.email.toLowerCase(), u.username);
      }
      this.emailCache.set('__loaded__', true);
    }
    return this.emailCache.get(String(email || '').toLowerCase()) || fallbackName || email;
  }

  checkRate(key) {
    const t = Date.now();
    const arr = (this.attempts.get(key) || []).filter(x => t - x < 5 * 60_000);
    this.attempts.set(key, arr);
    if (arr.length >= 10) throw httpError(429, 'Too many login attempts. Try again in a few minutes.');
    arr.push(t);
  }

  authenticate(username, password, ip = '') {
    this.checkRate(`${ip}|${String(username).toLowerCase()}`);
    const u = this.byUsername(username);
    if (!u || !u.active || !verifyPassword(password, u.password_hash)) throw httpError(401, 'Invalid username or password');
    this.attempts.delete(`${ip}|${String(username).toLowerCase()}`);
    return u;
  }

  createSession(userId, ip) {
    const token = randomToken();
    const exp = new Date(Date.now() + this.app.cfg.sessionTtlHours * 3600_000).toISOString();
    this.db.run('INSERT INTO sessions (token_hash, user_id, expires_at, created_at, ip) VALUES (?,?,?,?,?)', sha256(token), userId, exp, now(), ip || null);
    this.db.run('UPDATE users SET last_login = ? WHERE id = ?', now(), userId);
    return { token, expires: exp };
  }

  destroySession(token) { if (token) this.db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token)); }

  userForSession(token) {
    if (!token) return null;
    const s = this.db.get('SELECT * FROM sessions WHERE token_hash = ?', sha256(token));
    if (!s || s.expires_at < now()) return null;
    const u = this.byId(s.user_id);
    return u && u.active ? u : null;
  }

  createApiToken(userId, name, expiresDays) {
    const token = 'gw_' + randomToken(24);
    const exp = expiresDays ? new Date(Date.now() + expiresDays * 86400_000).toISOString() : null;
    const r = this.db.run('INSERT INTO api_tokens (user_id, name, token_hash, created_at, expires_at) VALUES (?,?,?,?,?)', userId, name || 'token', sha256(token), now(), exp);
    return { id: Number(r.lastInsertRowid), token, name, expires_at: exp };
  }

  userForApiToken(token) {
    if (!token) return null;
    const t = this.db.get('SELECT * FROM api_tokens WHERE token_hash = ?', sha256(token));
    if (!t || (t.expires_at && t.expires_at < now())) return null;
    this.db.run('UPDATE api_tokens SET last_used = ? WHERE id = ?', now(), t.id);
    const u = this.byId(t.user_id);
    return u && u.active ? u : null;
  }

  // ---- groups --------------------------------------------------------------------------
  listGroups() {
    return this.db.all('SELECT g.*, (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS members FROM groups g ORDER BY name')
      .map(g => ({ ...g, users: this.db.all('SELECT u.username FROM users u JOIN group_members m ON m.user_id = u.id WHERE m.group_id = ? ORDER BY u.username', g.id).map(r => r.username) }));
  }
  createGroup(name, description = '') {
    if (!/^[\w .-]{1,64}$/.test(name || '')) throw httpError(400, 'Invalid group name');
    if (this.db.get('SELECT 1 FROM groups WHERE name = ?', name)) throw httpError(409, 'Group exists');
    const r = this.db.run('INSERT INTO groups (name, description) VALUES (?,?)', name, description);
    return this.db.get('SELECT * FROM groups WHERE id = ?', Number(r.lastInsertRowid));
  }
  setGroupMembers(name, usernames) {
    const g = this.db.get('SELECT * FROM groups WHERE name = ?', name);
    if (!g) throw httpError(404, 'Group not found');
    this.db.tx(() => {
      this.db.run('DELETE FROM group_members WHERE group_id = ?', g.id);
      for (const un of usernames) {
        const u = this.byUsername(un);
        if (!u) throw httpError(400, `Unknown user ${un}`);
        this.db.run('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?,?)', g.id, u.id);
      }
    });
    return g;
  }
  addToGroup(name, userId) {
    let g = this.db.get('SELECT * FROM groups WHERE name = ?', name);
    if (!g) g = this.createGroup(name);
    this.db.run('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?,?)', g.id, userId);
  }
  deleteGroup(name) {
    const g = this.db.get('SELECT * FROM groups WHERE name = ?', name);
    if (!g) throw httpError(404, 'Group not found');
    this.db.run('DELETE FROM group_members WHERE group_id = ?', g.id);
    this.db.run('DELETE FROM groups WHERE id = ?', g.id);
    this.db.run("DELETE FROM space_perms WHERE ptype = 'group' AND principal = ?", name);
    this.db.run("DELETE FROM page_restrictions WHERE ptype = 'group' AND principal = ?", name);
  }
}
