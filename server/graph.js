// Knowledge graph built from the index: nodes = pages (typed by the ontology), tags, people,
// spaces; edges = wikilinks, embeds, typed relations, parent/child, tags, mentions.
// Provides PageRank centrality, Louvain community detection and standard exports.
import { lit } from './ontology.js';
import { terms } from './embed.js';

export class Graph {
  constructor(app) { this.app = app; this._cache = null; }
  get db() { return this.app.db; }

  /** Full (unfiltered) graph, cached per index version. */
  full() {
    const v = this.app.indexer.version;
    if (this._cache && this._cache.version === v) return this._cache;
    const nodes = new Map();
    const edges = [];
    const pages = this.db.all('SELECT id, title, space, type, parent, tags, excerpt, updated_at, kind, archived FROM pages WHERE archived = 0');
    for (const p of pages) nodes.set('page:' + p.id, { id: 'page:' + p.id, kind: 'page', label: p.title, type: p.type || 'Document', space: p.space, pageId: p.id, parent: p.parent, excerpt: p.excerpt, updated_at: p.updated_at });
    for (const s of this.db.all('SELECT key, name FROM spaces')) nodes.set('space:' + s.key, { id: 'space:' + s.key, kind: 'space', label: s.name, space: s.key });
    for (const p of pages) {
      if (p.parent && nodes.has('page:' + p.parent)) edges.push({ source: 'page:' + p.id, target: 'page:' + p.parent, rel: 'child_of', w: 1 });
      edges.push({ source: 'page:' + p.id, target: 'space:' + p.space, rel: 'in_space', w: 0.1 });
    }
    for (const t of this.db.all('SELECT t.page_id, t.tag FROM page_tags t JOIN pages p ON p.id = t.page_id WHERE p.archived = 0')) {
      const id = 'tag:' + t.tag;
      if (!nodes.has(id)) nodes.set(id, { id, kind: 'tag', label: '#' + t.tag, tag: t.tag });
      edges.push({ source: 'page:' + t.page_id, target: id, rel: 'tagged_with', w: 0.6 });
    }
    for (const l of this.db.all('SELECT src, target, target_id, kind FROM links')) {
      if (!nodes.has('page:' + l.src)) continue;
      if (l.kind === 'mention') {
        const u = this.app.users.byUsername(l.target);
        if (!u) continue;
        const id = 'person:' + u.username.toLowerCase();
        if (!nodes.has(id)) nodes.set(id, { id, kind: 'person', label: u.name || u.username, username: u.username });
        edges.push({ source: 'page:' + l.src, target: id, rel: 'mentions', w: 0.5 });
        continue;
      }
      if (!l.target_id || !nodes.has('page:' + l.target_id) || l.target_id === l.src) continue;
      const rel = l.kind === 'link' ? 'links_to' : l.kind === 'embed' ? 'embeds' : l.kind.slice(4);
      edges.push({ source: 'page:' + l.src, target: 'page:' + l.target_id, rel, w: l.kind.startsWith('rel:') ? 1.5 : 1 });
    }
    const adj = new Map();
    for (const n of nodes.keys()) adj.set(n, []);
    for (const e of edges) { adj.get(e.source)?.push({ n: e.target, e }); adj.get(e.target)?.push({ n: e.source, e }); }
    this._cache = { version: v, nodes, edges, adj, pagerank: null, communities: null };
    return this._cache;
  }

  /** Graph restricted to what `user` can see. */
  forUser(user) {
    const g = this.full();
    const canView = this.app.perms.viewFilter(user);
    const allowed = new Set();
    for (const n of g.nodes.values()) {
      if (n.kind === 'page') { if (canView({ id: n.pageId, space: n.space, parent: n.parent })) allowed.add(n.id); }
      else if (n.kind === 'space') { if (this.app.perms.canSpace(user, 'view', n.space)) allowed.add(n.id); }
      else allowed.add(n.id);
    }
    return { g, allowed };
  }

