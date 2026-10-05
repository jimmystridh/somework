import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { devstack, loginOperator, watchConsole } from './support';

test('no console errors across every operator view', async ({ page }) => {
  const problems = watchConsole(page);
  await loginOperator(page);
  const ids = devstack().ids;
  const routes = [
    '#/overview', '#/tasks', `#/tasks/${ids.succeeded}`, `#/tasks/${ids.delegationRoot}`, '#/conversations', `#/conversations/${ids.conversation}`,
    `#/conversations/${ids.room}`, '#/approvals', '#/catalog', '#/policy', '#/policy/audit', '#/contexts', '#/outbox', '#/runtimes',
  ];
  for (const r of routes) {
    await page.goto(`/ui/${r}`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('view-error')).toHaveCount(0);
  }
  expect(problems).toEqual([]);
});

test('keyboard users can reach the content and navigate', async ({ page }) => {
  await loginOperator(page);
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#main$/);
  await page.goto('/ui/#/overview');
  const tasksLink = page.getByTestId('nav-tasks');
  await tasksLink.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/tasks$/);
  await expect(page.getByTestId('nav-tasks')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await expect(page.getByRole('main')).toBeVisible();
});

test('theme toggle switches and persists', async ({ page }) => {
  await loginOperator(page);
  const root = page.locator('html');
  const before = await root.getAttribute('data-theme');
  await page.getByTestId('theme-toggle').click();
  const after = await root.getAttribute('data-theme');
  expect(after).not.toBe(before);
  await page.reload();
  await expect(root).toHaveAttribute('data-theme', after!);
});

test('layout holds on a phone-sized viewport', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginOperator(page);
  const ids = devstack().ids;
  for (const route of ['#/overview', '#/tasks', `#/tasks/${ids.succeeded}`, '#/approvals', `#/conversations/${ids.conversation}`]) {
    await page.goto(`/ui/${route}`);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${route} overflows horizontally by ${overflow}px`).toBeLessThanOrEqual(1);
  }
  const shot = info.outputPath('mobile-conversation.png');
  fs.mkdirSync(info.outputDir, { recursive: true });
  await page.screenshot({ path: shot, fullPage: true });
  await info.attach('mobile-conversation', { path: shot, contentType: 'image/png' });
});
