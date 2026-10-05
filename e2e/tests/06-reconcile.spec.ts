import { expect, test } from '@playwright/test';
import { alice, call, devstack, loginOperator, ok } from './support';

const resolve = async (page: any, id: string, resolution: string, result?: string) => {
  await page.goto(`/ui/#/tasks/${id}`);
  await expect(page.getByTestId('blocker')).toContainText('reconciliation');
  await page.getByTestId('reconcile-resolution').selectOption(resolution);
  await page.getByTestId('reconcile-note').fill(`resolved as ${resolution} in e2e`);
  if (result) await page.getByTestId('reconcile-result').fill(result);
  await page.getByTestId('reconcile-submit').click();
};

test('the reconciliation queue is visible and a task can be re-queued by an operator', async ({ page }) => {
  await loginOperator(page);
  const [retry] = devstack().ids.reconciliation as string[];
  const before = await ok(call(alice(), 'GET', '/v1/admin/overview'));
  await resolve(page, retry, 'retry');
  await expect(page.getByTestId('state-chip').first()).toHaveText('queued', { timeout: 8000 });
  const after = await ok(call(alice(), 'GET', '/v1/admin/overview'));
  expect(after.reconciliationQueue).toBe(before.reconciliationQueue - 1);
  const task = await ok(call(alice(), 'GET', `/v1/tasks/${retry}`));
  expect(task.attempt).toBe(2);
});

test('an operator can resolve an interrupted task as failed', async ({ page }) => {
  await loginOperator(page);
  const id = devstack().ids.reconciliation[1];
  await resolve(page, id, 'failed');
  await expect(page.getByTestId('state-chip').first()).toHaveText('failed', { timeout: 8000 });
  await expect(page.getByTestId('failure')).toContainText('reconciled_failed');
});

test('an operator can resolve an interrupted task as succeeded with a validated result', async ({ page }) => {
  await loginOperator(page);
  const id = devstack().ids.reconciliation[2];
  await resolve(page, id, 'succeeded', '{"verdict": "approve"}');
  await expect(page.getByTestId('state-chip').first()).toHaveText('succeeded', { timeout: 8000 });
  await expect(page.getByTestId('result-json')).toContainText('approve');
});
