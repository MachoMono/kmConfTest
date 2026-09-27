// SQLite (node:sqlite) — operational data (users, comments, notifications, audit …) and
// derived indexes (search, links, tags, chunks) that can always be rebuilt from git.
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = [
  // ---- identity & access -------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE, email TEXT, name TEXT,
    password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', active INTEGER NOT NULL DEFAULT 1,
    oidc_sub TEXT, external_id TEXT, created_at TEXT NOT NULL, last_login TEXT, prefs TEXT DEFAULT '{}')`,
  `CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL COLLATE NOCASE, description TEXT)`,
  `CREATE TABLE IF NOT EXISTS group_members (group_id INTEGER, user_id INTEGER, PRIMARY KEY (group_id, user_id))`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, ip TEXT)`,
  `CREATE TABLE IF NOT EXISTS api_tokens (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT, token_hash TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL, last_used TEXT, expires_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS space_perms (space TEXT NOT NULL, ptype TEXT NOT NULL, principal TEXT NOT NULL, role TEXT NOT NULL,
    PRIMARY KEY (space, ptype, principal))`,
  `CREATE TABLE IF NOT EXISTS page_restrictions (page_id TEXT NOT NULL, kind TEXT NOT NULL, ptype TEXT NOT NULL, principal TEXT NOT NULL,
    PRIMARY KEY (page_id, kind, ptype, principal))`,
  // ---- content index (derived from git) -------------------------------------------------
  `CREATE TABLE IF NOT EXISTS spaces (key TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, home_id TEXT,
    archived INTEGER DEFAULT 0, created_at TEXT, created_by TEXT, color TEXT, icon TEXT)`,
  `CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY, space TEXT NOT NULL, path TEXT UNIQUE NOT NULL, slug TEXT, title TEXT NOT NULL, kind TEXT DEFAULT 'page',
    type TEXT, parent TEXT, sort REAL DEFAULT 0, excerpt TEXT, tags TEXT DEFAULT '[]', aliases TEXT DEFAULT '[]', props TEXT DEFAULT '{}',
    status TEXT, owner TEXT, rev TEXT, created_at TEXT, created_by TEXT, updated_at TEXT, updated_by TEXT,
    archived INTEGER DEFAULT 0, review_by TEXT, words INTEGER DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS pages_space ON pages(space, parent, sort)`,
  `CREATE INDEX IF NOT EXISTS pages_updated ON pages(updated_at)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(id UNINDEXED, title, aliases, tags, body, tokenize='porter unicode61')`,
  `CREATE TABLE IF NOT EXISTS page_names (name TEXT NOT NULL, page_id TEXT NOT NULL, space TEXT NOT NULL, is_title INTEGER)`,
  `CREATE INDEX IF NOT EXISTS page_names_name ON page_names(name)`,
  `CREATE TABLE IF NOT EXISTS links (src TEXT NOT NULL, src_space TEXT, target TEXT NOT NULL, tname TEXT, target_id TEXT, anchor TEXT, kind TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS links_src ON links(src)`,
  `CREATE INDEX IF NOT EXISTS links_target ON links(tname)`,
  `CREATE INDEX IF NOT EXISTS links_target_id ON links(target_id)`,
  `CREATE TABLE IF NOT EXISTS page_tags (page_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY(page_id, tag))`,
  `CREATE INDEX IF NOT EXISTS page_tags_tag ON page_tags(tag)`,
  `CREATE TABLE IF NOT EXISTS tasks (page_id TEXT NOT NULL, line INTEGER, done INTEGER, text TEXT, assignee TEXT, due TEXT)`,
  `CREATE INDEX IF NOT EXISTS tasks_assignee ON tasks(assignee, done)`,
  `CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, page_id TEXT NOT NULL, ord INTEGER, heading TEXT, anchor TEXT, text TEXT, vec BLOB)`,
  `CREATE INDEX IF NOT EXISTS chunks_page ON chunks(page_id)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, heading, tokenize='porter unicode61')`,
  // ---- collaboration -----------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY, page_id TEXT NOT NULL, parent_id INTEGER, user_id INTEGER NOT NULL,
    body TEXT NOT NULL, anchor TEXT, resolved INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT, deleted INTEGER DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS comments_page ON comments(page_id)`,
  `CREATE TABLE IF NOT EXISTS reactions (ttype TEXT, tid TEXT, user_id INTEGER, emoji TEXT, PRIMARY KEY (ttype, tid, user_id, emoji))`,
  `CREATE TABLE IF NOT EXISTS watches (user_id INTEGER, ttype TEXT, tid TEXT, PRIMARY KEY (user_id, ttype, tid))`,
  `CREATE TABLE IF NOT EXISTS favorites (user_id INTEGER, page_id TEXT, created_at TEXT, PRIMARY KEY (user_id, page_id))`,
  `CREATE TABLE IF NOT EXISTS recent (user_id INTEGER, page_id TEXT, ts TEXT, PRIMARY KEY (user_id, page_id))`,
  `CREATE TABLE IF NOT EXISTS views (page_id TEXT, user_id INTEGER, ts TEXT)`,
  `CREATE INDEX IF NOT EXISTS views_page ON views(page_id)`,
  `CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY, user_id INTEGER, type TEXT, data TEXT, read INTEGER DEFAULT 0, created_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, read)`,
  `CREATE TABLE IF NOT EXISTS email_outbox (id INTEGER PRIMARY KEY, to_addr TEXT, subject TEXT, body TEXT, created_at TEXT, sent_at TEXT, error TEXT)`,
  `CREATE TABLE IF NOT EXISTS drafts (key TEXT NOT NULL, user_id INTEGER NOT NULL, page_id TEXT, space TEXT, parent TEXT, title TEXT, markdown TEXT,
    base_rev TEXT, updated_at TEXT, PRIMARY KEY (key, user_id))`,
  `CREATE TABLE IF NOT EXISTS trash (page_id TEXT PRIMARY KEY, space TEXT, title TEXT, path TEXT, rev TEXT, deleted_at TEXT, deleted_by TEXT)`,
  // ---- governance --------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS conflicts (id INTEGER PRIMARY KEY, page_id TEXT, path TEXT, created_at TEXT, user_id INTEGER, source TEXT,
    base_rev TEXT, merged_rev TEXT, details TEXT, status TEXT DEFAULT 'open')`,
  `CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, user_id INTEGER, username TEXT, action TEXT NOT NULL,
    target TEXT, details TEXT, ip TEXT)`,
  `CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS search_log (id INTEGER PRIMARY KEY, q TEXT, user_id INTEGER, results INTEGER, ts TEXT, mode TEXT)`,
  `CREATE TABLE IF NOT EXISTS webhooks (id INTEGER PRIMARY KEY, url TEXT NOT NULL, events TEXT, secret TEXT, active INTEGER DEFAULT 1,
    created_at TEXT, last_status TEXT)`,
  `CREATE TABLE IF NOT EXISTS oidc_states (state TEXT PRIMARY KEY, verifier TEXT, nonce TEXT, created_at TEXT, return_to TEXT)`,
];

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 5000;');
  for (const s of SCHEMA) db.exec(s);
  const cache = new Map();
  const prep = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  return {
    raw: db,
    all: (sql, ...p) => prep(sql).all(...p),
    get: (sql, ...p) => prep(sql).get(...p),
    run: (sql, ...p) => prep(sql).run(...p),
    exec: (sql) => db.exec(sql),
    tx(fn) {
      db.exec('BEGIN');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    close: () => db.close(),
  };
}

export const now = () => new Date().toISOString();
