// Document model: frontmatter + body parsing and semantic extraction (links, tags, mentions,
// typed relations, tasks, sections). Used by the indexer, the ontology/GraphRAG layer and the UI.
import YAML from 'yaml';
import { parseWikiTarget, slugify } from './markdown.js';

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)(?:\r?\n)?/;

export function splitFrontmatter(text) {
  const m = FM_RE.exec(text || '');
  if (!m) return { data: {}, body: text || '', raw: '' };
  let data = {};
  try { data = YAML.parse(m[1]) || {}; } catch { data = {}; }
  if (typeof data !== 'object' || Array.isArray(data)) data = {};
  return { data, body: text.slice(m[0].length), raw: m[1] };
}

const FM_ORDER = ['id', 'title', 'type', 'kind', 'tags', 'aliases', 'parent', 'order', 'status', 'owner',
  'review_by', 'archived', 'created', 'created_by'];

export function joinFrontmatter(data, body) {
  const keys = Object.keys(data).filter(k => data[k] !== undefined && data[k] !== null &&
    !(Array.isArray(data[k]) && data[k].length === 0));
  keys.sort((a, b) => {
    const ia = FM_ORDER.indexOf(a), ib = FM_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const ordered = {};
  for (const k of keys) ordered[k] = data[k];
  const yaml = YAML.stringify(ordered, { lineWidth: 0, flowCollectionPadding: false }).trimEnd();
  const b = (body || '').replace(/^\n+/, '');
  return `---\n${yaml}\n---\n\n${b.endsWith('\n') ? b : b + '\n'}`;
}

export function normalizeTag(t) {
  return String(t).trim().replace(/^#/, '').replace(/\/+$/, '').toLowerCase();
}
export function normalizeName(s) {
  return String(s).trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Replace fenced code and inline code with blanks so extraction ignores them (keeps offsets). */
export function maskCode(body) {
  return body
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
}

const WIKI_G = /(!?)\[\[([^\]\n]+?)\]\]/g;
const TAG_G = /(^|[\s([{,;:!?"'>])#([\p{L}\p{N}_\-/]*[\p{L}_\-][\p{L}\p{N}_\-/]*)/gu;
const MENTION_G = /(^|[\s([{,;:!?"'>])@([A-Za-z0-9_][A-Za-z0-9._-]*[A-Za-z0-9_]|[A-Za-z0-9_])/g;
const FIELD_RE = /^[ \t]*(?:[-*][ \t]+)?([A-Za-z][\w-]*)::[ \t]*(.+)$/gm;
const TASK_RE = /^([ \t]*)[-*][ \t]+\[([ xX])\][ \t]+(.*)$/gm;
const DUE_RE = /(?:📅|due:)[ \t]*(\d{4}-\d{2}-\d{2})/;

function wikiTargetsIn(value) {
  const out = [];
  const s = typeof value === 'string' ? value : Array.isArray(value) ? value.join(' ') : '';
  for (const m of s.matchAll(WIKI_G)) out.push(parseWikiTarget(m[2]).target);
  return out;
}

/**
 * Extract everything semantic from a page. Returns
 * { links:[{target,anchor,embed}], tags:[], mentions:[], relations:[{rel,target}], fields:{},
 *   tasks:[{line,done,text,assignee,due}], headings:[{level,text,id}], text }
 */
export function extract(data, body) {
  const masked = maskCode(body || '');
  const links = [];
  for (const m of masked.matchAll(WIKI_G)) {
    const w = parseWikiTarget(m[2]);
    if (w.target) links.push({ target: w.target, anchor: w.anchor, embed: m[1] === '!' });
  }
  const tagSet = new Set();
  for (const t of [].concat(data.tags || [])) if (t) tagSet.add(normalizeTag(t));
  for (const m of masked.matchAll(TAG_G)) {
    // Skip markdown headings ("# Title" never matches since a space follows '#') and anchors in URLs.
    tagSet.add(normalizeTag(m[2]));
  }
  tagSet.delete('');
  const mentions = [...new Set([...masked.matchAll(MENTION_G)].map(m => m[2].toLowerCase()))];

  const relations = [];
  const fields = {};
  const reserved = new Set(['id', 'title', 'tags', 'aliases', 'parent', 'order', 'created', 'created_by',
    'kind', 'status', 'archived', 'review_by', 'type', 'excerpt', 'template']);
  for (const [k, v] of Object.entries(data)) {
    if (reserved.has(k)) continue;
    const targets = wikiTargetsIn(v);
    if (targets.length) for (const t of targets) relations.push({ rel: k, target: t, source: 'frontmatter' });
    else fields[k] = v;
  }
  for (const m of masked.matchAll(FIELD_RE)) {
    const key = m[1], val = m[2].trim();
    const targets = wikiTargetsIn(val);
    if (targets.length) for (const t of targets) relations.push({ rel: key, target: t, source: 'inline' });
    else fields[key] = val;
  }

  const tasks = [];
  let lineNo = 0;
  const lines = (body || '').split('\n');
  const maskedLines = masked.split('\n');
  for (; lineNo < lines.length; lineNo++) {
    TASK_RE.lastIndex = 0;
    const m = TASK_RE.exec(maskedLines[lineNo]);
    if (!m) continue;
    const text = lines[lineNo].replace(/^[ \t]*[-*][ \t]+\[[ xX]\][ \t]+/, '');
    const am = /(?:^|\s)@([A-Za-z0-9_][A-Za-z0-9._-]*[A-Za-z0-9_]|[A-Za-z0-9_])/.exec(text);
    const dm = DUE_RE.exec(text);
    tasks.push({ line: lineNo, done: m[2] !== ' ', text, assignee: am ? am[1].toLowerCase() : null, due: dm ? dm[1] : null });
  }

  const headings = [];
  const used = new Map();
  for (const l of maskedLines) {
    const m = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/.exec(l);
    if (!m) continue;
    let id = slugify(m[2]);
    const n = used.get(id) || 0; used.set(id, n + 1); if (n) id += '-' + n;
    headings.push({ level: m[1].length, text: m[2], id });
  }
  return { links, tags: [...tagSet].sort(), mentions, relations, fields, tasks, headings, text: plainText(body) };
}

/** Markdown -> plain text for search indexing and snippets. */
export function plainText(body) {
  return (body || '')
    .replace(/^(```|~~~)[^\n]*$/gm, '')
    .replace(/!?\[\[([^\]|#]*)(?:#([^\]|]*))?(?:\|([^\]]*))?\]\]/g, (_m, t, a, al) => al || t || a || '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\{\{status:[a-z]+\|([^}]*)\}\}/g, '$1')
    .replace(/^>\s?\[![a-z]+\][+-]?\s?/gim, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/gm, '')
    .replace(/^[ \t]*([-*+]|\d+\.)[ \t]+/gm, '')
    .replace(/^#{1,6}[ \t]+/gm, '')
    .replace(/^>[ \t]?/gm, '')
    .replace(/[*_~`|]+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Split a body into heading-scoped sections (chunks) for retrieval. */
export function sections(title, body, maxChars = 1500) {
  const out = [];
  const lines = (body || '').split('\n');
  const masked = maskCode(body || '').split('\n');
  const path = [];
  let cur = { heading: '', anchor: '', lines: [] };
  const flush = () => {
    const text = plainText(cur.lines.join('\n'));
    if (!text) return;
    const crumbs = [title, ...path.map(p => p.text)].filter(Boolean).join(' › ');
    // split overly long sections on paragraph boundaries
    const paras = text.split('\n');
    let buf = '';
    for (const p of paras) {
      if (buf && buf.length + p.length > maxChars) { out.push({ heading: crumbs, anchor: cur.anchor, text: buf }); buf = ''; }
      buf += (buf ? '\n' : '') + p;
    }
    if (buf) out.push({ heading: crumbs, anchor: cur.anchor, text: buf });
  };
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/.exec(masked[i]);
    if (m) {
      flush();
      const level = m[1].length;
      while (path.length && path[path.length - 1].level >= level) path.pop();
      path.push({ level, text: m[2] });
      cur = { heading: m[2], anchor: slugify(m[2]), lines: [] };
    } else cur.lines.push(lines[i]);
  }
  flush();
  return out;
}

export function excerptOf(body, max = 240) {
  const t = plainText(body).split('\n').find(l => l.trim().length > 20) || plainText(body).split('\n')[0] || '';
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}
