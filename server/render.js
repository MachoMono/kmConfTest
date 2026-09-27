// Server-side page rendering: Markdown -> sanitised HTML with resolved wikilinks, attachments,
// macros (toc, children, query, recent, tasks, include, tagcloud, excerpt) and transclusion.
import sanitizeHtml from 'sanitize-html';
import crypto from 'node:crypto';
import { renderMarkdown, escapeHtml } from '../shared/markdown.js';
import { splitFrontmatter } from '../shared/doc.js';

const SANITIZE = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'details', 'summary', 'del', 's', 'ins', 'u', 'mark', 'sub', 'sup',
    'kbd', 'h1', 'h2', 'h5', 'h6', 'input', 'label', 'span', 'div', 'figure', 'figcaption', 'dl', 'dt', 'dd']),
  allowedAttributes: {
    '*': ['id', 'class', 'title', 'data-*', 'align'],
    a: ['href', 'name', 'target', 'rel', 'class', 'data-*'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'data-*'],
    input: ['type', 'checked', 'disabled'],
    td: ['colspan', 'rowspan', 'style'], th: ['colspan', 'rowspan', 'style'],
    ol: ['start'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  allowProtocolRelative: false,
  allowedStyles: { '*': { 'text-align': [/^(left|right|center)$/] } },
  transformTags: {
    a: (tag, attribs) => /^https?:/i.test(attribs.href || '') ? { tagName: 'a', attribs: { ...attribs, rel: 'noopener noreferrer', target: '_blank' } } : { tagName: 'a', attribs },
    img: (tag, attribs) => ({ tagName: 'img', attribs: { ...attribs, loading: 'lazy' } }),
  },
};

export function sanitize(html) { return sanitizeHtml(html, SANITIZE); }

export function parseParams(text) {
  const params = {};
  const free = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*([a-z_]+)\s*:\s*(.*)$/i.exec(line);
    if (m && !/^(tag|space|type|author|kind|sort|owner|status|in)$/i.test(m[1])) params[m[1].toLowerCase()] = m[2].trim();
    else if (line.trim()) free.push(line.trim());
  }
  if (free.length && !params.query) params.query = free.join(' ');
  return params;
}

const fmtDate = (d) => d ? String(d).slice(0, 10) : '';

export class Renderer {
  constructor(app) { this.app = app; this.cache = new Map(); }

  pageHref(p, anchor) { return `/p/${p.id}${anchor ? '#' + encodeURIComponent(anchor) : ''}`; }

  attachmentUrl(space, rel) {
    return `/api/v1/files/${encodeURIComponent(space)}/${rel.split('/').map(encodeURIComponent).join('/')}`;
  }

  env(page) {
    const idx = this.app.indexer;
    return {
      resolveLink: (target, anchor) => {
        const hit = target ? idx.resolve(target, page.space) : page;
        if (hit) return { exists: true, href: this.pageHref(hit, anchor) };
        return { exists: false, href: `/new?space=${encodeURIComponent(page.space)}&title=${encodeURIComponent(target)}` };
      },
      resolveAttachment: (name, relative) => {
        if (relative) return this.attachmentUrl(page.space, decodeURIComponent(name));
        const own = `_attachments/${page.id}/${name}`;
        if (this.app.git.exists(`spaces/${page.space}/${own}`)) return this.attachmentUrl(page.space, own);
        return this.attachmentUrl(page.space, `_attachments/_shared/${name}`);
      },
      tagHref: (t) => `/tags/${encodeURIComponent(t)}`,
      userName: (u) => { const r = this.app.users.byUsername(u); return r ? r.name : null; },
    };
  }

  /** Markdown body -> sanitised HTML (cached by content + index version). */
  base(page, body) {
    const key = crypto.createHash('sha1').update(page.id + '\0' + page.space + '\0' + body).digest('hex') + ':' + this.app.indexer.version;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const env = this.env(page);
    const html = sanitize(renderMarkdown(body, env));
    const out = { html, headings: env.headings || [] };
    if (this.cache.size > 2000) this.cache.clear();
    this.cache.set(key, out);
    return out;
  }

