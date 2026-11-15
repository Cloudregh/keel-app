// Trend charts on Reports (feature added 2026-11-15), as a user sees them: the cards appear once there is tracked
// time, hovering a day shows its value, and the range buttons redraw the lines for 7, 14 or 30 days.
import { test, expect } from "../fixtures/keel.mjs";

const seed = `() => {
  localStorage.clear(); state = normalize(null); state.settings.weekStart = 1; act = {}; actCache = {};
  for (let d = 0; d < 40; d++) { const k = addDays(todayKey(), -d), st = dayStart(k) + 8 * HOUR, len = (60 + (d % 5) * 20) * MIN;
    if (st + len > Date.now()) continue;
    state.entries.push({ id: "e" + d, type: d % 2 ? "focus" : "work", start: st, end: st + len, dur: len, projectId: "p_work", note: "" }); }
  const y = addDays(todayKey(), -1); act[y] = [{ s: dayStart(y) + 8 * HOUR, e: dayStart(y) + 9 * HOUR, app: "Code" }];
  save(); saveAct(); ui.view = "reports"; ui.reportRange = "week"; render();
}`;

test("Reports shows trend cards; hovering a day shows its value; range buttons redraw", async ({ keel }) => {
  const { page } = keel;
  await keel.ev(seed);
  const trends = page.getByRole("region", { name: "Trends" });
  await expect(trends.locator(".trend")).toHaveCount(4);
  await expect(trends.locator('[data-trend="work"] .tr-pt')).toHaveCount(7);

  // Monday (yesterday) has 1h 20m worked (d = 1 → 60 + 20 minutes).
  await trends.locator('[data-trend="work"] .tr-pt').nth(0).hover();
  const tip = page.locator(".tip");
  await expect(tip).toHaveClass(/on/);
  await expect(tip).toContainText("Worked: 1h 20m");
  await expect(trends.locator('[data-trend="work"] .tr-pt').nth(0).locator("circle")).toHaveCSS("opacity", "1");

  await page.getByRole("button", { name: "30 days" }).click();
  await expect(trends.locator('[data-trend="work"] .tr-pt')).toHaveCount(30);
  await expect(trends.locator('[data-trend="work"] .delta')).toContainText("vs previous 30 days");
  await expect(page.getByRole("img", { name: /^Worked per day, .* average / })).toBeVisible();

  await expect(page.locator(".tr-app")).toHaveCount(1);
  await expect(page.locator(".tr-app .n")).toHaveText("Code");
});

test("no tracked time: no Trends section, the usual empty state instead", async ({ keel }) => {
  await keel.ev(`() => { localStorage.clear(); state = normalize(null); act = {}; actCache = {}; ui.view = "reports"; render(); }`);
  await expect(keel.page.getByRole("region", { name: "Trends" })).toHaveCount(0);
  await expect(keel.page.getByText("No tracked time in this range")).toBeVisible();
});
