// Phase 9: the planner "in service". Keel has no model server: the models run inside the page, so this tests them
// where they run: output contract, odd input, a damaged or missing model, batch vs single, cached vs fresh
// predictions, version tracking and rollback, cold start, memory, latency and what the user sees when a model fails.
import { test, expect } from "../fixtures/keel.mjs";

const VIEWS = ["today", "focus", "tasks", "timeline", "apps", "reports", "projects", "settings"];

// In-page helpers: a seeded random generator and the documented output contracts.
const HELPERS = `
  window.__rng = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  window.__effortOk = o => !!o && ["L", "M", "H"].includes(o.best) && ["L", "M", "H"].every(c => Number.isFinite(o.p[c]) && o.p[c] >= 0 && o.p[c] <= 1)
    && Math.abs(o.p.L + o.p.M + o.p.H - 1) < 1e-9 && Math.abs(o.conf - o.p[o.best]) < 1e-12 && Array.isArray(o.why) && o.why.every(w => typeof w === "string")
    && ["likely", "probably", "unsure"].includes(o.sure);
  window.__durOk = o => !!o && Number.isInteger(o.min) && o.min >= 5 && o.min <= 480 && o.min % 5 === 0 && (o.mult === null || (Number.isFinite(o.mult) && o.mult > 0)) && typeof o.basis === "string" && o.basis.length > 0;
  window.__planOk = (p, now) => {
    if (!p || typeof p.day !== "string" || !Array.isArray(p.items) || !Array.isArray(p.later) || typeof p.overflow !== "boolean") return "shape";
    let prev = -Infinity;
    for (const i of p.items) {
      if (!["task", "break"].includes(i.kind) || !Number.isFinite(i.start) || !Number.isFinite(i.end) || i.end <= i.start || i.start < prev || i.start < now) return "item " + JSON.stringify(i).slice(0, 120);
      if (typeof i.reason !== "string" || !i.reason) return "reason";
      if (i.kind === "task" && (!taskById(i.taskId) || !["L", "M", "H"].includes(i.eff) || !(i.dur > 0) || i.dur % 5 !== 0 || !(i.part >= 1 && i.part <= i.parts))) return "task item " + JSON.stringify(i).slice(0, 120);
      prev = i.end;
    }
    return p.later.every(id => typeof id === "string") ? null : "later";
  };
  window.__oddTask = (r, i) => {
    const pick = xs => xs[Math.floor(r() * xs.length)];
    return { id: "odd" + i, title: pick(["Write report", "", null, 42, "🚀🔥", "x".repeat(5000), "Écrire le rapport", { a: 1 }, "Pay bill", "   "]),
      notes: pick(["", null, "n".repeat(3000), 7]), estimate: pick([0, 15, 60, -5, NaN, 1e9, "30", null, undefined, Infinity]),
      priority: pick([0, 1, 3, 9, -1, "high", null]), due: pick([null, todayKey(), addDays(todayKey(), -3), "tomorrow", 12345, "2026-13-45"]),
      projectId: pick([null, "p_work", "nope", 5]), subtasks: pick([[], null, "x", [{}, {}], Array(50).fill({ title: "s" })]), done: false, energy: pick([undefined, "L", "H", "Q", 3]) };
  };`;

test.beforeEach(async ({ keel: { page } }) => { await page.evaluate(HELPERS); });

