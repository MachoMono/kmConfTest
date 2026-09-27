import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from '../helpers.js';

let t, alice, bob, carol;
before(async () => { t = await startApp(); [alice, bob, carol] = await Promise.all(['alice', 'bob', 'carol'].map(u => t.as(u))); });
after(async () => { await t.stop(); });
const P = (id) => `/api/v1/pages/${id}`;

test('[F:merge-concurrent-api] simultaneous edits from the same base merge silently', async () => {
  const body = 'Intro paragraph.\n\n## Section A\n\nAlpha text here.\n\n## Section B\n\nBeta text here.\n\n## Section C\n\nGamma text here.\n';
  const p = (await alice.ok('POST', '/api/v1/pages', { space: 'ENG', title: 'Shared Doc', markdown: body, tags: ['x'] })).page;
  const base = p.rev;
  // three people save at the same moment, all from the same base revision
  const [a, b, c] = await Promise.all([
    alice.ok('PUT', P(p.id), { markdown: body.replace('Alpha text', 'Alpha text (alice)'), baseRev: base, tags: ['x', 'from-alice'] }),
    bob.ok('PUT', P(p.id), { markdown: body.replace('Beta text', 'Beta text (bob)'), baseRev: base }),
    carol.ok('PUT', P(p.id), { markdown: body.replace('Gamma text', 'Gamma text (carol)') + '\nCarol appendix.\n', baseRev: base, tags: ['x', 'from-carol'] }),
  ]);
  const merges = [a, b, c].filter(r => r.merged).length;
  assert.equal(merges, 2, 'two of the three saves needed an automatic merge');
  assert.ok([a, b, c].every(r => r.conflicts === 0));
  const v = await alice.ok('GET', P(p.id));
  for (const s of ['Alpha text (alice)', 'Beta text (bob)', 'Gamma text (carol)', 'Carol appendix.']) assert.ok(v.markdown.includes(s), `missing ${s}`);
  assert.deepEqual(v.page.tags.sort(), ['from-alice', 'from-carol', 'x']);
  assert.doesNotMatch(v.markdown, /<<<<<<<|>>>>>>>/);
  const hist = await alice.ok('GET', P(p.id) + '/history');
  assert.equal(hist.length, 4);
  assert.equal(hist.filter(h => /auto-merged/.test(h.message)).length, 2);
  assert.equal(new Set(hist.map(h => h.author)).size, 3, 'each author attributed');
});

test('[F:merge-conflict-record] [F:merge-review-restore] overlapping edits: newest wins, loser recorded, KM can restore', async () => {
  const p = (await alice.ok('POST', '/api/v1/pages', { space: 'ENG', title: 'Contested', markdown: 'The SLA is 99.9 percent.\n' })).page;
  await alice.ok('PUT', P(p.id), { markdown: 'The SLA is 99.95 percent.\n', baseRev: p.rev });
  const r = await bob.ok('PUT', P(p.id), { markdown: 'The SLA is 99.99 percent.\n', baseRev: p.rev });
  assert.equal(r.merged, true);
  assert.equal(r.conflicts, 1);
  assert.equal((await bob.ok('GET', P(p.id))).markdown, 'The SLA is 99.99 percent.\n');
  const note = (await alice.ok('GET', '/api/v1/notifications')).items.find(n => n.type === 'merge');
  assert.ok(note, 'overwritten author gets a gentle notification');
  assert.equal(t.app.db.get("SELECT COUNT(*) AS n FROM email_outbox WHERE subject LIKE '%merged%'").n, 0, 'merge notices never email');
  const list = await alice.ok('GET', '/api/v1/admin/conflicts');
  const c = list.find(x => x.page_id === p.id);
  assert.equal(c.details.conflicts[0].discarded, '95');
  assert.equal(c.details.conflicts[0].kept, '99');
  await alice.ok('POST', `/api/v1/admin/conflicts/${c.id}`, { action: 'restore' });
  assert.equal((await bob.ok('GET', P(p.id))).markdown, 'The SLA is 99.95 percent.\n');
  assert.ok(!(await alice.ok('GET', '/api/v1/admin/conflicts')).some(x => x.id === c.id));
  assert.ok((await alice.ok('GET', '/api/v1/admin/conflicts?status=restored')).some(x => x.id === c.id));
});

test('[F:merge-concurrent-api] title change and body edit from same base both apply', async () => {
  const p = (await alice.ok('POST', '/api/v1/pages', { space: 'ENG', title: 'Rename Race', markdown: 'one\n\ntwo\n' })).page;
  await alice.ok('PUT', P(p.id), { title: 'Rename Race Renamed', baseRev: p.rev });
  const r = await bob.ok('PUT', P(p.id), { markdown: 'one\n\ntwo\n\nthree\n', baseRev: p.rev });
  assert.equal(r.merged, true);
  const v = await bob.ok('GET', P(p.id));
  assert.equal(v.page.title, 'Rename Race Renamed');
  assert.match(v.markdown, /three/);
  assert.match(v.page.path, /rename-race-renamed\.md$/);
});

test('[F:merge-concurrent-api] many parallel writers never corrupt the repository', async () => {
  const p = (await alice.ok('POST', '/api/v1/pages', { space: 'ENG', title: 'Hot Page', markdown: Array.from({ length: 20 }, (_, i) => `Line ${i}.`).join('\n\n') + '\n' })).page;
  const writers = Array.from({ length: 20 }, (_, i) => (i % 3 === 0 ? alice : i % 3 === 1 ? bob : carol));
  const base = (await alice.ok('GET', P(p.id))).markdown;
  await Promise.all(writers.map((c, i) => c.ok('PUT', P(p.id), { markdown: base.replace(`Line ${i}.`, `Line ${i} edited.`), baseRev: p.rev })));
  const v = await alice.ok('GET', P(p.id));
  for (let i = 0; i < 20; i++) assert.ok(v.markdown.includes(`Line ${i} edited.`), `edit ${i} lost`);
  const fsck = await t.app.git.run(['fsck', '--no-progress'], { allowFail: true });
  assert.equal(fsck.ok, true);
  const status = await t.app.git.run(['status', '--porcelain']);
  assert.equal(status.trim(), '', 'working tree clean');
});
