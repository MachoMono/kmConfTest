// Isomorphic Markdown -> HTML renderer (used by the server for page views and by the
// browser to load Markdown into the WYSIWYG editor). Extends CommonMark/GFM with the
// Obsidian and Confluence-style syntax GitWiki stores in the repo:
//   [[Page]] [[Page#Heading|alias]] ![[Page]] ![[image.png]]   wikilinks / embeds
//   #tag #nested/tag                                           tags
//   @username                                                  mentions
//   > [!info] Title                                            callouts (panels)
//   - [ ] task / - [x] done                                    task lists
//   {{status:green|Done}}                                      status lozenges
//   ```toc / children / query / recent / tasks / include       macros
//   ```mermaid                                                 diagrams
import MarkdownIt from 'markdown-it';

export const MACROS = ['toc', 'children', 'query', 'recent', 'tasks', 'include', 'tagcloud', 'excerpt'];
export const CALLOUTS = ['info', 'note', 'tip', 'success', 'warning', 'danger', 'question', 'quote', 'example'];
const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|avif|bmp)$/i;
const TAG_RE = /^#([\p{L}\p{N}_\-/]*[\p{L}_\-][\p{L}\p{N}_\-/]*)/u;
const MENTION_RE = /^@([A-Za-z0-9_][A-Za-z0-9._-]*[A-Za-z0-9_]|[A-Za-z0-9_])/;
const STATUS_RE = /^\{\{status:([a-z]+)\|([^}]*)\}\}/;
const WIKI_RE = /^(!?)\[\[([^\]\n]+?)\]\]/;

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'untitled';
}

/** Parse the inside of [[...]] into {target, anchor, alias}. */
export function parseWikiTarget(inner) {
  let alias = null;
  const pipe = inner.indexOf('|');
  if (pipe >= 0) { alias = inner.slice(pipe + 1).trim(); inner = inner.slice(0, pipe); }
  let anchor = null;
  const hash = inner.indexOf('#');
  if (hash >= 0) { anchor = inner.slice(hash + 1).trim(); inner = inner.slice(0, hash); }
  return { target: inner.trim(), anchor, alias };
}

