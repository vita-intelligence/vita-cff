import { defineConfig } from "@playwright/test";

/**
 * Playwright config for the NPD end-to-end regression suite.
 *
 * Assumes the Next dev server is already running on :3030 and the
 * Django dev server is on :8000 (the Next proxy at ``proxy.ts``
 * forwards ``/api/*`` requests to Django, so tests only ever hit the
 * Next origin).
 *
 * Auth is a fresh user seeded via ``manage.py`` (see the shell block
 * in the e2e commit — email + password below match).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  // Single worker so beforeAll's created formulation is shared across
  // the file — different workers would each seed their own row.
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3030",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
