// Derives all query structures from repository files: page metadata, full-text search, link
// graph (resolved Obsidian-style by title/alias/slug), tags, tasks and retrieval chunks.
// Everything here can be rebuilt from git at any time (`rebuild()`).
import YAML from 'yaml';
import { splitFrontmatter, extract, sections, excerptOf, normalizeName } from '../shared/doc.js';
import { toBlob } from './embed.js';
import { now } from './db.js';

const PAGE_RE = /^spaces\/([A-Za-z0-9_-]+)\/(blog\/)?([^/]+)\.md$/;
const SPACE_RE = /^spaces\/([A-Za-z0-9_-]+)\/_space\.yml$/;

export function classifyPath(p) {
  let m = PAGE_RE.exec(p);
  if (m) return { kind: m[2] ? 'blog' : 'page', space: m[1], slug: m[3] };
  m = SPACE_RE.exec(p);
  if (m) return { kind: 'space', space: m[1] };
  return null;
}

export function fallbackId(p) {
  let h = 2166136261;
  for (let i = 0; i < p.length; i++) { h ^= p.charCodeAt(i); h = Math.imul(h, 16777619); }
  return 'f' + (h >>> 0).toString(36);
}

export class Indexer {
  constructor(app) { this.app = app; this.version = 0; }
  get db() { return this.app.db; }

  /** Resolve a wikilink target to a page row, preferring `fromSpace`. Supports "KEY:Title". */
  resolve(target, fromSpace) {
    if (!target) return null;
    let space = fromSpace, name = target;
    const m = /^([A-Za-z0-9_-]+):(.+)$/.exec(target);
    if (m && this.db.get('SELECT 1 FROM spaces WHERE key = ?', m[1].toUpperCase())) { space = m[1].toUpperCase(); name = m[2]; }
    const rows = this.db.all(`SELECT n.page_id, n.space, n.is_title FROM page_names n JOIN pages p ON p.id = n.page_id
      WHERE n.name = ? AND p.archived = 0 ORDER BY (n.space = ?) DESC, n.is_title DESC LIMIT 1`, normalizeName(name), space || '');
    if (!rows.length) {
      const byId = this.db.get('SELECT id FROM pages WHERE id = ?', target);
      return byId ? this.db.get('SELECT * FROM pages WHERE id = ?', byId.id) : null;
    }
    return this.db.get('SELECT * FROM pages WHERE id = ?', rows[0].page_id);
  }

  /** Re-resolve stored links whose target text is one of `names` (after create/rename/delete). */
  reresolve(names) {
    const uniq = [...new Set(names.map(normalizeName))].filter(Boolean);
    for (const n of uniq) {
      const rows = this.db.all(`SELECT rowid, target, src_space FROM links WHERE tname = ? AND kind != 'mention'`, n);
      for (const r of rows) {
        const hit = this.resolve(r.target, r.src_space);
        this.db.run('UPDATE links SET target_id = ? WHERE rowid = ?', hit ? hit.id : null, r.rowid);
      }
    }
  }

  namesOf(pageId) {
    return this.db.all('SELECT name FROM page_names WHERE page_id = ?', pageId).map(r => r.name);
  }

  async indexPath(p, content, meta = {}) {
    const c = classifyPath(p);
    if (!c) return null;
    if (content == null) content = await this.app.git.readFile(p);
    if (content == null) return this.removePath(p);
    if (c.kind === 'space') return this.indexSpace(c.space, content);
    return this.indexPage(p, c, content, meta);
  }

  indexSpace(key, content) {
    let d = {};
    try { d = YAML.parse(content) || {}; } catch {}
    this.db.run(`INSERT INTO spaces (key, name, description, home_id, archived, created_at, created_by, color, icon)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET name=excluded.name, description=excluded.description,
      home_id=excluded.home_id, archived=excluded.archived, color=excluded.color, icon=excluded.icon`,
      key, d.name || key, d.description || '', d.home || null, d.archived ? 1 : 0, d.created || now(), d.created_by || null,
      d.color || null, d.icon || null);
    this.version++;
    return { space: key };
  }

