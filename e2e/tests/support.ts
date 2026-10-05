import { expect, type Page } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface KeyInfo { kind: string; id: string; privateKey: string; runtimeInstanceId?: string | null }
export interface Devstack {
  url: string; idpUrl: string; domainId: string;
  admin: KeyInfo; humans: Record<string, KeyInfo>; agents: Record<string, KeyInfo>;
  ids: Record<string, any>;
}

const outFile = process.env.DEVSTACK_OUT ?? path.join(__dirname, '..', 'test-results', 'devstack.json');
let cached: Devstack | undefined;

export function devstack(): Devstack {
  cached ??= JSON.parse(fs.readFileSync(outFile, 'utf8'));
  return cached!;
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function assertion(k: KeyInfo, domainId = devstack().domainId): string {
  const key = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(k.privateKey, 'base64url')]), format: 'der', type: 'pkcs8' });
  const iss = `${k.kind}:${k.id}`;
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = { iss, sub: iss, aud: [`somework:${domainId}`], iat: now, exp: now + 120, jti: crypto.randomBytes(16).toString('hex') };
  if (k.runtimeInstanceId) claims.runtimeInstanceId = k.runtimeInstanceId;
  const head = b64u(JSON.stringify({ alg: 'EdDSA', typ: 'somework+assertion', kid: iss }));
  const body = b64u(JSON.stringify(claims));
  return `${head}.${body}.${b64u(crypto.sign(null, Buffer.from(`${head}.${body}`), key))}`;
}

export async function call(k: KeyInfo, method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${devstack().url}${p}`, {
    method,
    headers: { authorization: `Bearer ${assertion(k)}`, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { status: res.status, body: json };
}

export const alice = () => devstack().humans.alice;
export const author = () => devstack().agents.author;
export const reviewer = () => devstack().agents.reviewer;

export async function ok(r: Promise<{ status: number; body: any }>) {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body;
}

/** Signs in through the mock IdP as `user` (the full authorization-code + PKCE flow). */
export async function loginAs(page: Page, user: string) {
  await page.goto('/ui/');
  await page.getByTestId('login-button').click();
  await page.getByTestId(`idp-user-${user}`).click();
}

export async function loginOperator(page: Page) {
  await loginAs(page, 'alice');
  await expect(page.getByTestId('whoami')).toContainText('alice');
}

/** Collects console errors and uncaught exceptions for the lifetime of the page. */
export function watchConsole(page: Page) {
  const problems: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}
