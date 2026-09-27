import { test, expect } from '@playwright/test';
import { login, pageId } from './util.js';

test.beforeEach(async ({ page }) => { page.on('dialog', d => d.accept()); await login(page, 'bob'); });

test('[F:ui-search] quick search (Ctrl+K) and the search page with filters', async ({ page }) => {
  await page.keyboard.press('Control+k');
  const qs = page.getByRole('textbox', { name: 'Quick search' });
  await qs.fill('reconciliation');
  await expect(page.locator('.qs-results li').first()).toContainText('Ledger Service');
  await qs.press('Enter');
  await expect(page.locator('#page-title')).toHaveText('Ledger Service');
  await page.goto('/search?q=' + encodeURIComponent('runbook'));
  await expect(page.getByRole('status')).toContainText('result');
  await page.getByLabel('Filter by type').selectOption('Process');
  await expect(page).toHaveURL(/type%3AProcess/);
  await expect(page.locator('.results li')).toHaveCount(2);
  await expect(page.locator('.results')).toContainText('Database Failover Runbook');
  await page.goto('/search?q=replica');
  await expect(page.locator('.results .snippet mark').first()).toHaveText(/replica/i);
});

test('[F:ui-graph-view] knowledge graph renders, filters and offers an accessible list', async ({ page }) => {
  await page.goto('/graph');
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByText(/\d+ pages · \d+ connections/)).toBeVisible();
  await expect(page.locator('.clusters li').first()).toBeVisible();
  const box = await page.locator('canvas').boundingBox();
  expect(box.width).toBeGreaterThan(400);
  await page.getByRole('button', { name: 'Show as list' }).click();
  await expect(page.locator('.graph-canvas table')).toContainText('Billing Service');
  const id = await pageId(page, 'Ledger Service', 'ENG');
  await page.goto(`/graph?page=${id}`);
  await expect(page.getByRole('heading', { name: 'Local graph' })).toBeVisible();
  await page.getByRole('button', { name: 'Show as list' }).click();
  await expect(page.locator('.graph-canvas table')).toContainText('Postgres Cluster');
});

test('[F:ui-ask] Ask: GraphRAG answers with sources, entities and relations', async ({ page }) => {
  await page.goto('/ask');
  await page.getByLabel('Question').fill('What does the billing service depend on?');
  await page.getByRole('button', { name: 'Ask' }).click();
  await expect(page.locator('.sources li').first()).toBeVisible();
  await expect(page.locator('.sources')).toContainText('Billing Service');
  await expect(page.locator('.relations')).toContainText('depends_on');
  await expect(page.locator('.relations')).toContainText('Ledger Service');
  await expect(page.locator('.entities')).toContainText('in question');
  await page.getByText('Use this from other systems').click();
  await expect(page.getByText(/\/mcp/).first()).toBeVisible();
});

test('[F:tag-index] tags: hierarchy and tag page', async ({ page }) => {
  await page.goto('/tags');
  await expect(page.locator('.tag-tree')).toContainText('#team');
  await page.getByRole('link', { name: '#runbook' }).first().click();
  await expect(page.getByRole('heading', { name: '#runbook' })).toBeVisible();
  await expect(page.locator('table')).toContainText('Database Failover Runbook');
});