  /** Full view render for a user (macros and embeds are permission-aware). */
  async render(page, body, user, depth = 0) {
    const { html, headings } = this.base(page, body);
    let out = html;
    const macroRe = /<div class="macro" data-macro="([a-z]+)" data-params(?:="([^"]*)")?><\/div>/g;
    const macros = [...out.matchAll(macroRe)];
    for (const m of macros) {
      const params = parseParams((m[2] || '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/&amp;/g, '&'));
      let rendered;
      try { rendered = await this.macro(m[1], params, page, user, headings, depth); }
      catch (e) { rendered = `<div class="macro-error">Macro "${escapeHtml(m[1])}" failed: ${escapeHtml(e.message)}</div>`; }
      out = out.replace(m[0], `<div class="macro-rendered" data-macro="${m[1]}">${rendered}</div>`);
    }
    const embedRe = /<div class="embed" data-target="([^"]*)"(?: data-anchor="([^"]*)")?><\/div>/g;
    for (const m of [...out.matchAll(embedRe)]) {
      const target = m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"');
      out = out.replace(m[0], await this.embed(target, m[2], page, user, depth));
    }
    return { html: out, headings };
  }

  async embed(target, anchor, page, user, depth) {
    const hit = this.app.indexer.resolve(target, page.space);
    if (!hit || !this.app.perms.can(user, 'view', hit)) {
      return `<div class="embed missing">Embedded page “${escapeHtml(target)}” is unavailable.</div>`;
    }
    if (depth >= 2 || hit.id === page.id) {
      return `<div class="embed"><a class="wikilink" href="${this.pageHref(hit)}">${escapeHtml(hit.title)}</a></div>`;
    }
    const text = await this.app.git.readFile(hit.path);
    let { body } = splitFrontmatter(text || '');
    if (anchor) body = sectionOf(body, anchor);
    const r = await this.render(hit, body, user, depth + 1);
    return `<div class="embed" data-target="${escapeHtml(hit.title)}"><div class="embed-title"><a href="${this.pageHref(hit, anchor)}">${escapeHtml(hit.title)}${anchor ? ' › ' + escapeHtml(anchor) : ''}</a></div><div class="embed-body">${r.html}</div></div>`;
  }

