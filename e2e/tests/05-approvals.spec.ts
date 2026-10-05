import { expect, test } from '@playwright/test';
import { alice, author, call, devstack, loginOperator, ok } from './support';

test('approving binds the decision to the action digest and task revision shown', async ({ page }) => {
  await loginOperator(page);
  const [first] = devstack().ids.approvalsPending as { taskId: string; approvalId: string }[];
  await page.goto('/ui/#/approvals');
  const row = page.locator(`[data-testid="approval-row"][data-approval-id="${first.approvalId}"]`);
  await expect(row).toBeVisible();
  const approval = await ok(call(alice(), 'GET', `/v1/approvals/${first.approvalId}`));
  await expect(row.getByTestId('approval-revision')).toHaveText(String(approval.taskRevision));
  await expect(row.getByTestId('approval-digest')).toHaveAttribute('title', approval.actionDigest);
  await row.getByTestId('approve').click();
  await expect(page.getByTestId('toast-ok')).toBeVisible();
  const task = await ok(call(alice(), 'GET', `/v1/tasks/${first.taskId}`));
  expect(task.state).toBe('queued');
  const decided = await ok(call(alice(), 'GET', `/v1/approvals/${first.approvalId}`));
  expect(decided.status).toBe('approved');
  expect(decided.approvedBy).toBe('human:alice');
});

test('a stale approval is refused when the task changed underneath it', async ({ page }) => {
  await loginOperator(page);
  const second = devstack().ids.approvalsPending[1] as { taskId: string; approvalId: string };
  await page.goto('/ui/#/approvals');
  const row = page.locator(`[data-testid="approval-row"][data-approval-id="${second.approvalId}"]`);
  await expect(row).toBeVisible();
  await ok(call(author(), 'POST', `/v1/tasks/${second.taskId}/cancel`, { reason: 'requester changed their mind' }));
  await row.getByTestId('approve').click();
  await expect(page.getByTestId('toast-error')).toContainText(/superseded|no longer applies|already/);
  const task = await ok(call(alice(), 'GET', `/v1/tasks/${second.taskId}`));
  expect(task.state).toBe('canceled');
});

test('denying an approval rejects the task', async ({ page }) => {
  await loginOperator(page);
  const third = devstack().ids.approvalsPending[2] as { taskId: string; approvalId: string };
  await page.goto('/ui/#/approvals');
  await page.locator(`[data-testid="approval-row"][data-approval-id="${third.approvalId}"]`).getByTestId('deny').click();
  await expect(page.getByTestId('toast-ok')).toContainText('denied');
  const task = await ok(call(alice(), 'GET', `/v1/tasks/${third.taskId}`));
  expect(task.state).toBe('rejected');
  expect(task.failure.code).toBe('approval_denied');
});