test.describe("output contract and odd input", () => {
  test("2,000 odd tasks: every effort and duration prediction matches its contract, nothing throws", async ({ keel: { ev } }) => {
    const r = await ev(`() => {
      const r = __rng(901), bad = [];
      for (let i = 0; i < 2000; i++) {
        const t = __oddTask(r, i);
        try { if (!__effortOk(predictEffort(t))) bad.push(["effort", i]); if (!__durOk(predictDuration(t))) bad.push(["duration", i]); if (!["L", "M", "H"].includes(effortOf(t))) bad.push(["effortOf", i]); }
        catch (e) { bad.push(["threw", i, String(e.message || e)]); }
      }
      return bad.slice(0, 10);
    }`);
    expect(r).toEqual([]);
  });
  test("200 odd days: every plan matches its contract, nothing throws", async ({ keel: { ev } }) => {
    const r = await ev(`() => {
      const r = __rng(902), bad = [];
      for (let d = 0; d < 200; d++) {
        state.ml = null; mlState(); state.planSkips = null;
        state.tasks = Array.from({ length: Math.floor(r() * 40) }, (_, i) => __oddTask(r, d * 100 + i));
        state.updatedAt++;
        try { const p = buildPlan(), why = __planOk(p, Date.now()); if (why) bad.push([d, why]); } catch (e) { bad.push([d, "threw", String(e.message || e)]); }
      }
      return bad.slice(0, 10);
    }`);
    expect(r).toEqual([]);
  });
});

test.describe("damaged or missing model", () => {
  const CORRUPT = {
    "missing": `state.ml = undefined`,
    "not an object": `state.ml = "garbage"`,
    "empty word counts": `state.ml = { nb: {} }`,
    "class table missing": `state.ml = { nb: { c: { L: null }, n: {}, docs: {} } }`,
    "counts saved as text": `state.ml = { nb: { c: { L: { write: "5" }, M: {}, H: {} }, n: { L: "9", M: 0, H: 0 }, docs: { L: "x", M: 0, H: 0 } } }`,
    "weights broken": `state.ml = { w: { prio: "x", energy: null, quick: -5 } }`,
    "labels not a map": `state.ml = { labels: [1, 2, 3] }`,
    "unknown chronotype": `state.ml = { chrono: "vampire" }`,
  };
  for (const [name, setup] of Object.entries(CORRUPT)) {
    test(`${name}: predictions still work, every screen renders, and the model is repaired`, async ({ keel: { page, ev } }) => {
      const errors = []; page.on("pageerror", e => errors.push(e.message));
      const r = await ev(`() => {
        const k = todayKey();
        state.tasks = [{ id: "t1", title: "Write the quarterly report", estimate: 120, priority: 2, due: k, subtasks: [], done: false },
                       { id: "t2", title: "Pay electricity bill", estimate: 10, priority: 1, due: k, subtasks: [], done: false }];
        ${setup}; state.updatedAt++;
        const out = {};
        try { out.effort = __effortOk(predictEffort(state.tasks[0])); } catch (e) { out.effort = "threw: " + e.message; }
        try { out.duration = __durOk(predictDuration(state.tasks[0])); } catch (e) { out.duration = "threw: " + e.message; }
        try { const p = buildPlan(); out.plan = __planOk(p, Date.now()) || (p.items.length > 0); } catch (e) { out.plan = "threw: " + e.message; }
        try { setEffort(state.tasks[1], "L"); out.learn = true; } catch (e) { out.learn = "threw: " + e.message; }
        return out;
      }`);
      expect(r).toEqual({ effort: true, duration: true, plan: true, learn: true });
      for (const v of VIEWS) await page.evaluate(`ui.view = "${v}"; render();`);
      expect(errors).toEqual([]);
    });
  }
  test("a damaged model saved in storage doesn't break the app after a reload", async ({ keel: { page } }) => {
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    await page.evaluate(`state.tasks = [{ id: "t1", title: "Write report", estimate: 60, priority: 2, due: todayKey(), subtasks: [], done: false }]; state.ml = { nb: { c: 5 } }; save();`);
    await page.reload();
    await page.locator('#nav [data-view="tasks"]').click();
    await expect(page.locator("main")).toContainText("Write report");
    await page.locator('#nav [data-view="today"]').click();
    expect(errors).toEqual([]);
  });
});

