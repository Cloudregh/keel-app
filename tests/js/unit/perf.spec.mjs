// Phase 12: browser-side performance against the approved targets (docs/test-strategy.md §6):
//   buildPlan p95 < 50 ms for 30 tasks with 30 days of history; dashboard render < 150 ms with 30 days of activity.
// Each measurement is repeated (p50/p95/p99 over many runs, after a warm-up) and also taken at 4× CPU slowdown
// (a mid-range phone; reported, not a target). The data-size ramp finds what breaks first as data grows.
// Numbers are written to perf/results/web-<date>.json for docs/performance.md.
import { test, expect } from "../fixtures/keel.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const VIEWS = ["today", "focus", "tasks", "timeline", "apps", "reports", "projects", "settings"];
const OUT = {};
test.afterAll(() => {
  mkdirSync("perf/results", { recursive: true });
  writeFileSync(`perf/results/web-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(OUT, null, 1) + "\n");
});

// Seeds `tasks` tasks (a third done, with tracked sessions), `years` of sessions and `actDays` heavy activity days
// (800 app segments each). Deterministic. Returns storage use and whether saving worked.
const seed = `([tasks, years, actDays, openTasks]) => {
  localStorage.clear(); state = normalize(null); state.updatedAt = 0; act = {}; actCache = {};
  let s = 20261114; const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const words = ["Write", "report", "Review", "pull requests", "Plan", "sprint", "Call", "bank", "Design", "onboarding", "Fix", "bug", "Email", "team", "Refactor", "billing", "Prepare", "slides"];
  for (let i = 0; i < tasks; i++) {
    const done = openTasks ? i >= openTasks : i % 3 === 0;
    state.tasks.push({ id: "t" + i, title: words[i % words.length] + " " + words[(i * 7 + 3) % words.length] + " " + i, projectId: ["p_work", "p_learn", "p_personal"][i % 3],
      priority: i % 4, due: addDays(todayKey(), (i % 20) - 10), estimate: 15 + (i % 8) * 15, notes: i % 5 ? "" : "Some notes about this task", subtasks: [],
      done, doneAt: done ? Date.now() - (1 + (i % 30)) * DAY : null, createdAt: Date.now() - 40 * DAY + i });
  }
  for (let d = 0; d < 365 * years; d++) for (let j = 0; j < 10; j++) {
    const st = dayStart(addDays(todayKey(), -d - 1)) + (8 + j) * HOUR, len = (25 + Math.floor(rnd() * 40)) * MIN;
    state.entries.push({ id: "e" + d + "_" + j, type: ["focus", "work", "meeting", "break"][j % 4], start: st, end: st + len, dur: len, projectId: "p_work", taskId: "t" + ((d * 10 + j) % tasks), note: "", switches: j % 3 });
  }
  const apps = ["Code", "Google Chrome", "Slack", "Figma", "Terminal", "Safari", "Notes", "Spotify"], doms = ["github.com", "youtube.com", "docs.google.com", "x.com", "stackoverflow.com"];
  for (let d = 0; d < actDays; d++) {
    const day = addDays(todayKey(), -d), segs = []; let t = dayStart(day) + 8 * HOUR;
    for (let k = 0; k < 800; k++) { const app = apps[Math.floor(rnd() * apps.length)], br = /Chrome|Safari/.test(app), len = (10 + Math.floor(rnd() * 120)) * 1000;
      segs.push({ s: t, e: t + len, app, ...(br ? { domain: doms[Math.floor(rnd() * doms.length)], title: "Some page title that is fairly long, about this long" } : {}) }); t += len + 2000; }
    act[day] = segs;
  }
  state.settings.actKeepDays = Math.max(30, actDays);
  save(); saveAct();
  return { bytes: lsBytes(), storageFull: !!(typeof storageFull !== "undefined" && storageFull), tasks: state.tasks.length, entries: state.entries.length };
}`;

// Times fn `n` times after `warm` warm-up runs; returns p50/p95/p99/max in ms.
const timeIt = `([code, n, warm]) => {
  const fn = new Function(code), xs = [];
  for (let i = 0; i < warm; i++) fn();
  for (let i = 0; i < n; i++) { const t0 = performance.now(); fn(); xs.push(performance.now() - t0); }
  xs.sort((a, b) => a - b); const p = q => Math.round(10 * xs[Math.min(xs.length - 1, Math.round(q * (xs.length - 1)))]) / 10;
  return { n, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: Math.round(10 * xs[xs.length - 1]) / 10 };
}`;

async function throttled(page, rate, fn) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  try { return await fn(); } finally { await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }); }
}

test.describe("Phase 12: browser performance", () => {
  test.describe.configure({ mode: "serial" });

  test("planner: buildPlan p95 < 50 ms for 30 open tasks with 30 days of history", async ({ keel }) => {
    test.setTimeout(120_000);
    // 30 open tasks plus 60 done ones with 30 days of tracked sessions feeding the duration and energy models
    OUT.plannerData = await keel.ev(seed, [90, 30 / 365, 30, 30]);
    const desk = await keel.ev(timeIt, ["buildPlan()", 300, 20]);
    const slow = await throttled(keel.page, 4, () => keel.ev(timeIt, ["buildPlan()", 100, 5]));
    const planned = await keel.ev(`() => buildPlan().items.filter(i => i.kind === "task").length`);
    OUT.planner = { desktop: desk, cpu4x: slow, plannedItems: planned };
    console.log("buildPlan", OUT.planner);
    expect(planned).toBeGreaterThan(0);
    expect(desk.p95).toBeLessThan(50);
  });

  test("render: dashboard p95 < 150 ms with 30 heavy activity days; every view measured", async ({ keel }) => {
    test.setTimeout(180_000);
    OUT.renderData = await keel.ev(seed, [600, 1, 30, 0]);
    const views = {};
    for (const v of VIEWS) {
      await keel.ev(`v => { ui.view = v; ui.reportRange = "30d"; }`, v);
      views[v] = { desktop: await keel.ev(timeIt, ["render()", 40, 3]) };
      views[v].cpu4x = await throttled(keel.page, 4, () => keel.ev(timeIt, ["render()", 15, 1]));
    }
    OUT.render = views;
    console.log("render p95 desktop / 4x:", Object.fromEntries(Object.entries(views).map(([k, x]) => [k, [x.desktop.p95, x.cpu4x.p95]])));
    expect(views.today.desktop.p95).toBeLessThan(150);
  });

  test("mobile (390 px, 4× CPU): each view loads with a year of data within LCP/CLS/TBT targets; a tap in Tasks responds", async ({ keel }) => {
    test.setTimeout(300_000);
    const { page } = keel;
    await page.setViewportSize({ width: 390, height: 844 });
    await keel.ev(seed, [600, 1, 30, 0]);
    await page.addInitScript(() => {
      const v = window.__vitals = { lcp: 0, cls: 0, fcp: 0, longTasks: [] };
      new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.name === "first-contentful-paint") v.fcp = e.startTime; }).observe({ type: "paint", buffered: true });
      new PerformanceObserver(l => { for (const e of l.getEntries()) v.lcp = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true });
      new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) v.cls += e.value; }).observe({ type: "layout-shift", buffered: true });
      new PerformanceObserver(l => { for (const e of l.getEntries()) v.longTasks.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: "longtask", buffered: true });
    });
    const out = {};
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    for (const v of VIEWS) {
      await keel.ev(`v => { ui.view = v; ui.reportRange = "30d"; saveUI(); }`, v);
      const runs = [];
      for (let r = 0; r < 3; r++) {   // median of 3 loads, as Lighthouse reports
      await page.reload();
      await page.waitForFunction(() => typeof window.render === "function");
      await page.waitForTimeout(1500);
      runs.push(await page.evaluate(() => { const v = window.__vitals, fcp = v.fcp;
        return { lcp: Math.round(v.lcp), fcp: Math.round(fcp), cls: Math.round(1000 * v.cls) / 1000, tbt: v.longTasks.filter(([s]) => s >= fcp).reduce((a, [, d]) => a + Math.max(0, d - 50), 0), longest: Math.max(0, ...v.longTasks.map(([, d]) => d)) }; }));
      }
      out[v] = Object.fromEntries(["lcp", "fcp", "cls", "tbt", "longest"].map(k => [k, median(runs.map(x => x[k]))]));
      out[v].tbtRuns = runs.map(x => x.tbt);
    }
    // Interaction: tick a task's checkbox in the Tasks view and time it to the next paint (an INP-style measurement).
    await keel.ev(`() => { ui.view = "tasks"; saveUI(); }`);
    await page.reload(); await page.waitForFunction(() => typeof window.render === "function"); await page.waitForTimeout(800);
    const tapOnce = async () => {
      const box = page.locator("[data-act='toggle-task']").first();
      await page.evaluate(() => { window.__tap = 0; document.addEventListener("click", () => { const t0 = performance.now(); requestAnimationFrame(() => setTimeout(() => { window.__tap = performance.now() - t0; }, 0)); }, { once: true, capture: true }); });
      await box.click();
      await page.waitForFunction(() => window.__tap > 0);
      return Math.round(await page.evaluate(() => window.__tap));
    };
    const domNodes = await page.evaluate(() => document.querySelectorAll("*").length);
    const taskRows = await page.locator("[data-act='toggle-task']").count();
    const taps = [];
    for (let i = 0; i < 5; i++) {
      const box = page.locator("[data-act='toggle-task']").first();
      await page.evaluate(() => { window.__tap = 0; document.addEventListener("click", () => { const t0 = performance.now(); requestAnimationFrame(() => setTimeout(() => { window.__tap = performance.now() - t0; }, 0)); }, { once: true, capture: true }); });
      await box.click();
      await page.waitForFunction(() => window.__tap > 0);
      taps.push(Math.round(await page.evaluate(() => window.__tap)));
    }
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    const desktopTaps = [];
    for (let i = 0; i < 5; i++) desktopTaps.push(await tapOnce());
    OUT.mobile = { views: out, taskTapMs: taps, desktopTaskTapMs: desktopTaps, tasksViewDomNodes: domNodes, taskRowsRendered: taskRows };
    console.log("mobile 4x", JSON.stringify(OUT.mobile));
    // Fix 62 regression: before the fix a tick took 120–183 ms on desktop (498–808 ms at 4×); after, about 25–36 ms (106–299 ms).
    const med = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    expect(med(desktopTaps), "desktop tick, tap to next frame (median ms)").toBeLessThan(100);
    for (const v of VIEWS) {
      expect(out[v].lcp, v).toBeLessThan(2500);
      expect(out[v].cls, v).toBeLessThan(0.1);
      expect(out[v].tbt, v).toBeLessThan(300);
    }
  });

  test("data-size ramp: what breaks first as data grows", async ({ keel }) => {
    test.setTimeout(600_000);
    const steps = [[600, 1, 30], [2000, 2, 60], [5000, 3, 90], [10000, 5, 180], [20000, 8, 365]];
    OUT.ramp = [];
    for (const [tasks, years, actDays] of steps) {
      const d = await keel.ev(seed, [tasks, years, actDays, 0]);
      const t = {};
      for (const v of ["today", "tasks", "reports"]) { await keel.ev(`v => { ui.view = v; ui.reportRange = "30d"; }`, v); t[v] = (await keel.ev(timeIt, ["render()", 8, 1])).p95; }
      t.plan = (await keel.ev(timeIt, ["buildPlan()", 8, 1])).p95;
      const reload = await keel.ev(`() => { const t0 = performance.now(); const raw = localStorage.getItem(LS_KEY); if (raw) normalize(JSON.parse(raw)); return Math.round(performance.now() - t0); }`).catch(e => "error: " + e.message);   // the start-up parse, as at line 758 of index.html
      const row = { tasks, years, actDays, ...d, mb: Math.round(d.bytes / 1e4) / 100, p95: t, loadMs: reload };
      OUT.ramp.push(row);
      console.log(JSON.stringify(row));
    }
    // The first step is the approved "30 heavy days" case: within every target.
    expect(OUT.ramp[0].storageFull).toBe(false);
    expect(OUT.ramp[0].p95.today).toBeLessThan(150);
  });
});
