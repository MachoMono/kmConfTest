import { httpError } from '../auth.js';
import { Ontology, ONTOLOGY_PATH } from '../ontology.js';
import { pageDto } from './content.js';

export default function (r, app) {
  r.get('/api/v1/search', (ctx) => {
    const res = app.search.query(ctx.user, String(ctx.query.q || ''), { limit: Math.min(Number(ctx.query.limit) || 20, 100), offset: Number(ctx.query.offset) || 0 });
    return { total: res.total, results: res.results, ms: res.ms, relaxed: res.relaxed };
  }, { public: true });

  r.get('/api/v1/suggest/pages', (ctx) => app.search.suggest(ctx.user, ctx.query.q, { space: ctx.query.space, limit: Math.min(Number(ctx.query.limit) || 10, 30) }), { public: true });
  r.get('/api/v1/suggest/tags', (ctx) => {
    const q = String(ctx.query.q || '').toLowerCase().replace(/^#/, '');
    const rows = app.db.all('SELECT tag, COUNT(*) AS n FROM page_tags WHERE tag LIKE ? GROUP BY tag ORDER BY n DESC LIMIT 20', q + '%');
    const known = (app.ontology.data.tags || []).map(t => t.name).filter(t => t.startsWith(q) && !rows.some(r => r.tag === t));
    return [...rows.map(r => ({ tag: r.tag, count: r.n })), ...known.map(t => ({ tag: t, count: 0 }))];
  }, { public: true });

  // ---- tags ------------------------------------------------------------------------------------
  r.get('/api/v1/tags', (ctx) => {
    const canView = app.perms.viewFilter(ctx.user);
    const rows = app.db.all('SELECT t.tag, p.id, p.space, p.parent FROM page_tags t JOIN pages p ON p.id = t.page_id WHERE p.archived = 0');
    const counts = new Map();
    for (const r0 of rows) if (canView(r0)) counts.set(r0.tag, (counts.get(r0.tag) || 0) + 1);
    const tax = new Map((app.ontology.data.tags || []).map(t => [t.name, t]));
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tag, count]) => ({ tag, count, parent: tag.includes('/') ? tag.slice(0, tag.lastIndexOf('/')) : null, description: tax.get(tag)?.description || null, deprecated: !!tax.get(tag)?.deprecated }));
  }, { public: true });

  r.get('/api/v1/tags/:tag*', (ctx) => {
    const tag = ctx.params.tag.toLowerCase();
    const canView = app.perms.viewFilter(ctx.user);
    const pages = app.db.all(`SELECT DISTINCT p.* FROM page_tags t JOIN pages p ON p.id = t.page_id WHERE (t.tag = ? OR t.tag LIKE ?) AND p.archived = 0 ORDER BY p.title`, tag, tag + '/%')
      .filter(canView).map(p => pageDto(app, p));
    const related = app.db.all(`SELECT t2.tag, COUNT(*) AS n FROM page_tags t1 JOIN page_tags t2 ON t1.page_id = t2.page_id AND t2.tag != t1.tag
      WHERE t1.tag = ? GROUP BY t2.tag ORDER BY n DESC LIMIT 12`, tag);
    const def = (app.ontology.data.tags || []).find(t => t.name === tag) || null;
    return { tag, pages, related, definition: def, children: app.db.all('SELECT DISTINCT tag FROM page_tags WHERE tag LIKE ?', tag + '/%').map(x => x.tag) };
  }, { public: true });

  // ---- graph -----------------------------------------------------------------------------------
  r.get('/api/v1/graph', (ctx) => app.graph.toJson(ctx.user, {
    focus: ctx.query.page || null, depth: Math.min(Number(ctx.query.depth) || 2, 4),
    includeTags: ctx.query.tags !== '0', includePeople: ctx.query.people !== '0', limit: Math.min(Number(ctx.query.limit) || 1500, 5000),
  }), { public: true });
  r.get('/api/v1/graph/communities', (ctx) => {
    const { allowed } = app.graph.forUser(ctx.user);
    return app.graph.communities().list.map(c => ({ ...c, pages: c.pages.filter(p => allowed.has('page:' + p)) })).filter(c => c.pages.length)
      .map(c => ({ ...c, pageTitles: c.pages.slice(0, 12).map(id => ({ id, title: app.pages.row(id)?.title })) }));
  }, { public: true });
  r.get('/api/v1/graph/neighbors/:id', (ctx) => {
    const n = app.graph.neighbors(ctx.user, ctx.params.id, Math.min(Number(ctx.query.depth) || 1, 3));
    if (!n) throw httpError(404, 'Page not found');
    return n.map(x => ({ rel: x.rel, direction: x.direction, depth: x.depth, node: x.node }));
  }, { public: true });
  r.get('/api/v1/graph/export', (ctx) => {
    const fmt = ctx.query.format || 'jsonld';
    if (fmt === 'jsonld') return ctx.send(200, JSON.stringify(app.graph.exportJsonLd(ctx.user), null, 2), { 'content-type': 'application/ld+json; charset=utf-8' });
    if (fmt === 'ttl') return ctx.send(200, app.graph.exportTurtle(ctx.user), { 'content-type': 'text/turtle; charset=utf-8' });
    if (fmt === 'graphml') return ctx.send(200, app.graph.exportGraphML(ctx.user), { 'content-type': 'application/graphml+xml; charset=utf-8' });
    throw httpError(400, 'format must be jsonld, ttl or graphml');
  }, { auth: true });

  // ---- GraphRAG --------------------------------------------------------------------------------
  const rag = async (ctx, q, opts) => {
    if (!ctx.user && !app.settings.get('anonymous_access', false)) throw httpError(401, 'Login required');
    const mode = ['hybrid', 'local', 'global', 'vector'].includes(opts.mode) ? opts.mode : 'hybrid';
    const answer = !!opts.answer && app.flag('graphrag.answer', ctx.user);
    return app.graphrag.query(ctx.user, q, { mode, k: Math.min(Number(opts.k) || 8, 30), depth: Math.min(Number(opts.depth) || 2, 3), answer });
  };
  r.get('/api/v1/graphrag/query', (ctx) => rag(ctx, String(ctx.query.q || ''), ctx.query), { public: true });
  r.post('/api/v1/graphrag/query', async (ctx) => { const b = await ctx.json(); return rag(ctx, String(b.query || b.q || ''), b); }, { public: true, noCsrf: false });

  // ---- ontology --------------------------------------------------------------------------------
  r.get('/api/v1/ontology', (ctx) => {
    const usage = Object.fromEntries(app.db.all('SELECT type, COUNT(*) AS n FROM pages WHERE archived = 0 GROUP BY type').map(x => [x.type, x.n]));
    const relUsage = Object.fromEntries(app.db.all("SELECT substr(kind, 5) AS rel, COUNT(*) AS n FROM links WHERE kind LIKE 'rel:%' GROUP BY kind").map(x => [x.rel, x.n]));
    return { ontology: app.ontology.data, yaml: app.ontology.toYAML(), usage, relationUsage: relUsage, builtins: [...app.ontology.relations.values()].filter(r0 => r0.builtin) };
  }, { public: true });
  r.put('/api/v1/ontology', async (ctx) => {
    app.perms.assertKm(ctx.user);
    const b = await ctx.json();
    const onto = b.yaml !== undefined ? Ontology.parse(String(b.yaml)) : new Ontology(b.ontology);
    await app.pages.commitAndIndex({ writes: [{ path: ONTOLOGY_PATH, content: onto.toYAML() }], user: ctx.user, message: b.message || 'Update ontology' });
    app.ontology = onto;
    app.indexer.version++;
    app.audit(ctx.user, 'ontology.update', null, { types: onto.data.types.length, relations: (onto.data.relations || []).length }, ctx.ip);
    return { ontology: onto.data };
  }, { auth: true });
  r.post('/api/v1/ontology/validate', async (ctx) => {
    const b = await ctx.json();
    try { const o = b.yaml !== undefined ? Ontology.parse(String(b.yaml)) : new Ontology(b.ontology); return { valid: true, types: o.data.types.length }; }
    catch (e) { return { valid: false, error: e.message, errors: e.errors || [] }; }
  }, { auth: true });
  r.get('/api/v1/ontology/schema.ttl', (ctx) => ctx.send(200, app.ontology.schemaTurtle(), { 'content-type': 'text/turtle; charset=utf-8' }), { public: true });
}
