import { expect, test } from '@playwright/test';
import { loginOperator } from './support';

test('policy decisions list denials with the reasons that caused them', async ({ page }) => {
  await loginOperator(page);
  await page.goto('/ui/#/policy');
  await expect(page.getByTestId('decision-row').first()).toBeVisible();
  await page.getByTestId('decision-filter').selectOption('deny');
  const rows = page.locator('[data-testid="decision-row"]');
  await expect(rows.first()).toHaveAttribute('data-decision', 'deny');
  for (const r of await rows.all()) await expect(r).toHaveAttribute('data-decision', 'deny');
  await expect(rows.first()).toContainText('agent:agent/intruder');
  await expect(rows.first()).toContainText('not granted');
  await page.getByTestId('actor-filter').fill('nobody-at-all');
  await expect(page.getByTestId('empty')).toBeVisible();
});

test('the audit trail verifies its hash chain on demand', async ({ page }) => {
  await loginOperator(page);
  await page.goto('/ui/#/policy/audit');
  await expect(page.getByTestId('audit-row').first()).toBeVisible();
  await page.getByTestId('verify-chain').click();
  await expect(page.getByTestId('chain-verdict').locator('[data-intact="true"]')).toBeVisible();
  await page.getByTestId('tab-policy').click();
  await expect(page.getByTestId('policy-json')).toContainText('classificationLevels');
});

test('outbox and health, runtimes and agents views render live data', async ({ page }) => {
  await loginOperator(page);
  await page.goto('/ui/#/outbox');
  await expect(page.getByTestId('health')).toContainText('database ok');
  await expect(page.getByTestId('metrics-link')).toHaveAttribute('href', '/metrics');
  await page.goto('/ui/#/runtimes');
  await expect(page.getByTestId('agent-row').filter({ hasText: 'agent/reviewer' })).toBeVisible();
  await expect(page.getByTestId('runtime-row')).toHaveCount(3);
  const metrics = await page.request.get('/metrics');
  expect(await metrics.text()).toContain('somework_tasks_submitted_total');
});

test('audit records expose trace ids that can be copied', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await loginOperator(page);
  await page.goto('/ui/#/policy/audit');
  const copy = page.getByTestId('audit-row').first().getByTestId('copy');
  await copy.click();
  await expect(copy).toHaveText('copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^[0-9a-f]{32}$/);
});
