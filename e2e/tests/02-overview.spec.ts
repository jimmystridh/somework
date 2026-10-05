import { expect, test } from '@playwright/test';
import { alice, call, loginOperator, ok, watchConsole } from './support';

test('overview figures match the API', async ({ page }) => {
  const problems = watchConsole(page);
  await loginOperator(page);
  const o = await ok(call(alice(), 'GET', '/v1/admin/overview'));
  const total = Object.values(o.tasksByState as Record<string, number>).reduce((a, b) => a + b, 0);
  await expect(page.getByTestId('stat-total-value')).toHaveText(String(total));
  await expect(page.getByTestId('stat-approvals-value')).toHaveText(String(o.pendingApprovals));
  await expect(page.getByTestId('stat-reconciliation-value')).toHaveText(String(o.reconciliationQueue));
  await expect(page.getByTestId('stat-runtimes-value')).toHaveText(String(o.onlineRuntimes));
  await expect(page.getByTestId('stat-denials-value')).toHaveText(String(o.denialsLast24h));
  expect(o.denialsLast24h).toBeGreaterThanOrEqual(1);
  expect(o.reconciliationQueue).toBeGreaterThanOrEqual(3);
  for (const [state, n] of Object.entries(o.tasksByState)) {
    await expect(page.getByTestId(`state-count-${state}`)).toHaveText(`${state} ${n}`);
  }
  await expect(page.getByTestId('approvals-count')).toHaveText(String(o.pendingApprovals));
  expect(problems).toEqual([]);
});
