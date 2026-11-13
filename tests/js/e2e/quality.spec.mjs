// Phase 5: every page at mobile, tablet and desktop sizes: accessibility (axe), console errors, failed requests,
// and layout overflow. Runs like a real visit: the tracker isn't running (connection refused), fonts load normally
// (fonts are only blocked in other tests to avoid network flakiness; failures loading them are excluded below).
import { test as base, expect } from "@playwright/test";
import { TRACKER, guardTracker } from "../fixtures/tracker-guard.mjs";
import AxeBuilder from "@axe-core/playwright";

const test = base;
test.use({ bypassCSP: false });   // the sweep never contacts the tracker, so it runs under the app's real policy
test.use({ timezoneId: "Africa/Accra" });
const VIEWS = ["today", "focus", "tasks", "timeline", "apps", "reports", "projects", "settings"];
const SIZES = [["mobile", 390, 844], ["tablet", 768, 1024], ["desktop", 1440, 900]];
const seed = `() => {
  state.tasks.push({ id: "t1", title: "Write proposal", projectId: "p_work", priority: 3, due: todayKey(), estimate: 45, notes: "", subtasks: [{ id: "s", title: "Outline", done: false }], done: false, createdAt: 1 },
                   { id: "t2", title: "Reply to emails", priority: 1, due: todayKey(), estimate: 15, notes: "", subtasks: [], done: false, createdAt: 2 });
  state.entries.push({ id: "e1", type: "focus", start: dayStart(todayKey()) + 8 * HOUR, end: dayStart(todayKey()) + 9 * HOUR, dur: HOUR, projectId: "p_work", switches: 1 },
                     { id: "e2", type: "break", start: dayStart(todayKey()) + 9 * HOUR, end: dayStart(todayKey()) + 9.25 * HOUR, dur: 15 * MIN });
  act[todayKey()] = [{ s: dayStart(todayKey()) + 8 * HOUR, e: dayStart(todayKey()) + 8.5 * HOUR, app: "Code" }, { s: dayStart(todayKey()) + 8.5 * HOUR, e: dayStart(todayKey()) + 9 * HOUR, app: "Google Chrome", domain: "youtube.com", title: "Video" }];
  state.plan = buildPlan(); state.plan.accepted = true; saveAct(); save();
}`;

for (const theme of ["dark", "light"]) {
  for (const [label, width, height] of SIZES) {
    test(`${theme} · ${label}: every page is accessible, error-free and fits the screen`, async ({ page }) => {
      test.setTimeout(120_000);
      const consoleErrors = [], failed = [], pageErrors = [];
      page.on("console", m => { if (m.type() === "error") consoleErrors.push(`${m.text()} @ ${m.location().url}`); });
      page.on("pageerror", e => pageErrors.push(e.message));
      page.on("requestfailed", r => failed.push(`${r.url()} ${r.failure()?.errorText}`));
      await guardTracker(page);
      await page.route(TRACKER, r => r.abort("connectionrefused"));        // tracker not running, as for most visitors
      await page.clock.setFixedTime(new Date("2026-11-10T10:00:00Z"));
      await page.setViewportSize({ width, height });
      await page.goto("/index.html");
      await page.evaluate(seed);
      await page.evaluate(`state.settings.theme = "${theme}"; applyTheme();`);
      const problems = [];
      for (const v of VIEWS) {
        await page.evaluate(`ui.view = "${v}"; ui.taskFilter = "today"; render();`);
        const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        for (const x of axe.violations.filter(x => ["serious", "critical"].includes(x.impact))) problems.push(`${v}: [${x.impact}] ${x.id} (${x.nodes.length}×) ${x.nodes[0].target.join(" ")}`);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        if (overflow > 1) problems.push(`${v}: page is ${overflow}px wider than the screen`);
      }
      const isFont = s => /fonts\.(googleapis|gstatic)\.com/.test(s);
      // Soft assertions: every category is checked and reported, even when an earlier one fails.
      expect.soft(pageErrors, "page errors").toEqual([]);
      expect.soft(problems, "accessibility / layout").toEqual([]);
      expect.soft(consoleErrors.filter(e => !isFont(e)), "console errors").toEqual([]);
      expect.soft(failed.filter(f => !isFont(f)), "failed requests").toEqual([]);
    });
  }
}