  async macro(name, params, page, user, headings, depth) {
    const db = this.app.db;
    const canView = this.app.perms.viewFilter(user);
    const link = (p) => `<a class="wikilink" href="${this.pageHref(p)}">${escapeHtml(p.title)}</a>`;
    switch (name) {
      case 'toc': {
        const max = Number(params.maxlevel || params.max || 3);
        const hs = headings.filter(h => h.level <= max);
        if (!hs.length) return '<p class="muted">No headings yet.</p>';
        const min = Math.min(...hs.map(h => h.level));
        return '<nav class="toc"><ul>' + hs.map(h => `<li class="toc-l${h.level - min}"><a href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a></li>`).join('') + '</ul></nav>';
      }
      case 'children': {
        const maxDepth = Number(params.depth || 1);
        const withExcerpt = /^(true|yes|1)$/i.test(params.excerpt || '');
        const tree = (pid, d) => {
          const kids = db.all("SELECT * FROM pages WHERE parent = ? AND archived = 0 AND kind = 'page' ORDER BY sort, title", pid).filter(canView);
          if (!kids.length) return '';
          return '<ul class="children">' + kids.map(k => `<li>${link(k)}${withExcerpt && k.excerpt ? `<div class="excerpt">${escapeHtml(k.excerpt)}</div>` : ''}${d < maxDepth ? tree(k.id, d + 1) : ''}</li>`).join('') + '</ul>';
        };
        return tree(page.id, 1) || '<p class="muted">No child pages.</p>';
      }
      case 'query': {
        const q = params.query || '';
        const limit = Math.min(Number(params.limit || 50), 200);
        const res = this.app.search.query(user, q + (/sort:/.test(q) ? '' : ' sort:title'), { limit, log: false });
        const cols = (params.columns || 'title, type, updated').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        if (!res.results.length) return '<p class="muted">No matching pages.</p>';
        const cell = (r, c) => {
          const row = db.get('SELECT * FROM pages WHERE id = ?', r.id);
          const props = JSON.parse(row.props || '{}');
          if (c === 'title') return link(row);
          if (c === 'updated') return escapeHtml(fmtDate(row.updated_at));
          if (c === 'created') return escapeHtml(fmtDate(row.created_at));
          if (c === 'tags') return JSON.parse(row.tags).map(t => `<a class="tag" href="/tags/${encodeURIComponent(t)}">#${escapeHtml(t)}</a>`).join(' ');
          if (c === 'space' || c === 'type' || c === 'status' || c === 'updated_by' || c === 'created_by' || c === 'excerpt' || c === 'review_by') return escapeHtml(row[c] || '');
          const v = props[c];
          if (Array.isArray(v)) return v.map(t => { const h = this.app.indexer.resolve(t, row.space); return h ? link(h) : escapeHtml(t); }).join(', ');
          return escapeHtml(v == null ? '' : String(v));
        };
        return `<table class="query-table"><thead><tr>${cols.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead><tbody>` +
          res.results.map(r => `<tr>${cols.map(c => `<td>${cell(r, c)}</td>`).join('')}</tr>`).join('') + '</tbody></table>';
      }
      case 'recent': {
        const limit = Math.min(Number(params.limit || 10), 50);
        const space = params.space === 'all' ? null : (params.space || page.space).toUpperCase();
        const rows = db.all(`SELECT * FROM pages WHERE archived = 0 ${space ? 'AND space = ?' : ''} ORDER BY updated_at DESC LIMIT 200`, ...(space ? [space] : []))
          .filter(canView).slice(0, limit);
        return '<ul class="recent">' + rows.map(r => `<li>${link(r)} <span class="muted">${escapeHtml(fmtDate(r.updated_at))} · ${escapeHtml(r.updated_by || '')}</span></li>`).join('') + '</ul>';
      }
      case 'tasks': {
        const where = [];
        const args = [];
        if (params.assignee) { where.push('t.assignee = ?'); args.push(params.assignee === 'me' && user ? user.username.toLowerCase() : params.assignee.toLowerCase()); }
        if (params.done !== undefined) { where.push('t.done = ?'); args.push(/^(true|yes|1)$/i.test(params.done) ? 1 : 0); }
        if (params.space) { where.push('p.space = ?'); args.push(params.space.toUpperCase()); }
        if (!params.assignee && !params.space && !params.query) { where.push('t.page_id = ?'); args.push(page.id); }
        const rows = db.all(`SELECT t.*, p.title, p.id AS pid, p.space, p.parent FROM tasks t JOIN pages p ON p.id = t.page_id
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.done, t.due IS NULL, t.due LIMIT 200`, ...args)
          .filter(r => canView({ id: r.pid, space: r.space, parent: r.parent }));
        if (!rows.length) return '<p class="muted">No tasks.</p>';
        return '<ul class="task-report">' + rows.map(r => `<li class="${r.done ? 'done' : ''}"><input type="checkbox" disabled${r.done ? ' checked' : ''}> ${escapeHtml(r.text)} <span class="muted">— <a href="/p/${r.pid}">${escapeHtml(r.title)}</a>${r.due ? ' · due ' + escapeHtml(r.due) : ''}</span></li>`).join('') + '</ul>';
      }
      case 'include': case 'excerpt': {
        const target = params.page || params.query;
        if (!target) return '<p class="muted">No page specified.</p>';
        if (name === 'include') return this.embed(target.replace(/^\[\[|\]\]$/g, ''), params.section || null, page, user, depth);
        const hit = this.app.indexer.resolve(target.replace(/^\[\[|\]\]$/g, ''), page.space);
        if (!hit || !canView(hit)) return '<p class="muted">Page unavailable.</p>';
        return `<blockquote class="excerpt">${escapeHtml(hit.excerpt || '')} — ${link(hit)}</blockquote>`;
      }
      case 'tagcloud': {
        const space = params.space ? params.space.toUpperCase() : null;
        const rows = db.all(`SELECT t.tag, COUNT(*) AS n FROM page_tags t JOIN pages p ON p.id = t.page_id WHERE p.archived = 0 ${space ? 'AND p.space = ?' : ''}
          GROUP BY t.tag ORDER BY n DESC LIMIT ${Math.min(Number(params.limit || 50), 200)}`, ...(space ? [space] : []));
        const max = Math.max(1, ...rows.map(r => r.n));
        return '<div class="tagcloud">' + rows.map(r => `<a class="tag" style="font-size:${(0.85 + (r.n / max) * 0.8).toFixed(2)}em" href="/tags/${encodeURIComponent(r.tag)}">#${escapeHtml(r.tag)} <small>${r.n}</small></a>`).join(' ') + '</div>';
      }
      default:
        return `<p class="muted">Unknown macro ${escapeHtml(name)}</p>`;
    }
  }
}

/** Return the section of a Markdown body under the heading whose text/slug matches `anchor`. */
export function sectionOf(body, anchor) {
  const lines = body.split('\n');
  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  const a = norm(anchor);
  let start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.+?)\s*#*$/.exec(lines[i]);
    if (!m) continue;
    if (start < 0 && norm(m[2]) === a) { start = i; level = m[1].length; continue; }
    if (start >= 0 && m[1].length <= level) return lines.slice(start, i).join('\n');
  }
  return start >= 0 ? lines.slice(start).join('\n') : body;
}