  toJson(user, { focus, depth = 2, includeTags = true, includePeople = true, limit = 2000 } = {}) {
    const { g, allowed } = this.forUser(user);
    let keep = new Set([...allowed].filter(id => (includeTags || !id.startsWith('tag:')) && (includePeople || !id.startsWith('person:')) && !id.startsWith('space:')));
    if (focus) {
      const start = 'page:' + focus;
      const seen = new Set([start]);
      let frontier = [start];
      for (let d = 0; d < depth; d++) {
        const next = [];
        for (const id of frontier) for (const { n } of g.adj.get(id) || []) if (keep.has(n) && !seen.has(n)) { seen.add(n); next.push(n); }
        frontier = next;
      }
      keep = new Set([...seen].filter(id => keep.has(id)));
    }
    const pr = this.pagerank();
    const comm = this.communities();
    const nodes = [...keep].slice(0, limit).map(id => { const n = g.nodes.get(id); return { ...n, rank: +(pr.get(id) || 0).toFixed(5), community: comm.membership.get(id) ?? null }; });
    const ids = new Set(nodes.map(n => n.id));
    const edges = g.edges.filter(e => ids.has(e.source) && ids.has(e.target) && e.rel !== 'in_space');
    return { nodes, edges };
  }

  pagerank(iter = 30, d = 0.85) {
    const g = this.full();
    if (g.pagerank) return g.pagerank;
    const ids = [...g.nodes.keys()];
    const N = ids.length || 1;
    let pr = new Map(ids.map(i => [i, 1 / N]));
    const outW = new Map(ids.map(i => [i, 0]));
    for (const e of g.edges) { outW.set(e.source, outW.get(e.source) + e.w); outW.set(e.target, outW.get(e.target) + e.w * 0.3); }
    for (let k = 0; k < iter; k++) {
      const next = new Map(ids.map(i => [i, (1 - d) / N]));
      let dangling = 0;
      for (const i of ids) if (!outW.get(i)) dangling += pr.get(i);
      for (const e of g.edges) {
        next.set(e.target, next.get(e.target) + d * pr.get(e.source) * e.w / outW.get(e.source));
        next.set(e.source, next.get(e.source) + d * pr.get(e.target) * e.w * 0.3 / outW.get(e.target));
      }
      for (const i of ids) next.set(i, next.get(i) + d * dangling / N);
      pr = next;
    }
    g.pagerank = pr;
    return pr;
  }

