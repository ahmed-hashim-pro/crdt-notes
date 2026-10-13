import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8790;

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // CHROME=1 uses an installed Google Chrome instead of Playwright's Chromium.
    ...(process.env.CHROME ? { channel: 'chrome' } : {}),
    viewport: { width: 760, height: 520 },
  },
  webServer: {
    command: 'node apps/relay/src/server.ts',
    cwd: '..',
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    env: { PORT: String(PORT), DATA: join(tmpdir(), `crdt-notes-e2e-${Date.now()}.jsonl`) },
  },
});
