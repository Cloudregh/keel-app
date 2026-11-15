// Mac notifications (owner's request, 2026-11-15): Keel sends its schedule to the tracker (POST /schedule) on the
// regular tracker check, only when it changed (or every 10 minutes), and never inside claude.ai.
import { test, expect } from "../fixtures/keel.mjs";
import { TRACKER, cors, preflight } from "../fixtures/tracker-guard.mjs";

const STATUS = { app: "keel-tracker", version: 2, running: true, paused: false, current: null, idle: false, todayMs: 0, device: "Mac", now: 1, storage: {} };
const ACTIVITY = { source: "keel-tracker", version: 2, device: "Mac", updatedAt: 1, days: {} };

async function fakeTracker(page, { scheduleStatus = 200 } = {}) {
  const sent = [];
  await page.unroute(TRACKER);
  await page.route(TRACKER, async route => {
    if (await preflight(route)) return;
    const req = route.request(), path = new URL(req.url()).pathname, h = cors(req);
    if (path === "/schedule") {
      sent.push(JSON.parse(req.postData() || "{}"));
      return route.fulfill({ status: scheduleStatus, headers: h, contentType: "application/json", body: scheduleStatus === 200 ? '{"scheduled":0}' : '{"error":"Not found"}' });
    }
    return route.fulfill({ headers: h, contentType: "application/json", body: JSON.stringify(path === "/activity" ? ACTIVITY : STATUS) });
  });
  return sent;
}

test("Keel sends its schedule to the tracker, again only when it changes", async ({ keel: { page, ev } }) => {
  const sent = await fakeTracker(page);
  await ev(`() => trPoll(true)`);
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0].prefs).toEqual({ focus: true, plan: true, summary: true, tracker: true });
  expect(sent[0].summaryAt).toBe(new Date("2026-11-10T19:00:00Z").getTime());   // default workday end
  await ev(`() => trPoll(false)`);
  await page.waitForTimeout(200);
  expect(sent.length).toBe(1);                                                   // unchanged: not sent again
  await page.locator('#nav [data-view="focus"]').click();
  await page.locator('[data-act="focus-start"]').click();                        // a 25-minute focus session
  await ev(`() => trPoll(false)`);
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1].items.map(i => i.title)).toContain("Focus session done");
});

test("an older tracker without /schedule: no error shown, tracking stays connected", async ({ keel: { page, ev } }) => {
  const sent = await fakeTracker(page, { scheduleStatus: 404 });
  await ev(`() => trPoll(true)`);
  await expect.poll(() => sent.length).toBe(1);
  await page.waitForTimeout(200);
  await expect(page.locator("#toasts")).not.toContainText(/tracker/i);
  expect(await ev(`() => TR.state`)).toBe("online");
});

test("Settings → Notifications: five switches, and turning one off reaches the tracker", async ({ keel: { page, ev } }) => {
  const sent = await fakeTracker(page);
  await page.locator('#nav [data-view="settings"]').click();
  const panel = page.locator("section.panel", { has: page.getByRole("heading", { name: "Notifications" }) });
  await expect(panel).toContainText("on your Mac");
  for (const name of ["Focus and breaks", "Plan reminders", "End-of-day summary", "Tracker problems", "Hide task names"]) await expect(panel.getByRole("switch", { name })).toBeVisible();
  await expect(panel.getByRole("switch", { name: "Hide task names" })).toHaveAttribute("aria-checked", "false");
  await panel.getByRole("switch", { name: "Plan reminders" }).click();
  await expect(panel.getByRole("switch", { name: "Plan reminders" })).toHaveAttribute("aria-checked", "false");
  await ev(`() => trPoll(true)`);
  await expect.poll(() => sent.at(-1) && sent.at(-1).prefs.plan).toBe(false);
  await page.reload();
  expect(await ev(`() => state.settings.notifyPlan`)).toBe(false);               // the choice is saved
});

test.describe("inside claude.ai", () => {
  test.use({ aiMode: "mock" });
  test("no schedule is sent (there's no tracker there)", async ({ keel: { page, ev } }) => {
    const sent = await fakeTracker(page);
    await ev(`() => trPoll(true)`);
    await page.waitForTimeout(300);
    expect(sent.length).toBe(0);
  });
});
