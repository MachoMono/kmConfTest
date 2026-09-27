import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startApp } from '../helpers.js';

let t, admin, alice, remote, clone;
const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Power User', GIT_AUTHOR_EMAIL: 'power@example.com', GIT_COMMITTER_NAME: 'Power User', GIT_COMMITTER_EMAIL: 'power@example.com' } });

before(async () => {
  t = await startApp();
  [admin, alice] = await Promise.all([t.as('admin'), t.as('alice')]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gitwiki-remote-'));
  remote = path.join(tmp, 'kb.git');
  clone = path.join(tmp, 'clone');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
});
after(async () => { await t.stop(); fs.rmSync(path.dirname(remote), { recursive: true, force: true }); });

const sync = () => admin.ok('POST', '/api/v1/admin/git/sync');

test('[F:github-sync-push] connecting a remote pushes the whole knowledge base', async () => {
  const st = await admin.ok('PUT', '/api/v1/admin/git', { url: remote, branch: 'main', autoPush: true, interval: 0, webhookSecret: 'hooksecret' });
  assert.equal(st.configured, true);
  const r = await sync();
  assert.equal(r.pushed, true);
  execFileSync('git', ['clone', '-q', remote, clone]);
  assert.ok(fs.existsSync(path.join(clone, 'spaces/ENG/billing-service.md')));
  assert.ok(fs.existsSync(path.join(clone, '_system/ontology.yml')));
  // later UI edits are pushed automatically (debounced) or on sync
  const p = (await alice.ok('POST', '/api/v1/pages', { space: 'ENG', title: 'Pushed Page', markdown: 'from the UI' })).page;
  await sync();
  git(clone, 'pull', '-q');
  assert.match(fs.readFileSync(path.join(clone, p.path), 'utf8'), /from the UI/);
  assert.equal(git(clone, 'log', '-1', '--format=%an').trim(), 'Alice Chen');
});

test('[F:github-sync-pull] [F:git-normalize] power users edit Markdown in git; GitWiki pulls, normalises and indexes', async () => {
  fs.writeFileSync(path.join(clone, 'spaces/ENG/cli-guide.md'), '# CLI Guide\n\nUse the `kb` command. Related: [[Billing Service]] #tooling\n');
  const billing = path.join(clone, 'spaces/ENG/billing-service.md');
  fs.writeFileSync(billing, fs.readFileSync(billing, 'utf8').replace('generates invoices', 'generates invoices and credit notes'));
  git(clone, 'add', '-A'); git(clone, 'commit', '-q', '-m', 'Docs from my editor'); git(clone, 'push', '-q');
  const r = await sync();
  assert.equal(r.fastForward, true);
  assert.equal(r.normalized, 1);
  const s = await alice.ok('GET', '/api/v1/search?q=tooling');
  const cli = s.results.find(x => x.title === 'CLI Guide');
  assert.ok(cli, 'new file indexed with title from H1');
  const v = await alice.ok('GET', `/api/v1/pages/${cli.id}`);
  assert.match(v.markdown, /Use the `kb` command/);
  assert.ok((await alice.ok('GET', `/api/v1/pages/${t.pages['Billing Service'].id}`)).markdown.includes('credit notes'));
  const hist = await alice.ok('GET', `/api/v1/pages/${t.pages['Billing Service'].id}/history`);
  assert.equal(hist[0].author, 'Power User');
  // the normalisation commit (id/title frontmatter) is pushed back to the remote
  git(clone, 'pull', '-q');
  assert.match(fs.readFileSync(path.join(clone, 'spaces/ENG/cli-guide.md'), 'utf8'), /^---\nid: /);
});

test('[F:github-sync-merge] diverged histories merge per file with no conflict markers', async () => {
  const ledger = t.pages['Ledger Service'];
  // UI edits one paragraph while a git user edits another paragraph of the same page
  const cur = await alice.ok('GET', `/api/v1/pages/${ledger.id}`);
  await alice.ok('PUT', `/api/v1/pages/${ledger.id}`, { markdown: cur.markdown.replace('immutable and auditable', 'immutable, auditable and signed') });
  git(clone, 'pull', '-q');
  const f = path.join(clone, ledger.path);
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('Nightly reconciliation', 'Hourly reconciliation'));
  git(clone, 'commit', '-qam', 'Faster recon'); git(clone, 'push', '-q');
  // and both change the same sentence of another page (true conflict)
  const auth = t.pages['Auth Service'];
  const a = await alice.ok('GET', `/api/v1/pages/${auth.id}`);
  await alice.ok('PUT', `/api/v1/pages/${auth.id}`, { markdown: a.markdown.replace('Issues OAuth tokens', 'Issues OIDC tokens') });
  const af = path.join(clone, auth.path);
  await new Promise(r => setTimeout(r, 1100)); // remote commit is strictly newer
  fs.writeFileSync(af, fs.readFileSync(af, 'utf8').replace('Issues OAuth tokens', 'Issues SAML tokens'));
  git(clone, 'commit', '-qam', 'SAML'); git(clone, 'push', '-q');
  const r = await sync();
  assert.equal(r.merged, true);
  assert.equal(r.conflicts, 1);
  assert.equal(r.pushed, true);
  const l = (await alice.ok('GET', `/api/v1/pages/${ledger.id}`)).markdown;
  assert.ok(l.includes('immutable, auditable and signed') && l.includes('Hourly reconciliation'), 'both edits kept');
  const au = (await alice.ok('GET', `/api/v1/pages/${auth.id}`)).markdown;
  assert.match(au, /Issues SAML tokens/, 'newer commit wins the overlapping words');
  for (const file of [ledger.path, auth.path]) assert.doesNotMatch(await t.app.git.readFile(file), /<<<<<<<|>>>>>>>|=======/);
  const conflicts = await admin.ok('GET', '/api/v1/admin/conflicts');
  assert.ok(conflicts.some(c => c.source === 'sync' && c.page_id === auth.id && c.details.conflicts[0].discarded === 'OIDC'));
  git(clone, 'pull', '-q');
  assert.match(fs.readFileSync(f, 'utf8'), /signed/);
  const status = await admin.ok('GET', '/api/v1/admin/git');
  assert.equal(status.status.ahead, 0);
  assert.equal(status.status.behind, 0);
  assert.equal(status.status.lastError, null);
});

