// GraphRAG retrieval over the knowledge base.
//   local  : seed entities from the query -> k-hop expansion over typed edges -> rank chunks
//   global : rank Louvain communities by similarity to the query -> community summaries
//   hybrid : reciprocal-rank fusion of BM25 + dense vectors + graph proximity (default)
// Results are permission-filtered and returned with citations and an LLM-ready context string.
import { cosine, fromBlob, terms } from './embed.js';
import { toFts, parseQuery } from './search.js';
import { normalizeName } from '../shared/doc.js';
import { llmConfigured, synthesize } from './llm.js';
import { now } from './db.js';

const RRF_K = 60;

export class GraphRag {
  constructor(app) { this.app = app; }
  get db() { return this.app.db; }

  async embedQuery(q) { return (await this.app.embedder.embed([q]))[0]; }

  bm25Chunks(q, limit = 60) {
    const fts = toFts(parseQuery(q.replace(/[:"]/g, ' ')));
    if (!fts) return [];
    // OR the terms: retrieval should be recall-oriented
    const orExpr = fts.split(' AND ').join(' OR ');
    try {
      return this.db.all(`SELECT c.id, c.page_id, bm25(chunks_fts, 1.0, 2.0) AS r FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
        WHERE chunks_fts MATCH ? ORDER BY r LIMIT ?`, orExpr, limit);
    } catch { return []; }
  }

  vectorChunks(qv, limit = 60) {
    const scored = [];
    for (const r of this.db.all('SELECT id, page_id, vec FROM chunks')) {
      const v = fromBlob(r.vec);
      if (!v || v.length !== qv.length) continue;
      scored.push({ id: r.id, page_id: r.page_id, s: cosine(qv, v) });
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, limit).filter(x => x.s > 0.02);
  }

  /** Entities explicitly named in the query: page titles/aliases and tags. */
  seedEntities(q) {
    const text = ' ' + normalizeName(q).replace(/[^\p{L}\p{N}#/ -]+/gu, ' ') + ' ';
    const seeds = new Set();
    for (const r of this.db.all('SELECT DISTINCT name, page_id FROM page_names WHERE length(name) >= 3')) {
      if (text.includes(' ' + r.name + ' ')) seeds.add('page:' + r.page_id);
    }
    const used = new Set(this.db.all('SELECT DISTINCT tag FROM page_tags').map(r => r.tag));
    for (const tag of used) {
      if (text.includes(' #' + tag + ' ') || (tag.length >= 4 && text.includes(' ' + tag.replace(/[/-]/g, ' ') + ' '))) seeds.add('tag:' + tag);
    }
    // ontology-aware expansion: query words that match a curated tag's description or synonyms
    const qTerms = new Set(terms(q));
    for (const def of this.app.ontology.data.tags || []) {
      if (!used.has(def.name)) continue;
      const vocab = new Set(terms([def.description || '', ...(def.synonyms || [])].join(' ')));
      if ([...qTerms].some(w => w.length > 3 && vocab.has(w))) seeds.add('tag:' + def.name);
    }
    return [...seeds];
  }

  /** seeds: [[nodeId, weight]] — explicit entities weigh more than retrieval-derived ones. */
  graphProximity(seeds, allowed, depth = 2) {
    const g = this.app.graph.full();
    const score = new Map();
    let frontier = seeds.filter(([s]) => allowed.has(s));
    for (const [s, w] of frontier) score.set(s, Math.max(score.get(s) || 0, w));
    for (let d = 0; d < depth; d++) {
      const next = [];
      for (const [id, sc] of frontier) {
        for (const { n, e } of g.adj.get(id) || []) {
          if (!allowed.has(n) || n.startsWith('space:')) continue;
          const w = sc * 0.5 * (e.rel.startsWith('links') || e.rel === 'embeds' ? 1 : e.rel === 'tagged_with' ? 0.6 : e.rel === 'child_of' ? 0.8 : 1.2);
          if ((score.get(n) || 0) < w) { score.set(n, w); next.push([n, w]); }
        }
      }
      frontier = next;
    }
    return score;
  }

  async query(user, q, { mode = 'hybrid', k = 8, depth = 2, answer = false, log = true } = {}) {
    const t0 = performance.now();
    q = String(q || '').trim();
    if (!q) return { query: q, mode, chunks: [], entities: [], relations: [], communities: [], context: '' };
    const { g, allowed } = this.app.graph.forUser(user);
    const pageOk = (pid) => allowed.has('page:' + pid);
    const lists = [];
    let bm = [], vec = [];
    if (mode !== 'global') {
      bm = this.bm25Chunks(q).filter(c => pageOk(c.page_id));
      vec = this.vectorChunks(await this.embedQuery(q)).filter(c => pageOk(c.page_id));
      lists.push([bm.map(c => c.id), 1]);
      if (mode === 'hybrid' || mode === 'vector') lists.push([vec.map(c => c.id), 1]);
    }
    const seeds = this.seedEntities(q).filter(s => allowed.has(s));
    const topPages = [...new Set([...bm.slice(0, 5), ...vec.slice(0, 5)].map(c => 'page:' + c.page_id))];
    const prox = this.graphProximity([...seeds.map(s => [s, 2]), ...topPages.slice(0, mode === 'local' ? 3 : 2).map(s => [s, 1])], allowed, depth);
    if (mode === 'local' || mode === 'hybrid') {
      const proxPages = [...prox.entries()].filter(([id]) => id.startsWith('page:')).sort((a, b) => b[1] - a[1]).slice(0, 30);
      const byPage = new Map();
      for (const c of [...bm, ...vec]) if (!byPage.has(c.page_id)) byPage.set(c.page_id, c.id);
      const graphList = [];
      for (const [id] of proxPages) {
        const pid = id.slice(5);
        const cid = byPage.get(pid) ?? (this.db.get('SELECT id FROM chunks WHERE page_id = ? ORDER BY ord LIMIT 1', pid) || {}).id;
        if (cid != null) graphList.push(cid);
      }
      lists.push([graphList, 1]);
      // pages that are, or are directly attached to, entities the question names explicitly
      if (seeds.length) {
        const direct = new Map();
        for (const s of seeds) {
          if (s.startsWith('page:')) direct.set(s.slice(5), 2);
          for (const { n } of g.adj.get(s) || []) if (n.startsWith('page:') && allowed.has(n)) direct.set(n.slice(5), Math.max(direct.get(n.slice(5)) || 0, 1));
        }
        const directList = [...direct.entries()].sort((a, b) => b[1] - a[1]).map(([pid]) => {
          const hit = [...bm, ...vec].find(c => c.page_id === pid);
          return hit ? hit.id : (this.db.get('SELECT id FROM chunks WHERE page_id = ? ORDER BY ord LIMIT 1', pid) || {}).id;
        }).filter(x => x != null);
        lists.push([directList, 2]);
      }
    }
    const fused = new Map();
    for (const [list, weight] of lists) list.forEach((cid, rank) => fused.set(cid, (fused.get(cid) || 0) + weight / (RRF_K + rank + 1)));
    const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]);
    // diversity: at most 2 chunks per page
    const perPage = new Map();
    const chosen = [];
    for (const [cid, s] of ranked) {
      const c = this.db.get('SELECT c.*, p.title, p.space, p.rev, p.type FROM chunks c JOIN pages p ON p.id = c.page_id WHERE c.id = ?', cid);
      if (!c) continue;
      const n = perPage.get(c.page_id) || 0;
      if (n >= 2) continue;
      perPage.set(c.page_id, n + 1);
      chosen.push({ chunk: cid, page: c.page_id, title: c.title, space: c.space, type: c.type, heading: c.heading, anchor: c.anchor,
        text: c.text, score: +s.toFixed(5), rev: c.rev, url: `/p/${c.page_id}${c.anchor ? '#' + c.anchor : ''}` });
      if (chosen.length >= k) break;
    }

    // communities (global context)
    const comm = this.app.graph.communities();
    let communities = [];
    if (mode === 'global' || mode === 'hybrid') {
      const qv = await this.embedQuery(q);
      const embedded = await this.app.embedder.embed(comm.list.map(c => c.summary));
      communities = comm.list.map((c, i) => ({ c, s: cosine(qv, embedded[i]) + chosen.filter(x => c.pages.includes(x.page)).length * 0.05 }))
        .filter(x => x.c.pages.some(pageOk)).sort((a, b) => b.s - a.s).slice(0, mode === 'global' ? 5 : 3)
        .map(({ c, s }) => ({ id: c.id, title: c.title, summary: c.summary, size: c.size, pages: c.pages.filter(pageOk).slice(0, 10), score: +s.toFixed(4) }));
      if (mode === 'global' && !chosen.length) {
        for (const c of communities) for (const pid of c.pages.slice(0, 2)) {
          const ch = this.db.get('SELECT c.*, p.title, p.space, p.rev, p.type FROM chunks c JOIN pages p ON p.id = c.page_id WHERE c.page_id = ? ORDER BY ord LIMIT 1', pid);
          if (ch && chosen.length < k) chosen.push({ chunk: ch.id, page: pid, title: ch.title, space: ch.space, type: ch.type, heading: ch.heading, anchor: ch.anchor, text: ch.text, score: c.score, rev: ch.rev, url: `/p/${pid}` });
        }
      }
    }

    // entities + relations among the retrieved pages and seeds
    const entIds = new Set([...seeds, ...chosen.map(c => 'page:' + c.page)]);
    const pr = this.app.graph.pagerank();
    const entities = [...entIds].filter(id => g.nodes.has(id)).map(id => {
      const n = g.nodes.get(id);
      return { id, kind: n.kind, label: n.label, type: n.type || null, pageId: n.pageId || null, rank: +(pr.get(id) || 0).toFixed(5), seed: seeds.includes(id) };
    });
    const relations = [];
    for (const id of entIds) for (const { n, e } of g.adj.get(id) || []) {
      if (e.source !== id || !allowed.has(n) || n.startsWith('space:')) continue;
      if (!entIds.has(n) && !(e.rel !== 'links_to' && e.rel !== 'tagged_with' && e.rel !== 'in_space')) continue;
      relations.push({ source: g.nodes.get(e.source).label, rel: e.rel, target: g.nodes.get(e.target).label, sourceId: e.source, targetId: e.target });
      if (relations.length > 60) break;
    }

    const base = this.app.cfg.baseUrl || '';
    const ctx = [];
    chosen.forEach((c, i) => ctx.push(`[${i + 1}] ${c.heading} (${c.space}, ${c.type}) ${base}${c.url}\n${c.text}`));
    if (relations.length) ctx.push('Known relations:\n' + relations.slice(0, 30).map(r => `- ${r.source} —${r.rel}→ ${r.target}`).join('\n'));
    if (communities.length) ctx.push('Topic clusters:\n' + communities.map(c => `- ${c.summary}`).join('\n'));
    const context = ctx.join('\n\n');

    const out = { query: q, mode, chunks: chosen, entities, relations, communities, context, ms: Math.round(performance.now() - t0) };
    if (answer) {
      if (llmConfigured(this.app.settings)) Object.assign(out, await synthesize(this.app.settings, q, context));
      else out.answer = null, out.note = 'No LLM configured; returning retrieved context only.';
    }
    if (log) this.db.run('INSERT INTO search_log (q, user_id, results, ts, mode) VALUES (?,?,?,?,?)', q, user ? user.id : null, chosen.length, now(), 'graphrag:' + mode);
    return out;
  }
}
