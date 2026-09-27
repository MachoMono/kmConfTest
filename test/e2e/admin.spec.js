import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { login, pageId, uniq } from './util.js';

test.beforeEach(async ({ page }) => { page.on('dialog', d => d.accept()); });

test('[F:ui-space-admin] create a space and manage its permissions', async ({ page }) => {
  await login(page, 'bob');
  await page.goto('/spaces');
  await page.getByRole('button', { name: '+ Create space' }).click();
  const name = uniq('Design');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Key').fill('DSN' + Math.floor(Math.random() * 1000));
  await page.getByRole('button', { name: 'Create space' }).last().click();
  await expect(page.locator('#page-title')).toHaveText(name);
  await page.getByRole('link', { name: '⚙ Space settings' }).click();
  await expect(page.getByRole('heading', { name: /Space settings/ })).toBeVisible();
  await page.getByRole('button', { name: '+ Add' }).click();
  const last = page.locator('table[aria-label="Space permissions"] tbody tr').last();
  await last.getByLabel('Principal type').selectOption('user');
  await last.getByLabel('Principal name').fill('carol');
  await last.getByLabel('Role').selectOption('editor');
  await page.getByRole('button', { name: 'Save permissions' }).click();
  await expect(page.getByText('Permissions saved')).toBeVisible();
});

test('[F:ui-drag-drop-tree] reorganise pages by dragging in the page tree', async ({ page }) => {
  await login(page, 'alice');
  const id = await pageId(page, 'Runbooks', 'ENG');
  await page.goto(`/p/${id}`);
  const tree = page.locator('.tree');
  const source = tree.locator('.tree-row', { hasText: 'Glossary: Idempotency' });
  const target = tree.locator('.tree-row', { hasText: 'Runbooks' });
  const glossary = await pageId(page, 'Glossary: Idempotency', 'ENG');
  await source.dragTo(target);
  await expect.poll(async () => (await (await page.request.get(`/api/v1/pages/${glossary}?track=0`)).json()).page.parent).toBe(id);
  await page.reload();
  await expect(page.locator('.page-rail .rail-card', { hasText: 'Child pages' })).toContainText('Glossary: Idempotency');
});

test('[F:ui-permissions] the interface adapts to permissions', async ({ page }) => {
  await login(page, 'dave');
  const id = await pageId(page, 'Billing Service', 'ENG');
  await page.goto(`/p/${id}`);
  await expect(page.locator('#page-title')).toHaveText('Billing Service');
  await expect(page.getByRole('link', { name: '✎ Edit' })).toHaveCount(0);
  await expect(page.getByLabel('Add a comment')).toHaveCount(0);
  await page.goto('/spaces');
  await expect(page.locator('.space-grid')).not.toContainText('Finance');
  await page.goto('/admin');
  await expect(page.getByText('The admin panel is for knowledge managers')).toBeVisible();
});

test('[F:ui-admin-panel] KM admin panel sections work', async ({ page }) => {
  await login(page, 'admin');
  await page.goto('/admin');
  await expect(page.getByText('Content health score')).toBeVisible();
  await page.getByRole('link', { name: '🩺 Content health' }).click();
  await expect(page.getByRole('tab', { name: /Review overdue/ })).toBeVisible();
  await expect(page.locator('table')).toContainText('Security Policy');
  await page.getByRole('tab', { name: /Ontology issues/ }).click();
  await expect(page.locator('table')).toContainText('Legacy Invoicing');
  await page.getByRole('link', { name: '🧬 Ontology' }).click();
  await expect(page.locator('table')).toContainText('System');
  await page.getByRole('tab', { name: 'Edit (YAML)' }).click();
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByText(/Valid —/)).toBeVisible();
  await page.getByRole('link', { name: '📈 Analytics' }).click();
  await expect(page.getByText('Page views per day')).toBeVisible();
  await page.getByRole('button', { name: 'Show table' }).click();
  await expect(page.locator('figure table')).toBeVisible();
  await page.getByRole('link', { name: '🏷 Tags' }).click();
  await expect(page.locator('tr', { hasText: '#oncall' }).getByRole('button', { name: 'Rename / merge' })).toBeVisible();
  await page.getByRole('link', { name: '👤 Users' }).click();
  await page.getByRole('button', { name: '+ Add user' }).click();
  await page.getByLabel('Username').fill('henry');
  await page.getByLabel('Name', { exact: true }).fill('Henry Ford');
  await page.getByLabel('Password').fill('password-henry');
  await page.getByRole('button', { name: 'Create user' }).click();
  await expect(page.locator('table')).toContainText('Henry Ford');
  await page.getByRole('link', { name: '⚙ Settings & flags' }).click();
  await page.getByLabel('Rollout for search.graph_boost').fill('50');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();
  await page.getByRole('link', { name: '🔁 Git & GitHub' }).click();
  await expect(page.getByText('Recent commits')).toBeVisible();
  await page.getByRole('link', { name: '📜 Audit log' }).click();
  await expect(page.locator('table')).toContainText('user.create');
  await page.getByRole('link', { name: '🔀 Merge review' }).click();
  await expect(page.getByRole('heading', { name: 'Merge review' })).toBeVisible();
  await page.getByRole('link', { name: '🔌 API & webhooks' }).click();
  await expect(page.getByText('MCP server')).toBeVisible();
  await page.getByRole('link', { name: '🛠 System' }).click();
  await page.getByRole('button', { name: 'Rebuild index' }).click();
  await expect(page.getByText(/Re-indexed \d+ pages/)).toBeVisible();
});

test('[F:ui-dark-mode] theme can be switched to dark', async ({ page }) => {
  await login(page, 'carol');
  await page.goto('/profile');
  await page.getByLabel('Theme').selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(15, 18, 24)');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByLabel('Theme').selectOption('auto');
});

test('[F:accessibility] no serious accessibility violations on key screens; keyboard skip link', async ({ page }) => {
  await login(page, 'alice');
  const id = await pageId(page, 'Billing Service', 'ENG');
  for (const url of ['/', `/p/${id}`, `/p/${id}/edit`, '/search?q=ledger', '/admin', '/tags', '/ask']) {
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(300);
    const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).disableRules(['color-contrast']).analyze();
    const bad = res.violations.filter(v => ['serious', 'critical'].includes(v.impact));
    expect(bad.map(v => `${url}: ${v.id} (${v.nodes.length}) ${v.nodes[0].target}`)).toEqual([]);
  }
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
});