test('[F:github-webhook] GitHub push webhook (HMAC verified) triggers a sync', async () => {
  fs.writeFileSync(path.join(clone, 'spaces/ENG/webhook-page.md'), '---\ntitle: Webhook Page\n---\n\nArrived by webhook.\n');
  git(clone, 'add', '-A'); git(clone, 'commit', '-qm', 'hook'); git(clone, 'push', '-q');
  const body = JSON.stringify({ ref: 'refs/heads/main' });
  const bad = await fetch(t.url + '/api/v1/webhooks/github', { method: 'POST', headers: { 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=00' }, body });
  assert.equal(bad.status, 401);
  const sig = 'sha256=' + crypto.createHmac('sha256', 'hooksecret').update(body).digest('hex');
  const ok = await fetch(t.url + '/api/v1/webhooks/github', { method: 'POST', headers: { 'x-github-event': 'push', 'x-hub-signature-256': sig, 'content-type': 'application/json' }, body });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).result.fastForward, true);
  assert.ok((await alice.ok('GET', '/api/v1/search?q=webhook')).results.some(x => x.title === 'Webhook Page'));
  // deletions in git remove pages from the index
  git(clone, 'pull', '-q');
  git(clone, 'rm', '-q', 'spaces/ENG/webhook-page.md'); git(clone, 'commit', '-qm', 'rm'); git(clone, 'push', '-q');
  await sync();
  assert.ok(!(await alice.ok('GET', '/api/v1/search?q=webhook')).results.some(x => x.title === 'Webhook Page'));
});

test('ontology edits made in git are picked up on sync', async () => {
  git(clone, 'pull', '-q');
  const f = path.join(clone, '_system/ontology.yml');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('  - name: HowTo', '  - name: Runbook\n    description: Operational runbook.\n  - name: HowTo'));
  git(clone, 'commit', '-qam', 'Add Runbook type'); git(clone, 'push', '-q');
  await sync();
  assert.ok(t.app.ontology.types.has('Runbook'));
});
