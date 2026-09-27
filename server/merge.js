// Silent, layered three-way merge for Markdown pages.
//
//   1. fast paths (identical / one side unchanged)
//   2. frontmatter merged structurally (per key; arrays as sets)
//   3. body merged line-by-line with diff3
//   4. each conflicting region re-merged word-by-word with diff3
//   5. anything still conflicting: the preferred side wins *for that span only*, and the
//      discarded text is returned in `conflicts` so it can be recorded and restored later.
//
// Users never see conflict markers, and no edit is silently lost: it is either merged or
// captured as a conflict record.
import { diffArrays } from 'diff';
import { splitFrontmatter, joinFrontmatter } from '../shared/doc.js';

function hunks(base, side, label) {
  const out = [];
  let i = 0, cur = null;
  for (const part of diffArrays(base, side)) {
    if (part.added) {
      cur ||= { start: i, end: i, content: [], side: label };
      cur.content.push(...part.value);
    } else if (part.removed) {
      cur ||= { start: i, end: i, content: [], side: label };
      i += part.count;
      cur.end = i;
    } else {
      if (cur) { out.push(cur); cur = null; }
      i += part.count;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function eq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function applySide(base, start, end, sideHunks) {
  const res = [];
  let i = start;
  for (const h of sideHunks) {
    while (i < h.start) res.push(base[i++]);
    res.push(...h.content);
    i = h.end;
  }
  while (i < end) res.push(base[i++]);
  return res;
}

/**
 * Generic diff3 over token arrays. Returns {result, conflicts} where each conflict is
 * {base, ours, theirs, at} and `result` contains a placeholder object {conflict: n} at the
 * conflict position.
 */
export function diff3(base, ours, theirs) {
  const all = [...hunks(base, theirs, 'theirs'), ...hunks(base, ours, 'ours')];
  all.sort((a, b) => a.start - b.start || (a.end - a.start) - (b.end - b.start) ||
    (a.side === b.side ? 0 : a.side === 'theirs' ? -1 : 1));
  // drop identical insertions made by both sides at the same point
  const hs = [];
  for (const h of all) {
    const p = hs[hs.length - 1];
    if (p && p.side !== h.side && p.start === h.start && p.end === h.end && eq(p.content, h.content)) continue;
    hs.push(h);
  }
  const regions = [];
  for (const h of hs) {
    const r = regions[regions.length - 1];
    if (r && h.start < r.end && r.start < h.end) { r.hunks.push(h); r.end = Math.max(r.end, h.end); r.start = Math.min(r.start, h.start); }
    else if (r && h.start < r.end && h.start === h.end) { r.hunks.push(h); }
    else regions.push({ start: h.start, end: h.end, hunks: [h] });
  }
  const result = [];
  const conflicts = [];
  let cursor = 0;
  for (const r of regions) {
    while (cursor < r.start) result.push(base[cursor++]);
    const o = r.hunks.filter(h => h.side === 'ours');
    const t = r.hunks.filter(h => h.side === 'theirs');
    if (!o.length || !t.length) {
      result.push(...applySide(base, r.start, r.end, r.hunks));
    } else {
      const oc = applySide(base, r.start, r.end, o);
      const tc = applySide(base, r.start, r.end, t);
      if (eq(oc, tc)) result.push(...oc);
      else {
        conflicts.push({ base: base.slice(r.start, r.end), ours: oc, theirs: tc, at: result.length });
        result.push({ conflict: conflicts.length - 1 });
      }
    }
    cursor = r.end;
  }
  while (cursor < base.length) result.push(base[cursor++]);
  return { result, conflicts };
}

const WORD_RE = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const tokenize = (s) => s.match(WORD_RE) || [];

/** Merge plain text line-wise, falling back to word-wise inside conflicting regions. */
export function mergeText(base, ours, theirs, { prefer = 'ours' } = {}) {
  const lines = diff3(base.split('\n'), ours.split('\n'), theirs.split('\n'));
  const out = [];
  const lost = [];
  for (const item of lines.result) {
    if (typeof item === 'string') { out.push(item); continue; }
    const c = lines.conflicts[item.conflict];
    const words = diff3(tokenize(c.base.join('\n')), tokenize(c.ours.join('\n')), tokenize(c.theirs.join('\n')));
    const firstLost = lost.length;
    let text = '';
    for (const w of words.result) {
      if (typeof w === 'string') { text += w; continue; }
      const wc = words.conflicts[w.conflict];
      const win = prefer === 'ours' ? wc.ours : wc.theirs;
      const lose = prefer === 'ours' ? wc.theirs : wc.ours;
      text += win.join('');
      lost.push({ base: wc.base.join(''), kept: win.join(''), discarded: lose.join(''),
        context: (prefer === 'ours' ? c.theirs : c.ours).join('\n') });
    }
    // region-level record so a KM reviewer can swap the whole region back unambiguously
    const loserRegion = (prefer === 'ours' ? c.theirs : c.ours).join('\n');
    for (let k = firstLost; k < lost.length; k++) Object.assign(lost[k], { regionKept: text, regionDiscarded: loserRegion });
    out.push(...text.split('\n'));
  }
  return { text: out.join('\n'), conflicts: lost };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Merge frontmatter objects key-by-key; arrays of scalars are merged as sets. */
export function mergeData(base = {}, ours = {}, theirs = {}, { prefer = 'ours' } = {}) {
  const out = {};
  const conflicts = [];
  const keys = new Set([...Object.keys(theirs), ...Object.keys(ours), ...Object.keys(base)]);
  for (const k of keys) {
    const b = base[k], o = ours[k], t = theirs[k];
    if (same(o, t)) { if (o !== undefined) out[k] = o; continue; }
    if (same(o, b)) { if (t !== undefined) out[k] = t; continue; }
    if (same(t, b)) { if (o !== undefined) out[k] = o; continue; }
    const scalarArr = (v) => v === undefined || (Array.isArray(v) && v.every(x => typeof x !== 'object'));
    if (scalarArr(b) && scalarArr(o) && scalarArr(t) && (Array.isArray(o) || Array.isArray(t))) {
      const bs = new Set(b || []), os = new Set(o || []), ts = new Set(t || []);
      const removed = new Set([...bs].filter(x => !os.has(x) || !ts.has(x)));
      const merged = [];
      for (const x of [...(t || []), ...(o || [])]) if (!removed.has(x) && !merged.includes(x)) merged.push(x);
      out[k] = merged;
      continue;
    }
    const win = prefer === 'ours' ? o : t;
    if (win !== undefined) out[k] = win;
    conflicts.push({ field: k, base: b, kept: win, discarded: prefer === 'ours' ? t : o });
  }
  return { data: out, conflicts };
}

/**
 * Merge whole page files (frontmatter + body).
 * `ours` = the incoming change, `theirs` = what is already committed.
 * Returns {text, clean, conflicts}.
 */
export function mergeDocument(base, ours, theirs, opts = {}) {
  if (ours === theirs) return { text: ours, clean: true, conflicts: [] };
  if (base === theirs) return { text: ours, clean: true, conflicts: [] };
  if (base === ours) return { text: theirs, clean: true, conflicts: [] };
  const B = splitFrontmatter(base ?? ''), O = splitFrontmatter(ours), T = splitFrontmatter(theirs);
  const hasFm = B.raw || O.raw || T.raw;
  const d = mergeData(B.data, O.data, T.data, opts);
  const m = mergeText(B.body, O.body, T.body, opts);
  const conflicts = [...d.conflicts, ...m.conflicts];
  const text = hasFm ? joinFrontmatter(d.data, m.text) : m.text;
  return { text, clean: conflicts.length === 0, conflicts };
}
