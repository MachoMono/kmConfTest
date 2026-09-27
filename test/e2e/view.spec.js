import { test, expect } from '@playwright/test';
import { login, pageId, source, uniq } from './util.js';

test.beforeEach(async ({ page }) => { page.on('dialog', d => d.accept()); });

test('[F:ui-login] login, bad password and logout', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /GitWiki/ })).toBeVisible();
  await page.getByLabel('Username').fill('bob');
  await page.getByLabel('Password').fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid username or password');
  await login(page, 'bob');
  await page.getByRole('button', { name: /Bob Martinez/ }).click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('[F:ui-page-view] [F:task-toggle] page view: macros, relations, backlinks, TOC, diagrams, tasks and links', async ({ page }) => {
  await login(page, 'alice');
  const id = await pageId(page, 'Architecture Overview', 'ENG');
  await page.goto(`/p/${id}`);
  const c = page.locator('.page-content.rendered');
  await expect(c.locator('nav.toc')).toContainText('Services');
  await expect(c.locator('.query-table')).toContainText('ADR 001 Use Event Sourcing for Ledger');
  await expect(c.locator('.embed')).toContainText('Nightly reconciliation');
  await expect(page.locator('.page-rail')).toContainText('On this page');
  // follow a wikilink
  await c.locator('a.wikilink', { hasText: 'Postgres Cluster' }).first().click();
  await expect(page.locator('#page-title')).toHaveText('Postgres Cluster');
  await expect(page.locator('pre.mermaid svg')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.page-rail')).toContainText('Linked from');
  await expect(page.locator('.page-rail')).toContainText('Ledger Service');
  // typed properties / relations on a System page
  const billing = await pageId(page, 'Billing Service', 'ENG');
  await page.goto(`/p/${billing}`);
  await expect(page.locator('.properties')).toContainText('owned by');
  await expect(page.locator('.properties')).toContainText('Payments Team');
  await expect(page.locator('.properties')).toContainText('depends on');
  await expect(page.locator('.page-content .callout[data-callout="warning"]')).toContainText('Month-end freeze');
  await expect(page.locator('.page-content .status')).toHaveText('Healthy');
  await expect(page.locator('pre code.hljs, .page-content table')).toHaveCount(1);
  // toggle a task straight from the page view
  const task = page.locator('li[data-type="taskItem"]', { hasText: 'Document retry policy' }).locator('input.task-cb');
  await task.check();
  await expect.poll(async () => source(page, billing)).toContain('- [x] Document retry policy @carol');
  await task.uncheck();
  await expect.poll(async () => source(page, billing)).toContain('- [ ] Document retry policy @carol');
});

test('[F:ui-comments] comments, replies, inline comments, reactions and resolve', async ({ page, browser }) => {
  await login(page, 'bob');
  const id = await pageId(page, 'Auth Service', 'ENG');
  await page.goto(`/p/${id}`);
  await page.getByLabel('Add a comment').fill('Do we support **WebAuthn**?');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const first = page.locator('.comment').filter({ hasText: 'WebAuthn' });
  await expect(first.locator('.comment-body strong')).toHaveText('WebAuthn');
  await first.getByRole('button', { name: 'React 👍' }).click();
  await expect(first.getByRole('button', { name: 'React 👍' })).toHaveText('👍 1');
  // inline comment on selected text
  const p = page.locator('.page-content.rendered p').first();
  await p.evaluate((el) => {
    const r = document.createRange(); const text = el.firstChild;
    r.setStart(text, 0); r.setEnd(text, 'Issues OAuth tokens'.length);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByRole('button', { name: '💬 Comment' }).click();
  await expect(page.locator('.comment-form .quote-ref')).toContainText('Issues OAuth tokens');
  await page.getByLabel('Add a comment').fill('Which grant types?');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(page.locator('mark.inline-comment')).toHaveText('Issues OAuth tokens');
  // Alice replies and resolves in her own session; Bob sees it live
  const ctx = await browser.newContext();
  const other = await ctx.newPage();
  await login(other, 'alice');
  await other.goto(`/p/${id}`);
  const thread = other.locator('.comment').filter({ hasText: 'WebAuthn' }).first();
  await thread.getByRole('button', { name: 'Reply' }).click();
  await other.getByLabel('Reply').fill('Yes, since v2.');
  await thread.locator('.comment-form button.primary').click();
  await expect(other.locator('.replies')).toContainText('Yes, since v2.');
  await thread.getByRole('button', { name: 'Resolve' }).click();
  await expect(page.locator('.replies')).toContainText('Yes, since v2.');
  await expect(page.locator('.comment.resolved').first()).toBeVisible();
  await ctx.close();
});

test('[F:ui-history] history: compare versions and restore', async ({ page }) => {
  await login(page, 'alice');
  const title = uniq('History Demo');
  const r = await page.request.post('/api/v1/pages', { headers: { 'x-gitwiki-csrf': '1' }, data: { space: 'ENG', title, markdown: 'First draft of the text.' } });
  const id = (await r.json()).page.id;
  await page.goto(`/p/${id}/edit`);
  await page.locator('.ProseMirror').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Second version of the text.');
  await page.getByLabel('Change description').fill('Rewrite intro');
  await page.getByRole('button', { name: 'Update' }).click();
  await expect(page.locator('.page-content.rendered')).toContainText('Second version');
  await page.getByRole('link', { name: 'history', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Page history' })).toBeVisible();
  await expect(page.locator('table.history tbody tr')).toHaveCount(2);
  await page.getByLabel('Select version 1').check();
  await page.getByLabel('Select version 2').check();
  await page.getByRole('button', { name: 'Compare selected' }).click();
  await expect(page.locator('.diff del').first()).toContainText('First');
  await expect(page.locator('.diff del').first()).toBeVisible();
  await expect(page.locator('.diff ins').first()).toBeVisible();
  await page.locator('table.history tbody tr').nth(1).getByRole('button', { name: 'Restore' }).click();
  await expect(page.locator('#page-title')).toHaveText(title);
  await expect(page.locator('.page-content.rendered')).toContainText('First draft of the text.');
});

test('[F:ui-concurrent-edit] two people edit the same page at once; both changes survive, presence shown', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await login(a, 'alice');
  await login(b, 'bob');
  const title = uniq('Team Plan');
  const r = await a.request.post('/api/v1/pages', { headers: { 'x-gitwiki-csrf': '1' }, data: { space: 'ENG', title, markdown: 'Goals paragraph.\n\nRisks paragraph.\n' } });
  const id = (await r.json()).page.id;
  await a.goto(`/p/${id}/edit`);
  await b.goto(`/p/${id}/edit`);
  await expect(a.locator('.presence-note')).toContainText('Bob Martinez', { timeout: 20000 });
  await a.locator('.ProseMirror p', { hasText: 'Goals' }).click();
  await a.keyboard.press('End');
  await a.keyboard.type(' Ship v2 by Q4.');
  await b.locator('.ProseMirror p', { hasText: 'Risks' }).click();
  await b.keyboard.press('End');
  await b.keyboard.type(' Hiring is slow.');
  await a.getByRole('button', { name: 'Update' }).click();
  await expect(a.locator('.page-content.rendered')).toContainText('Ship v2 by Q4.');
  await expect(b.locator('.presence-note.warn')).toContainText('alice just published');
  await b.getByRole('button', { name: 'Update' }).click();
  await expect(b.getByText(/merged with changes made by others/)).toBeVisible();
  await expect(b.locator('.page-content.rendered')).toContainText('Ship v2 by Q4.');
  await expect(b.locator('.page-content.rendered')).toContainText('Hiring is slow.');
  await expect(b.locator('.page-content.rendered')).not.toContainText('<<<<');
});

test('[F:ui-share-status] share dialog, page status, aliases and unlinked mentions in the UI', async ({ page }) => {
  await login(page, 'alice');
  const id = await pageId(page, 'Ledger Service', 'ENG');
  await page.goto(`/p/${id}/edit`);
  await page.getByRole('button', { name: '⚙ Properties' }).click();
  await page.getByLabel('Page status').selectOption('Verified');
  await page.getByLabel('Also known as (aliases)').fill('General Ledger');
  await page.getByRole('button', { name: 'Update' }).click();
  await expect(page.locator('.page-status')).toHaveText('Verified');
  // a page that mentions the alias without linking shows up as an unlinked mention
  const r = await page.request.post('/api/v1/pages', { headers: { 'x-gitwiki-csrf': '1' }, data: { space: 'ENG', title: uniq('Audit Notes'), markdown: 'Auditors sampled the general ledger this week.' } });
  const src = (await r.json()).page;
  await page.reload();
  const card = page.locator('.rail-card', { hasText: 'Unlinked mentions' });
  await expect(card).toContainText(src.title);
  await card.getByRole('button', { name: 'Link' }).click();
  await expect(page.locator('.rail-card', { hasText: 'Linked from' })).toContainText(src.title);
  expect(await source(page, src.id)).toContain('[[Ledger Service|general ledger]]');
  // share with a colleague
  await page.getByRole('button', { name: '🔗 Share' }).click();
  await page.getByLabel('Notify people (usernames, comma separated)').fill('bob');
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(page.getByText('Shared with bob')).toBeVisible();
});