  async indexPage(p, c, content, meta) {
    const { data, body } = splitFrontmatter(content);
    const id = String(data.id || fallbackId(p));
    const h1 = /^#[ \t]+(.+)$/m.exec(body);
    const title = String(data.title || (h1 && h1[1]) || c.slug.replace(/[-_]+/g, ' '));
    const ex = extract(data, body);
    const onto = this.app.ontology;
    const tags = [...new Set(ex.tags.map(t => onto ? onto.canonicalTag(t) : t))].sort();
    const aliases = [].concat(data.aliases || []).map(String);
    const prev = this.db.get('SELECT id, path, title, aliases, created_at, created_by, updated_at, updated_by, rev FROM pages WHERE path = ? OR id = ?', p, id);
    const oldNames = prev ? this.namesOf(prev.id) : [];
    const date = meta.date || (prev && prev.updated_at) || now();
    const who = meta.author || (prev && prev.updated_by) || null;
    const props = { ...ex.fields };
    for (const r of ex.relations) (props[r.rel] ||= []).push(r.target);
    const toStr = (v) => v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
    const sections_ = sections(title, body);
    const embeds = await this.app.embedder.embed(sections_.map(s => s.heading + '\n' + s.text));

    this.db.tx(() => {
      if (prev && prev.id !== id) this.removePageRows(prev.id);
      this.db.run(`INSERT INTO pages (id, space, path, slug, title, kind, type, parent, sort, excerpt, tags, aliases, props, status, owner, rev,
          created_at, created_by, updated_at, updated_by, archived, review_by, words)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET space=excluded.space, path=excluded.path, slug=excluded.slug, title=excluded.title, kind=excluded.kind,
          type=excluded.type, parent=excluded.parent, sort=excluded.sort, excerpt=excluded.excerpt, tags=excluded.tags, aliases=excluded.aliases,
          props=excluded.props, status=excluded.status, owner=excluded.owner, rev=excluded.rev, created_at=excluded.created_at,
          created_by=excluded.created_by, updated_at=excluded.updated_at, updated_by=excluded.updated_by, archived=excluded.archived,
          review_by=excluded.review_by, words=excluded.words`,
        id, c.space, p, c.slug, title, data.kind === 'blog' || c.kind === 'blog' ? 'blog' : 'page', data.type ? String(data.type) : 'Document',
        data.parent ? String(data.parent) : null, Number(data.order ?? 0), String(data.excerpt || excerptOf(body)),
        JSON.stringify(tags), JSON.stringify(aliases), JSON.stringify(props), data.status ? String(data.status) : null,
        (ex.relations.find(r => r.rel === 'owner') || {}).target || (data.owner ? String(data.owner) : null),
        meta.rev || (prev && prev.rev) || null, toStr(data.created) || (prev && prev.created_at) || date,
        data.created_by ? String(data.created_by) : (prev && prev.created_by) || who,
        date, who, data.archived ? 1 : 0, toStr(data.review_by), ex.text.split(/\s+/).filter(Boolean).length);
      const row = this.db.get('SELECT rowid FROM pages WHERE id = ?', id);
      this.db.run('DELETE FROM pages_fts WHERE rowid = ?', row.rowid);
      this.db.run('INSERT INTO pages_fts (rowid, id, title, aliases, tags, body) VALUES (?,?,?,?,?,?)',
        row.rowid, id, title, aliases.join(' '), tags.map(t => t.replace(/\//g, ' ') + ' ' + t).join(' '), ex.text);

      this.db.run('DELETE FROM page_names WHERE page_id = ?', id);
      const names = new Map();
      names.set(normalizeName(title), 1);
      for (const a of aliases) if (!names.has(normalizeName(a))) names.set(normalizeName(a), 0);
      if (!names.has(normalizeName(c.slug))) names.set(normalizeName(c.slug), 0);
      for (const [n, isTitle] of names) this.db.run('INSERT INTO page_names (name, page_id, space, is_title) VALUES (?,?,?,?)', n, id, c.space, isTitle);

      this.db.run('DELETE FROM links WHERE src = ?', id);
      const seen = new Set();
      const addLink = (target, anchor, kind) => {
        const key = kind + '|' + normalizeName(target) + '|' + (anchor || '');
        if (seen.has(key)) return;
        seen.add(key);
        const t = normalizeName(target);
        this.db.run('INSERT INTO links (src, src_space, target, tname, target_id, anchor, kind) VALUES (?,?,?,?,?,?,?)',
          id, c.space, t, t.replace(/^[a-z0-9_-]+:(?=.)/, ''), null, anchor || null, kind);
      };
      for (const l of ex.links) addLink(l.target, l.anchor, l.embed ? 'embed' : 'link');
      for (const r of ex.relations) addLink(r.target, null, 'rel:' + r.rel);
      for (const m of ex.mentions) addLink(m, null, 'mention');

      this.db.run('DELETE FROM page_tags WHERE page_id = ?', id);
      for (const t of tags) this.db.run('INSERT OR IGNORE INTO page_tags (page_id, tag) VALUES (?,?)', id, t);

      this.db.run('DELETE FROM tasks WHERE page_id = ?', id);
      for (const t of ex.tasks) this.db.run('INSERT INTO tasks (page_id, line, done, text, assignee, due) VALUES (?,?,?,?,?,?)',
        id, t.line, t.done ? 1 : 0, t.text, t.assignee, t.due);

      for (const r of this.db.all('SELECT id FROM chunks WHERE page_id = ?', id)) this.db.run('DELETE FROM chunks_fts WHERE rowid = ?', r.id);
      this.db.run('DELETE FROM chunks WHERE page_id = ?', id);
      sections_.forEach((s, i) => {
        const r = this.db.run('INSERT INTO chunks (page_id, ord, heading, anchor, text, vec) VALUES (?,?,?,?,?,?)',
          id, i, s.heading, s.anchor, s.text, toBlob(embeds[i]));
        this.db.run('INSERT INTO chunks_fts (rowid, text, heading) VALUES (?,?,?)', r.lastInsertRowid, s.text, s.heading);
      });
    });
    this.version++;
    if (this.bulk) return { id, title, space: c.space, data, body, extract: ex, tags };
    // resolve this page's outbound links, and anything that pointed at its old/new names
    for (const l of this.db.all("SELECT rowid, target, src_space FROM links WHERE src = ? AND kind != 'mention'", id)) {
      const hit = this.resolve(l.target, l.src_space);
      this.db.run('UPDATE links SET target_id = ? WHERE rowid = ?', hit ? hit.id : null, l.rowid);
    }
    this.reresolve([...oldNames, ...this.namesOf(id)]);
    return { id, title, space: c.space, data, body, extract: ex, tags };
  }

  removePageRows(id) {
    const row = this.db.get('SELECT rowid FROM pages WHERE id = ?', id);
    if (row) this.db.run('DELETE FROM pages_fts WHERE rowid = ?', row.rowid);
    for (const r of this.db.all('SELECT id FROM chunks WHERE page_id = ?', id)) this.db.run('DELETE FROM chunks_fts WHERE rowid = ?', r.id);
    for (const sql of ['DELETE FROM chunks WHERE page_id = ?', 'DELETE FROM page_names WHERE page_id = ?', 'DELETE FROM links WHERE src = ?',
      'DELETE FROM page_tags WHERE page_id = ?', 'DELETE FROM tasks WHERE page_id = ?', 'DELETE FROM pages WHERE id = ?']) this.db.run(sql, id);
  }

  removePath(p) {
    const c = classifyPath(p);
    if (!c) return null;
    if (c.kind === 'space') { this.db.run('DELETE FROM spaces WHERE key = ?', c.space); this.version++; return null; }
    const row = this.db.get('SELECT id FROM pages WHERE path = ?', p);
    if (!row) return null;
    const names = this.namesOf(row.id);
    this.db.tx(() => this.removePageRows(row.id));
    this.db.run('UPDATE links SET target_id = NULL WHERE target_id = ?', row.id);
    this.reresolve(names);
    this.version++;
    return row.id;
  }

  resolveAll() {
    this.db.tx(() => {
      for (const l of this.db.all("SELECT rowid, target, src_space FROM links WHERE kind != 'mention'")) {
        const hit = this.resolve(l.target, l.src_space);
        this.db.run('UPDATE links SET target_id = ? WHERE rowid = ?', hit ? hit.id : null, l.rowid);
      }
    });
  }

  /** Author/date of the last commit per path, from one pass over the history. */
  async lastCommits() {
    const out = await this.app.git.run(['log', '--name-only', '--format=%x1e%H%x1f%ae%x1f%an%x1f%aI', '--', 'spaces']);
    const map = new Map();
    for (const rec of out.split('\x1e')) {
      if (!rec.trim()) continue;
      const [meta, ...files] = rec.split('\n');
      const [rev, email, name, date] = meta.split('\x1f');
      for (const f of files) if (f && !map.has(f)) map.set(f, { rev, date, author: this.app.users ? this.app.users.usernameForEmail(email, name) : name });
    }
    return map;
  }

  async rebuild() {
    const t0 = Date.now();
    for (const t of ['pages', 'pages_fts', 'page_names', 'links', 'page_tags', 'tasks', 'chunks', 'chunks_fts', 'spaces']) this.db.exec(`DELETE FROM ${t}`);
    const files = await this.app.git.listFiles('spaces');
    const commits = await this.lastCommits();
    const spaceFiles = files.filter(f => SPACE_RE.test(f));
    for (const f of spaceFiles) await this.indexPath(f, null, commits.get(f));
    let n = 0;
    this.bulk = true;
    try {
      for (const f of files) if (PAGE_RE.test(f)) { await this.indexPath(f, null, commits.get(f)); n++; }
    } finally { this.bulk = false; }
    this.resolveAll();
    // make sure a space row exists for every folder even without _space.yml
    for (const r of this.db.all('SELECT DISTINCT space FROM pages WHERE space NOT IN (SELECT key FROM spaces)')) {
      this.indexSpace(r.space, `name: ${r.space}\n`);
    }
    this.version++;
    return { pages: n, spaces: spaceFiles.length, ms: Date.now() - t0 };
  }
}
