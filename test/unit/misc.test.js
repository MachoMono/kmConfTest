import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, toFts } from '../../server/search.js';
import { Ontology, DEFAULT_ONTOLOGY } from '../../server/ontology.js';
import { localEmbed, cosine, terms } from '../../server/embed.js';
import { hashPassword, verifyPassword } from '../../server/auth.js';
import { Router } from '../../server/http.js';
import { classifyPath } from '../../server/indexer.js';

test('[F:search-filters] query language parses filters, phrases and exclusions', () => {
  const q = parseQuery('deploy "blue green" -legacy tag:Runbook #ops space:eng type:System author:bob updated>2026-01-01 sort:updated');
  assert.deepEqual(q.terms, ['deploy']);
  assert.deepEqual(q.phrases, ['blue green']);
  assert.deepEqual(q.exclude, ['legacy']);
  assert.deepEqual(q.filters.tag, ['runbook', 'ops']);
  assert.deepEqual(q.filters.space, ['eng']);
  assert.equal(q.updatedAfter, '2026-01-01');
  assert.equal(q.sort, 'updated');
  assert.equal(toFts(q), '("deploy"* AND "blue green") NOT "legacy"');
  assert.equal(toFts(parseQuery('tag:x')), null);
});

test('[F:ontology-default] [F:ontology-validate] ontology checks and validation', () => {
  const o = new Ontology();
  assert.ok(o.types.has('System'));
  assert.throws(() => new Ontology({ types: [{ name: 'A' }], relations: [{ name: 'r', range: ['Missing'] }] }), /unknown type Missing/);
  assert.throws(() => Ontology.parse('types: [\n'), /Invalid ontology YAML/);
  const issues = o.validate({ type: 'System', data: {}, relations: [{ rel: 'depends_on', target: 'X' }, { rel: 'weird', target: 'Y' }], tags: [] },
    (t) => t === 'X' ? 'Person' : null);
  const codes = issues.map(i => i.code).sort();
  assert.deepEqual(codes, ['missing-property', 'range', 'unknown-relation']);
  assert.equal(o.validate({ type: 'Nope' })[0].code, 'unknown-type');
  assert.equal(o.validate({ type: 'Policy', data: { owner: 'x', review_by: 'soon' } }).find(i => i.code === 'bad-date').level, 'warning');
});

test('[F:tag-synonyms] [F:ontology-schema-ttl] tag synonyms canonicalise; schema exports as OWL turtle', () => {
  const o = new Ontology({ ...DEFAULT_ONTOLOGY, tags: [{ name: 'engineering', synonyms: ['eng'] }, { name: 'old', deprecated: true, replaced_by: 'new' }] });
  assert.equal(o.canonicalTag('#ENG'), 'engineering');
  assert.equal(o.canonicalTag('other'), 'other');
  assert.equal(o.validate({ tags: ['old'] })[0].code, 'deprecated-tag');
  const ttl = o.schemaTurtle();
  assert.match(ttl, /gw:System a owl:Class/);
  assert.match(ttl, /gw:depends_on a owl:ObjectProperty .* owl:inverseOf gw:required_by/);
});

test('local embeddings capture topical similarity', () => {
  const a = localEmbed('invoice billing payments service');
  const b = localEmbed('billing invoices and payment processing');
  const c = localEmbed('holiday travel booking policy for flights');
  assert.ok(cosine(a, b) > cosine(a, c) + 0.15, `${cosine(a, b)} vs ${cosine(a, c)}`);
  assert.deepEqual(terms('The Invoices were billed'), ['invoice', 'bill']);
});

test('[F:auth-login] password hashing uses salted scrypt', () => {
  const h = hashPassword('correct horse');
  assert.match(h, /^scrypt\$16384\$/);
  assert.notEqual(h, hashPassword('correct horse'));
  assert.ok(verifyPassword('correct horse', h));
  assert.ok(!verifyPassword('wrong', h));
  assert.ok(!verifyPassword('x', null));
});

test('router matches params and splats; path classification', () => {
  const r = new Router();
  r.get('/a/:id', () => 1).get('/f/:space/:rest*', () => 2);
  assert.deepEqual(r.match('GET', '/a/x%20y').params, { id: 'x y' });
  assert.deepEqual(r.match('GET', '/f/ENG/_attachments/p/a.png').params, { space: 'ENG', rest: '_attachments/p/a.png' });
  assert.ok(r.match('POST', '/a/1').methodNotAllowed);
  assert.equal(r.match('GET', '/nope'), null);
  assert.deepEqual(classifyPath('spaces/ENG/foo.md'), { kind: 'page', space: 'ENG', slug: 'foo' });
  assert.deepEqual(classifyPath('spaces/ENG/blog/2026-x.md'), { kind: 'blog', space: 'ENG', slug: '2026-x' });
  assert.equal(classifyPath('spaces/ENG/_attachments/x/y.md'), null);
  assert.equal(classifyPath('README.md'), null);
});
