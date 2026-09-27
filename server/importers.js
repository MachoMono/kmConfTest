// Migration in and out:
//   importConfluence : Confluence "HTML export" zip -> pages (hierarchy, labels, panels, code,
//                      expand, status, attachments, cross-page links become [[wikilinks]])
//   importMarkdown   : Obsidian vault / Markdown zip -> pages (folders become parent pages)
//   exportSpace      : zip of the space's files (Markdown + attachments), Obsidian-compatible
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import domino from '@mixmark-io/domino';
import path from 'node:path';
import { htmlToMarkdown } from '../shared/tomd.js';
import { splitFrontmatter, joinFrontmatter } from '../shared/doc.js';
import { slugify } from '../shared/markdown.js';
import { newId, safeFileName } from './pages.js';
import { httpError } from './auth.js';
import { now } from './db.js';

const IMG = /\.(png|jpe?g|gif|svg|webp|avif|bmp)$/i;

function unzip(buf) {
  try { return unzipSync(new Uint8Array(buf)); } catch (e) { throw httpError(400, 'Not a valid zip archive: ' + e.message); }
}

class Planner {
  constructor(app, space) { this.app = app; this.space = space; this.writes = []; this.used = new Set(); this.count = 0; }
  path(title) {
    let base = slugify(title), p = `spaces/${this.space}/${base}.md`, n = 2;
    while (this.used.has(p) || this.app.git.exists(p)) p = `spaces/${this.space}/${base}-${n++}.md`;
    this.used.add(p);
    return p;
  }
  page(data, body) { this.writes.push({ path: this.path(data.title), content: joinFrontmatter(data, body) }); this.count++; }
  file(rel, content) { this.writes.push({ path: `spaces/${this.space}/${rel}`, content }); }
}

async function commitPlan(app, user, plan, message) {
  if (!plan.writes.length) return { pages: 0 };
  return app.pages.withLock(() => commitPlanLocked(app, user, plan, message));
}

async function commitPlanLocked(app, user, plan, message) {
  const rev = await app.git.commit({ writes: plan.writes, message, author: app.users.authorOf(user) });
  const meta = { rev, date: now(), author: user.username };
  app.indexer.bulk = true;
  try { for (const w of plan.writes) if (w.path.endsWith('.md')) await app.indexer.indexPath(w.path, null, meta); }
  finally { app.indexer.bulk = false; }
  app.indexer.resolveAll();
  app.audit(user, 'import', plan.space, { pages: plan.count, message });
  app.sync.schedulePush();
  return { pages: plan.count, rev };
}