  /** Louvain modularity optimisation (two levels) over the undirected weighted graph. */
  communities() {
    const g = this.full();
    if (g.communities) return g.communities;
    const ids = [...g.nodes.keys()].filter(id => !id.startsWith('space:'));
    const idx = new Map(ids.map((id, i) => [id, i]));
    let W = new Map();
    const addW = (a, b, w) => {
      if (a === b) return;
      const k = a < b ? a + ',' + b : b + ',' + a;
      W.set(k, (W.get(k) || 0) + w);
    };
    for (const e of g.edges) if (idx.has(e.source) && idx.has(e.target)) addW(idx.get(e.source), idx.get(e.target), e.w);
    let n = ids.length;
    let membership = ids.map((_, i) => i);
    for (let level = 0; level < 3 && n > 1; level++) {
      const nbr = Array.from({ length: n }, () => new Map());
      const deg = new Float64Array(n);
      let m2 = 0;
      for (const [k, w] of W) {
        const [a, b] = k.split(',').map(Number);
        if (a === b) { deg[a] += 2 * w; m2 += 2 * w; continue; } // internal weight of an aggregated community
        nbr[a].set(b, (nbr[a].get(b) || 0) + w); nbr[b].set(a, (nbr[b].get(a) || 0) + w);
        deg[a] += w; deg[b] += w; m2 += 2 * w;
      }
      if (!m2) break;
      const comm = Array.from({ length: n }, (_, i) => i);
      const tot = Float64Array.from(deg);
      let moved = true, passes = 0;
      while (moved && passes++ < 20) {
        moved = false;
        for (let i = 0; i < n; i++) {
          const ci = comm[i];
          const links = new Map();
          for (const [j, w] of nbr[i]) links.set(comm[j], (links.get(comm[j]) || 0) + w);
          tot[ci] -= deg[i];
          let best = ci, bestGain = (links.get(ci) || 0) - tot[ci] * deg[i] / m2;
          for (const [c, w] of links) {
            const gain = w - tot[c] * deg[i] / m2;
            if (gain > bestGain + 1e-12) { bestGain = gain; best = c; }
          }
          tot[best] += deg[i];
          if (best !== ci) { comm[i] = best; moved = true; }
        }
      }
      const remap = new Map();
      for (const c of comm) if (!remap.has(c)) remap.set(c, remap.size);
      if (remap.size === n) break;
      membership = membership.map(c => remap.get(comm[c]));
      const W2 = new Map();
      for (const [k, w] of W) {
        const [a, b] = k.split(',').map(Number);
        const ca = remap.get(comm[a]), cb = remap.get(comm[b]);
        const kk = ca < cb ? ca + ',' + cb : cb + ',' + ca;
        W2.set(kk, (W2.get(kk) || 0) + w);
      }
      W = W2; n = remap.size;
    }
    const groups = new Map();
    ids.forEach((id, i) => { const c = membership[i]; if (!groups.has(c)) groups.set(c, []); groups.get(c).push(id); });
    const pr = this.pagerank();
    const list = [...groups.values()].filter(m => m.some(id => id.startsWith('page:'))).sort((a, b) => b.length - a.length).map((members, i) => {
      const pages = members.filter(id => id.startsWith('page:')).sort((a, b) => pr.get(b) - pr.get(a));
      const tags = members.filter(id => id.startsWith('tag:'));
      const tf = new Map();
      for (const id of pages) for (const t of terms(g.nodes.get(id).label + ' ' + (g.nodes.get(id).excerpt || ''))) tf.set(t, (tf.get(t) || 0) + 1);
      const topTerms = [...tf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(x => x[0]);
      const title = pages.length ? g.nodes.get(pages[0]).label : 'Community';
      const summary = `Cluster of ${pages.length} page(s) around "${title}"` +
        (tags.length ? `, tagged ${tags.slice(0, 5).map(t => g.nodes.get(t).label).join(', ')}` : '') +
        (topTerms.length ? `. Key terms: ${topTerms.join(', ')}.` : '.') +
        ` Key pages: ${pages.slice(0, 5).map(p => g.nodes.get(p).label).join('; ')}.`;
      return { id: i, size: members.length, pages: pages.map(p => p.slice(5)), tags: tags.map(t => t.slice(4)), title, terms: topTerms, summary };
    });
    const mem = new Map();
    for (const c of list) { for (const p of c.pages) mem.set('page:' + p, c.id); for (const t of c.tags) mem.set('tag:' + t, c.id); }
    g.communities = { list, membership: mem };
    return g.communities;
  }

  neighbors(user, pageId, depth = 1) {
    const { g, allowed } = this.forUser(user);
    const start = 'page:' + pageId;
    if (!allowed.has(start)) return null;
    const out = [];
    const seen = new Set([start]);
    let frontier = [start];
    const GENERIC = new Set(['links_to', 'embeds', 'tagged_with', 'child_of', 'in_space', 'mentions']);
    for (let d = 1; d <= depth; d++) {
      const found = new Map(); // neighbour -> [{rel, direction, via, typed}]
      for (const id of frontier) for (const { n, e } of g.adj.get(id) || []) {
        if (!allowed.has(n) || seen.has(n) || n.startsWith('space:')) continue;
        const dir = e.source === id ? 'out' : 'in';
        const rel = dir === 'out' ? e.rel : (this.app.ontology.relations.get(e.rel)?.inverse || 'inverse_' + e.rel);
        if (!found.has(n)) found.set(n, []);
        found.get(n).push({ rel, direction: dir, via: id, typed: !GENERIC.has(e.rel) });
      }
      for (const [n, rels] of found) {
        seen.add(n);
        rels.sort((a, b) => b.typed - a.typed);
        out.push({ node: g.nodes.get(n), rel: rels[0].rel, direction: rels[0].direction, depth: d, via: rels[0].via, rels: [...new Set(rels.map(r => r.rel))] });
      }
      frontier = [...found.keys()];
    }
    return out;
  }

  // ---- exports -------------------------------------------------------------------------------
  exportJsonLd(user) {
    const { nodes, edges } = this.toJson(user, { limit: 100000 });
    const ns = this.app.ontology.data.namespace;
    const base = (this.app.cfg.baseUrl || 'urn:gitwiki:') ;
    const iri = (id) => base + id.replace(':', '/');
    const byId = new Map(nodes.map(n => [n.id, { '@id': iri(n.id), '@type': n.kind === 'page' ? 'gw:' + n.type : 'gw:' + n.kind[0].toUpperCase() + n.kind.slice(1), 'schema:name': n.label }]));
    for (const e of edges) {
      const s = byId.get(e.source);
      if (!s) continue;
      const k = 'gw:' + e.rel;
      (s[k] ||= []).push({ '@id': iri(e.target) });
    }
    for (const n of nodes) if (n.kind === 'page') { const o = byId.get(n.id); o['schema:url'] = `${this.app.cfg.baseUrl || ''}/p/${n.pageId}`; if (n.excerpt) o['schema:abstract'] = n.excerpt; o['gw:space'] = n.space; }
    return { '@context': { gw: ns, schema: 'https://schema.org/' }, '@graph': [...byId.values()] };
  }

  exportTurtle(user) {
    const { nodes, edges } = this.toJson(user, { limit: 100000 });
    const base = this.app.cfg.baseUrl || 'urn:gitwiki:';
    const iri = (id) => `<${base}${id.replace(':', '/').replace(/[<>"{}|^`\\ ]/g, encodeURIComponent)}>`;
    const lines = [`@prefix gw: <${this.app.ontology.data.namespace}> .`, '@prefix schema: <https://schema.org/> .', ''];
    for (const n of nodes) lines.push(`${iri(n.id)} a gw:${n.kind === 'page' ? n.type : n.kind[0].toUpperCase() + n.kind.slice(1)} ; schema:name ${lit(n.label)} .`);
    for (const e of edges) lines.push(`${iri(e.source)} gw:${e.rel} ${iri(e.target)} .`);
    return lines.join('\n') + '\n';
  }

  exportGraphML(user) {
    const { nodes, edges } = this.toJson(user, { limit: 100000 });
    const x = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    return `<?xml version="1.0" encoding="UTF-8"?>
<graphml xmlns="http://graphml.graphdrawing.org/xmlns">
  <key id="label" for="node" attr.name="label" attr.type="string"/>
  <key id="kind" for="node" attr.name="kind" attr.type="string"/>
  <key id="type" for="node" attr.name="type" attr.type="string"/>
  <key id="rel" for="edge" attr.name="rel" attr.type="string"/>
  <graph id="gitwiki" edgedefault="directed">
${nodes.map(n => `    <node id="${x(n.id)}"><data key="label">${x(n.label)}</data><data key="kind">${x(n.kind)}</data><data key="type">${x(n.type || '')}</data></node>`).join('\n')}
${edges.map((e, i) => `    <edge id="e${i}" source="${x(e.source)}" target="${x(e.target)}"><data key="rel">${x(e.rel)}</data></edge>`).join('\n')}
  </graph>
</graphml>
`;
  }
}
