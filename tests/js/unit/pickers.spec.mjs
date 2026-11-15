// Keel's own date and time pickers (they replace the browser's default pickers everywhere).
import { test, expect } from "../fixtures/keel.mjs";

const reset = `() => { localStorage.clear(); state = normalize(null); state.updatedAt = 0; act = {}; actCache = {}; closeModal(); render(); }`;

test("no browser-default date or time inputs remain on any page or dialog", async ({ keel }) => {
  await keel.ev(reset);
  await keel.ev(`() => { state.tasks.push({ id: "t", title: "T", due: todayKey(), done: false, createdAt: 1, subtasks: [] }); ui.expanded = "t"; }`);
  for (const v of ["today", "focus", "tasks", "timeline", "apps", "reports", "projects", "settings"]) {
    await keel.ev(`v => { ui.view = v; ui.taskFilter = "today"; render(); }`, v);
    expect(await keel.page.locator('input[type="date"], input[type="time"], input[type="datetime-local"]').count()).toBe(0);
  }
  await keel.page.keyboard.press("l");
  expect(await keel.page.locator('.modal input[type="date"], .modal input[type="time"]').count()).toBe(0);
});

test("timeline: open the calendar, see today marked, change month and pick a day", async ({ keel }) => {
  await keel.ev(reset);
  await keel.page.locator('#nav [data-view="timeline"]').click();
  const btn = keel.page.locator('[data-dp="tl-day"] .dp-btn');
  await expect(btn).toContainText("Today");
  await btn.click();
  const pop = keel.page.locator(".pop");
  await expect(pop).toBeVisible();
  await expect(btn).toHaveAttribute("aria-expanded", "true");
  await expect(pop.locator(".pop-h b")).toHaveText("November 2026");
  await expect(pop.locator(".cal-days .today")).toHaveText("10");
  await expect(pop.locator('.cal-days [aria-selected="true"]')).toHaveText("10");
  await expect(pop.locator(".cal-wd span").first()).toHaveText("Mo");           // week starts Monday by default
  await pop.locator('[data-act="dp-month"][data-d="-1"]').click();
  await expect(pop.locator(".pop-h b")).toHaveText("October 2026");
  await pop.locator('.cal-days [data-v="2026-10-21"]').click();
  await expect(pop).toHaveCount(0);
  expect(await keel.ev(`() => ui.tlDay`)).toBe("2026-10-21");
  await expect(keel.page.locator('[data-dp="tl-day"] .dp-btn')).toContainText("21 Oct");
});

test("keyboard: arrows move between days and across months, Enter picks, Escape closes and returns focus", async ({ keel }) => {
  await keel.ev(reset);
  await keel.page.locator('#nav [data-view="timeline"]').click();
  await keel.page.locator('[data-dp="tl-day"] .dp-btn').click();
  await expect(keel.page.locator('.cal-days [data-v="2026-11-10"]')).toBeFocused();
  await keel.page.keyboard.press("ArrowLeft");
  await expect(keel.page.locator('.cal-days [data-v="2026-11-09"]')).toBeFocused();
  for (let i = 0; i < 2; i++) await keel.page.keyboard.press("ArrowUp");
  await expect(keel.page.locator('.cal-days [data-v="2026-10-26"]')).toBeFocused();
  await keel.page.keyboard.press("Escape");
  await expect(keel.page.locator(".pop")).toHaveCount(0);
  await expect(keel.page.locator('[data-dp="tl-day"] .dp-btn')).toBeFocused();
  await keel.page.keyboard.press("Enter");                                          // reopen from the button
  await keel.page.keyboard.press("ArrowRight");
  await keel.page.keyboard.press("Enter");
  expect(await keel.ev(`() => ui.tlDay`)).toBe("2026-11-11");
});

test("week can start on Sunday; outside clicks close the picker; the 30-second refresh doesn't", async ({ keel }) => {
  await keel.ev(reset);
  await keel.ev(`() => { state.settings.weekStart = 0; ui.view = "timeline"; render(); }`);
  await keel.page.locator('[data-dp="tl-day"] .dp-btn').click();
  await expect(keel.page.locator(".cal-wd span").first()).toHaveText("Su");
  await keel.ev(`() => { lastFull = 0; tick(); }`);
  await expect(keel.page.locator(".pop")).toBeVisible();
  await keel.page.mouse.click(700, 500);
  await expect(keel.page.locator(".pop")).toHaveCount(0);
});

test("task due date: Tomorrow shortcut, then Clear", async ({ keel }) => {
  await keel.ev(reset);
  await keel.ev(`() => { state.tasks.push({ id: "t", title: "Write", due: null, done: false, createdAt: 1, subtasks: [] }); ui.view = "tasks"; ui.taskFilter = "open"; ui.expanded = "t"; render(); }`);
  const btn = keel.page.locator('[data-dp="due-t"] .dp-btn');
  await expect(btn).toContainText("No date");
  await btn.click();
  await keel.page.locator('.pop [data-act="dp-pick"]', { hasText: "Tomorrow" }).click();
  expect(await keel.ev(`() => state.tasks[0].due`)).toBe("2026-11-11");
  await keel.page.locator('[data-dp="due-t"] .dp-btn').click();
  await keel.page.locator('.pop [data-act="dp-pick"]', { hasText: "Clear" }).click();
  expect(await keel.ev(`() => state.tasks[0].due`)).toBeNull();
});

