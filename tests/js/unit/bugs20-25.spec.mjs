// Regression tests for bugs 20, 21 and 25 (Phase 5). Each failed before its fix and passes after.
// Bugs 22–24 are covered by tests/js/e2e/quality.spec.mjs and tests/js/e2e/ai-ui.spec.mjs, plus the contrast
// test in logic-core.spec.mjs.
import { test, expect } from "../fixtures/keel.mjs";
import { TRACKER, cors } from "../fixtures/tracker-guard.mjs";

const STATUS = { app: "keel-tracker", version: "1", paused: false, pausedUntil: null, idle: false, current: { app: "Code" }, storage: { keepDays: 30, fileBytes: 1000, logBytes: 0 } };

test.describe("bug 20: the coach's answer survives the dashboard's redraws", () => {
  test.use({ aiMode: "mock" });
  test("answer stays after render() and after a tracker poll", async ({ keel: { page, ev } }) => {
    await page.locator('#nav [data-view="today"]').click();
    await expect(page.locator("#ai-panel")).toBeVisible();
    await page.locator('#ai-panel [data-act="ai"]').click();
    await expect(page.locator("#ai-out")).toContainText("Write proposal");
    await ev(`() => render()`);
    await expect(page.locator("#ai-out")).toContainText("Write proposal");
    await ev(`() => trPoll(false)`);                    // tracker answers "offline" → state changes → re-render
    await ev(`() => render()`);
    await expect(page.locator("#ai-out")).toContainText("Write proposal");
    await expect(page.locator("#ai-panel")).toContainText("AI-generated");
  });
});

test.describe("bug 21: Settings dropdowns save the chosen number", () => {
  for (const [field, value] of [["actKeepDays", "14"], ["keepEntriesDays", "365"], ["keepDoneDays", "30"], ["weekStart", "0"]]) {
    test(`${field} = ${value}`, async ({ keel: { page, ev } }) => {
      await page.locator('#nav [data-view="settings"]').click();
      await page.locator(`select[data-change="setting"][data-f="${field}"]`).selectOption(value);
      expect(await ev(`f => state.settings[f]`, field)).toBe(Number(value));
      await page.reload();
      expect(await ev(`f => JSON.parse(localStorage.getItem("keel.v1")).settings[f]`, field)).toBe(Number(value));
    });
  }
  test("number boxes are still clamped to their range", async ({ keel: { page, ev } }) => {
    await page.locator('#nav [data-view="settings"]').click();
    await page.locator("#set-dailyGoalMin").fill("5");
    await page.locator("#set-dailyGoalMin").blur();
    expect(await ev(`() => state.settings.dailyGoalMin`)).toBe(30);
  });
});

test.describe("bug 25: no tracker requests until it has connected once", () => {
  test("first visit makes no request; Check again connects and is remembered", async ({ keel: { page } }) => {
    const hits = [];
    await page.unroute(TRACKER);
    await page.route(TRACKER, r => { hits.push(r.request().url()); return r.abort("connectionrefused"); });
    await page.clock.install({ time: new Date("2026-11-10T10:00:00Z") });
    await page.reload();
    await page.clock.runFor(5 * 60_000);                 // five minutes of the app's own polling loop
    expect(hits).toEqual([]);
    await expect(page.locator("#trk")).toContainText("Not set up on this computer yet");

    await page.unroute(TRACKER);
    await page.route(TRACKER, r => { hits.push(r.request().url()); return r.fulfill({ headers: cors(r.request()), contentType: "application/json", body: JSON.stringify(r.request().url().includes("/activity") ? { app: "keel-tracker", days: {} } : STATUS) }); });
    await page.locator('#trk [data-act="tr-retry"]').click();
    await expect(page.locator("#trk")).toContainText("Tracking apps");

    hits.length = 0;                                     // returning visit: the app checks by itself
    await page.reload();
    await expect(page.locator("#trk")).toContainText("Tracking apps");
    expect(hits.some(u => u.endsWith("/status"))).toBe(true);
  });
});
