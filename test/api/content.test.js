import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { startApp } from '../helpers.js';

let t, alice, bob;
before(async () => { t = await startApp(); alice = await t.as('alice'); bob = await t.as('bob'); });
after(async () => { await t.stop(); });

const P = (id) => `/api/v1/pages/${id}`;

test('[F:spaces-create] [F:space-home] [F:page-tree] create space, home page and tree', async () => {
  const s = await bob.ok('POST', '/api/v1/spaces', { key: 'OPS', name: 'Operations', description: 'Ops docs' });
  assert.equal(s.key, 'OPS');
  const sp = await bob.ok('GET', '/api/v1/spaces/OPS');
  assert.equal(sp.home_id, s.home);
  assert.equal(sp.role, 'admin');
  assert.equal(sp.tree.length, 1);
  assert.equal((await bob.post('/api/v1/spaces', { key: 'OPS', name: 'dup' })).status, 409);
  assert.equal((await bob.post('/api/v1/spaces', { key: 'x', name: 'bad' })).status, 400);
  const list = await bob.ok('GET', '/api/v1/spaces');
  assert.ok(list.some(x => x.key === 'OPS'));
  assert.ok(!list.some(x => x.key === 'FIN'), 'bob cannot see FIN');
});

test('[F:pages-create] [F:git-versioning] [F:git-author-attribution] pages are markdown files committed by the author', async () => {
  const r = await bob.ok('POST', '/api/v1/pages', { space: 'OPS', title: 'Deploy Guide', markdown: '# Steps\n\n1. Build\n2. Ship #deploy', tags: ['ops'] });
  const page = r.page;
  assert.equal(page.parent, (await bob.ok('GET', '/api/v1/spaces/OPS')).home_id, 'defaults under space home');
  assert.deepEqual(page.tags, ['deploy', 'ops']);
  const text = await t.app.git.readFile(page.path);
  assert.match(text, /^---\nid: [a-z0-9]+\ntitle: Deploy Guide\ntags:\n  - ops\nparent: /);
  const log = await t.app.git.log(page.path);
  assert.equal(log[0].author, 'Bob Martinez');
  assert.equal(log[0].email, 'bob@example.com');
  const view = await bob.ok('GET', P(page.id));
  assert.match(view.html, /<ol>/);
  assert.equal(view.perms.edit, true);
  const src = await bob.get(P(page.id) + '/source');
  assert.match(src.data, /2\. Ship #deploy/);
});

test('[F:pages-update] [F:history] [F:diff] [F:restore-version] update, history, diff and restore', async () => {
  const { page } = await bob.ok('POST', '/api/v1/pages', { space: 'OPS', title: 'Versioned', markdown: 'Version one text.' });
  const u = await bob.ok('PUT', P(page.id), { markdown: 'Version two text.', baseRev: page.rev, message: 'second' });
  assert.equal(u.merged, false);
  const same = await bob.ok('PUT', P(page.id), { markdown: 'Version two text.' });
  assert.equal(same.unchanged, true);
  const hist = await bob.ok('GET', P(page.id) + '/history');
  assert.equal(hist.length, 2);
  assert.equal(hist[0].message, 'second');
  assert.equal(hist[0].version, 2);
  const diff = await bob.ok('GET', `${P(page.id)}/diff?from=${hist[1].rev}&to=${hist[0].rev}`);
  assert.match(diff.html, /<del>one<\/del>|<ins>two<\/ins>/);
  const v1 = await bob.ok('GET', `${P(page.id)}/versions/${hist[1].rev}`);
  assert.equal(v1.markdown.trim(), 'Version one text.');
  await bob.ok('POST', P(page.id) + '/restore', { rev: hist[1].rev });
  assert.equal((await bob.ok('GET', P(page.id))).markdown.trim(), 'Version one text.');
  assert.equal((await bob.ok('GET', P(page.id) + '/history')).length, 3);
  assert.equal((await bob.get(`${P(page.id)}/versions/zzz`)).status, 400);
});

test('[F:pages-rename-link-rewrite] renaming a page rewrites inbound wikilinks', async () => {
  const target = (await bob.ok('POST', '/api/v1/pages', { space: 'OPS', title: 'Old Name', markdown: 'target' })).page;
  const src = (await bob.ok('POST', '/api/v1/pages', { space: 'OPS', title: 'Linker', markdown: 'See [[Old Name]], [[old name#Sec|alias]] and ![[Old Name]].' })).page;
  const other = (await alice.ok('POST', '/api/v1/pages', { space: 'ENG', title: 'Cross', markdown: 'Cross ref [[OPS:Old Name]].' })).page;
  assert.equal((await bob.ok('GET', P(target.id))).backlinks.length, 2);
  await bob.ok('PUT', P(target.id), { title: 'New Name' });
  const moved = await bob.ok('GET', P(target.id));
  assert.match(moved.page.path, /new-name\.md$/);
  assert.equal((await bob.ok('GET', P(src.id))).markdown.trim(), 'See [[New Name]], [[New Name#Sec|alias]] and ![[New Name]].');
  assert.equal((await alice.ok('GET', P(other.id))).markdown.trim(), 'Cross ref [[OPS:New Name]].');
  assert.equal((await bob.ok('GET', P(target.id))).backlinks.length, 2);
  assert.ok(!(await t.app.git.exists('spaces/OPS/old-name.md')));
});

test('[F:pages-move] [F:pages-reorder] [F:pages-copy] move, reorder, copy (with children)', async () => {
  const a = (await bob.ok('POST', '/api/v1/pages', { space: 'OPS', title: 'Parent A', markdown: 'a' })).page;
  const c1 = (await bob.ok('POST', '/api/v1/pages', { space: 'OPS', title: 'Child 1', parent: a.id, markdown: 'c1' })).page;
  const c2 = (await bob.ok('POST', '/api/v1/pages', { space: 'OPS', title: 'Child 2', parent: a.id, markdown: 'c2' })).page;
  await bob.ok('POST', P(c2.id) + '/move', { parent: a.id, before: c1.id });
  const kids = (await bob.ok('GET', P(a.id))).children.map(k => k.title);
  assert.deepEqual(kids, ['Child 2', 'Child 1']);
  assert.equal((await bob.post(P(a.id) + '/move', { parent: c1.id })).status, 400, 'cannot move under own child');
  const copy = await bob.ok('POST', P(a.id) + '/copy', { withChildren: true });
  assert.equal(copy.page.title, 'Copy of Parent A');
  assert.equal((await bob.ok('GET', P(copy.page.id))).children.length, 2);
  // move to another space brings children along
  await t.app.perms.setSpacePerms('ENG', [...t.app.perms.spacePerms('ENG'), { ptype: 'user', principal: 'bob', role: 'editor' }]);
  await bob.ok('POST', P(a.id) + '/move', { space: 'ENG', parent: null });
  const moved = await bob.ok('GET', P(c1.id));
  assert.equal(moved.page.space, 'ENG');
  assert.equal(moved.page.parent, a.id);
});

test('[F:pages-archive] [F:pages-delete-trash] [F:trash-restore] archive, delete to trash and restore', async () => {
  const p = (await bob.ok('POST', '/api/v1/pages', { space: 'OPS', title: 'Temp Page', markdown: 'temporary [[Deploy Guide]]' })).page;
  const kid = (await bob.ok('POST', '/api/v1/pages', { space: 'OPS', title: 'Temp Kid', parent: p.id, markdown: 'kid' })).page;
  await bob.ok('POST', P(p.id) + '/archive', { archived: true });
  assert.equal((await bob.ok('GET', P(p.id))).page.archived, true);
  assert.ok(!(await bob.ok('GET', '/api/v1/search?q=temporary')).results.some(r => r.id === p.id), 'archived pages hidden from search');
  await bob.ok('POST', P(p.id) + '/archive', { archived: false });
  await bob.ok('DELETE', P(p.id));
  assert.equal((await bob.get(P(p.id))).status, 404);
  assert.equal((await bob.ok('GET', P(kid.id))).page.parent, p.parent, 'children move up');
  const trash = await bob.ok('GET', '/api/v1/trash');
  assert.ok(trash.some(x => x.page_id === p.id));
  const restored = await bob.ok('POST', `/api/v1/trash/${p.id}/restore`);
  assert.equal(restored.page.title, 'Temp Page');
  assert.match((await bob.ok('GET', P(p.id))).markdown, /temporary/);
  const home = (await bob.ok('GET', '/api/v1/spaces/OPS')).home_id;
  assert.equal((await bob.del(P(home))).status, 400, 'home page cannot be deleted');
});

test('[F:attachments] [F:attachment-images] upload, list, serve, reference and delete attachments', async () => {
  const p = (await bob.ok('POST', '/api/v1/pages', { space: 'OPS', title: 'With Files', markdown: 'x' })).page;
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex');
  const up = await bob.req('POST', `${P(p.id)}/attachments?name=${encodeURIComponent('dia gram.png')}`, undefined, { raw: png, headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(up.status, 200);
  assert.equal(up.data.name, 'dia gram.png');
  assert.equal(up.data.markdown, '![[dia gram.png]]');
  const list = await bob.ok('GET', P(p.id) + '/attachments');
  assert.equal(list.length, 1);
  const file = await bob.get(list[0].url);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(file.data), png);
  await bob.ok('PUT', P(p.id), { markdown: 'Diagram: ![[dia gram.png]]' });
  assert.match((await bob.ok('GET', P(p.id))).html, /src="\/api\/v1\/files\/OPS\/_attachments\/[^"]+\/dia%20gram.png"/);
  assert.equal((await bob.get('/api/v1/files/OPS/_attachments/..%2f..%2f..%2fREADME.md')).status, 400, 'encoded traversal rejected');
  assert.notEqual((await bob.get('/api/v1/files/OPS/_attachments/../../README.md')).status, 200);
  await bob.ok('DELETE', `${P(p.id)}/attachments/${encodeURIComponent('dia gram.png')}`);
  assert.equal((await bob.ok('GET', P(p.id) + '/attachments')).length, 0);
});

test('[F:templates] templates list, create from template, admin CRUD', async () => {
  const list = await bob.ok('GET', '/api/v1/templates');
  assert.ok(list.some(x => x.id === 'meeting-notes'));
  const r = await bob.ok('POST', '/api/v1/pages', { space: 'OPS', title: 'Standup', template: 'meeting-notes' });
  assert.equal(r.page.type, 'Meeting');
  assert.ok(r.page.tags.includes('meeting'));
  const view = await bob.ok('GET', P(r.page.id));
  assert.match(view.markdown, /## Attendees\n\n- @bob/);
  assert.equal((await bob.put('/api/v1/templates/custom', { name: 'Custom' })).status, 403);
  await alice.ok('PUT', '/api/v1/templates/custom', { name: 'Custom', description: 'd', body: '# {{title}}\n' });
  assert.ok((await bob.ok('GET', '/api/v1/templates')).some(x => x.id === 'custom'));
  await alice.ok('DELETE', '/api/v1/templates/custom');
});

test('[F:drafts-autosave] drafts save, list, restore and clear on publish', async () => {
  const p = (await bob.ok('POST', '/api/v1/pages', { space: 'OPS', title: 'Drafty', markdown: 'v1' })).page;
  await bob.ok('PUT', `/api/v1/drafts/${p.id}`, { page_id: p.id, title: 'Drafty', markdown: 'unsaved work', base_rev: p.rev });
  assert.equal((await bob.ok('GET', `/api/v1/drafts/${p.id}`)).markdown, 'unsaved work');
  assert.equal((await alice.get(`/api/v1/drafts/${p.id}`)).status, 404, 'drafts are private');
  assert.ok((await bob.ok('GET', '/api/v1/dashboard')).drafts.some(d => d.key === p.id));
  await bob.ok('PUT', P(p.id), { markdown: 'unsaved work', baseRev: p.rev, draftKey: p.id });
  assert.equal((await bob.get(`/api/v1/drafts/${p.id}`)).status, 404);
  await bob.ok('PUT', '/api/v1/drafts/new-abc', { space: 'OPS', title: 'New thing', markdown: 'draft body' });
  await bob.ok('POST', '/api/v1/pages', { space: 'OPS', title: 'New thing', markdown: 'draft body', draftKey: 'new-abc' });
  assert.equal((await bob.get('/api/v1/drafts/new-abc')).status, 404);
});

test('[F:labels] [F:task-toggle] labels add/remove and task checkbox toggling', async () => {
  const p = (await bob.ok('POST', '/api/v1/pages', { space: 'OPS', title: 'Labelled', markdown: 'Intro #inline\n\n- [ ] first\n- [ ] second @alice' })).page;
  let r = await bob.ok('POST', P(p.id) + '/labels', { add: ['Alpha', '#beta'] });
  assert.deepEqual(r.tags, ['alpha', 'beta', 'inline']);
  r = await bob.ok('POST', P(p.id) + '/labels', { remove: ['alpha'] });
  assert.deepEqual(r.tags, ['beta', 'inline']);
  await bob.ok('POST', P(p.id) + '/tasks/3', { done: true });
  assert.match((await bob.ok('GET', P(p.id))).markdown, /- \[ \] first\n- \[x\] second @alice/);
  assert.equal((await bob.post(P(p.id) + '/tasks/0', { done: true })).status, 400);
});

test('[F:blog] blog posts live in the space blog', async () => {
  const b = await bob.ok('POST', '/api/v1/pages', { space: 'OPS', kind: 'blog', title: 'We launched', markdown: 'News!' });
  assert.equal(b.page.kind, 'blog');
  assert.match(b.page.path, /^spaces\/OPS\/blog\/\d{4}-\d{2}-\d{2}-we-launched\.md$/);
  const blog = await bob.ok('GET', '/api/v1/spaces/OPS/blog');
  assert.equal(blog[0].title, 'We launched');
  assert.ok((await bob.ok('GET', '/api/v1/dashboard')).blog.length >= 1);
});

test('[F:export-page-md] [F:export-page-html] [F:export-page-pdf] [F:export-space] page and space exports', async () => {
  const id = t.pages['Billing Service'].id;
  const md = await alice.get(`${P(id)}/export?format=md`);
  assert.match(md.headers.get('content-disposition'), /billing-service\.md/);
  assert.match(md.data, /^---\nid:/);
  const html = await alice.get(`${P(id)}/export?format=html`);
  assert.match(html.data, /<h1>Billing Service<\/h1>/);
  assert.match(html.data, /print\.css/);
  const pdf = await alice.get(`${P(id)}/export?format=pdf`);
  assert.match(pdf.data, /print\.js/);
  const zip = await alice.get('/api/v1/spaces/ENG/export');
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  const files = unzipSync(new Uint8Array(zip.data));
  assert.ok(files['billing-service.md']);
  assert.ok(files['_space.yml']);
  assert.match(strFromU8(files['README.md']), /Obsidian/);
});

test('[F:spaces-settings] [F:space-archive] space details update and archive', async () => {
  await bob.ok('PUT', '/api/v1/spaces/OPS', { description: 'Updated', color: '#123456' });
  assert.equal((await bob.ok('GET', '/api/v1/spaces/OPS')).description, 'Updated');
  assert.equal((await alice.put('/api/v1/spaces/OPS', { name: 'x' })).status, 200, 'KM admins manage all spaces');
  await bob.ok('PUT', '/api/v1/spaces/OPS', { archived: true, name: 'Operations' });
  assert.ok(!(await bob.ok('GET', '/api/v1/spaces')).some(s => s.key === 'OPS'));
  assert.ok((await bob.ok('GET', '/api/v1/spaces?archived=1')).some(s => s.key === 'OPS'));
  await bob.ok('PUT', '/api/v1/spaces/OPS', { archived: false });
});

test('[F:macros-children] [F:macros-query] [F:macros-recent] [F:macros-tasks] [F:macros-include] [F:macros-tagcloud] [F:embeds] macros render', async () => {
  const md = '```children\n```\n\n```query\ntype:System owner:payments-team\ncolumns: title, lifecycle, owner\n```\n\n```recent\nlimit: 3\n```\n\n```tasks\nassignee: carol\n```\n\n```include\npage: Ledger Service\nsection: Reconciliation\n```\n\n```tagcloud\n```\n\n```excerpt\npage: Auth Service\n```\n\n```toc\n```\n\n## Heading A\n\n![[Postgres Cluster]]\n';
  const p = (await alice.ok('POST', '/api/v1/pages', { space: 'ENG', title: 'Macro Showcase', markdown: md, parent: t.pages.Runbooks.id })).page;
  const v = await alice.ok('GET', P(p.id));
  assert.match(v.html, /data-macro="query"><table class="query-table">[\s\S]*Billing Service[\s\S]*Ledger Service/);
  assert.doesNotMatch(v.html.match(/data-macro="query">[\s\S]*?<\/table>/)[0], /Auth Service/, 'owner filter excludes platform systems');
  assert.match(v.html, /data-macro="recent"><ul class="recent">/);
  assert.match(v.html, /data-macro="tasks"><ul class="task-report">[\s\S]*Document retry policy/);
  assert.match(v.html, /data-macro="include"><div class="embed"[\s\S]*Nightly reconciliation/);
  assert.match(v.html, /data-macro="tagcloud"><div class="tagcloud">/);
  assert.match(v.html, /data-macro="excerpt"><blockquote class="excerpt">Issues OAuth tokens/);
  assert.match(v.html, /<nav class="toc">[\s\S]*Heading A/);
  assert.match(v.html, /<div class="embed" data-target="Postgres Cluster">[\s\S]*<pre class="mermaid">/);
  const runbooks = await alice.ok('GET', P(t.pages.Runbooks.id));
  assert.match(runbooks.html, /data-macro="children"><ul class="children">[\s\S]*Billing Incident Runbook/);
});

test('[F:typed-relations] [F:ontology-page-validation] relations and ontology issues on page view', async () => {
  const v = await alice.ok('GET', P(t.pages['Billing Service'].id));
  const rels = v.relations.map(r => `${r.rel}:${r.title}`).sort();
  assert.deepEqual(rels, ['depends_on:Auth Service', 'depends_on:Ledger Service', 'owner:Payments Team']);
  assert.equal(v.ontologyIssues.filter(i => i.level === 'warning').length, 0);
  const legacy = await alice.ok('GET', P(t.pages['Legacy Invoicing'].id));
  assert.ok(legacy.ontologyIssues.some(i => i.code === 'missing-property'), 'System without owner is flagged');
  const back = await alice.ok('GET', P(t.pages['Ledger Service'].id));
  assert.ok(back.backlinks.some(b => b.title === 'Billing Service' && b.rel === 'depends_on'));
});

test('resolve and preview endpoints', async () => {
  assert.equal((await alice.ok('GET', '/api/v1/resolve?title=ledger%20service')).page.title, 'Ledger Service');
  assert.equal((await alice.ok('GET', '/api/v1/resolve?title=nope')).page, null);
  const pv = await alice.ok('POST', '/api/v1/preview', { space: 'ENG', markdown: 'Hi [[Auth Service]]' });
  assert.match(pv.html, /class="wikilink" href="\/p\//);
});
