import { test, expect } from '@playwright/test';
import { login, pageId, source, uniq } from './util.js';

test.describe('WYSIWYG editor', () => {
  test.beforeEach(async ({ page }) => { page.on('dialog', d => d.accept()); await login(page, 'alice'); });

  test('[F:ui-template-picker] [F:ui-editor-toolbar] [F:ui-slash-menu] [F:ui-link-autocomplete] [F:ui-tag-autocomplete] [F:ui-mention-autocomplete] write a rich page without Markdown', async ({ page }) => {
    const title = uniq('Rich Page');
    await page.goto('/new?space=ENG');
    await expect(page.getByRole('heading', { name: 'Start with a template' })).toBeVisible();
    await page.getByRole('button', { name: /Blank page/ }).click();
    await page.getByLabel('Page title').fill(title);
    const ed = page.locator('.ProseMirror');
    await ed.click();
    // toolbar: heading + bold + italic
    await page.getByLabel('Text style').selectOption('h2');
    await page.keyboard.type('Overview');
    await page.keyboard.press('Enter');
    await page.keyboard.type('This is ');
    await page.getByRole('button', { name: 'Bold (Ctrl+B)' }).click();
    await page.keyboard.type('important');
    await page.getByRole('button', { name: 'Bold (Ctrl+B)' }).click();
    await page.keyboard.type(' and ');
    await page.keyboard.press('Control+i');
    await page.keyboard.type('subtle');
    await page.keyboard.press('Control+i');
    await page.keyboard.type('. Depends on ');
    // [[ page link autocomplete
    await page.keyboard.type('[[Ledg');
    await expect(page.locator('.suggest-popup .suggest-item').first()).toContainText('Ledger Service');
    await page.keyboard.press('Enter');
    await expect(ed.locator('a.wikilink', { hasText: 'Ledger Service' })).toBeVisible();
    // # tag autocomplete
    await page.keyboard.type('#paym');
    await expect(page.locator('.suggest-popup')).toContainText('payments');
    await page.keyboard.press('Enter');
    // @ mention autocomplete
    await page.keyboard.type('cc @bo');
    await expect(page.locator('.suggest-popup')).toContainText('Bob Martinez');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    // slash menu: warning panel
    await page.keyboard.type('/warn');
    await expect(page.locator('.suggest-popup')).toContainText('Warning panel');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Careful with month-end.');
    await expect(ed.locator('.callout[data-callout="warning"]')).toBeVisible();
    // leave the panel: click the empty line below it, then a task list via the toolbar
    await ed.locator(':scope > p').last().click();
    await page.getByRole('button', { name: 'Task list' }).click();
    await page.keyboard.type('Write tests @car');
    await expect(page.locator('.suggest-popup')).toContainText('Carol Singh');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    // slash menu: table + table of contents macro
    await page.keyboard.type('/toc');
    await page.keyboard.press('Enter');
    await expect(ed.locator('.macro-chip')).toContainText('Table of contents');
    await page.keyboard.type('/Table');
    await page.locator('.suggest-item', { hasText: /^▦Table/ }).click();
    await page.keyboard.type('Col A');
    await page.keyboard.press('Tab');
    await page.keyboard.type('Col B');
    await expect(page.locator('.table-tools')).toBeVisible();
    await page.getByRole('button', { name: 'Publish' }).click();
    await expect(page.locator('#page-title')).toHaveText(title);
    // rendered view
    const content = page.locator('.page-content.rendered');
    await expect(content.locator('h2#overview')).toHaveText(/Overview/);
    await expect(content.locator('strong')).toHaveText('important');
    await expect(content.locator('a.wikilink', { hasText: 'Ledger Service' })).toHaveAttribute('href', /^\/p\//);
    await expect(content.locator('.callout[data-callout="warning"]')).toContainText('Careful with month-end.');
    await expect(content.locator('nav.toc')).toContainText('Overview');
    await expect(content.locator('table th').first()).toHaveText('Col A');
    // stored Markdown is clean and Obsidian compatible
    const md = await source(page, await pageId(page, title, 'ENG'));
    expect(md).toContain('## Overview');
    expect(md).toContain('This is **important** and _subtle_. Depends on [[Ledger Service]] #payments cc @bob');
    expect(md).toContain('> [!warning]\n> Careful with month-end.');
    expect(md).toContain('- [ ] Write tests @carol');
    expect(md).toContain('```toc\n```');
    expect(md).toMatch(/\| Col A \| Col B \|/);
    expect(md).toMatch(/tags:\n {2}- payments|#payments/);
  });

  test('[F:ui-markdown-source-toggle] optional Markdown source mode round-trips with the visual editor', async ({ page }) => {
    const id = await pageId(page, 'Glossary: Idempotency', 'ENG');
    await page.goto(`/p/${id}/edit`);
    await expect(page.locator('.ProseMirror')).toContainText('idempotent');
    await page.getByRole('button', { name: 'Edit as Markdown (optional)' }).click();
    const src = page.getByLabel('Markdown source');
    await expect(src).toHaveValue(/\*\*idempotent\*\*/);
    await expect(src).toHaveValue(/\[\[Billing Service\]\]/);
    await src.fill((await src.inputValue()) + '\nSee also {{status:blue|REVIEWED}} and #glossary/terms.\n');
    await page.getByRole('button', { name: 'Edit as Markdown (optional)' }).click();
    await expect(page.locator('.ProseMirror .status')).toHaveText('REVIEWED');
    await page.getByRole('button', { name: 'Update' }).click();
    await expect(page.locator('.page-content.rendered .status[data-color="blue"]')).toHaveText('REVIEWED');
    const md = await source(page, id);
    expect(md).toContain('{{status:blue|REVIEWED}} and #glossary/terms.');
    expect(md).toContain('**idempotent**');
  });

  test('[F:drafts-autosave] unpublished edits autosave and are restored after a reload', async ({ page }) => {
    const id = await pageId(page, 'Travel Policy', 'HR');
    await page.goto(`/p/${id}/edit`);
    const ed = page.locator('.ProseMirror');
    await ed.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' Rail is preferred for trips under 4 hours.');
    await expect(page.getByText(/Draft saved/)).toBeVisible({ timeout: 8000 });
    await page.reload();
    await expect(page.getByText(/Restored your unsaved draft/)).toBeVisible();
    await expect(page.locator('.ProseMirror')).toContainText('Rail is preferred');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('#page-title')).toHaveText('Travel Policy');
    await expect(page.locator('.page-content.rendered')).not.toContainText('Rail is preferred');
  });
});
