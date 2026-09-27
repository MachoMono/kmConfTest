// Full-text search with a small query language:
//   words "exact phrase" -exclude tag:team/x space:ENG type:System author:jane
//   updated>2026-01-01 updated<2026-06-01 sort:updated|title|relevance|created kind:blog
import { now } from './db.js';
import { normalizeTag } from '../shared/doc.js';
import { escapeHtml } from '../shared/markdown.js';

const FILTERS = ['tag', 'space', 'type', 'author', 'kind', 'sort', 'owner', 'status', 'limit', 'in'];

export function parseQuery(q) {
  const out = { terms: [], phrases: [], exclude: [], filters: {}, sort: null, updatedAfter: null, updatedBefore: null };
  const re = /(-?)"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(q || ''))) {
    if (m[2] !== undefined) { if (m[2].trim()) (m[1] ? out.exclude : out.phrases).push(m[2].trim()); continue; }
    const tok = m[3];
    const fm = /^([a-z]+):(.+)$/i.exec(tok);
    if (fm && FILTERS.includes(fm[1].toLowerCase())) {
      const k = fm[1].toLowerCase();
      if (k === 'sort') out.sort = fm[2].toLowerCase();
      else (out.filters[k] ||= []).push(k === 'tag' ? normalizeTag(fm[2]) : fm[2]);
      continue;
    }
    const um = /^updated([<>])=?(\d{4}-\d{2}-\d{2})$/.exec(tok);
    if (um) { if (um[1] === '>') out.updatedAfter = um[2]; else out.updatedBefore = um[2]; continue; }
    if (tok.startsWith('#') && tok.length > 1) { (out.filters.tag ||= []).push(normalizeTag(tok)); continue; }
    if (tok.startsWith('-') && tok.length > 1) { out.exclude.push(tok.slice(1)); continue; }
    out.terms.push(tok);
  }
  return out;
}

