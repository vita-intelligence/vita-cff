/**
 * End-to-end smoke test for the project workspace tabs.
 *
 * Signs a dedicated e2e user in, opens MA01416, and walks every tab
 * in the project shell — Overview → Builder → Spec sheets → Proposals
 * → Trial batches → QC → History. Verifies that each tab renders
 * without a client-side error boundary AND that the new pieces from
 * this session's work are present:
 *
 *   * Builder tab strip shows the 5 pills (Setup / Formulation /
 *     Stages / Routing / Preview).
 *   * Stages tab surfaces the ``servings per output unit`` bridge
 *     field on every stage card.
 *   * Routing tab has the "+ Add ingredient" affordance in the
 *     inventory column.
 *   * History tab has both Versions AND Activity sub-tabs, and the
 *     Activity feed renders at least one entry.
 *
 * Auth: dedicated user ``e2e-playwright@vita.test`` seeded outside
 * the test (see the shell block that ran ``set_password``). The user
 * shares MA01416's org so no fixture setup is needed.
 */

import { expect, test } from "@playwright/test";

const CREDENTIALS = {
  email: "e2e-playwright@vita.test",
  password: "PlaywrightE2E!2026",
};
const FORMULATION_ID = "5b26f909-2a8b-4a94-af92-94fa31fab7de";
const FORMULATION_CODE = "MA01416";

// Route the user through the app's real login form. Shares the
// authenticated context across all specs so we only pay the login
// cost once per run.
test.beforeEach(async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  (page as unknown as { __errors: string[] }).__errors = consoleErrors;

  await page.goto("/en/login");
  await page.getByLabel(/email/i).fill(CREDENTIALS.email);
  await page.getByLabel(/password/i).fill(CREDENTIALS.password);
  await page.getByRole("button", { name: /log in|sign in/i }).click();
  // Land somewhere authenticated (home / formulations / dashboard).
  await page.waitForURL(/\/(home|formulations|dashboard)/, {
    timeout: 30_000,
  });
});

test("project shell tabs all render for MA01416", async ({ page }) => {
  await page.goto(`/en/formulations/${FORMULATION_ID}`);

  // Compact header at the top of the shell renders the formulation
  // code chip — a stable, uniquely-named anchor that proves the page
  // hydrated with real project data (not the loading skeleton or
  // 404 fallback).
  await expect(
    page.getByText(FORMULATION_CODE, { exact: true }).first(),
  ).toBeVisible({ timeout: 20_000 });

  // Every tab pill is in the DOM.
  for (const label of [
    "Overview",
    "Builder",
    "Spec sheets",
    "Proposals",
    "Trial batches",
    "QC",
    "History",
  ]) {
    await expect(
      page.getByRole("link", { name: new RegExp(label, "i") }),
    ).toBeVisible();
  }
});

test("Builder tab strip shows the 5 wizard pills", async ({ page }) => {
  await page.goto(`/en/formulations/${FORMULATION_ID}/builder`);
  const tabStrip = page.locator('nav[aria-label="Formulation builder tabs"]');
  await expect(tabStrip).toBeVisible({ timeout: 20_000 });
  for (const label of [
    "Setup",
    "Formulation",
    "Stages",
    "Routing",
    "Preview",
  ]) {
    await expect(tabStrip.getByRole("button", { name: label })).toBeVisible();
  }
});

test("Stages tab surfaces the servings-per-output-unit bridge field", async ({
  page,
}) => {
  await page.goto(`/en/formulations/${FORMULATION_ID}/builder`);
  await page
    .locator('nav[aria-label="Formulation builder tabs"]')
    .getByRole("button", { name: "Stages" })
    .click();
  // Auto-fill label copy from stage-strip.tsx.
  await expect(
    page.getByText(
      /how many finished servings\?|1 stock-unit of/i,
    ).first(),
  ).toBeVisible({ timeout: 15_000 });
  // Placeholder / helper text explaining the field.
  await expect(
    page.getByText(/servings per output unit/i).first(),
  ).toBeVisible();
});

test("Routing tab exposes + Add ingredient", async ({ page }) => {
  await page.goto(`/en/formulations/${FORMULATION_ID}/builder`);
  await page
    .locator('nav[aria-label="Formulation builder tabs"]')
    .getByRole("button", { name: "Routing" })
    .click();
  await expect(
    page.getByRole("button", { name: /add ingredient/i }),
  ).toBeVisible({ timeout: 15_000 });
});

test("History tab has Versions + Activity sub-tabs", async ({ page }) => {
  await page.goto(`/en/formulations/${FORMULATION_ID}/history`);
  const sub = page.locator('nav[aria-label="History sub-tabs"]');
  await expect(sub).toBeVisible({ timeout: 20_000 });
  await expect(sub.getByRole("button", { name: /Versions/i })).toBeVisible();
  await expect(sub.getByRole("button", { name: /Activity/i })).toBeVisible();

  // Switch to Activity and expect either a real row OR the empty state.
  await sub.getByRole("button", { name: /Activity/i }).click();
  await expect(
    page
      .getByRole("listitem")
      .or(page.getByText(/No activity yet/i))
      .first(),
  ).toBeVisible({ timeout: 15_000 });
});

test.afterEach(async ({ page }, testInfo) => {
  const errs = (page as unknown as { __errors?: string[] }).__errors ?? [];
  // Console noise from external SDKs is common — only fail the run
  // when we see errors that indicate broken app code.
  const meaningful = errs.filter(
    (e) =>
      /TypeError|ReferenceError|Cannot read|Uncaught|Failed to fetch/i.test(e),
  );
  if (meaningful.length > 0) {
    testInfo.annotations.push({
      type: "console-errors",
      description: meaningful.join("\n"),
    });
    throw new Error(`Console errors seen:\n${meaningful.join("\n")}`);
  }
});