test("log time with the pickers: calendar date, time from the list, and a typed time", async ({ keel }) => {
  await keel.ev(reset);
  await keel.page.keyboard.press("l");
  await keel.page.locator('[data-dp="entry-date"] .dp-btn').click();
  await keel.page.locator('.pop .cal-days [data-v="2026-11-09"]').click();
  await keel.page.locator('[data-dp="entry-start"] .dp-btn').click();
  await keel.page.locator('.pop.tp [data-v="08:30"]').click();
  await expect(keel.page.locator('[data-dp="entry-start"] .dp-btn')).toContainText("8:30 AM");
  await keel.page.locator('[data-dp="entry-end"] .dp-btn').click();
  const typed = keel.page.locator(".pop.tp [data-tp-type]");
  await typed.fill("25:99");
  await typed.press("Enter");
  await expect(typed).toHaveAttribute("aria-invalid", "true");                      // invalid time is refused
  await typed.fill("9:05 pm");
  await typed.press("Enter");
  await expect(keel.page.locator('[data-dp="entry-end"] .dp-btn')).toContainText("9:05 PM");
  await keel.page.keyboard.press("Escape");                                          // picker is closed, so Escape closes the dialog
  await expect(keel.page.locator(".modal")).toHaveCount(0);
  await keel.page.keyboard.press("l");
  await keel.page.locator('[data-dp="entry-date"] .dp-btn').click();
  await keel.page.locator('.pop .cal-days [data-v="2026-11-09"]').click();
  await keel.page.locator('[data-dp="entry-start"] .dp-btn').click();
  await keel.page.locator('.pop.tp [data-v="08:30"]').click();
  await keel.page.locator('[data-dp="entry-end"] .dp-btn').click();
  await keel.page.locator(".pop.tp [data-tp-type]").fill("21:05");
  await keel.page.locator(".pop.tp [data-tp-type]").press("Enter");
  await keel.page.locator(".modal button.primary").click();
  const e = await keel.ev(`() => state.entries[0]`);
  expect(new Date(e.start).toISOString()).toBe("2026-11-09T08:30:00.000Z");
  expect(new Date(e.end).toISOString()).toBe("2026-11-09T21:05:00.000Z");
});

test("Escape inside an open picker closes only the picker, not the dialog", async ({ keel }) => {
  await keel.ev(reset);
  await keel.page.keyboard.press("l");
  await keel.page.locator('[data-dp="entry-date"] .dp-btn').click();
  await keel.page.keyboard.press("Escape");
  await expect(keel.page.locator(".pop")).toHaveCount(0);
  await expect(keel.page.locator(".modal")).toBeVisible();
});

test("dashboard: jump to any day from the calendar button", async ({ keel }) => {
  await keel.ev(reset);
  await keel.page.locator('#nav [data-view="today"]').click();
  await keel.page.locator('[data-dp="dash-day"] .dp-btn').click();
  await keel.page.locator('.pop .cal-days [data-v="2026-11-03"]').click();
  expect(await keel.ev(`() => ui.dashDay`)).toBe("2026-11-03");
  await expect(keel.page.locator(".dash-head h1")).toContainText("3 November");
});

test("a scroll event that arrives after the picker opened, with the page not moving, doesn't close it; a real scroll does", async ({ keel }) => {
  // A scroll that ended just before the click (trackpad momentum, or a browser scrolling the button into view) can
  // deliver its scroll event after the picker opened. Found in Phase 14 (2026-11-15) when the new look made the Tasks
  // page taller. The picker now closes only if its button actually moved.
  await keel.ev(reset);
  await keel.ev(`() => { for (let i = 0; i < 12; i++) state.tasks.push({ id: "t" + i, title: "Task " + i, due: null, done: false, createdAt: 1, subtasks: [] }); ui.view = "tasks"; ui.taskFilter = "open"; ui.expanded = "t0"; render(); }`);
  await keel.page.locator('[data-dp="due-t0"] .dp-btn').click();
  await expect(keel.page.locator(".pop")).toBeVisible();
  await keel.page.evaluate(() => document.dispatchEvent(new Event("scroll")));                 // a late event, nothing moved
  await expect(keel.page.locator(".pop")).toBeVisible();
  await keel.page.locator('.pop [data-act="dp-pick"]', { hasText: "Tomorrow" }).click();
  expect(await keel.ev(`() => state.tasks[0].due`)).toBe("2026-11-11");
  await keel.page.locator('[data-dp="due-t0"] .dp-btn').click();
  await expect(keel.page.locator(".pop")).toBeVisible();
  await keel.page.evaluate(() => { document.documentElement.style.minHeight = "3000px"; window.scrollBy(0, 200); });   // the page really scrolls
  await expect(keel.page.locator(".pop")).toHaveCount(0);
});
