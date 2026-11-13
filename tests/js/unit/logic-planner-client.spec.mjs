// Business-logic unit tests: planner (effort learning, durations, urgency, plan constraints, feedback) and the
// tracker client (status polling, pause/resume/cleanup calls, error states) against a fake tracker API.
import { test, expect } from "../fixtures/keel.mjs";
import { TRACKER, cors, preflight } from "../fixtures/tracker-guard.mjs";

const reset = `() => { state = normalize(null); state.updatedAt = 0; act = {}; actCache = {}; closeModal(); render(); }`;
const task = (id, title, extra = {}) => ({ id, title, projectId: null, priority: 0, due: null, estimate: 0, notes: "", subtasks: [], done: false, doneAt: null, createdAt: 1, ...extra });

test.describe("effort model", () => {
  test("lexicon prior: heavy, medium and light words", async ({ keel }) => {
    await keel.ev(reset);
    const out = await keel.ev(`ts => ts.map(t => { const p = predictEffort(t); return [p.best, p.sure, p.why.length > 0]; })`, [
      task("a", "Write the Q4 proposal draft"), task("b", "Reply to emails"), task("c", "Review notes"), task("d", "Untitled thing", { estimate: 180 }), task("e", "Pay bill", { estimate: 10 })
    ]);
    expect(out.map(o => o[0])).toEqual(["H", "L", "M", "H", "L"]);
    for (const [, sure] of out) expect(["likely", "probably", "unsure"]).toContain(sure);
    expect(out[0][2]).toBe(true);
  });
  test("probabilities are a valid distribution, even for empty or huge input", async ({ keel }) => {
    const out = await keel.ev(`ts => ts.map(t => { const p = predictEffort(t).p; return p.L + p.M + p.H; })`, [task("a", ""), task("b", "x ".repeat(5000)), task("c", "🙂🙂"), task("d", "Write", { notes: "n".repeat(10000) })]);
    for (const s of out) expect(s).toBeCloseTo(1, 6);
  });
  test("user corrections are learned and can be undone", async ({ keel }) => {
    await keel.ev(reset);
    const out = await keel.ev(`() => {
      const mk = i => ({ id: "c" + i, title: "Groom backlog item " + i, projectId: null, priority: 0, estimate: 0, subtasks: [], notes: "" });
      const before = predictEffort(mk(99)).best;
      for (let i = 0; i < 6; i++) { const t = mk(i); state.tasks.push(t); setEffort(t, "H"); }
      const after = predictEffort(mk(99)).best;
      const t0 = state.tasks[0]; setEffort(t0, null);
      return { before, after, cleared: t0.energy === undefined, explicit: effortOf(state.tasks[1]), labels: Object.keys(mlState().labels).length };
    }`);
    expect(out.before).not.toBe("H");
    expect(out.after).toBe("H");
    expect(out.cleared).toBe(true);
    expect(out.explicit).toBe("H");
    expect(out.labels).toBe(5);
  });
  test("finished tasks teach effort from real tracked time, but never override the user", async ({ keel }) => {
    await keel.ev(reset);
    const out = await keel.ev(`() => {
      const a = { id: "a", title: "Mystery", done: true, estimate: 0, subtasks: [] }, b = { id: "b", title: "Other", done: true, estimate: 0, subtasks: [] }, c = { id: "c", title: "Tiny", done: true, subtasks: [] };
      state.tasks.push(a, b, c);
      state.entries.push({ type: "focus", taskId: "a", dur: 100 * MIN }, { type: "focus", taskId: "b", dur: 50 * MIN }, { type: "focus", taskId: "c", dur: 2 * MIN });
      setEffort(b, "L");
      learnFromDone(a); learnFromDone(b); learnFromDone(c);
      const L = mlState().labels;
      return { a: L.a, b: L.b, c: L.c || null };
    }`);
    expect(out.a).toMatchObject({ label: "H", src: "actual", w: 0.5 });
    expect(out.b).toMatchObject({ label: "L", src: "user" });
    expect(out.c).toBeNull();
  });
});