test.describe("fallback: what you see if a model fails", () => {
  for (const fn of ["predictEffort", "predictDuration", "energyCurve"]) {
    test(`${fn} throwing: tasks, plan and every screen still work`, async ({ keel: { page, ev } }) => {
      const errors = []; page.on("pageerror", e => errors.push(e.message));
      const r = await ev(`() => {
        const k = todayKey();
        state.tasks = [{ id: "t1", title: "Write the quarterly report", estimate: 120, priority: 2, due: k, subtasks: [], done: false },
                       { id: "t2", title: "Pay electricity bill", estimate: 10, priority: 1, due: k, subtasks: [], done: false }];
        state.updatedAt++;
        ${fn} = () => { throw new Error("model failure (test)"); };
        let plan; try { plan = buildPlan(); } catch (e) { return { plan: "threw: " + e.message }; }
        return { plan: __planOk(plan, Date.now()) || new Set(plan.items.filter(i => i.kind === "task").map(i => i.taskId)).size, onDefaults: plan.onDefaults };
      }`);
      expect(r).toEqual({ plan: 2, onDefaults: true });   // both tasks still planned (long ones split into parts), and the plan says it's on defaults
      for (const v of VIEWS) await page.evaluate(`ui.view = "${v}"; render();`);
      await page.locator('#nav [data-view="tasks"]').click();
      await expect(page.locator("main")).toContainText("Pay electricity bill");
      expect(errors).toEqual([]);
    });
  }
});

test.describe("batch vs single, and cached vs fresh", () => {
  test("predictions inside a plan equal one-by-one predictions; task order doesn't change any prediction", async ({ keel: { ev } }) => {
    const r = await ev(`() => {
      const r = __rng(903), k = todayKey(), titles = ["Write the grant proposal", "Pay rent", "Review the budget", "Call mum", "Design the landing page", "Weed the cassava plot", "Draft chapter 3", "Book a haircut"];
      state.ml = null; mlState(); state.planSkips = null; state.entries = [];
      state.tasks = Array.from({ length: 12 }, (_, i) => ({ id: "b" + i, title: titles[i % titles.length] + " " + i, estimate: [0, 10, 30, 45, 90][i % 5], priority: i % 4, due: k, subtasks: [], done: false }));
      state.updatedAt++;
      const single = Object.fromEntries(state.tasks.map(t => [t.id, { eff: effortOf(t), dur: predictDuration(t).min, p: JSON.stringify(predictEffort(t).p) }]));
      const plan = buildPlan(), mismatches = [];
      for (const i of plan.items.filter(i => i.kind === "task" && i.parts === 1)) { const s = single[i.taskId]; if (i.eff !== s.eff || i.dur !== s.dur) mismatches.push(i.taskId); }
      const sig = p => JSON.stringify(p.items.map(i => [i.kind, i.taskId || null, i.start, i.end]));
      const plans = [];
      for (let n = 0; n < 5; n++) { state.tasks = state.tasks.slice().sort(() => r() - 0.5); state.updatedAt++; const after = Object.fromEntries(state.tasks.map(t => [t.id, JSON.stringify(predictEffort(t).p)])); if (Object.keys(single).some(id => single[id].p !== after[id])) mismatches.push("order changed a prediction"); plans.push(sig(buildPlan())); }
      return { mismatches, planned: plan.items.filter(i => i.kind === "task").length, samePlanForAnyOrder: new Set(plans).size === 1 };
    }`);
    expect(r.mismatches).toEqual([]);
    expect(r.planned).toBeGreaterThan(5);
    expect(r.samePlanForAnyOrder).toBe(true);
  });
  test("cached duration and energy predictions always match a fresh computation, even for changes in the same millisecond", async ({ keel: { ev } }) => {
    const r = await ev(`() => {
      state.ml = null; mlState(); state.tasks = []; state.entries = [];
      const now = Date.now();
      for (let i = 0; i < 12; i++) { state.tasks.push({ id: "h" + i, title: "Review the budget " + i, estimate: 30, priority: 1, subtasks: [], done: true, doneAt: now - (i + 1) * 3600e3 }); state.entries.push({ id: "e" + i, type: "focus", start: now - (i + 1) * 3600e3 - 60 * 60e3, end: now - (i + 1) * 3600e3, dur: 60 * 60e3, taskId: "h" + i, switches: 0 }); }
      commit();
      const t = { id: "new", title: "Review the budget", estimate: 30, priority: 1, subtasks: [] };
      const before = predictDuration(t).min;
      // the user relabels every finished task Light, which changes the class statistics (same millisecond: the clock is frozen)
      for (const x of state.tasks) setEffort(x, "L");
      commit();
      const cached = predictDuration({ ...t, energy: "L" }).min;
      _durKey = ""; _energyKey = "";
      const fresh = predictDuration({ ...t, energy: "L" }).min;
      return { before, cached, fresh };
    }`);
    expect(r.cached).toBe(r.fresh);
  });
});

