import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { startApp } from '../helpers.js';

let t, admin, bob, token;
before(async () => {
  t = await startApp();
  [admin, bob] = await Promise.all([t.as('admin'), t.as('bob')]);
  token = (await bob.ok('POST', '/api/v1/auth/tokens', { name: 'agent' })).token;
});
after(async () => { await t.stop(); });

const page = (title, crumbs, body, labels = '') => `<!DOCTYPE html><html><head><title>Migration : ${title}</title></head><body>
<div id="breadcrumb-section"><ol id="breadcrumbs"><li><a href="index.html">Migration</a></li>${crumbs.map(c => `<li><a href="${c}">x</a></li>`).join('')}</ol></div>
<h1 id="title-heading" class="pagetitle"><span id="title-text"> Migration : ${title} </span></h1>
<div id="main-content" class="wiki-content group">${body}</div>${labels}
<div class="pageSection group"><h2 id="attachments">Attachments:</h2></div></body></html>`;

test('[F:import-confluence] Confluence HTML export imports hierarchy, macros, links, labels and attachments', async () => {
  await admin.ok('POST', '/api/v1/spaces', { key: 'MIG', name: 'Migration' });
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const zip = zipSync({
    'MIG/index.html': strToU8('<html><body>index</body></html>'),
    'MIG/Home_1.html': strToU8(page('Home', [], `<p>Welcome. See <a href="Child-Page_2.html">the child</a>.</p>
      <div class="confluence-information-macro confluence-information-macro-warning"><p class="title">Heads up</p><div class="confluence-information-macro-body"><p>Legacy content.</p></div></div>`)),
    'MIG/Child-Page_2.html': strToU8(page('Child Page', ['Home_1.html'], `<h2>Code</h2>
      <div class="code panel"><div class="codeContent"><pre class="syntaxhighlighter-pre" data-syntaxhighlighter-params="brush: java; gutter: false">System.out.println("hi");</pre></div></div>
      <p><span class="status-macro aui-lozenge aui-lozenge-success">DONE</span> by <a class="confluence-userlink" data-username="jsmith" href="/display/~jsmith">John Smith</a></p>
      <div class="expand-container"><div class="expand-control"><span class="expand-control-text">Click me</span></div><div class="expand-content"><p>Hidden text</p></div></div>
      <p><img src="attachments/2/9001.png" data-linked-resource-default-alias="diagram.png"></p>
      <table><tbody><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></tbody></table>`,
      '<div class="labels"><a class="aui-label" href="#">Legacy Docs</a></div>')),
    'MIG/attachments/2/9001.png': png,
  });
  const r = await admin.req('POST', '/api/v1/spaces/MIG/import?format=confluence', undefined, { raw: Buffer.from(zip), headers: { 'content-type': 'application/zip' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.pages, 2);
  const home = (await admin.ok('GET', '/api/v1/search?q=' + encodeURIComponent('space:MIG Welcome'))).results.find(x => x.title === 'Home');
  const hv = await admin.ok('GET', `/api/v1/pages/${home.id}`);
  assert.match(hv.markdown, /See \[\[Child Page\|the child\]\]\./);
  assert.match(hv.markdown, /> \[!warning\] Heads up\n> Legacy content\./);
  const child = hv.backlinks.length === 0 ? (await admin.ok('GET', '/api/v1/resolve?space=MIG&title=Child%20Page')).page : null;
  const cv = await admin.ok('GET', `/api/v1/pages/${child.id}`);
  assert.equal(cv.page.parent, home.id, 'breadcrumb hierarchy preserved');
  assert.deepEqual(cv.page.tags, ['legacy-docs']);
  assert.match(cv.markdown, /```java\nSystem.out.println\("hi"\);\n```/);
  assert.match(cv.markdown, /\{\{status:green\|DONE\}\} by @jsmith/);
  assert.match(cv.markdown, /<details><summary>Click me<\/summary>\n\nHidden text\n\n<\/details>/);
  assert.match(cv.markdown, /!\[\]\(_attachments\/[a-z0-9]+\/diagram.png\)/);
  assert.match(cv.markdown, /\| A \| B \|/);
  const att = await admin.ok('GET', `/api/v1/pages/${child.id}/attachments`);
  assert.equal(att[0].name, 'diagram.png');
  assert.equal((await admin.ok('GET', `/api/v1/pages/${home.id}`)).backlinks.length, 0);
  assert.ok((await admin.ok('GET', `/api/v1/pages/${child.id}`)).backlinks.some(b => b.id === home.id));
  assert.equal((await bob.req('POST', '/api/v1/spaces/MIG/import', undefined, { raw: Buffer.from(zip) })).status, 403);
  assert.equal((await admin.req('POST', '/api/v1/spaces/MIG/import', undefined, { raw: Buffer.from('not a zip') })).status, 400);
});

test('[F:import-markdown] Obsidian vault import keeps folders, frontmatter, links and images', async () => {
  const zip = zipSync({
    'vault/.obsidian/app.json': strToU8('{}'),
    'vault/Projects/Apollo.md': strToU8('---\ntags: [project]\nstatus: active\n---\n\nApollo depends on [[Zeus]]. ![[apollo.png]]\n'),
    'vault/Projects/Apollo/Notes.md': strToU8('Notes for [[Apollo]].\n'),
    'vault/Zeus.md': strToU8('# Zeus\n\nThe platform. #infra\n'),
    'vault/assets/apollo.png': new Uint8Array([137, 80, 78, 71]),
  });
  const r = await admin.req('POST', '/api/v1/spaces/MIG/import?format=markdown', undefined, { raw: Buffer.from(zip) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const res = async (title) => (await admin.ok('GET', `/api/v1/resolve?space=MIG&title=${encodeURIComponent(title)}`)).page;
  const apollo = await res('Apollo'), notes = await res('Notes'), zeus = await res('Zeus'), vault = await res('vault');
  assert.ok(apollo && notes && zeus && vault);
  const av = await admin.ok('GET', `/api/v1/pages/${apollo.id}`);
  assert.deepEqual(av.page.tags, ['project']);
  assert.equal(av.frontmatter.status, 'active');
  assert.match(av.html, /class="wikilink" href="\/p\/[^"]+" data-target="Zeus"/);
  assert.match(av.html, /_attachments\/_shared\/apollo.png/);
  assert.equal((await admin.ok('GET', `/api/v1/pages/${notes.id}`)).page.parent, apollo.id, 'folder note is the folder parent');
  const img = await admin.get('/api/v1/files/MIG/_attachments/_shared/apollo.png');
  assert.equal(img.status, 200);
});

const rpc = (body, tok = token) => fetch(t.url + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(body) });
const call = async (name, args, id = 1) => (await (await rpc({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })).json()).result;

test('[F:mcp] MCP server: handshake, tool listing and every tool', async () => {
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, null)).status, 401);
  const init = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })).json();
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'gitwiki');
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const tools = (await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()).result.tools.map(x => x.name);
  assert.deepEqual(tools, ['search', 'graphrag_query', 'get_page', 'list_spaces', 'get_neighbors', 'get_ontology', 'create_page', 'append_to_page']);
  const s = await call('search', { query: 'reconciliation' });
  assert.equal(s.structuredContent.results[0].title, 'Ledger Service');
  assert.match(s.structuredContent.results[0].url, /^http:\/\/127\.0\.0\.1:\d+\/p\//);
  const g = await call('graphrag_query', { question: 'What depends on the Postgres cluster?' });
  assert.ok(g.structuredContent.relations.some(r => r.target === 'Postgres Cluster' && r.rel === 'depends_on'));
  assert.match(g.content[0].text, /"context":/);
  const p = await call('get_page', { title: 'Billing Service' });
  assert.match(p.structuredContent.markdown, /generates invoices/);
  assert.ok(!(await call('list_spaces', {})).structuredContent.some(x => x.key === 'FIN'));
  const n = await call('get_neighbors', { title: 'Payments Team' });
  assert.ok(n.structuredContent.neighbors.some(x => x.label === 'Billing Service'));
  assert.ok((await call('get_ontology', {})).structuredContent.types.length > 5);
  const c = await call('create_page', { space: 'ENG', title: 'Agent Notes', markdown: 'Written by an AI agent.', tags: ['ai'] });
  assert.ok(c.structuredContent.id);
  const ap = await call('append_to_page', { id: c.structuredContent.id, markdown: 'Appended line.' });
  assert.ok(ap.structuredContent.rev);
  assert.match((await bob.ok('GET', `/api/v1/pages/${c.structuredContent.id}`)).markdown, /Written by an AI agent\.\n\nAppended line\./);
  assert.equal((await call('create_page', { space: 'FIN', title: 'Nope' })).isError, true);
  const unknown = await (await rpc({ jsonrpc: '2.0', id: 9, method: 'bogus' })).json();
  assert.equal(unknown.error.code, -32601);
  const batch = await (await rpc([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }])).json();
  assert.equal(batch.length, 2);
  assert.equal((await fetch(t.url + '/mcp')).status, 405);
});