test.describe("duration model", () => {
  test("cold start applies the planning-fallacy multiplier by estimate size", async ({ keel }) => {
    await keel.ev(reset);
    const out = await keel.ev(`ts => ts.map(t => predictDuration(t).min)`, [task("a", "Pay bill", { estimate: 20 }), task("b", "Write report", { estimate: 120 }), task("c", "Write report"), task("d", "Reply email")]);
    expect(out).toEqual([25, 180, 120, 15]);
  });
  test("learns this user's real overrun from finished tasks (shrinks toward the prior)", async ({ keel }) => {
    await keel.ev(reset);
    const out = await keel.ev(`() => {
      for (let i = 0; i < 12; i++) { state.tasks.push({ id: "d" + i, title: "Review chapter " + i, estimate: 30, done: true, subtasks: [] }); state.entries.push({ type: "focus", taskId: "d" + i, dur: 60 * MIN }); }
      state.updatedAt = Date.now();
      return predictDuration({ id: "n", title: "Review chapter new", estimate: 30, subtasks: [] }).min;
    }`);
    expect(out).toBeGreaterThan(40);   // user runs 2× over; prior alone would give 40
    expect(out).toBeLessThanOrEqual(90);
  });
  test("durations stay within 5 minutes to 8 hours", async ({ keel }) => {
    const out = await keel.ev(`ts => ts.map(t => predictDuration(t).min)`, [task("a", "x", { estimate: 1 }), task("b", "x", { estimate: 100000 })]);
    expect(out[0]).toBeGreaterThanOrEqual(5);
    expect(out[1]).toBeLessThanOrEqual(480);
  });
});

test.describe("urgency and energy", () => {
  test("urgency rises toward the deadline and caps when overdue", async ({ keel }) => {
    const out = await keel.ev(`() => [urgencyOf({ due: null }, Date.now()), urgencyOf({ due: "2026-11-09" }, Date.now()), urgencyOf({ due: "2026-11-10" }, Date.now()), urgencyOf({ due: "2026-11-12" }, Date.now()), urgencyOf({ due: "2026-11-30" }, Date.now())]`);
    expect(out[0]).toBe(1);
    expect(out[1]).toBe(20);
    expect(out[2]).toBeGreaterThan(out[3]);
    expect(out[3]).toBeGreaterThan(out[4]);
    expect(out[4]).toBeLessThan(1);
  });
  test("energy curve: 24 values in [0,1], peak late morning by default, shifts with chronotype", async ({ keel }) => {
    await keel.ev(reset);
    const out = await keel.ev(`() => { const peak = c => c.indexOf(Math.max(...c)); const a = energyCurve(); mlState().chrono = "evening"; state.updatedAt++; const b = energyCurve(); return { len: a.curve.length, min: Math.min(...a.curve), max: Math.max(...a.curve), peakA: peak(a.curve), peakB: peak(b.curve), days: a.learnedDays }; }`);
    expect(out.len).toBe(24);
    expect(out.min).toBeGreaterThanOrEqual(0);
    expect(out.max).toBeCloseTo(1, 6);
    expect(out.peakA).toBeGreaterThanOrEqual(9);
    expect(out.peakA).toBeLessThanOrEqual(11);
    expect(out.peakB).toBeGreaterThan(out.peakA);
    expect(out.days).toBe(0);
  });
});

test("energy curve learns from this user's focus sessions and app activity (recent days weigh more)", async ({ keel }) => {
  await keel.ev(reset);
  const out = await keel.ev(`() => {
    const before = energyCurve().curve.slice();
    for (let d = 1; d <= 10; d++) {
      const day = addDays(todayKey(), -d), s = dayStart(day) + 20 * HOUR;
      state.entries.push({ id: "f" + d, type: "focus", start: s, end: s + 90 * MIN, dur: 90 * MIN });
      act[day] = [{ s: dayStart(day) + 9 * HOUR, e: dayStart(day) + 10 * HOUR, app: "Google Chrome", domain: "youtube.com" }, { s: dayStart(day) + 20 * HOUR, e: dayStart(day) + 21 * HOUR, app: "Code" }];
    }
    state.updatedAt = Date.now(); actCache = {};
    const after = energyCurve();
    return { b20: before[20], a20: after.curve[20], b9: before[9], a9: after.curve[9], days: after.learnedDays };
  }`);
  expect(out.days).toBe(10);
  expect(out.a20).toBeGreaterThan(out.b20);           // evening focus learned
  expect(out.a9).toBeLessThan(out.b9);                // distracting mornings learned
});

