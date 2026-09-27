import { expect } from '@playwright/test';

export const PW = { admin: 'admin-password-1', alice: 'password-alice', bob: 'password-bob', carol: 'password-carol', dave: 'password-dave' };

export async function login(page, user) {
  await page.goto('/login');
  await page.getByLabel('Username').fill(user);
  await page.getByLabel('Password').fill(PW[user]);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible();
}

/** Resolve a page id by title through the API (uses the page's cookies). */
export async function pageId(page, title, space = '') {
  const r = await page.request.get(`/api/v1/resolve?title=${encodeURIComponent(title)}&space=${space}`);
  return (await r.json()).page.id;
}

export async function source(page, id) {
  const r = await page.request.get(`/api/v1/pages/${id}/source`);
  return r.text();
}

export const uniq = (s) => `${s} ${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
