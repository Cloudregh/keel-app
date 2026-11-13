// Regression test for bug 9: the "Reset custom rules" button exists on the Activity page and resets overrides.
import { test, expect } from "../fixtures/keel.mjs";

test.use({ clock: undefined });

test("custom app rules can be reset from the Activity page", async ({ keel }) => {
  const { page } = keel;
  await page.clock.setFixedTime(new Date("2026-11-10T12:00:00Z"));
  await page.reload();
  await page.locator('#nav [data-view="apps"]').click();
  await page.setInputFiles("#act-file", "tests/js/fixtures/data/activity-2026-11-10.json");
  await expect(page.locator(".apps-tbl")).toBeVisible();
  await expect(page.locator('[data-act="act-reset-rules"]')).toHaveCount(0);

  await page.locator('select[data-change="act-cat"][data-key="a:Code"]').selectOption("entertainment");
  const reset = page.locator('[data-act="act-reset-rules"]');
  await expect(reset).toHaveText("Reset 1 custom rule");
  expect(await page.evaluate("state.appRules['a:Code'].cat")).toBe("entertainment");

  await reset.click();
  await page.locator('[data-act="confirm-yes"]').click();
  expect(await page.evaluate("Object.keys(state.appRules).length")).toBe(0);
  await expect(page.locator('select[data-change="act-cat"][data-key="a:Code"]')).toHaveValue("code");
  await expect(page.locator('[data-act="act-reset-rules"]')).toHaveCount(0);
});
