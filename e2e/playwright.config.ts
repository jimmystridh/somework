import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const port = process.env.DEVSTACK_PORT ?? '18080';
const idpPort = process.env.DEVSTACK_IDP_PORT ?? '18081';
export const credentialsFile = process.env.DEVSTACK_OUT ?? path.join(__dirname, 'test-results', 'devstack.json');

process.env.DEVSTACK_OUT = credentialsFile;
process.env.DEVSTACK_PORT = port;
process.env.DEVSTACK_IDP_PORT = idpPort;

// The seeded stack is stateful (approvals are decided, tasks reconciled), so tests run serially against one instance.
export default defineConfig({
  testDir: './tests',
  outputDir: './test-results/artifacts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'cargo run -q -p somework-testkit --bin devstack',
    cwd: root,
    url: `http://127.0.0.1:${port}/healthz`,
    timeout: 600_000,
    reuseExistingServer: process.env.SOMEWORK_E2E_REUSE === '1',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env as Record<string, string> },
  },
});
