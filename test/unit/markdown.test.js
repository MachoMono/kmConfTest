import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, parseWikiTarget, slugify } from '../../shared/markdown.js';
import { htmlToMarkdown } from '../../shared/tomd.js';
import { sanitize, parseParams, sectionOf } from '../../server/render.js';
import { PAGES } from '../../scripts/seed-data.js';

const rt = (md) => htmlToMarkdown(renderMarkdown(md, {}));

test('[F:wikilinks] [F:wikilink-anchor-alias] wikilinks render with target, anchor and alias', () => {
  const html = renderMarkdown('See [[Billing Service]] and [[Ledger#Reconciliation|the recon]].', {
    resolveLink: (t) => t === 'Billing Service' ? { exists: true, href: '/p/1' } : { exists: false, href: '/new' },
  });
  assert.match(html, /<a class="wikilink" href="\/p\/1" data-target="Billing Service">Billing Service<\/a>/);
  assert.match(html, /class="wikilink missing"[^>]*data-target="Ledger" data-anchor="Reconciliation" data-alias="the recon">the recon</);
  assert.deepEqual(parseWikiTarget('Page#Head|Alias'), { target: 'Page', anchor: 'Head', alias: 'Alias' });
});

test('[F:embeds] [F:attachment-images] page embeds and image embeds', () => {
  const html = renderMarkdown('![[Other Page#Sec]]\n\n![[diagram.png]]', { resolveAttachment: (n) => '/files/' + n });
  assert.match(html, /<div class="embed" data-target="Other Page" data-anchor="Sec"><\/div>/);
  assert.doesNotMatch(html, /<p><div class="embed"/);
  assert.match(html, /<img src="\/files\/diagram.png" alt="diagram.png" data-wikiembed="diagram.png">/);
});