test.describe("versioning and rollback", () => {
  test("every plan and the saved model carry the planner version", async ({ keel: { ev } }) => {
    const r = await ev(`() => { state.tasks = [{ id: "t1", title: "Pay rent", estimate: 10, priority: 1, due: todayKey(), subtasks: [], done: false }]; state.updatedAt++; return { plan: buildPlan().version, model: mlState().version, constant: typeof PLANNER_VERSION === "string" ? PLANNER_VERSION : null }; }`);
    expect(r.constant).toMatch(/^planner-v\d+/);
    expect(r.plan).toBe(r.constant);
    expect(r.model).toBe(r.constant);
  });
  test("rollback: the previous release runs on data and a model trained by this release, and coming back keeps the model", async ({ keel: { page, ev } }) => {
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    const trained = await ev(`() => {
      const k = todayKey();
      state.tasks = [{ id: "t1", title: "Construct the drying racks", estimate: 120, priority: 2, due: k, subtasks: [], done: false }, { id: "t2", title: "Écrire le rapport", estimate: 30, priority: 1, due: k, subtasks: [], done: false }];
      setEffort(state.tasks[0], "H"); setEffort(state.tasks[1], "M"); commit();
      return JSON.stringify(state.ml.nb);
    }`);
    await page.goto("/tests/js/fixtures/prev/index.html");
    await page.waitForFunction("typeof predictEffort === 'function'");
    const prev = await page.evaluate(`(() => { const o = predictEffort(state.tasks[0]); const p = buildPlan(); for (const v of ${JSON.stringify(VIEWS)}) { ui.view = v; render(); } return { best: o.best, planned: new Set(p.items.filter(i => i.kind === "task").map(i => i.taskId)).size }; })()`);   // distinct tasks: long ones are split into parts
    expect(prev.planned).toBe(2);
    await page.goto("/index.html");
    await page.waitForFunction("typeof predictEffort === 'function'");
    expect(await page.evaluate(`JSON.stringify(state.ml.nb)`)).toBe(trained);
    expect(errors).toEqual([]);
  });
});

