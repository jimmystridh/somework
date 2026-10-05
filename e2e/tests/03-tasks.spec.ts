import { expect, test } from '@playwright/test';
import { alice, author, call, devstack, loginOperator, ok, reviewer } from './support';

const cap = { id: 'code.review', version: '2.1' };
const input = { repository: 'billing/import-service', commit: '61a8d52' };

test('task list filters by state and links to details', async ({ page }) => {
  await loginOperator(page);
  await page.goto('/ui/#/tasks');
  await expect(page.getByTestId('task-row').first()).toBeVisible();
  await page.getByTestId('filter-state').selectOption('failed');
  const rows = page.getByTestId('task-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('data-state', 'failed');
  await page.getByTestId('filter-text').fill('nonexistent-agent');
  await expect(page.getByTestId('empty')).toBeVisible();
  await page.getByTestId('filter-text').fill('');
  await rows.first().getByTestId('task-link').click();
  await expect(page.getByTestId('failure')).toContainText('checkout_failed');
});

test('a running task shows lease, fencing token and effective authority', async ({ page }) => {
  await loginOperator(page);
  await page.goto(`/ui/#/tasks/${devstack().ids.running}`);
  await expect(page.getByTestId('lease')).toContainText('fence 1');
  await expect(page.getByTestId('view-tasks')).toContainText('Side effects at most');
  await expect(page.getByTestId('view-tasks')).toContainText('read');
});

test('the lifecycle of a task is watched live while a worker progresses', async ({ page }) => {
  await loginOperator(page);
  const task = await ok(call(author(), 'POST', '/v1/tasks', { capability: cap, input, targetAgentId: 'agent/reviewer' }));
  await page.goto(`/ui/#/tasks/${task.taskId}`);
  await expect(page.getByTestId('state-chip').first()).toHaveText('queued');
  await expect(page.getByTestId('lifecycle-event')).toHaveCount(2);

  const claim = await ok(call(reviewer(), 'POST', `/v1/tasks/${task.taskId}/claim`, { leaseSeconds: 600 }));
  await expect(page.getByTestId('state-chip').first()).toHaveText('claimed', { timeout: 8000 });
  await ok(call(reviewer(), 'POST', `/v1/tasks/${task.taskId}/progress`, { fencingToken: claim.fencingToken, message: 'halfway' }));
  await expect(page.getByTestId('state-chip').first()).toHaveText('running', { timeout: 8000 });
  await expect(page.getByTestId('lease')).toContainText(`fence ${claim.fencingToken}`);
  await ok(call(reviewer(), 'POST', `/v1/tasks/${task.taskId}/complete`, { fencingToken: claim.fencingToken, result: { verdict: 'reject' } }));
  await expect(page.getByTestId('state-chip').first()).toHaveText('succeeded', { timeout: 8000 });
  await expect(page.getByTestId('result-json')).toContainText('reject');
  await expect(page.getByTestId('lifecycle-event')).toHaveCount(5);
  await expect(page.getByTestId('lifecycle-event').last()).toHaveAttribute('data-type', 'task.succeeded');
});

test('the delegation lineage renders as a DAG', async ({ page }) => {
  await loginOperator(page);
  await page.goto(`/ui/#/tasks/${devstack().ids.delegationRoot}`);
  await page.getByTestId('tab-dag').click();
  const nodes = page.getByTestId('dag-node');
  await expect(nodes).toHaveCount(3);
  await expect(page.locator('[data-testid="dag-node"][data-state="succeeded"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="dag-node"][data-state="queued"]')).toHaveCount(1);
  const child = devstack().ids.delegationChildren[0];
  await page.locator(`[data-testid="dag-node"][data-task-id="${child}"]`).click();
  await expect(page.getByTestId('task-id')).toHaveText(child);
});

test('an operator can cancel a queued task from the console', async ({ page }) => {
  await loginOperator(page);
  const id = devstack().ids.queued;
  await page.goto(`/ui/#/tasks/${id}`);
  await page.getByTestId('cancel-task').click();
  await expect(page.getByTestId('state-chip').first()).toHaveText('canceled', { timeout: 8000 });
  const t = await ok(call(alice(), 'GET', `/v1/tasks/${id}`));
  expect(t.state).toBe('canceled');
});