function precededByBoundary(state) {
  if (state.pos === 0) return true;
  const prev = state.src.charCodeAt(state.pos - 1);
  // whitespace, ( [ { , ; : ! ? " '
  return /[\s([{,;:!?"'>]/.test(String.fromCharCode(prev));
}

function wikilinkPlugin(md) {
  md.inline.ruler.before('link', 'wikilink', (state, silent) => {
    const src = state.src.slice(state.pos);
    if (src[0] !== '[' && !(src[0] === '!' && src[1] === '[')) return false;
    const m = WIKI_RE.exec(src);
    if (!m) return false;
    if (!silent) {
      const tok = state.push('wikilink', '', 0);
      tok.meta = { embed: m[1] === '!', ...parseWikiTarget(m[2]) };
      tok.content = m[0];
    }
    state.pos += m[0].length;
    return true;
  });
  md.renderer.rules.wikilink = (tokens, idx, _opts, env) => {
    const { embed, target, anchor, alias } = tokens[idx].meta;
    if (embed && IMAGE_EXT.test(target)) {
      const src = env.resolveAttachment ? env.resolveAttachment(target) : target;
      return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alias || target)}" data-wikiembed="${escapeHtml(target)}">`;
    }
    if (embed) {
      return `<div class="embed" data-target="${escapeHtml(target)}"${anchor ? ` data-anchor="${escapeHtml(anchor)}"` : ''}></div>`;
    }
    const r = env.resolveLink ? env.resolveLink(target, anchor) : null;
    const cls = r && !r.exists ? 'wikilink missing' : 'wikilink';
    const href = r ? r.href : '#';
    const text = alias || (anchor && !target ? anchor : target + (anchor ? ' › ' + anchor : ''));
    return `<a class="${cls}" href="${escapeHtml(href)}" data-target="${escapeHtml(target)}"` +
      `${anchor ? ` data-anchor="${escapeHtml(anchor)}"` : ''}${alias ? ` data-alias="${escapeHtml(alias)}"` : ''}>${escapeHtml(text)}</a>`;
  };
}

function inlineSigilsPlugin(md) {
  md.inline.ruler.before('emphasis', 'tag', (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x23 /* # */ || !precededByBoundary(state)) return false;
    const m = TAG_RE.exec(state.src.slice(state.pos));
    if (!m) return false;
    let tag = m[1].replace(/\/+$/, '');
    if (!tag) return false;
    if (!silent) { const t = state.push('tag', '', 0); t.meta = { tag }; }
    state.pos += tag.length + 1;
    return true;
  });
  md.renderer.rules.tag = (tokens, idx, _o, env) => {
    const tag = tokens[idx].meta.tag;
    const href = env.tagHref ? env.tagHref(tag) : `/tags/${encodeURIComponent(tag)}`;
    return `<a class="tag" href="${escapeHtml(href)}" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</a>`;
  };

  md.inline.ruler.before('emphasis', 'mention', (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x40 /* @ */ || !precededByBoundary(state)) return false;
    const m = MENTION_RE.exec(state.src.slice(state.pos));
    if (!m) return false;
    if (!silent) { const t = state.push('mention', '', 0); t.meta = { user: m[1] }; }
    state.pos += m[0].length;
    return true;
  });
  md.renderer.rules.mention = (tokens, idx, _o, env) => {
    const u = tokens[idx].meta.user;
    const name = env.userName ? env.userName(u) : null;
    return `<span class="mention" data-user="${escapeHtml(u)}"${name ? ` title="${escapeHtml(name)}"` : ''}>@${escapeHtml(u)}</span>`;
  };

  md.inline.ruler.before('emphasis', 'status', (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x7b /* { */) return false;
    const m = STATUS_RE.exec(state.src.slice(state.pos));
    if (!m) return false;
    if (!silent) { const t = state.push('status', '', 0); t.meta = { color: m[1], text: m[2] }; }
    state.pos += m[0].length;
    return true;
  });
  md.renderer.rules.status = (tokens, idx) => {
    const { color, text } = tokens[idx].meta;
    return `<span class="status" data-color="${escapeHtml(color)}">${escapeHtml(text)}</span>`;
  };
}

function calloutAndTaskPlugin(md) {
  md.core.ruler.after('block', 'callouts_tasks', (state) => {
    const toks = state.tokens;
    const quoteStack = [];
    const listStack = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.type === 'blockquote_open') {
        quoteStack.push(t);
        const p = toks[i + 1], inl = toks[i + 2];
        if (p && p.type === 'paragraph_open' && inl && inl.type === 'inline') {
          const m = /^\[!([a-zA-Z]+)\]([+-]?)[ \t]*(.*)$/.exec(inl.content.split('\n')[0]);
          if (m) {
            t.meta = { callout: m[1].toLowerCase(), title: m[3] };
            const rest = inl.content.split('\n').slice(1).join('\n');
            if (rest.trim()) inl.content = rest;
            else { toks.splice(i + 1, 3); } // drop the now-empty paragraph
          }
        }
      } else if (t.type === 'blockquote_close') {
        const open = quoteStack.pop();
        if (open && open.meta && open.meta.callout) t.meta = { callout: true };
      } else if (t.type === 'bullet_list_open' || t.type === 'ordered_list_open') {
        listStack.push({ open: t, items: 0, tasks: 0, itemToks: [] });
      } else if (t.type === 'bullet_list_close' || t.type === 'ordered_list_close') {
        const l = listStack.pop();
        if (l && l.open.type === 'bullet_list_open' && l.items > 0 && l.items === l.tasks) {
          l.open.attrSet('data-type', 'taskList');
          for (const [li, checked, inl] of l.itemToks) {
            li.attrSet('data-type', 'taskItem');
            li.attrSet('data-checked', checked ? 'true' : 'false');
            inl.content = inl.content.replace(/^\[[ xX]\][ \t]?/, '');
          }
        }
      } else if (t.type === 'list_item_open') {
        const l = listStack[listStack.length - 1];
        if (!l) continue;
        l.items++;
        const p = toks[i + 1], inl = toks[i + 2];
        if (p && p.type === 'paragraph_open' && inl && inl.type === 'inline') {
          const m = /^\[([ xX])\](?:[ \t]|$)/.exec(inl.content);
          if (m) { l.tasks++; l.itemToks.push([t, m[1] !== ' ', inl]); }
        }
      }
    }
  });
  const defOpen = md.renderer.rules.blockquote_open || ((t, i, o, e, s) => s.renderToken(t, i, o));
  const defClose = md.renderer.rules.blockquote_close || ((t, i, o, e, s) => s.renderToken(t, i, o));
  md.renderer.rules.blockquote_open = (tokens, idx, o, e, self) => {
    const m = tokens[idx].meta;
    if (m && m.callout) {
      const type = CALLOUTS.includes(m.callout) ? m.callout : 'note';
      return `<div class="callout" data-callout="${type}"><div class="callout-title">${md.renderInline(m.title || '', e)}</div><div class="callout-body">`;
    }
    return defOpen(tokens, idx, o, e, self);
  };
  md.renderer.rules.blockquote_close = (tokens, idx, o, e, self) =>
    tokens[idx].meta && tokens[idx].meta.callout ? '</div></div>\n' : defClose(tokens, idx, o, e, self);
}

