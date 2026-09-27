// Page service: every content mutation is a git commit authored by the acting user. Concurrent
// edits are merged silently (see merge.js); renames rewrite inbound [[links]] so they never break.
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import fs from 'node:fs/promises';
import YAML from 'yaml';
import { diffLines, diffWordsWithSpace } from 'diff';
import { splitFrontmatter, joinFrontmatter, normalizeName, extract } from '../shared/doc.js';
import { slugify, escapeHtml } from '../shared/markdown.js';
import { htmlToMarkdown } from '../shared/tomd.js';
import { mergeDocument } from './merge.js';
import { httpError } from './auth.js';
import { now } from './db.js';

export const SPACE_KEY_RE = /^[A-Z][A-Z0-9_]{1,15}$/;
const MANAGED = ['id', 'title', 'kind', 'parent', 'order', 'created', 'created_by'];

export function newId() {
  return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

export function safeFileName(name) {
  const base = path.basename(String(name || 'file')).replace(/[^\w.\- ()]+/g, '_').replace(/^\.+/, '_').slice(0, 120);
  return base || 'file';
}

const lockHeld = new AsyncLocalStorage();
const LOCKED = ['createSpace', 'updateSpace', 'create', 'update', 'move', 'copy', 'setArchived', 'remove', 'restoreFromTrash', 'restoreVersion',
  'toggleTask', 'addAttachment', 'removeAttachment', 'saveTemplate', 'deleteTemplate', 'commitAndIndex'];

export class Pages {
  constructor(app) {
    this.app = app;
    this._chain = Promise.resolve();
    // Read-merge-commit must be atomic: serialise every content mutation (reentrant, so
    // composite operations like copy -> create or restoreVersion -> update do not deadlock).
    for (const name of LOCKED) { const fn = this[name].bind(this); this[name] = (...args) => this.withLock(() => fn(...args)); }
  }

  withLock(fn) {
    if (lockHeld.getStore()) return fn();
    const run = () => lockHeld.run(true, fn);
    const p = this._chain.then(run, run);
    this._chain = p.catch(() => {});
    return p;
  }
  get db() { return this.app.db; }
  get git() { return this.app.git; }

  row(id) { return this.db.get('SELECT * FROM pages WHERE id = ?', id); }
  mustRow(id) { const r = this.row(id); if (!r) throw httpError(404, 'Page not found'); return r; }

  async read(id) {
    const row = this.mustRow(id);
    const text = await this.git.readFile(row.path);
    if (text == null) throw httpError(404, 'Page file missing');
    const { data, body } = splitFrontmatter(text);
    return { row, text, data, body };
  }

  dirFor(space, kind) { return kind === 'blog' ? `spaces/${space}/blog` : `spaces/${space}`; }

  uniquePath(space, title, kind, exceptPath = null) {
    const dir = this.dirFor(space, kind);
    let base = kind === 'blog' ? `${new Date().toISOString().slice(0, 10)}-${slugify(title)}` : slugify(title);
    if (base.startsWith('_')) base = 'p' + base;
    let p = `${dir}/${base}.md`, n = 2;
    while ((this.git.exists(p) || this.db.get('SELECT 1 FROM pages WHERE path = ?', p)) && p !== exceptPath) p = `${dir}/${base}-${n++}.md`;
    return p;
  }

  toMarkdown({ markdown, html }) {
    if (markdown != null) return String(markdown);
    if (html != null) return htmlToMarkdown(String(html));
    return '';
  }

  nextOrder(space, parent) {
    const r = this.db.get("SELECT MAX(sort) AS m FROM pages WHERE space = ? AND parent IS ? AND kind = 'page'", space, parent || null);
    return (r && r.m != null ? Math.floor(r.m) : 0) + 10;
  }

  async commitAndIndex({ writes = [], deletes = [], renames = [], message, user, indexPaths = [], removePaths = [] }) {
    const author = this.app.users.authorOf(user);
    const rev = await this.git.commit({ writes, deletes, renames, message, author });
    const meta = { rev, date: now(), author: user ? user.username : null };
    for (const p of removePaths) this.app.indexer.removePath(p);
    const results = [];
    for (const p of indexPaths) results.push(await this.app.indexer.indexPath(p, null, meta));
    this.app.sync && this.app.sync.schedulePush();
    return { rev, results };
  }

  applyTemplate(text, vars) {
    return text.replace(/\{\{(title|date|datetime|user|username|space)\}\}/g, (_m, k) => vars[k] ?? '');
  }

  // ---- spaces ----------------------------------------------------------------------------
  async createSpace(user, { key, name, description = '', color, icon, template }) {
    key = String(key || '').toUpperCase();
    if (!SPACE_KEY_RE.test(key)) throw httpError(400, 'Space key must be 2-16 chars: A-Z, 0-9, _ (starting with a letter)');
    if (this.db.get('SELECT 1 FROM spaces WHERE key = ?', key) || this.git.exists(`spaces/${key}`)) throw httpError(409, 'Space already exists');
    if (!name) throw httpError(400, 'Space name is required');
    const homeId = newId();
    const homeBody = template === 'team'
      ? `# ${name}\n\nWelcome to the **${name}** space.\n\n## Team\n\n- Lead: \n\n## Pages\n\n\`\`\`children\ndepth: 2\n\`\`\`\n\n## Recently updated\n\n\`\`\`recent\nlimit: 10\n\`\`\`\n`
      : `# ${name}\n\n${description || 'Welcome to this space.'}\n\n\`\`\`children\n\`\`\`\n\n## Recently updated\n\n\`\`\`recent\n\`\`\`\n`;
    const home = joinFrontmatter({ id: homeId, title: name, created: now(), created_by: user.username }, homeBody);
    const meta = YAML.stringify({ name, description, home: homeId, created: now(), created_by: user.username, color: color || null, icon: icon || null });
    const homePath = `spaces/${key}/${slugify(name)}.md`;
    const { rev } = await this.commitAndIndex({
      writes: [{ path: `spaces/${key}/_space.yml`, content: meta }, { path: homePath, content: home }],
      message: `Create space ${key}`, user, indexPaths: [`spaces/${key}/_space.yml`, homePath],
    });
    this.app.perms.setSpacePerms(key, [{ ptype: 'user', principal: user.username, role: 'admin' }, { ptype: 'all', principal: '*', role: 'editor' }]);
    this.app.notify.watch(user.id, 'space', key);
    return { key, rev, home: homeId };
  }

  async updateSpace(user, key, patch) {
    const p = `spaces/${key}/_space.yml`;
    const text = await this.git.readFile(p);
    if (text == null) throw httpError(404, 'Space not found');
    const d = YAML.parse(text) || {};
    for (const k of ['name', 'description', 'home', 'archived', 'color', 'icon']) if (patch[k] !== undefined) d[k] = patch[k];
    await this.commitAndIndex({ writes: [{ path: p, content: YAML.stringify(d) }], message: `Update space ${key}`, user, indexPaths: [p] });
    return this.db.get('SELECT * FROM spaces WHERE key = ?', key);
  }

  // ---- create ----------------------------------------------------------------------------
  async create(user, input) {
    const space = String(input.space || '').toUpperCase();
    if (!this.db.get('SELECT 1 FROM spaces WHERE key = ?', space)) throw httpError(404, 'Space not found');
    const title = String(input.title || '').trim();
    if (!title) throw httpError(400, 'Title is required');
    if (title.length > 200) throw httpError(400, 'Title too long');
    const kind = input.kind === 'blog' ? 'blog' : 'page';
    let parent = input.parent || null;
    if (parent) {
      const pr = this.mustRow(parent);
      if (pr.space !== space) throw httpError(400, 'Parent page is in another space');
    } else if (kind === 'page') {
      const s = this.db.get('SELECT home_id FROM spaces WHERE key = ?', space);
      parent = s && s.home_id && this.row(s.home_id) ? s.home_id : null;
    }
    let body = this.toMarkdown(input);
    let tdata = {};
    if (input.template) {
      const t = await this.template(input.template);
      if (!t) throw httpError(404, 'Template not found');
      tdata = t.data;
      if (!body.trim()) body = this.applyTemplate(t.body, { title, date: now().slice(0, 10), datetime: now(), user: user.name || user.username, username: user.username, space });
    }
    const id = newId();
    const data = {
      id, title, kind: kind === 'blog' ? 'blog' : undefined,
      type: input.type || tdata.type || undefined,
      tags: [...new Set([...(tdata.tags || []), ...(input.tags || [])])],
      aliases: input.aliases || undefined,
      parent: kind === 'page' ? parent || undefined : undefined,
      order: kind === 'page' ? this.nextOrder(space, parent) : undefined,
      created: now(), created_by: user.username,
      ...(input.props || {}),
    };
    const p = this.uniquePath(space, title, kind);
    const text = joinFrontmatter(data, body);
    const { rev, results } = await this.commitAndIndex({ writes: [{ path: p, content: text }], message: input.message || `Create "${title}"`, user, indexPaths: [p] });
    this.app.notify.watch(user.id, 'page', id);
    const page = this.row(id);
    this.app.events.pageChanged('page.created', page, user, { extract: results[0] && results[0].extract });
    this.db.run('DELETE FROM drafts WHERE key = ? AND user_id = ?', input.draftKey || '', user.id);
    return { page, rev };
  }

  // ---- update (with silent merge) ----------------------------------------------------------
  async update(user, id, input) {
    const cur = await this.read(id);
    const { row } = cur;
    const baseRev = input.baseRev || row.rev;
    let baseText = cur.text;
    if (baseRev && baseRev !== row.rev) {
      baseText = await this.git.show(baseRev, row.path);
      if (baseText == null) {
        const oldPath = await this.git.findPathById(baseRev, id);
        baseText = oldPath ? await this.git.show(baseRev, oldPath) : null;
      }
      if (baseText == null) baseText = cur.text; // unknown base: treat as two-way (ours wins)
    }
    const base = splitFrontmatter(baseText);
    const oursData = { ...base.data };
    if (input.title !== undefined) {
      const t = String(input.title).trim();
      if (!t) throw httpError(400, 'Title is required');
      oursData.title = t;
    }
    if (input.tags !== undefined) oursData.tags = [...new Set(input.tags.map(String))];
    if (input.type !== undefined) oursData.type = input.type || undefined;
    if (input.aliases !== undefined) oursData.aliases = input.aliases;
    if (input.props) for (const [k, v] of Object.entries(input.props)) {
      if (MANAGED.includes(k)) continue;
      if (v === null || v === '') delete oursData[k]; else oursData[k] = v;
    }
    const oursBody = input.markdown !== undefined || input.html !== undefined ? this.toMarkdown(input) : base.body;
    const oursText = joinFrontmatter(oursData, oursBody);
    const merged = mergeDocument(baseText, oursText, cur.text, { prefer: 'ours' });
    const mergedWasNeeded = baseText !== cur.text;
    const final = splitFrontmatter(merged.text);
    for (const k of MANAGED) if (cur.data[k] !== undefined && k !== 'title') final.data[k] = cur.data[k];
    final.data.id = id;
    let finalText = joinFrontmatter(final.data, final.body);
    if (finalText === cur.text) return { page: row, rev: row.rev, merged: false, unchanged: true, conflicts: 0 };

    const writes = [];
    let renames = [];
    let newPath = row.path;
    const indexPaths = [];
    const oldTitle = cur.data.title || row.title;
    const newTitle = final.data.title || oldTitle;
    if (newTitle !== oldTitle) {
      newPath = this.uniquePath(row.space, newTitle, row.kind, row.path);
      if (newPath !== row.path) renames = [[row.path, newPath]];
      writes.push(...await this.rewriteInboundLinks(id, oldTitle, newTitle, row));
    }
    writes.unshift({ path: newPath, content: finalText });
    indexPaths.push(newPath, ...writes.slice(1).map(w => w.path));
    const oldExtract = extract(cur.data, cur.body);
    const { rev, results } = await this.commitAndIndex({
      writes, renames, user, indexPaths, removePaths: renames.length ? [row.path] : [],
      message: input.message || (mergedWasNeeded ? `Update "${newTitle}" (auto-merged)` : `Update "${newTitle}"`),
    });
    if (merged.conflicts.length) {
      const other = this.app.users.byUsername(row.updated_by || '') || null;
      this.db.run(`INSERT INTO conflicts (page_id, path, created_at, user_id, source, base_rev, merged_rev, details, status) VALUES (?,?,?,?,?,?,?,?,?)`,
        id, newPath, now(), user.id, 'edit', baseRev, rev, JSON.stringify({ conflicts: merged.conflicts, otherUser: row.updated_by, otherRev: row.rev }), 'open');
      if (other && other.id !== user.id) {
        this.app.notify.notify(other.id, 'merge', { page: id, title: newTitle, by: user.username, count: merged.conflicts.length }, { email: false });
      }
    }
    this.app.notify.watch(user.id, 'page', id);
    const page = this.row(id);
    this.app.events.pageChanged('page.updated', page, user, { oldExtract, extract: results[0] && results[0].extract, merged: mergedWasNeeded });
    this.db.run('DELETE FROM drafts WHERE key = ? AND user_id = ?', input.draftKey || id, user.id);
    return { page, rev, merged: mergedWasNeeded, conflicts: merged.conflicts.length, markdown: final.body };
  }

  /** Rewrite [[Old Title...]] -> [[New Title...]] in every page linking here. */
  async rewriteInboundLinks(id, oldTitle, newTitle, row) {
    const sources = this.db.all(`SELECT DISTINCT l.src, p.path FROM links l JOIN pages p ON p.id = l.src
      WHERE l.target_id = ? AND l.tname = ? AND l.src != ?`, id, normalizeName(oldTitle), id);
    const writes = [];
    const esc = oldTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    const re = new RegExp(`(!?\\[\\[)((?:${row.space}:)?)${esc}(?=[\\]|#])`, 'gi');
    for (const s of sources) {
      const text = await this.git.readFile(s.path);
      if (text == null) continue;
      const { data, body } = splitFrontmatter(text);
      const nb = body.replace(re, (_m, open, prefix) => `${open}${prefix}${newTitle}`);
      const nd = JSON.parse(JSON.stringify(data, (k, v) => typeof v === 'string' ? v.replace(re, (_m, open, prefix) => `${open}${prefix}${newTitle}`) : v));
      const out = joinFrontmatter(nd, nb);
      if (out !== text) writes.push({ path: s.path, content: out });
    }
    return writes;
  }

  // ---- structure ---------------------------------------------------------------------------
  async move(user, id, { parent = null, space, before, after, index } = {}) {
    const cur = await this.read(id);
    const row = cur.row;
    const targetSpace = (space || row.space).toUpperCase();
    if (parent) {
      const pr = this.mustRow(parent);
      if (pr.space !== targetSpace) throw httpError(400, 'Parent must be in the target space');
      let a = pr, guard = 0;
      while (a && guard++ < 100) { if (a.id === id) throw httpError(400, 'Cannot move a page under itself'); a = a.parent ? this.row(a.parent) : null; }
    }
    const siblings = this.db.all("SELECT id, sort FROM pages WHERE space = ? AND parent IS ? AND id != ? AND kind = 'page' ORDER BY sort, title", targetSpace, parent || null, id);
    let order;
    const pos = before ? siblings.findIndex(s => s.id === before) : after ? siblings.findIndex(s => s.id === after) + 1 : index ?? siblings.length;
    const prev = siblings[pos - 1], next = siblings[pos];
    if (prev && next) order = (prev.sort + next.sort) / 2;
    else if (prev) order = Math.floor(prev.sort) + 10;
    else if (next) order = next.sort - 10;
    else order = 10;
    const data = { ...cur.data, parent: parent || undefined, order };
    const writes = [];
    const renames = [];
    let newPath = row.path;
    const removePaths = [];
    if (targetSpace !== row.space) {
      if (!this.db.get('SELECT 1 FROM spaces WHERE key = ?', targetSpace)) throw httpError(404, 'Target space not found');
      newPath = this.uniquePath(targetSpace, row.title, row.kind);
      renames.push([row.path, newPath]);
      removePaths.push(row.path);
      const attDir = `spaces/${row.space}/_attachments/${id}`;
      if (this.git.exists(attDir)) renames.push([attDir, `spaces/${targetSpace}/_attachments/${id}`]);
      // children move with their parent
      for (const d of this.app.search.descendants(id)) {
        const dr = this.row(d);
        const dp = this.uniquePath(targetSpace, dr.title, dr.kind);
        renames.push([dr.path, dp]);
        removePaths.push(dr.path);
        const dAtt = `spaces/${row.space}/_attachments/${d}`;
        if (this.git.exists(dAtt)) renames.push([dAtt, `spaces/${targetSpace}/_attachments/${d}`]);
      }
    }
    writes.push({ path: newPath, content: joinFrontmatter(data, cur.body) });
    const indexPaths = [newPath, ...renames.filter(r => r[1].endsWith('.md')).map(r => r[1])];
    const { rev } = await this.commitAndIndex({ writes, renames, removePaths, indexPaths: [...new Set(indexPaths)], user, message: `Move "${row.title}"` });
    this.app.events.pageChanged('page.moved', this.row(id), user, {});
    return { page: this.row(id), rev };
  }

  async copy(user, id, { space, parent, title, withChildren = false } = {}) {
    const cur = await this.read(id);
    const res = await this.create(user, { space: space || cur.row.space, parent: parent ?? cur.row.parent, title: title || `Copy of ${cur.row.title}`,
      markdown: cur.body, tags: [].concat(cur.data.tags || []), type: cur.data.type });
    if (withChildren) {
      for (const k of this.db.all('SELECT id FROM pages WHERE parent = ? ORDER BY sort', id)) {
        await this.copy(user, k.id, { space: space || cur.row.space, parent: res.page.id, title: this.row(k.id).title + ' (copy)', withChildren: true });
      }
    }
    return res;
  }

  async setArchived(user, id, archived) {
    const cur = await this.read(id);
    const data = { ...cur.data, archived: archived ? true : undefined };
    const { rev } = await this.commitAndIndex({ writes: [{ path: cur.row.path, content: joinFrontmatter(data, cur.body) }], indexPaths: [cur.row.path], user,
      message: `${archived ? 'Archive' : 'Unarchive'} "${cur.row.title}"` });
    this.app.events.pageChanged(archived ? 'page.archived' : 'page.unarchived', this.row(id), user, {});
    return { page: this.row(id), rev };
  }

  async remove(user, id) {
    const cur = await this.read(id);
    const row = cur.row;
    const space = this.db.get('SELECT * FROM spaces WHERE key = ?', row.space);
    if (space && space.home_id === id) throw httpError(400, 'The space home page cannot be deleted');
    // children move up to the deleted page's parent
    const writes = [];
    const kids = this.db.all('SELECT id FROM pages WHERE parent = ?', id);
    for (const k of kids) {
      const kr = await this.read(k.id);
      writes.push({ path: kr.row.path, content: joinFrontmatter({ ...kr.data, parent: row.parent || undefined }, kr.body) });
    }
    const deletes = [row.path];
    const attDir = `spaces/${row.space}/_attachments/${id}`;
    if (this.git.exists(attDir)) deletes.push(attDir);
    const { rev } = await this.commitAndIndex({ writes, deletes, user, removePaths: [row.path], indexPaths: writes.map(w => w.path), message: `Delete "${row.title}"` });
    this.db.run('INSERT OR REPLACE INTO trash (page_id, space, title, path, rev, deleted_at, deleted_by) VALUES (?,?,?,?,?,?,?)',
      id, row.space, row.title, row.path, row.rev, now(), user.username);
    this.app.events.pageChanged('page.deleted', row, user, {});
    return { rev };
  }

  async restoreFromTrash(user, id) {
    const t = this.db.get('SELECT * FROM trash WHERE page_id = ?', id);
    if (!t) throw httpError(404, 'Not in trash');
    const beforeDelete = (await this.git.run(['log', '-1', '--format=%H', '--diff-filter=D', '--', t.path])).trim();
    const rev = beforeDelete ? beforeDelete + '^' : t.rev;
    const text = await this.git.show(rev, t.path);
    if (text == null) throw httpError(410, 'Page content no longer recoverable');
    const { data, body } = splitFrontmatter(text);
    if (data.parent && !this.row(data.parent)) delete data.parent;
    const p = this.git.exists(t.path) ? this.uniquePath(t.space, t.title, data.kind) : t.path;
    const writes = [{ path: p, content: joinFrontmatter(data, body) }];
    const att = `spaces/${t.space}/_attachments/${id}`;
    const ls = await this.git.run(['ls-tree', '-r', '--name-only', rev, '--', att], { allowFail: true });
    for (const f of (ls.stdout || '').split('\n').filter(Boolean)) {
      const buf = await this.git.show(rev, f, 'buffer');
      if (buf) writes.push({ path: f, content: buf });
    }
    await this.commitAndIndex({ writes, user, indexPaths: [p], message: `Restore "${t.title}" from trash` });
    this.db.run('DELETE FROM trash WHERE page_id = ?', id);
    this.app.events.pageChanged('page.restored', this.row(id), user, {});
    return { page: this.row(id) };
  }

  // ---- history -------------------------------------------------------------------------------
  async history(id) {
    const row = this.mustRow(id);
    const log = await this.git.pageLog(row.path, id);
    return log.map((c, i) => ({ ...c, author: this.app.users.usernameForEmail(c.email, c.author), version: log.length - i }));
  }

  async version(id, rev) {
    const row = this.mustRow(id);
    if (!/^[0-9a-f]{7,40}$/.test(rev)) throw httpError(400, 'Invalid revision');
    let text = await this.git.show(rev, row.path);
    if (text == null) { const p = await this.git.findPathById(rev, id); text = p ? await this.git.show(rev, p) : null; }
    if (text == null) throw httpError(404, 'Version not found');
    return splitFrontmatter(text);
  }

  async diff(id, from, to) {
    const a = await this.version(id, from);
    const b = to ? await this.version(id, to) : splitFrontmatter((await this.read(id)).text);
    const parts = diffLines(a.body, b.body);
    const html = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const nx = parts[i + 1];
      if (p.removed && nx && nx.added) {
        const words = diffWordsWithSpace(p.value, nx.value).map(w => w.added ? `<ins>${escapeHtml(w.value)}</ins>` : w.removed ? `<del>${escapeHtml(w.value)}</del>` : escapeHtml(w.value)).join('');
        html.push(`<div class="diff-chg">${words}</div>`);
        i++;
      } else if (p.added) html.push(`<div class="diff-add"><ins>${escapeHtml(p.value)}</ins></div>`);
      else if (p.removed) html.push(`<div class="diff-del"><del>${escapeHtml(p.value)}</del></div>`);
      else html.push(`<div class="diff-same">${escapeHtml(p.value)}</div>`);
    }
    const meta = [];
    for (const k of new Set([...Object.keys(a.data), ...Object.keys(b.data)])) {
      if (JSON.stringify(a.data[k]) !== JSON.stringify(b.data[k])) meta.push({ field: k, from: a.data[k] ?? null, to: b.data[k] ?? null });
    }
    return { html: html.join(''), meta, stats: { added: parts.filter(p => p.added).reduce((s, p) => s + p.count, 0), removed: parts.filter(p => p.removed).reduce((s, p) => s + p.count, 0) } };
  }

  async restoreVersion(user, id, rev) {
    const v = await this.version(id, rev);
    const cur = await this.read(id);
    return this.update(user, id, { title: v.data.title || cur.row.title, markdown: v.body, tags: [].concat(v.data.tags || []), baseRev: cur.row.rev,
      message: `Restore "${cur.row.title}" to version ${rev.slice(0, 7)}` });
  }

  async toggleTask(user, id, line, done) {
    const cur = await this.read(id);
    const lines = cur.body.split('\n');
    if (!/^\s*[-*]\s+\[[ xX]\]/.test(lines[line] || '')) throw httpError(400, 'No task on that line');
    lines[line] = lines[line].replace(/\[[ xX]\]/, done ? '[x]' : '[ ]');
    return this.update(user, id, { markdown: lines.join('\n'), baseRev: cur.row.rev, message: `${done ? 'Complete' : 'Reopen'} task in "${cur.row.title}"` });
  }

  // ---- attachments ---------------------------------------------------------------------------
  attDir(row) { return `spaces/${row.space}/_attachments/${row.id}`; }

  async attachments(id) {
    const row = this.mustRow(id);
    const dir = this.git.abs(this.attDir(row));
    let names = [];
    try { names = await fs.readdir(dir); } catch { return []; }
    const out = [];
    for (const n of names.sort()) {
      const st = await fs.stat(path.join(dir, n));
      out.push({ name: n, size: st.size, modified: st.mtime.toISOString(), url: `/api/v1/files/${row.space}/_attachments/${row.id}/${encodeURIComponent(n)}`,
        markdown: /\.(png|jpe?g|gif|svg|webp|avif)$/i.test(n) ? `![[${n}]]` : `[${n}](_attachments/${row.id}/${encodeURIComponent(n)})` });
    }
    return out;
  }

  async addAttachment(user, id, name, buf) {
    const row = this.mustRow(id);
    const max = this.app.settings.get('max_attachment_mb', 25) * 1024 * 1024;
    if (buf.length > max) throw httpError(413, 'Attachment too large');
    const file = safeFileName(name);
    const p = `${this.attDir(row)}/${file}`;
    await this.commitAndIndex({ writes: [{ path: p, content: buf }], user, message: `Attach ${file} to "${row.title}"` });
    this.app.events.pageChanged('attachment.added', row, user, { file });
    return (await this.attachments(id)).find(a => a.name === file);
  }

  async removeAttachment(user, id, name) {
    const row = this.mustRow(id);
    const p = `${this.attDir(row)}/${safeFileName(name)}`;
    if (!this.git.exists(p)) throw httpError(404, 'Attachment not found');
    await this.commitAndIndex({ deletes: [p], user, message: `Remove ${name} from "${row.title}"` });
  }

  // ---- templates -----------------------------------------------------------------------------
  async templates() {
    const files = (await this.git.listFiles('_system/templates')).filter(f => f.endsWith('.md'));
    const out = [];
    for (const f of files) {
      const { data, body } = splitFrontmatter(await this.git.readFile(f) || '');
      out.push({ id: path.basename(f, '.md'), name: data.name || path.basename(f, '.md'), description: data.description || '', type: data.type || null, tags: data.tags || [], body });
    }
    return out;
  }
  async template(tid) {
    if (!/^[\w-]+$/.test(tid)) return null;
    const text = await this.git.readFile(`_system/templates/${tid}.md`);
    if (text == null) return null;
    return splitFrontmatter(text);
  }
  async saveTemplate(user, { id, name, description = '', type, tags = [], body = '' }) {
    const tid = id || slugify(name);
    if (!/^[\w-]+$/.test(tid)) throw httpError(400, 'Invalid template id');
    const text = joinFrontmatter({ name, description, type: type || undefined, tags }, body);
    await this.commitAndIndex({ writes: [{ path: `_system/templates/${tid}.md`, content: text }], user, message: `Save template ${name}` });
    return { id: tid, name };
  }
  async deleteTemplate(user, tid) {
    if (!/^[\w-]+$/.test(tid) || !this.git.exists(`_system/templates/${tid}.md`)) throw httpError(404, 'Template not found');
    await this.commitAndIndex({ deletes: [`_system/templates/${tid}.md`], user, message: `Delete template ${tid}` });
  }
}