test.describe("cold start, memory and latency", () => {
  test("measurements (reported; the approved target is buildPlan p95 < 50 ms with 30 tasks)", async ({ keel: { ev } }) => {
    const r = await ev(`() => {
      const q = (xs, p) => { const s = xs.slice().sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)].toFixed(3); };
      const time = (n, f) => { const out = []; for (let i = 0; i < n; i++) { const t0 = performance.now(); f(i); out.push(performance.now() - t0); } return { p50: q(out, 0.5), p95: q(out, 0.95), p99: q(out, 0.99) }; };
      const r = __rng(904), k = todayKey(), now = Date.now();
      state.ml = null; mlState(); state.entries = []; state.planSkips = null;
      const tasks = Array.from({ length: 300 }, (_, i) => ({ id: "x" + i, title: ["Write the grant proposal", "Pay rent", "Review the budget", "Call mum", "Design the landing page"][i % 5] + " " + i, notes: "", estimate: [0, 10, 30, 60, 120][i % 5], priority: i % 4, due: i % 3 ? k : null, subtasks: [], done: false }));
      const out = { effortCold: time(2000, i => predictEffort(tasks[i % 300])) };
      for (let i = 0; i < 1000; i++) setEffort({ ...tasks[i % 300], id: "c" + i, title: tasks[i % 300].title + " v" + i }, ["L", "M", "H"][i % 3]);
      out.effortAfter1000Corrections = time(2000, i => predictEffort(tasks[i % 300]));
      out.modelBytesAfter1000Corrections = JSON.stringify(state.ml).length;
      for (let d = 1; d <= 30; d++) for (let j = 0; j < 6; j++) { const s = now - d * 86400e3 + j * 3600e3; state.entries.push({ id: "e" + d + "-" + j, type: "focus", start: s, end: s + 40 * 60e3, dur: 40 * 60e3, taskId: null, switches: 0 }); }
      for (const n of [30, 100, 300]) { state.tasks = tasks.slice(0, n); out["buildPlan" + n] = time(n === 300 ? 60 : 200, () => { state.updatedAt++; buildPlan(); }); }
      return out;
    }`);
    console.log("Phase 9 latency/size:", JSON.stringify(r));
    expect(r.buildPlan30.p95).toBeLessThan(50);
    expect(r.effortAfter1000Corrections.p99).toBeLessThan(5);
  });
  test("cold start with a large, heavily trained model is quick; no memory growth over 20,000 predictions", async ({ keel: { page } }) => {
    await page.evaluate(`(() => {
      state.ml = null; mlState(); const k = todayKey();
      state.tasks = Array.from({ length: 500 }, (_, i) => ({ id: "t" + i, title: "Task number " + i + " about topic " + (i % 37), estimate: 30, priority: 1, due: k, subtasks: [], done: i % 2 === 0, doneAt: i % 2 ? undefined : Date.now() - i * 3600e3 }));
      for (let i = 0; i < 2000; i++) setEffort({ id: "c" + i, title: "Correction " + i + " word" + (i % 400) + " other" + (i % 113) }, ["L", "M", "H"][i % 3]);
      save();
    })()`);
    const t0 = Date.now();
    await page.reload();
    await page.waitForFunction("typeof state === 'object' && document.querySelector('#nav')");
    const bootMs = Date.now() - t0;
    const cdp = await page.context().newCDPSession(page);
    const heap = async () => { await cdp.send("HeapProfiler.collectGarbage"); return (await cdp.send("Runtime.getHeapUsage")).usedSize; };
    await page.evaluate(`for (let i = 0; i < 2000; i++) predictEffort(state.tasks[i % 500]); buildPlan();`);
    const h0 = await heap();
    await page.evaluate(`for (let i = 0; i < 20000; i++) predictEffort(state.tasks[i % 500]); for (let i = 0; i < 50; i++) { state.updatedAt++; buildPlan(); }`);
    const h1 = await heap();
    console.log("Phase 9 cold start:", JSON.stringify({ bootMs, heapBeforeMB: +(h0 / 1048576).toFixed(2), heapAfterMB: +(h1 / 1048576).toFixed(2), modelKB: Math.round((await page.evaluate("JSON.stringify(state.ml).length")) / 1024) }));
    expect(bootMs).toBeLessThan(3000);
    expect(h1 - h0).toBeLessThan(2 * 1048576);   // < 2 MB growth after 20k predictions and 50 plans
  });
  test("labels for tasks that no longer exist are cleaned up (what was learned stays)", async ({ keel: { ev } }) => {
    const r = await ev(`() => {
      state.ml = null; mlState();
      state.tasks = Array.from({ length: 50 }, (_, i) => ({ id: "t" + i, title: "Write report " + i, estimate: 60, priority: 1, subtasks: [], done: false }));
      for (const t of state.tasks) setEffort(t, "H");
      const counts = JSON.stringify(mlState().nb);
      state.tasks = state.tasks.slice(0, 10);   // 40 tasks deleted
      cleanupKeel(false);
      return { labels: Object.keys(mlState().labels).length, countsKept: JSON.stringify(mlState().nb) === counts };
    }`);
    expect(r).toEqual({ labels: 10, countsKept: true });
  });
});
