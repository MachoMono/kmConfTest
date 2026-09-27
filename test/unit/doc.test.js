import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitFrontmatter, joinFrontmatter, extract, plainText, sections, excerptOf, normalizeTag } from '../../shared/doc.js';

test('[F:frontmatter] frontmatter split/join is stable and ordered', () => {
  const text = joinFrontmatter({ tags: ['b', 'a'], title: 'T', id: 'x1', custom: 'v', empty: [] }, 'Body\n');
  assert.equal(text, '---\nid: x1\ntitle: T\ntags:\n  - b\n  - a\ncustom: v\n---\n\nBody\n');
  const { data, body } = splitFrontmatter(text);
  assert.deepEqual(data, { id: 'x1', title: 'T', tags: ['b', 'a'], custom: 'v' });
  assert.equal(body, 'Body\n');
  assert.equal(joinFrontmatter(data, body), text);
  assert.deepEqual(splitFrontmatter('no fm').data, {});
  assert.deepEqual(splitFrontmatter('---\n: bad : yaml : [\n---\nx').data, {});
});

test('[F:inline-fields] [F:typed-relations] [F:wikilinks] [F:tags] extraction of links, relations, fields', () => {
  const body = 'Owned by team.\n\ndepends_on:: [[Ledger]], [[Auth|auth svc]]\nlifecycle:: active\n\nSee [[Page#H|x]] and ![[Embed]]. #Payments #team/core/ @bob\n\n```\n[[NotALink]] #nottag @nobody\n```\n\n`[[inline code]]`\n';
  const ex = extract({ owner: '[[Payments Team]]', tags: ['Eng'], lifecycle2: 'x' }, body);
  assert.deepEqual(ex.links.map(l => [l.target, l.anchor, l.embed]), [['Ledger', null, false], ['Auth', null, false], ['Page', 'H', false], ['Embed', null, true]]);
  assert.deepEqual(ex.relations.map(r => [r.rel, r.target, r.source]), [['owner', 'Payments Team', 'frontmatter'], ['depends_on', 'Ledger', 'inline'], ['depends_on', 'Auth', 'inline']]);
  assert.equal(ex.fields.lifecycle, 'active');
  assert.equal(ex.fields.lifecycle2, 'x');
  assert.deepEqual(ex.tags, ['eng', 'payments', 'team/core']);
  assert.deepEqual(ex.mentions, ['bob']);
});

test('[F:task-lists] [F:my-tasks] task extraction with assignee and due date', () => {
  const ex = extract({}, '# T\n\n- [ ] write docs @Carol 📅 2026-10-15\n- [x] shipped @bob\n  - [ ] nested due:2026-01-02\n* not a task\n');
  assert.deepEqual(ex.tasks.map(t => [t.line, t.done, t.assignee, t.due]), [[2, false, 'carol', '2026-10-15'], [3, true, 'bob', null], [4, false, null, '2026-01-02']]);
  assert.deepEqual(ex.headings, [{ level: 1, text: 'T', id: 't' }]);
});

test('plain text, sections and excerpts for indexing', () => {
  const body = '# Intro\n\nHello [[World|there]] **bold** {{status:red|Down}}.\n\n## Details\n\n- item one\n- [ ] task two\n\n```js\ncode()\n```\n';
  assert.match(plainText(body), /Hello there bold Down\./);
  const s = sections('Page', body);
  assert.deepEqual(s.map(x => x.heading), ['Page › Intro', 'Page › Intro › Details']);
  assert.equal(s[1].anchor, 'details');
  assert.match(excerptOf(body), /Hello there/);
  assert.equal(normalizeTag('#Team/Core/'), 'team/core');
});
