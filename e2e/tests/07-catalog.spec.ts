import crypto from 'node:crypto';
import { expect, test } from '@playwright/test';
import { alice, call, loginOperator, ok, type KeyInfo } from './support';

function newKey(id: string): { info: KeyInfo; publicKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64url');
  return { info: { kind: 'agent', id, privateKey: priv }, publicKey: pub };
}

test('a self-registered agent starts as a draft and an operator approves it with exports', async ({ page }) => {
  await loginOperator(page);
  const id = 'agent/newbie';
  const { info, publicKey } = newKey(id);
  await ok(call(alice(), 'POST', '/v1/admin/principals', { kind: 'agent', id, publicKey }));
  await ok(call(info, 'PUT', `/v1/agents/${encodeURIComponent(id)}`, {
    card: {
      schemaVersion: '1.0', agentId: id, domainId: 'development', displayName: 'Newbie', description: 'Summarises release notes',
      owner: { team: 'docs' }, interfaces: [{ protocol: 'somework' }],
      capabilities: [{ id: 'notes.summarise', version: '1.0', name: 'Summarise', description: 'Summarise release notes', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, sideEffects: 'none' }],
    },
  }));

  await page.goto('/ui/#/catalog');
  const entry = page.locator(`[data-testid="catalog-entry"][data-agent-id="${id}"]`);
  await expect(entry).toHaveAttribute('data-approval', 'draft');
  await expect(page.getByTestId('view-overview')).toHaveCount(0);

  await entry.getByTestId('visibility-select').selectOption('exported');
  await entry.getByTestId('trust-select').selectOption('partner');
  await entry.getByTestId('exports-input').fill('notes.summarise');
  await entry.getByTestId('approve-entry').click();
  await expect(entry).toHaveAttribute('data-approval', 'approved');

  const stored = await ok(call(alice(), 'GET', `/v1/agents/${encodeURIComponent(id)}`));
  expect(stored.approval.status).toBe('approved');
  expect(stored.visibility).toBe('exported');
  expect(stored.trustTier).toBe('partner');
  expect(stored.exportedCapabilities).toEqual(['notes.summarise']);
  await entry.getByTestId('suspend-entry').click();
  await expect(entry).toHaveAttribute('data-approval', 'suspended');
});

test('the overview counts drafts until they are approved', async ({ page }) => {
  await loginOperator(page);
  const o = await ok(call(alice(), 'GET', '/v1/admin/overview'));
  await expect(page.getByTestId('stat-drafts-value')).toHaveText(String(o.draftCatalogEntries));
});