export async function importConfluence(app, user, space, buf, { parent } = {}) {
  const files = unzip(buf);
  const names = Object.keys(files);
  const htmlFiles = names.filter(n => /\.html?$/i.test(n) && !/(^|\/)index\.html?$/i.test(n));
  if (!htmlFiles.length) throw httpError(400, 'No Confluence HTML pages found in archive');
  const pages = new Map(); // file basename -> info
  for (const n of htmlFiles) {
    const doc = domino.createDocument(strFromU8(files[n]));
    const titleEl = doc.querySelector('#title-text') || doc.querySelector('h1');
    let title = (titleEl ? titleEl.textContent : doc.title || path.basename(n, '.html')).trim();
    title = title.replace(/^[^:]{1,80}\s:\s/, '').trim() || path.basename(n, '.html');
    const crumbs = [...doc.querySelectorAll('#breadcrumbs li a')].map(a => a.getAttribute('href')).filter(h => h && !/index\.html?$/i.test(h));
    const labels = [...doc.querySelectorAll('.labels a, .aui-label a, a.aui-label')].map(a => a.textContent.trim()).filter(Boolean);
    const content = doc.querySelector('#main-content') || doc.querySelector('.wiki-content') || doc.body;
    pages.set(path.basename(n), { file: n, dir: path.dirname(n), title, parentFile: crumbs.length ? path.basename(crumbs[crumbs.length - 1]) : null, labels, content, doc, id: newId() });
  }
  const plan = new Planner(app, space);
  const byTitle = new Map([...pages.values()].map(p => [p.title, p]));
  let order = 10;
  for (const p of pages.values()) {
    const c = p.content;
    // info/note/warning/tip panels -> callouts
    for (const m of [...c.querySelectorAll('.confluence-information-macro')]) {
      const cls = m.getAttribute('class') || '';
      const type = /warning/.test(cls) ? 'warning' : /note/.test(cls) ? 'note' : /tip/.test(cls) ? 'tip' : 'info';
      const t = m.querySelector('.title');
      const body = m.querySelector('.confluence-information-macro-body') || m;
      const div = p.doc.createElement('div');
      div.setAttribute('class', 'callout'); div.setAttribute('data-callout', type);
      div.innerHTML = `<div class="callout-title">${t ? t.textContent.replace(/</g, '&lt;') : ''}</div><div class="callout-body">${body.innerHTML}</div>`;
      m.parentNode.replaceChild(div, m);
    }
    // code macros
    for (const pre of [...c.querySelectorAll('pre.syntaxhighlighter-pre, .code pre, pre[data-syntaxhighlighter-params]')]) {
      const params = pre.getAttribute('data-syntaxhighlighter-params') || '';
      const lang = (/brush:\s*([\w+#-]+)/.exec(params) || [])[1] || '';
      const np = p.doc.createElement('pre');
      const code = p.doc.createElement('code');
      if (lang) code.setAttribute('class', 'language-' + lang.toLowerCase());
      code.textContent = pre.textContent;
      np.appendChild(code);
      pre.parentNode.replaceChild(np, pre);
    }
    // expand macros -> details
    for (const ex of [...c.querySelectorAll('.expand-container')]) {
      const d = p.doc.createElement('details');
      const s = p.doc.createElement('summary');
      s.textContent = (ex.querySelector('.expand-control-text') || {}).textContent || 'Details';
      d.appendChild(s);
      const body = ex.querySelector('.expand-content');
      if (body) d.innerHTML += body.innerHTML;
      ex.parentNode.replaceChild(d, ex);
    }
    // status lozenges
    for (const st of [...c.querySelectorAll('.status-macro')]) {
      const cls = st.getAttribute('class') || '';
      const color = /success/.test(cls) ? 'green' : /error/.test(cls) ? 'red' : /current/.test(cls) ? 'blue' : /moved|complete/.test(cls) ? 'yellow' : 'grey';
      const sp = p.doc.createElement('span');
      sp.setAttribute('class', 'status'); sp.setAttribute('data-color', color); sp.textContent = st.textContent.trim();
      st.parentNode.replaceChild(sp, st);
    }
    // user mentions
    for (const a of [...c.querySelectorAll('a.confluence-userlink, a.user-mention')]) {
      const un = (a.getAttribute('data-username') || a.textContent).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '.');
      const sp = p.doc.createElement('span'); sp.setAttribute('class', 'mention'); sp.setAttribute('data-user', un); sp.textContent = '@' + un;
      a.parentNode.replaceChild(sp, a);
    }
    // links to other exported pages -> wikilinks
    for (const a of [...c.querySelectorAll('a[href]')]) {
      const href = a.getAttribute('href');
      const target = pages.get(path.basename(href.split('#')[0]));
      if (target && !/^https?:/i.test(href)) {
        a.setAttribute('class', 'wikilink'); a.setAttribute('data-target', target.title);
        if (a.textContent.trim() && a.textContent.trim() !== target.title) a.setAttribute('data-alias', a.textContent.trim());
      }
    }
    // attachments
    for (const img of [...c.querySelectorAll('img[src]')]) {
      const src = decodeURIComponent(img.getAttribute('src').split('?')[0]);
      const full = path.posix.normalize(path.posix.join(p.dir, src));
      const data = files[full] || files[src];
      if (!data) continue;
      const name = safeFileName(img.getAttribute('data-linked-resource-default-alias') || path.basename(src));
      plan.file(`_attachments/${p.id}/${name}`, Buffer.from(data));
      img.setAttribute('src', `_attachments/${p.id}/${encodeURIComponent(name)}`);
      img.removeAttribute('data-src');
    }
    for (const a of [...c.querySelectorAll('a[href^="attachments/"]')]) {
      const src = decodeURIComponent(a.getAttribute('href').split('?')[0]);
      const data = files[path.posix.join(p.dir, src)] || files[src];
      if (!data) continue;
      const name = safeFileName(path.basename(src));
      plan.file(`_attachments/${p.id}/${name}`, Buffer.from(data));
      a.setAttribute('href', `_attachments/${p.id}/${encodeURIComponent(name)}`);
    }
    for (const junk of [...c.querySelectorAll('.pageSection, #attachments, .plugin_pagetree, script, style')]) junk.parentNode && junk.parentNode.removeChild(junk);
    const body = htmlToMarkdown(c.innerHTML);
    const par = p.parentFile && pages.get(p.parentFile) ? pages.get(p.parentFile).id : (parent || app.db.get('SELECT home_id FROM spaces WHERE key = ?', space)?.home_id || undefined);
    plan.page({ id: p.id, title: p.title, tags: p.labels.map(l => l.toLowerCase().replace(/\s+/g, '-')), parent: par, order: order += 10,
      created: now(), created_by: user.username, source: 'confluence' }, body);
  }
  void byTitle;
  return commitPlan(app, user, plan, `Import ${pages.size} page(s) from Confluence into ${space}`);
}

export async function importMarkdown(app, user, space, buf, { parent } = {}) {
  const files = unzip(buf);
  const names = Object.keys(files).filter(n => !n.endsWith('/') && !/(^|\/)\.(obsidian|git|trash)\//.test(n) && !/(^|\/)\./.test(path.basename(n)));
  const mdFiles = names.filter(n => /\.md$/i.test(n));
  if (!mdFiles.length) throw httpError(400, 'No Markdown files found in archive');
  const plan = new Planner(app, space);
  const root = parent || app.db.get('SELECT home_id FROM spaces WHERE key = ?', space)?.home_id || undefined;
  const folderIds = new Map();
  const noteByDirAndName = new Set(mdFiles.map(n => n.replace(/\.md$/i, '')));
  let order = 10;
  const folderId = (dir) => {
    if (!dir || dir === '.') return root;
    if (folderIds.has(dir)) return folderIds.get(dir);
    const id = newId();
    folderIds.set(dir, id);
    const parentId = folderId(path.posix.dirname(dir));
    if (!noteByDirAndName.has(dir)) {
      plan.page({ id, title: path.posix.basename(dir), parent: parentId, order: order += 10, created: now(), created_by: user.username },
        `\`\`\`children\ndepth: 2\n\`\`\`\n`);
    }
    return id;
  };
  // folder notes: "folder.md" next to "folder/" becomes the folder page itself
  for (const n of mdFiles) {
    const dirKey = n.replace(/\.md$/i, '');
    if (names.some(x => x.startsWith(dirKey + '/'))) folderIds.set(dirKey, newId());
  }
  for (const n of mdFiles) {
    const { data, body } = splitFrontmatter(strFromU8(files[n]));
    const dirKey = n.replace(/\.md$/i, '');
    const id = folderIds.get(dirKey) || newId();
    const title = String(data.title || path.posix.basename(n, '.md'));
    const par = folderId(path.posix.dirname(n));
    plan.page({ ...data, id, title, parent: par === id ? root : par, order: order += 10, created: data.created || now(), created_by: user.username }, body);
  }
  for (const n of names) {
    if (/\.md$/i.test(n) || !(IMG.test(n) || /\.(pdf|docx?|xlsx?|pptx?|csv|txt|zip)$/i.test(n))) continue;
    plan.file(`_attachments/_shared/${safeFileName(path.posix.basename(n))}`, Buffer.from(files[n]));
  }
  return commitPlan(app, user, plan, `Import ${plan.count} page(s) from Markdown archive into ${space}`);
}

export async function exportSpace(app, space) {
  const files = await app.git.listFiles(`spaces/${space}`);
  const out = {};
  for (const f of files) {
    const buf = await app.git.readFile(f, null);
    if (buf) out[f.slice(`spaces/${space}/`.length)] = new Uint8Array(buf);
  }
  out['README.md'] = strToU8(`# ${space}\n\nExported from GitWiki on ${now()}.\nPages are Markdown with YAML frontmatter and Obsidian-style [[links]]; open this folder as an Obsidian vault.\n`);
  return Buffer.from(zipSync(out, { level: 6 }));
}