const ftsWord = (w) => '"' + w.replace(/"/g, '""') + '"';

export function toFts(pq) {
  const words = pq.terms.map(t => t.replace(/[^\p{L}\p{N}_-]+/gu, ' ').trim()).filter(Boolean)
    .flatMap(t => t.split(/\s+/)).filter(Boolean);
  const parts = [...words.map(w => ftsWord(w) + '*'), ...pq.phrases.map(ftsWord)];
  if (!parts.length) return null;
  let expr = parts.join(' AND ');
  for (const e of pq.exclude) expr = `(${expr}) NOT ${ftsWord(e)}`;
  return expr;
}

function safeSnippet(s) {
  return escapeHtml(s || '').replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>');
}

export class Search {
  constructor(app) { this.app = app; }
  get db() { return this.app.db; }

  filterSql(pq, alias = 'p') {
    const where = [`${alias}.archived = 0`];
    const params = [];
    const f = pq.filters;
    if (f.tag) for (const t of f.tag) {
      where.push(`EXISTS (SELECT 1 FROM page_tags t WHERE t.page_id = ${alias}.id AND (t.tag = ? OR t.tag LIKE ?))`);
      params.push(t, t + '/%');
    }
    if (f.space) { where.push(`${alias}.space IN (${f.space.map(() => '?').join(',')})`); params.push(...f.space.map(s => s.toUpperCase())); }
    if (f.type) { where.push(`lower(${alias}.type) IN (${f.type.map(() => '?').join(',')})`); params.push(...f.type.map(s => s.toLowerCase())); }
    if (f.kind) { where.push(`${alias}.kind IN (${f.kind.map(() => '?').join(',')})`); params.push(...f.kind); }
    if (f.status) { where.push(`lower(${alias}.status) IN (${f.status.map(() => '?').join(',')})`); params.push(...f.status.map(s => s.toLowerCase())); }
    if (f.author) { where.push(`(${alias}.updated_by IN (${f.author.map(() => '?').join(',')}) OR ${alias}.created_by IN (${f.author.map(() => '?').join(',')}))`); params.push(...f.author, ...f.author); }
    if (f.owner) {
      where.push('(' + f.owner.map(() => `lower(${alias}.owner) LIKE ?`).join(' OR ') + ')');
      params.push(...f.owner.map(s => '%' + s.toLowerCase().replace(/^\[\[|\]\]$/g, '').replace(/[-_]+/g, ' ')));
    }
    if (f.in) {
      // in:<page id or title> -> descendants of that page
      const root = this.app.indexer.resolve(f.in[0]);
      const ids = root ? this.descendants(root.id) : [];
      where.push(`${alias}.id IN (${ids.map(() => '?').join(',') || "''"})`); params.push(...ids);
    }
    if (pq.updatedAfter) { where.push(`${alias}.updated_at >= ?`); params.push(pq.updatedAfter); }
    if (pq.updatedBefore) { where.push(`${alias}.updated_at < ?`); params.push(pq.updatedBefore); }
    return { where: where.join(' AND '), params };
  }

  descendants(id) {
    const out = [];
    const q = [id];
    while (q.length && out.length < 5000) {
      const cur = q.shift();
      for (const r of this.db.all('SELECT id FROM pages WHERE parent = ?', cur)) { out.push(r.id); q.push(r.id); }
    }
    return out;
  }

  /**
   * Search pages visible to `user`. Returns {total, results:[{id,title,space,snippet,tags,type,updated_at,score}]}.
   * opts.boost toggles graph/recency boosting (feature flag "search.graph_boost").
   */
  query(user, q, { limit = 20, offset = 0, log = true, boost } = {}) {
    const t0 = performance.now();
    const pq = parseQuery(q);
    const fts = toFts(pq);
    const { where, params } = this.filterSql(pq);
    const canView = this.app.perms.viewFilter(user);
    const useBoost = boost ?? this.app.flag('search.graph_boost', user);
    let rows;
    let relaxed = false;
    if (fts) {
      try {
        rows = this.db.all(`SELECT p.*, bm25(pages_fts, 0, 10.0, 6.0, 4.0, 1.0) AS rank,
            snippet(pages_fts, 4, char(1), char(2), '…', 18) AS snip,
            (SELECT COUNT(*) FROM links l WHERE l.target_id = p.id) AS inbound
          FROM pages_fts JOIN pages p ON p.rowid = pages_fts.rowid
          WHERE pages_fts MATCH ? AND ${where} ORDER BY rank LIMIT 1000`, fts, ...params);
      } catch (e) {
        rows = [];
      }
      // natural-language queries rarely match every word: fall back to any-term matching
      const plain = pq.terms.filter(w => w.length > 2);
      if (!rows.length && plain.length > 1 && !pq.phrases.length) {
        const orExpr = plain.map(w => '"' + w.replace(/[^\p{L}\p{N}_-]+/gu, '').replace(/"/g, '') + '"*').filter(x => x !== '""*').join(' OR ');
        try {
          rows = this.db.all(`SELECT p.*, bm25(pages_fts, 0, 10.0, 6.0, 4.0, 1.0) AS rank,
              snippet(pages_fts, 4, char(1), char(2), '…', 18) AS snip,
              (SELECT COUNT(*) FROM links l WHERE l.target_id = p.id) AS inbound
            FROM pages_fts JOIN pages p ON p.rowid = pages_fts.rowid
            WHERE pages_fts MATCH ? AND ${where} ORDER BY rank LIMIT 200`, orExpr, ...params);
          relaxed = true;
        } catch { rows = []; }
      }
    } else {
      rows = this.db.all(`SELECT p.*, 0 AS rank, p.excerpt AS snip, (SELECT COUNT(*) FROM links l WHERE l.target_id = p.id) AS inbound
        FROM pages p WHERE ${where} ORDER BY p.updated_at DESC LIMIT 1000`, ...params);
    }
    rows = rows.filter(canView);
    const nowMs = Date.now();
    for (const r of rows) {
      let score = -r.rank; // bm25: lower is better
      if (useBoost && fts) {
        const ageDays = (nowMs - Date.parse(r.updated_at || 0)) / 86400_000;
        score *= 1 + Math.log1p(r.inbound) * 0.15 + (ageDays < 30 ? 0.1 : 0);
        const qt = pq.terms.join(' ').toLowerCase();
        if (qt && r.title.toLowerCase() === qt) score *= 2;
      }
      r.score = score;
    }
    const sort = pq.sort;
    if (sort === 'updated') rows.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    else if (sort === 'created') rows.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    else if (sort === 'title') rows.sort((a, b) => a.title.localeCompare(b.title));
    else if (fts) rows.sort((a, b) => b.score - a.score);
    const total = rows.length;
    const results = rows.slice(offset, offset + limit).map(r => ({
      id: r.id, title: r.title, space: r.space, kind: r.kind, type: r.type, tags: JSON.parse(r.tags || '[]'),
      snippet: fts ? safeSnippet(r.snip) : escapeHtml(r.excerpt || ''), updated_at: r.updated_at, updated_by: r.updated_by,
      score: Math.round((r.score || 0) * 1000) / 1000, parent: r.parent,
    }));
    if (log && (pq.terms.length || pq.phrases.length)) {
      this.db.run('INSERT INTO search_log (q, user_id, results, ts, mode) VALUES (?,?,?,?,?)', q, user ? user.id : null, total, now(), 'search');
    }
    return { total, results, query: pq, relaxed, ms: Math.round((performance.now() - t0) * 10) / 10 };
  }

  /** Fast title/alias suggestions for [[ autocomplete and quick search. */
  suggest(user, q, { limit = 10, space } = {}) {
    const canView = this.app.perms.viewFilter(user);
    const norm = String(q || '').trim().toLowerCase();
    let rows;
    if (!norm) rows = this.db.all('SELECT * FROM pages WHERE archived = 0 ORDER BY updated_at DESC LIMIT 50');
    else rows = this.db.all(`SELECT DISTINCT p.*, MIN(CASE WHEN n.name = ? THEN 0 WHEN n.name LIKE ? THEN 1 ELSE 2 END) AS m
        FROM page_names n JOIN pages p ON p.id = n.page_id
        WHERE p.archived = 0 AND (n.name LIKE ? OR n.name LIKE ?)
        GROUP BY p.id ORDER BY m, (p.space = ?) DESC, length(p.title) LIMIT 100`, norm, norm + '%', norm + '%', '% ' + norm + '%', space || '');
    return rows.filter(canView).slice(0, limit).map(r => ({ id: r.id, title: r.title, space: r.space, type: r.type, excerpt: r.excerpt }));
  }
}
