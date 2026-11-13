// Phase 2 smoke tests: the page boots in the isolated test environment and never makes a paid AI call.
import { test, expect } from "../fixtures/keel.mjs";

test("default mode: app boots with no AI available at all", async ({ keel }) => {
  const { page, aiCalls } = keel;
  await expect(page.locator("#nav button")).toHaveCount(8);
  expect(await page.evaluate(() => typeof window.claude)).toBe("undefined");
  expect(aiCalls.length).toBe(0);
});

test.describe("mock mode", () => {
  test.use({ aiMode: "mock" });
  test("coach answers from a recorded response, never a real model", async ({ keel }) => {
    const { page, aiCalls } = keel;
    await page.locator('#nav [data-view="today"]').click();
    await expect(page.locator("#ai-panel")).toBeVisible();
    await page.locator('[data-act="ai"]').click();
    await expect(page.locator("#ai-out")).toContainText("Tomorrow, start with");
    expect(aiCalls.length).toBe(1);
  });
});
