import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDocument, mergeText, mergeData, diff3 } from '../../server/merge.js';

const fm = (tags, body, extra = '') => `---\nid: p1\ntitle: T\ntags:\n${tags.map(t => '  - ' + t).join('\n')}\n${extra}---\n\n${body}`;

test('[F:merge-line] non-overlapping line edits merge cleanly', () => {
  const base = 'a\nb\nc\nd\ne\n';
  const r = mergeText(base, 'A\nb\nc\nd\ne\n', 'a\nb\nc\nd\nE\n');
  assert.equal(r.text, 'A\nb\nc\nd\nE\n');
  assert.equal(r.conflicts.length, 0);
});

test('[F:merge-line] both sides appending at the same place keeps both additions', () => {
  const base = '- one\n- two\n';
  const r = mergeText(base, '- one\n- two\n- mine\n', '- one\n- two\n- theirs\n');
  assert.equal(r.text, '- one\n- two\n- theirs\n- mine\n');
  assert.equal(r.conflicts.length, 0);
  const same = mergeText(base, base + '- x\n', base + '- x\n');
  assert.equal(same.text, base + '- x\n');
});

test('[F:merge-word] edits to different words of the same line merge word-by-word', () => {
  const base = 'The quick brown fox jumps over the lazy dog.';
  const r = mergeText(base, 'The speedy brown fox jumps over the lazy dog.', 'The quick brown fox jumps over the sleepy dog.');
  assert.equal(r.text, 'The speedy brown fox jumps over the sleepy dog.');
  assert.equal(r.conflicts.length, 0);
});

test('[F:merge-conflict-record] true conflicts: preferred side wins, loser recorded, no markers', () => {
  const base = 'Status is green today.';
  const r = mergeText(base, 'Status is red today.', 'Status is amber today.', { prefer: 'ours' });
  assert.equal(r.text, 'Status is red today.');
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].kept, 'red');
  assert.equal(r.conflicts[0].discarded, 'amber');
  assert.doesNotMatch(r.text, /<<<<<<<|>>>>>>>|=======/);
  const t = mergeText(base, 'Status is red today.', 'Status is amber today.', { prefer: 'theirs' });
  assert.equal(t.text, 'Status is amber today.');
});

test('[F:merge-frontmatter] frontmatter merges per key; tag lists merge as sets', () => {
  const base = fm(['a', 'b'], 'x\n');
  const ours = fm(['a', 'b', 'c'], 'x\n', 'owner: "[[Team A]]"\n');
  const theirs = fm(['b'], 'x\n', 'lifecycle: active\n');
  const r = mergeDocument(base, ours, theirs);
  assert.ok(r.clean);
  assert.match(r.text, /tags:\n  - b\n  - c\n/);
  assert.match(r.text, /owner: "\[\[Team A\]\]"/);
  assert.match(r.text, /lifecycle: active/);
  const d = mergeData({ title: 'A' }, { title: 'B' }, { title: 'C' });
  assert.equal(d.data.title, 'B');
  assert.equal(d.conflicts[0].field, 'title');
});

test('[F:merge-line] fast paths', () => {
  assert.equal(mergeDocument('a', 'b', 'a').text, 'b');
  assert.equal(mergeDocument('a', 'a', 'c').text, 'c');
  assert.equal(mergeDocument('a', 'z', 'z').text, 'z');
  const d = diff3(['x'], ['x'], ['x']);
  assert.deepEqual(d.result, ['x']);
});

// Property test: random concurrent edits to disjoint paragraphs never lose an edit.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const WORDS = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau'.split(' ');

test('[F:merge-line] [F:merge-word] property: disjoint concurrent edits are always fully preserved', () => {
  const rand = rng(42);
  for (let iter = 0; iter < 300; iter++) {
    const n = 6 + Math.floor(rand() * 10);
    const paras = Array.from({ length: n }, (_, i) => Array.from({ length: 5 + Math.floor(rand() * 6) }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(' ') + ` p${i}.`);
    const base = paras.join('\n\n') + '\n';
    const i = Math.floor(rand() * n);
    let j = Math.floor(rand() * n);
    if (j === i) j = (i + 1 + Math.floor(rand() * (n - 1))) % n;
    const mut = (arr, k, tag) => { const c = [...arr]; const w = c[k].split(' '); w.splice(Math.floor(rand() * w.length), 0, tag); c[k] = w.join(' '); return c.join('\n\n') + '\n'; };
    const oursMark = `OURS${iter}`, theirsMark = `THEIRS${iter}`;
    const ours = mut(paras, i, oursMark), theirs = mut(paras, j, theirsMark);
    const r = mergeDocument(base, ours, theirs);
    assert.ok(r.text.includes(oursMark) && r.text.includes(theirsMark), `iteration ${iter} lost an edit`);
    assert.equal(r.conflicts.length, 0, `iteration ${iter} reported conflicts`);
    for (let k = 0; k < n; k++) assert.ok(r.text.includes(`p${k}.`), 'paragraph lost');
  }
});

test('[F:merge-word] property: edits in different words of one paragraph merge', () => {
  const rand = rng(7);
  let merged = 0;
  for (let iter = 0; iter < 200; iter++) {
    const words = Array.from({ length: 30 }, (_, k) => WORDS[k % WORDS.length] + k);
    const base = words.join(' ');
    const a = Math.floor(rand() * 12), b = 18 + Math.floor(rand() * 12);
    const o = [...words]; o[a] = 'OURS';
    const t = [...words]; t[b] = 'THEIRS';
    const r = mergeText(base, o.join(' '), t.join(' '));
    if (r.text.includes('OURS') && r.text.includes('THEIRS') && !r.conflicts.length) merged++;
  }
  assert.equal(merged, 200);
});
