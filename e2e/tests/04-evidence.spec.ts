import { expect, test } from '@playwright/test';
import { alice, call, devstack, loginOperator, ok } from './support';

test('what participants said is visibly separate from the platform record', async ({ page }) => {
  await loginOperator(page);
  await page.goto(`/ui/#/conversations/${devstack().ids.conversation}`);
  const claim = page.locator('[data-testid="message-card"][data-kind="claim"]', { hasText: 'I ran the tests and everything passed.' });
  await expect(claim).toBeVisible();
  await expect(claim.getByTestId('message-stamp')).toHaveText('reported by participant');
  await expect(claim.getByTestId('type-badge')).toHaveText('chat.message');
  await expect(claim.getByTestId('trigger-mode')).toContainText('directed');
  await expect(claim.getByTestId('attachment')).toHaveAttribute('data-artifact-id', devstack().ids.artifactId);
  await expect(claim.getByTestId('attachment')).toContainText('review-notes.txt');

  const notice = page.locator('[data-testid="message-card"][data-type="chat.notice"]');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveClass(/notice/);
  await expect(notice.getByTestId('message-stamp')).toHaveText('automated notice');
  await expect(notice.getByTestId('trigger-mode')).toContainText('never');

  const record = page.getByTestId('execution-record');
  await expect(record).toBeVisible();
  await expect(record.locator('.stamp').first()).toHaveText('platform record');
  await expect(record.getByTestId('execution-event').first()).toBeVisible();
  await expect(record).not.toContainText('I ran the tests');
  const timeline = page.getByTestId('conversation-timeline');
  await expect(timeline.getByTestId('execution-event')).toHaveCount(0);
  await expect(page.getByTestId('matrix-link').first()).toHaveAttribute('href', /matrix\.to\/#\/!devroom/);
});

test('the canonical viewer shows the exact stored envelope and its digests', async ({ page }) => {
  await loginOperator(page);
  await page.goto(`/ui/#/conversations/${devstack().ids.conversation}`);
  const claim = page.locator('[data-testid="message-card"][data-kind="claim"]', { hasText: 'I ran the tests' });
  const messageId = await claim.getAttribute('data-message-id');
  await claim.getByTestId('message-canonical').click();
  await expect(page.getByTestId('envelope-id')).toHaveText(messageId!);
  await expect(page.getByTestId('envelope-type')).toHaveText('chat.message');

  const shown = JSON.parse(await page.getByTestId('envelope-json').innerText());
  const stored = await ok(call(alice(), 'GET', `/v1/messages/${messageId}`));
  const { seq, traceId, ...envelope } = stored;
  expect(shown).toEqual(envelope);
  expect(shown.schemaVersion).toBe('1.0');
  expect(shown.sender.id).toBe('agent/reviewer');

  const audit = await ok(call(alice(), 'GET', '/v1/admin/audit?limit=1000'));
  const record = audit.events.find((e: any) => e.resource === `message://${messageId}`);
  expect(record).toBeTruthy();
  await expect(page.getByTestId('digest-content')).toHaveText(record.detail.contentDigest);
  await expect(page.getByTestId('digest-envelope')).toHaveText(/^[0-9a-f]{64}$/);
});