test('[F:tags] [F:nested-tags] [F:mentions] [F:status] inline sigils', () => {
  const html = renderMarkdown('Tagged #payments and #team/platform, ping @alice. Issue #123 is not a tag. email a@b.com. {{status:green|Done}}');
  assert.match(html, /data-tag="payments">#payments/);
  assert.match(html, /data-tag="team\/platform"/);
  assert.match(html, /class="mention" data-user="alice">@alice/);
  assert.doesNotMatch(html, /data-tag="123"/);
  assert.doesNotMatch(html, /data-user="b.com"/);
  assert.match(html, /<span class="status" data-color="green">Done<\/span>/);
});

test('[F:callouts] obsidian callouts become panels', () => {
  const html = renderMarkdown('> [!warning] Careful\n> body text');
  assert.match(html, /<div class="callout" data-callout="warning"><div class="callout-title">Careful<\/div><div class="callout-body"><p>body text<\/p>/);
  const plain = renderMarkdown('> just a quote');
  assert.match(plain, /<blockquote>/);
});

test('[F:task-lists] GFM task lists', () => {
  const html = renderMarkdown('- [ ] open @bob\n- [x] done');
  assert.match(html, /<ul data-type="taskList">/);
  assert.match(html, /data-type="taskItem" data-checked="false">open/);
  assert.match(html, /data-checked="true">done/);
});

test('[F:macros-toc] [F:mermaid] [F:code-blocks] [F:tables] [F:details-expand] fences, tables, details', () => {
  const html = renderMarkdown('```toc\nmaxlevel: 2\n```\n\n```mermaid\ngraph TD\nA-->B\n```\n\n```js\nlet a = 1;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n<details><summary>More</summary>\n\nHidden\n\n</details>');
  assert.match(html, /<div class="macro" data-macro="toc" data-params="maxlevel: 2"><\/div>/);
  assert.match(html, /<pre class="mermaid">graph TD\nA--&gt;B/);
  assert.match(html, /<code class="language-js">/);
  assert.match(html, /<table>/);
  assert.match(html, /<details><summary>More<\/summary>/);
});

test('[F:md-wysiwyg-roundtrip] markdown -> html -> markdown is stable for all constructs', () => {
  const docs = [
    '# Title\n\nPara with **bold**, _italic_, `code`, ~~strike~~ and [link](https://example.com).\n',
    'Links: [[Page]], [[Page#Anchor]], [[Page|Alias]], [[KEY:Other Page]]. Tags #a #b/c, @user, {{status:red|Blocked}}.\n',
    '> [!tip] Tip title\n> line one\n>\n> - bullet\n',
    '- [ ] one @bob 📅 2026-01-01\n- [x] two\n',
    '1. first\n2. second\n   - nested\n\n- a\n- b\n',
    '| Col A | Col B |\n| --- | --- |\n| x \\| y | **z** |\n',
    '```python\nprint("hi")\n```\n\n```query\ntag:#runbook\ncolumns: title\n```\n\n```mermaid\ngraph TD\n  A --> B\n```\n',
    '![[Some Page]]\n\n![[img.png]]\n\n![alt](_attachments/id/p.png)\n',
    '<details><summary>More</summary>\n\nInside **bold**\n\n</details>\n',
    'Line\\\nbreak and <u>under</u> and <mark>hi</mark>\n',
    '---\n\nAfter rule. Special chars: 1 < 2, a_b_c, *not emphasis*?\n',
  ];
  for (const md of docs) {
    const once = rt(md);
    const twice = rt(once);
    assert.equal(twice, once, `unstable round trip for:\n${md}\n--- once:\n${once}`);
    // semantic content survives (compare rendered HTML of original vs round-tripped)
    const norm = (h) => h.replace(/\s+/g, ' ').replace(/ data-src="[^"]*"/g, '').trim();
    assert.equal(norm(renderMarkdown(once, {})), norm(renderMarkdown(md, {})), `semantic change for:\n${md}\n=> ${once}`);
  }
});

test('[F:md-wysiwyg-roundtrip] every seed page round-trips losslessly', () => {
  for (const p of PAGES) {
    const once = rt(p.md);
    assert.equal(rt(once), once, p.title);
  }
});

test('[F:md-wysiwyg-roundtrip] editor-style HTML (TipTap output) converts to clean markdown', () => {
  const html = '<h2>Heading</h2><p>Hello <strong>world</strong> <a class="wikilink" href="#" data-target="Billing Service">Billing Service</a> <a class="tag" href="#" data-tag="payments">#payments</a> <span class="mention" data-user="bob">@bob</span></p>' +
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked><span></span></label><div><p>done task</p></div></li></ul>' +
    '<div class="callout" data-callout="info" data-title="Note"><div class="callout-title">Note</div><div class="callout-body"><p>inside</p></div></div>' +
    '<table><tbody><tr><th><p>A</p></th><th><p>B</p></th></tr><tr><td><p>1</p></td><td><p>2</p></td></tr></tbody></table>' +
    '<div class="macro" data-macro="children" data-params="depth: 2"></div><div class="embed" data-target="X"></div>' +
    '<details open="open"><summary>Sum</summary><div data-details-content=""><p>body</p></div></details><p><span class="status" data-color="blue">WIP</span></p>';
  const md = htmlToMarkdown(html);
  assert.equal(md, '## Heading\n\nHello **world** [[Billing Service]] #payments @bob\n\n- [x] done task\n\n> [!info] Note\n> inside\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```children\ndepth: 2\n```\n\n![[X]]\n\n<details><summary>Sum</summary>\n\nbody\n\n</details>\n\n{{status:blue|WIP}}\n');
});

test('[F:xss-sanitize] rendered HTML is sanitised', () => {
  const html = sanitize(renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[x](javascript:alert(1))\n\n<a href="https://e.com" onclick="x()">e</a>\n\n<iframe src="https://evil"></iframe>', {}));
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /onerror|onclick/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.doesNotMatch(html, /<iframe/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('[F:macros-query] macro params parse; sections extract', () => {
  assert.deepEqual(parseParams('tag:#runbook type:System\ncolumns: title, owner\nlimit: 5'), { columns: 'title, owner', limit: '5', query: 'tag:#runbook type:System' });
  assert.equal(sectionOf('# A\n\na\n\n## B\n\nb\n\n## C\n\nc', 'B'), '## B\n\nb\n');
  assert.equal(slugify('Héllo Wörld!'), 'hello-world');
});