test("adding a task shows Keel's analysis: effort, realistic length and best hour", async ({ keel }) => {
  await keel.ev(reset);
  await keel.page.locator('#nav [data-view="tasks"]').click();
  await keel.page.locator("#qa-input").fill("Write investor update #work 60m");
  await keel.page.locator("#qa-input").press("Enter");
  const ins = await keel.ev(`() => { const i = insightFor(state.tasks[0]); return { ...i, text: \`looks \${EFF_LABEL[i.eff].toLowerCase()}, about \${fmtDur(i.min * MIN)}. Best around \${hourLabel(i.bestH)}.\` }; }`);
  await expect(keel.page.locator("#toasts")).toContainText(`Added “Write investor update”: ${ins.text}`);   // toast shows exactly the model's analysis
  expect(["L", "M", "H"]).toContain(ins.eff);
  expect(ins.min).toBeGreaterThanOrEqual(60);                                   // with no history yet, never shorter than the estimate
  expect(ins.bestH).toBeGreaterThanOrEqual(8);
  expect(ins.bestH).toBeLessThan(19);
});

test.describe("plan builder", () => {
  const twelve = [
    ["Write Q4 proposal", { priority: 3, due: "2026-11-10", estimate: 90 }], ["Reply to client emails", { due: "2026-11-10", estimate: 15 }],
    ["Pay electricity bill", { due: "2026-11-10" }], ["Design landing page", { due: "2026-11-10", estimate: 120 }], ["Call mum", { due: "2026-11-10" }],
    ["Read ML chapter", { due: "2026-11-10", estimate: 45 }], ["Review pull requests", { due: "2026-11-10", estimate: 30 }], ["Book dentist", { due: "2026-11-11" }],
    ["Prepare pitch deck", { priority: 3, due: "2026-11-11" }], ["Organize files", {}], ["Overdue invoice", { due: "2026-11-08", estimate: 20 }], ["Done already", { done: true }]
  ].map(([t, x], i) => task("t" + i, t, x));
  const build = `ts => { state.tasks = ts; state.plan = null; state.planSkips = null; const p = buildPlan(); return p; }`;
  test("hard constraints: no overlaps, starts at now, overdue first, parts in order, no done tasks", async ({ keel }) => {
    await keel.ev(reset);
    const p = await keel.ev(build, twelve);
    const now = Date.UTC(2026, 10, 10, 10, 0);
    expect(p.items[0].start).toBeGreaterThanOrEqual(now);
    for (let i = 1; i < p.items.length; i++) expect(p.items[i].start).toBeGreaterThanOrEqual(p.items[i - 1].end);
    const tasks = p.items.filter(i => i.kind === "task");
    expect(tasks[0].taskId).toBe("t10");                                         // overdue first
    expect(tasks.some(i => i.taskId === "t11")).toBe(false);                      // done tasks never planned
    const parts = {};
    for (const it of tasks) { if (it.parts > 1) { expect(it.part).toBe((parts[it.taskId] || 0) + 1); parts[it.taskId] = it.part; } }
    for (const it of tasks) expect(it.dur).toBeLessThanOrEqual(100);                // long tasks split into ≤ ~90-min blocks
    for (const it of p.items) expect(typeof it.reason).toBe("string");
  });
  test("breaks follow long focus; lunch is inserted around 12:30", async ({ keel }) => {
    await keel.ev(reset);
    const p = await keel.ev(build, twelve);
    let run = 0;
    for (const it of p.items) {
      if (it.kind === "break") { run = 0; continue; }
      run += it.dur;
      expect(run).toBeLessThanOrEqual(75 + 100);                                  // a break comes once a run passes 75 min (plus the block that crossed it)
    }
    expect(p.items.some(i => i.kind === "break" && /Lunch/.test(i.reason))).toBe(true);
  });
  test("tasks due later than 2 days ahead aren't planned today; skipped tasks are excluded", async ({ keel }) => {
    await keel.ev(reset);
    const out = await keel.ev(`ts => { state.tasks = ts; state.planSkips = { day: todayKey(), ids: ["t1"] }; const p = buildPlan(); return p.items.filter(i => i.kind === "task").map(i => i.taskId); }`,
      [task("t0", "Write essay", { due: "2026-11-20", estimate: 30 }), task("t1", "Reply emails", { due: "2026-11-10" }), task("t2", "Read", { due: "2026-11-12", estimate: 30 })]);
    expect(out).toEqual(["t2"]);
  });
  test("an empty list gives an empty plan; after the workday tasks move to 'doesn't fit today'", async ({ keel }) => {
    await keel.ev(reset);
    expect((await keel.ev(build, [])).items).toEqual([]);
    await keel.page.clock.setFixedTime(new Date("2026-11-10T21:00:00Z"));
    const p = await keel.ev(build, [task("a", "Late task", { due: "2026-11-10", estimate: 30 })]);
    expect(p.items).toEqual([]);
    expect(p.later).toEqual(["a"]);
  });
  test("reordering nudges weights within bounds; plan actions work", async ({ keel }) => {
    await keel.ev(reset);
    await keel.ev(build, twelve);
    await keel.ev(`() => { state.plan = buildPlan(); render(); }`);
    await keel.page.locator('#nav [data-view="tasks"]').click();
    const w0 = await keel.ev(`() => ({ ...mlState().w })`);
    await keel.page.locator('[data-act="plan-move"][data-d="-1"]').nth(1).click();
    const w1 = await keel.ev(`() => ({ ...mlState().w })`);
    expect(w1).not.toEqual(w0);
    for (const k of ["prio", "energy", "quick"]) { expect(w1[k]).toBeGreaterThanOrEqual(0.1); expect(w1[k]).toBeLessThanOrEqual(3); expect(Math.abs(w1[k] - w0[k])).toBeLessThanOrEqual(0.08 + 1e-9); }
    const firstTask = await keel.ev(`() => state.plan.items.find(i => i.kind === "task").taskId`);
    await keel.page.locator(`[data-act="plan-skip"][data-id="${firstTask}"]`).first().click();   // split tasks have one button per part
    expect(await keel.ev(`id => state.plan.items.some(i => i.taskId === id)`, firstTask)).toBe(false);
    await keel.page.locator('[data-act="plan-accept"]').click();
    expect(await keel.ev(`() => [state.plan.accepted, planForDay(todayKey()).length > 0]`)).toEqual([true, true]);
    await keel.page.locator('[data-act="plan-clear"]').click();
    expect(await keel.ev(`() => state.plan`)).toBeNull();
  });
  test("effort chip cycles Light → Medium → Heavy and trains the model", async ({ keel }) => {
    await keel.ev(reset);
    await keel.ev(`t => { state.tasks = [t]; render(); }`, task("x", "Something", { due: "2026-11-10" }));
    await keel.page.locator('#nav [data-view="tasks"]').click();
    const chip = keel.page.locator('.task [data-act="effort"]');
    const seen = [];
    for (let i = 0; i < 3; i++) { await chip.click(); seen.push(await keel.ev(`() => state.tasks[0].energy`)); }
    expect(new Set(seen).size).toBe(3);
    expect(await keel.ev(`() => mlState().labels.x.src`)).toBe("user");
  });
});

