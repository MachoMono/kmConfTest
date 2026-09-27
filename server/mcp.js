// Model Context Protocol server (Streamable HTTP transport, JSON responses) at POST /mcp.
// Lets external AI agents use the knowledge base as tools. Every call runs with the
// permissions of the authenticated principal (API token / session).
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export const MCP_TOOLS = [
  { name: 'search', description: 'Full-text search of the knowledge base. Supports filters like tag:x space:KEY type:System author:user "exact phrase".',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['query'] } },
  { name: 'graphrag_query', description: 'Retrieve the most relevant knowledge (chunks with citations, entities, typed relations, topic clusters) for a natural-language question using GraphRAG. Returns an LLM-ready context string.',
    inputSchema: { type: 'object', properties: { question: { type: 'string' }, mode: { type: 'string', enum: ['hybrid', 'local', 'global'] }, k: { type: 'integer', minimum: 1, maximum: 30 } }, required: ['question'] } },
  { name: 'get_page', description: 'Get a page as Markdown with metadata, by id or title.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, space: { type: 'string' } } } },
  { name: 'list_spaces', description: 'List spaces the caller can read.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_neighbors', description: 'Typed graph neighbours of a page (links, relations such as owner/depends_on, tags, parent/children).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, depth: { type: 'integer', minimum: 1, maximum: 3 } } } },
  { name: 'get_ontology', description: 'The knowledge-base ontology: entity types, relation types and tag taxonomy.', inputSchema: { type: 'object', properties: {} } },
  { name: 'create_page', description: 'Create a page (Markdown body). Requires edit permission in the space.',
    inputSchema: { type: 'object', properties: { space: { type: 'string' }, title: { type: 'string' }, markdown: { type: 'string' }, parent: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['space', 'title'] } },
  { name: 'append_to_page', description: 'Append Markdown to an existing page (merged safely with concurrent edits).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, markdown: { type: 'string' } }, required: ['id', 'markdown'] } },
];

function rpcError(id, code, message) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }

export async function handleMcp(app, user, msg) {
  if (Array.isArray(msg)) {
    const out = [];
    for (const m of msg) { const r = await handleMcp(app, user, m); if (r) out.push(r); }
    return out.length ? out : null;
  }
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg && msg.id, -32600, 'Invalid Request');
  const { id, method, params = {} } = msg;
  const isNotification = id === undefined;
  try {
    let result;
    switch (method) {
      case 'initialize': {
        const v = PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0];
        result = { protocolVersion: v, capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'gitwiki', title: app.settings.get('site_name', 'GitWiki'), version: '1.0.0' },
          instructions: 'Use graphrag_query to answer questions from the organisation knowledge base; cite page URLs from the results.' };
        break;
      }
      case 'notifications/initialized': case 'notifications/cancelled': return null;
      case 'ping': result = {}; break;
      case 'tools/list': result = { tools: MCP_TOOLS }; break;
      case 'tools/call': result = await callTool(app, user, params.name, params.arguments || {}); break;
      default: return isNotification ? null : rpcError(id, -32601, `Method not found: ${method}`);
    }
    return isNotification ? null : { jsonrpc: '2.0', id, result };
  } catch (e) {
    return isNotification ? null : rpcError(id, -32603, e.message);
  }
}

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }], structuredContent: typeof obj === 'string' ? undefined : obj });
const fail = (m) => ({ content: [{ type: 'text', text: m }], isError: true });

function findPage(app, user, a) {
  const row = a.id ? app.pages.row(a.id) : a.title ? app.indexer.resolve(a.title, a.space) : null;
  if (!row || !app.perms.can(user, 'view', row)) return null;
  return row;
}

async function callTool(app, user, name, a) {
  const base = app.cfg.baseUrl || '';
  switch (name) {
    case 'search': {
      const r = app.search.query(user, String(a.query || ''), { limit: Math.min(Number(a.limit) || 10, 50) });
      return text({ total: r.total, results: r.results.map(x => ({ ...x, snippet: x.snippet.replace(/<\/?mark>/g, ''), url: `${base}/p/${x.id}` })) });
    }
    case 'graphrag_query': {
      const r = await app.graphrag.query(user, String(a.question || ''), { mode: a.mode || 'hybrid', k: Math.min(Number(a.k) || 8, 30) });
      return text({ context: r.context, chunks: r.chunks.map(c => ({ title: c.title, heading: c.heading, url: base + c.url, text: c.text, score: c.score })),
        entities: r.entities, relations: r.relations, communities: r.communities });
    }
    case 'get_page': {
      const row = findPage(app, user, a);
      if (!row) return fail('Page not found');
      const { data, body } = await app.pages.read(row.id);
      return text({ id: row.id, title: row.title, space: row.space, type: row.type, tags: JSON.parse(row.tags), url: `${base}/p/${row.id}`,
        updated_at: row.updated_at, updated_by: row.updated_by, properties: data, markdown: body });
    }
    case 'list_spaces':
      return text(app.db.all('SELECT key, name, description FROM spaces WHERE archived = 0 ORDER BY name').filter(s => app.perms.canSpace(user, 'view', s.key)));
    case 'get_neighbors': {
      const row = findPage(app, user, a);
      if (!row) return fail('Page not found');
      const n = app.graph.neighbors(user, row.id, Math.min(Number(a.depth) || 1, 3)) || [];
      return text({ page: { id: row.id, title: row.title }, neighbors: n.map(x => ({ rel: x.rel, direction: x.direction, depth: x.depth, kind: x.node.kind, label: x.node.label, type: x.node.type || null, id: x.node.pageId || x.node.id })) });
    }
    case 'get_ontology': return text(app.ontology.data);
    case 'create_page': {
      if (!user) return fail('Authentication required');
      const space = String(a.space || '').toUpperCase();
      if (!app.perms.canSpace(user, 'edit', space)) return fail('No edit permission in that space');
      const r = await app.pages.create(user, { space, title: a.title, markdown: a.markdown || '', parent: a.parent, tags: a.tags || [] });
      return text({ id: r.page.id, title: r.page.title, url: `${base}/p/${r.page.id}` });
    }
    case 'append_to_page': {
      const row = findPage(app, user, a);
      if (!row) return fail('Page not found');
      if (!app.perms.can(user, 'edit', row)) return fail('No edit permission');
      const cur = await app.pages.read(row.id);
      const r = await app.pages.update(user, row.id, { markdown: cur.body.replace(/\s*$/, '\n\n') + String(a.markdown || '') + '\n', baseRev: row.rev });
      return text({ id: row.id, rev: r.rev, merged: r.merged });
    }
    default: return fail(`Unknown tool ${name}`);
  }
}
