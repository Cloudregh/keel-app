// Regression tests for Phase 8 findings 37, 39, 40 and 41. The model-level checks (500-day constraints, calibration
// on the test split, duration error, weight bounds) live in the evaluation: npm run eval (eval/planner/run.mjs).
import { test, expect } from "../fixtures/keel.mjs";

test("bug 37: an overdue task comes before a tiny Heavy task due today, even in a peak hour", async ({ keel: { ev } }) => {
  const r = await ev(`() => {
    state.ml = null; mlState(); state.entries = []; state.planSkips = null;
    const k = todayKey();
    state.tasks = [
      { id: "today", title: "Write the grant proposal", energy: "H", estimate: 5, priority: 3, due: k, subtasks: [], done: false },
      { id: "late", title: "Pay the electricity bill", energy: "L", estimate: 60, priority: 0, due: addDays(k, -2), subtasks: [], done: false },
    ];
    state.updatedAt++;
    return buildPlan().items.filter(i => i.kind === "task").map(i => i.taskId);
  }`);
  expect(r[0]).toBe("late");
});

test("bug 40: someone who estimates well isn't given a buffer they don't need", async ({ keel: { ev } }) => {
  const r = await ev(`() => {
    state.ml = null; mlState(); state.tasks = []; state.entries = [];
    const now = Date.now();
    // 20 finished tasks that took 1.1× the estimate, varying ±25% (steady, not erratic: spread ≈ 0.26)
    for (let i = 0; i < 20; i++) {
      const est = 30, actual = Math.round(est * 1.1 * Math.exp(i % 2 ? 0.25 : -0.25));
      state.tasks.push({ id: "h" + i, title: "Review the budget", energy: "M", estimate: est, priority: 1, subtasks: [], done: true, doneAt: now - (i + 1) * 3600e3 });
      state.entries.push({ id: "e" + i, type: "focus", start: now - (i + 1) * 3600e3 - actual * 60e3, end: now - (i + 1) * 3600e3, dur: actual * 60e3, taskId: "h" + i, switches: 0 });
    }
    state.updatedAt++;
    return predictDuration({ id: "new", title: "Review the budget", energy: "M", estimate: 60, priority: 1, subtasks: [] });
  }`);
  expect(r.min).toBeLessThanOrEqual(70);   // ~1.1× of 60; the old P75 buffer added ~18% (≈ 80)
  expect(r.min).toBeGreaterThanOrEqual(60);
});

test("bug 41: 30 identical 'move this up' choices raise that factor without switching another off", async ({ keel: { ev } }) => {
  const r = await ev(`() => {
    state.ml = null; mlState(); const k = todayKey();
    state.tasks = [{ id: "quick", title: "Reply to the landlord", estimate: 10, priority: 1, due: k, subtasks: [], done: false },
                   { id: "long", title: "Review the budget", estimate: 60, priority: 1, due: k, subtasks: [], done: false }];
    state.updatedAt++;
    for (let i = 0; i < 30; i++) learnOrder("quick", "long");
    const w = mlState().w;
    return { quickUp: w.quick - DEFAULT_W.quick, ratios: ["prio", "energy", "quick"].map(x => w[x] / DEFAULT_W[x]) };
  }`);
  expect(r.quickUp).toBeGreaterThanOrEqual(0.15);
  for (const x of r.ratios) { expect(x).toBeGreaterThanOrEqual(0.5); expect(x).toBeLessThanOrEqual(2); }
});

test("bug 39: recalibration changes confidence, never which class wins", async ({ keel: { ev } }) => {
  const r = await ev(`() => {
    state.ml = null; mlState();
    const tasks = ["Write the quarterly report", "Pay electricity bill", "Review Kojo's pull request", "Feed the chickens", "Plan the Q1 product roadmap", "Call mum"].map(t => ({ title: t, estimate: 0, priority: 1, subtasks: [] }));
    const now = tasks.map(t => predictEffort(t));
    const saved = { ...TEMP }; Object.assign(TEMP, { a: 1, b: 0.15 });   // the old constants
    const old = tasks.map(t => predictEffort(t)); Object.assign(TEMP, saved);
    return { sameBest: now.every((p, i) => p.best === old[i].best), sharper: now.every((p, i) => p.conf >= old[i].conf - 1e-9), heavyReport: now[0].conf };
  }`);
  expect(r).toMatchObject({ sameBest: true, sharper: true });
  expect(r.heavyReport).toBeGreaterThan(0.6);
});

test("bug 38: after one correction, the verb outweighs nouns shared with other effort levels", async ({ keel: { ev } }) => {
  const r = await ev(`() => {
    state.ml = null; mlState();
    const t = (id, title) => ({ id, title, notes: "", estimate: 0, priority: 1, projectId: null, subtasks: [] });
    setEffort(t("c1", "Feed the chickens"), "L"); setEffort(t("c2", "Collect eggs from the coop"), "L"); setEffort(t("c3", "Lock the coop for the night"), "L");
    setEffort(t("c4", "Weed the cassava plot"), "M");
    setEffort(t("c5", "Construct new drying racks"), "H");
    return ["Construct the second chicken coop", "Feed the goats", "Weed the maize plot"].map(x => predictEffort(t("x", x)).best);
  }`);
  expect(r).toEqual(["H", "L", "M"]);
});

test.describe("bug 43: a background redraw can't swallow a click", () => {
  test("press, the timer's periodic redraw fires, release: the click still lands", async ({ keel: { page, ev } }) => {
    await ev(`() => { ui.view = "apps"; render(); }`);
    const box = await page.locator('#nav [data-view="reports"]').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await ev(`() => { lastFull = 0; tick(); }`);          // the 30-second full redraw, while the button is held
    await page.mouse.up();
    await expect.poll(() => ev(`() => ui.view`)).toBe("reports");
  });
  test("the postponed redraw still happens right after release", async ({ keel: { page, ev } }) => {
    await ev(`() => { ui.view = "today"; render(); }`);
    const box = await page.locator("#view").boundingBox();
    await page.mouse.move(box.x + 5, box.y + 5);
    await page.mouse.down();
    await ev(`() => { document.querySelector("#view").insertAdjacentHTML("beforeend", "<i id='stale-marker'></i>"); bgRender(); }`);
    expect(await ev(`() => !!document.getElementById("stale-marker")`)).toBe(true);   // held: not redrawn yet
    await page.mouse.up();
    await expect.poll(() => ev(`() => !!document.getElementById("stale-marker")`)).toBe(false);   // redrawn after release
  });
});