test.describe("tracker client", () => {
  const STATUS = { app: "keel-tracker", version: 2, running: true, paused: false, pausedUntil: null, startedAt: 1, current: { app: "Code", domain: "" }, idle: false, todayMs: 60000, device: "Mac", now: 1, storage: { fileBytes: 2048, logBytes: 10, keepDays: 30, maxFileMb: 20, days: 1, lastCleanup: null } };
  const ACTIVITY = { source: "keel-tracker", version: 2, device: "Mac", updatedAt: 1, days: { "2026-11-10": [{ s: Date.UTC(2026, 10, 10, 9), e: Date.UTC(2026, 10, 10, 9, 30), app: "Code" }] } };
  async function fakeTracker(page, handler) {
    await page.route(TRACKER, async route => {
      if (await preflight(route)) return;
      const r = await handler(route.request());
      if (r === "abort") return route.abort("connectionrefused");
      return route.fulfill({ headers: cors(route.request()), status: r.status || 200, contentType: "application/json", body: JSON.stringify(r.body) });
    });
  }
  test("online: status and activity load, widget shows recording", async ({ keel }) => {
    await keel.ev(reset);
    await fakeTracker(keel.page, req => req.url().includes("/activity") ? { body: ACTIVITY } : { body: STATUS });
    await keel.ev(`() => trPoll(true)`);
    expect(await keel.ev(`() => [TR.state, Object.keys(act)]`)).toEqual(["online", ["2026-11-10"]]);
    await expect(keel.page.locator("#trk")).toContainText("Tracking apps");
    await expect(keel.page.locator("#trk")).toContainText("Now: Code");
  });
  test("pause, resume and cleanup send the right requests", async ({ keel }) => {
    await keel.ev(reset);
    const posts = [];
    await fakeTracker(keel.page, req => {
      if (req.method() === "POST") { posts.push([new URL(req.url()).pathname, req.postData()]); const paused = req.url().endsWith("/pause"); return { body: { ...STATUS, paused, pausedUntil: paused ? Date.now() + 3600000 : null, removedDays: 2 } }; }
      return req.url().includes("/activity") ? { body: ACTIVITY } : { body: STATUS };
    });
    await keel.ev(`() => trPoll(true)`);
    await keel.page.locator('#trk [data-act="tr-menu"]').click();
    await keel.page.locator('#trk [data-act="tr-pause"][data-min="60"]').click();
    await expect(keel.page.locator("#trk")).toContainText("Paused until");
    await keel.page.locator('#trk [data-act="tr-resume"]').click();
    await expect(keel.page.locator("#trk")).toContainText("Tracking apps");
    await keel.ev(`() => A["tr-cleanup"]()`);
    await expect(keel.page.locator("#toasts")).toContainText("removed 2 old days");
    expect(posts.map(p => p[0])).toEqual(["/pause", "/resume", "/cleanup"]);
    expect(JSON.parse(posts[0][1])).toEqual({ minutes: 60 });
  });
  test("blocked (403) and offline states explain what to do", async ({ keel }) => {
    await keel.ev(reset);
    await fakeTracker(keel.page, () => ({ status: 403, body: { error: "not allowed" } }));
    await keel.ev(`() => trPoll(false)`);
    expect(await keel.ev(`() => TR.state`)).toBe("blocked");
    await expect(keel.page.locator("#trk")).toContainText("isn't allowed");
    await keel.page.unroute(TRACKER);
    await fakeTracker(keel.page, () => "abort");
    await keel.ev(`() => trPoll(false)`);
    expect(await keel.ev(`() => TR.state`)).toBe("offline");
    await expect(keel.page.locator("#trk")).toContainText("Not running on this computer");
    await keel.ev(`() => trPost("/pause")`);
    await expect(keel.page.locator("#toasts")).toContainText("Couldn't reach the tracker");
  });
  test("bug 13: malformed activity keeps the tracker 'online' and says what went wrong", async ({ keel }) => {
    await keel.ev(reset);
    await fakeTracker(keel.page, req => req.url().includes("/activity") ? { body: { not: "keel" } } : { body: STATUS });
    await keel.ev(`() => trPoll(true)`);
    expect(await keel.ev(`() => TR.state`)).toBe("online");
    await expect(keel.page.locator("#trk")).toContainText("Tracking apps");
    await expect(keel.page.locator("#trk")).toContainText("couldn't read");
    await keel.page.unroute(TRACKER);
    await fakeTracker(keel.page, req => req.url().includes("/activity") ? { body: ACTIVITY } : { body: STATUS });
    await keel.ev(`() => trPoll(true)`);
    await expect(keel.page.locator("#trk")).not.toContainText("couldn't read");
  });
  test("bug 12: on a short window the sidebar scrolls so every Pause option can be clicked", async ({ keel }) => {
    await keel.page.setViewportSize({ width: 1280, height: 640 });
    await keel.ev(reset);
    await fakeTracker(keel.page, req => req.url().includes("/activity") ? { body: ACTIVITY } : { body: STATUS });
    await keel.ev(`() => trPoll(true)`);
    await keel.page.locator('#trk [data-act="tr-menu"]').click();
    for (const m of ["15", "60", "0"]) await expect(keel.page.locator(`#trk [data-act="tr-pause"][data-min="${m}"]`)).toBeVisible();
    await keel.page.locator('#trk [data-act="tr-pause"][data-min="0"]').scrollIntoViewIfNeeded();
    const box = await keel.page.locator('#trk [data-act="tr-pause"][data-min="0"]').boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(640);
  });
  test("a hung tracker times out instead of hanging the page", async ({ keel }) => {
    await keel.ev(reset);
    await keel.page.route(TRACKER, () => {});                      // never answers
    const t0 = Date.now();
    await keel.page.clock.install({ time: new Date("2026-11-10T10:00:00Z") });
    const p = keel.ev(`() => trPoll(false).then(() => TR.state)`);
    await keel.page.clock.runFor(3500);
    expect(await p).toBe("offline");
    expect(Date.now() - t0).toBeLessThan(15000);
  });
});
