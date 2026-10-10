import { expect, test } from '@playwright/test';
import { alice, author, call, loginOperator, ok, watchConsole } from './support';

test('overview figures match the API', async ({ page }) => {
  const problems = watchConsole(page);
  expect((await call(author(), 'PUT', '/v1/admin/policy', {})).status).toBe(403);
  await loginOperator(page);
  const o = await ok(call(alice(), 'GET', '/v1/admin/overview'));
  await expect(page.getByTestId('stat-agents-value')).toHaveText(String(o.agents));
  await expect(page.getByTestId('stat-runtimes-value')).toHaveText(String(o.onlineRuntimes));
  await expect(page.getByTestId('stat-denials-value')).toHaveText(String(o.denialsLast24h));
  await expect(page.getByTestId('stat-drafts-value')).toHaveText(String(o.draftCatalogEntries));
  expect(o.agents).toBeGreaterThanOrEqual(2);
  expect(o.denialsLast24h).toBeGreaterThanOrEqual(1);
  expect(problems).toEqual([]);
});