function headingIdsPlugin(md) {
  md.core.ruler.push('heading_ids', (state) => {
    const used = new Map();
    const toks = state.tokens;
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type !== 'heading_open') continue;
      const text = toks[i + 1].children.filter(c => c.type === 'text' || c.type === 'code_inline').map(c => c.content).join('');
      let id = slugify(text);
      const n = used.get(id) || 0;
      used.set(id, n + 1);
      if (n) id += '-' + n;
      toks[i].attrSet('id', id);
      (state.env.headings ||= []).push({ level: +toks[i].tag.slice(1), text, id });
    }
  });
}

function fencePlugin(md) {
  const defFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, opts, env, self) => {
    const t = tokens[idx];
    const lang = (t.info || '').trim().split(/\s+/)[0].toLowerCase();
    if (lang === 'mermaid') return `<pre class="mermaid">${escapeHtml(t.content)}</pre>\n`;
    if (MACROS.includes(lang)) {
      const params = t.content.replace(/\n$/, '');
      return `<div class="macro" data-macro="${lang}" data-params="${escapeHtml(params)}"></div>\n`;
    }
    return defFence(tokens, idx, opts, env, self);
  };
}

function imagePlugin(md) {
  const def = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, idx, opts, env, self) => {
    const t = tokens[idx];
    const src = t.attrGet('src') || '';
    if (env.resolveAttachment && !/^([a-z]+:|\/|#)/i.test(src)) {
      t.attrSet('src', env.resolveAttachment(src, true));
      t.attrSet('data-src', src);
    }
    return def(tokens, idx, opts, env, self);
  };
  const defLink = md.renderer.rules.link_open || ((t, i, o, e, s) => s.renderToken(t, i, o));
  md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
    const t = tokens[idx];
    const href = t.attrGet('href') || '';
    if (env.resolveAttachment && /^_attachments\//.test(href)) {
      t.attrSet('href', env.resolveAttachment(href, true));
      t.attrSet('data-src', href);
    }
    return defLink(tokens, idx, opts, env, self);
  };
}

let _md;
export function createMarkdown() {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false, breaks: false });
  md.use(wikilinkPlugin).use(inlineSigilsPlugin).use(calloutAndTaskPlugin)
    .use(headingIdsPlugin).use(fencePlugin).use(imagePlugin);
  return md;
}

/**
 * Render Markdown body (no frontmatter) to HTML. `env` may supply resolveLink(target, anchor),
 * resolveAttachment(name), tagHref(tag), userName(u). After rendering env.headings is populated.
 */
export function renderMarkdown(body, env = {}) {
  _md ||= createMarkdown();
  return _md.render(body || '', env).replace(/<p>(<div class="embed"[^>]*><\/div>)<\/p>/g, '$1');
}
