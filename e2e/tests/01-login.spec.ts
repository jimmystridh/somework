import { expect, test } from '@playwright/test';
import { alice, call, loginAs, loginOperator, watchConsole } from './support';

test('unauthenticated visitors see only the login screen', async ({ page }) => {
  await page.goto('/ui/');
  await expect(page.getByTestId('login')).toBeVisible();
  await expect(page.getByTestId('login-button')).toBeVisible();
  await expect(page.getByTestId('whoami')).toHaveCount(0);
  const api = await page.request.get('/v1/admin/overview');
  expect(api.status()).toBe(401);
});

test('OIDC login through the identity provider maps to the operator principal', async ({ page }) => {
  const problems = watchConsole(page);
  await loginOperator(page);
  await expect(page).toHaveURL(/\/ui\/#?\/?/);
  await expect(page.getByTestId('whoami')).toContainText('human');
  await expect(page.getByTestId('whoami')).toContainText('admin');
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name === 'somework_session');
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe('Strict');
  expect(await page.evaluate(() => document.cookie)).not.toContain('somework_session');
  expect(problems).toEqual([]);
});

test('an authenticated identity that is not provisioned is rejected with a clear message', async ({ page }) => {
  await loginAs(page, 'mallory');
  await expect(page.getByTestId('login-error')).toContainText('not provisioned');
  const cookies = await page.context().cookies();
  expect(cookies.find((c) => c.name === 'somework_session')).toBeUndefined();
  await page.goto('/ui/');
  await expect(page.getByTestId('login')).toBeVisible();
});

test('mutating calls need the CSRF header that only the SPA knows', async ({ page }) => {
  await loginOperator(page);
  const forged = await page.request.post('/v1/admin/maintenance', { data: {} });
  expect(forged.status()).toBe(403);
  const csrf = (await (await page.request.get('/ui/session')).json()).csrf;
  const allowed = await page.request.post('/v1/admin/maintenance', { data: {}, headers: { 'x-somework-csrf': csrf } });
  expect(allowed.status()).toBe(200);
});

test('sign out ends the session', async ({ page }) => {
  await loginOperator(page);
  await page.getByTestId('logout').click();
  await expect(page.getByTestId('login')).toBeVisible();
  const res = await page.request.get('/v1/admin/overview');
  expect(res.status()).toBe(401);
});

test('an ordinary human gets a not-authorised state on operator views and no data', async ({ page }) => {
  await loginAs(page, 'bob');
  await expect(page.getByTestId('whoami')).toContainText('bob');
  await expect(page.getByTestId('forbidden')).toBeVisible();
  await page.goto('/ui/#/policy');
  await expect(page.getByTestId('forbidden')).toBeVisible();
  await expect(page.getByTestId('audit-table')).toHaveCount(0);
  const direct = await page.request.get('/v1/admin/audit');
  expect(direct.status()).toBe(403);
  void alice; void call;
});
