// Phase 4: data integrity for Keel's browser storage (adapted from "database" tests).
// Migrations, validation ("constraints"), cascades, all-or-nothing writes, hidden completed items,
// performance on realistic volumes, backup → restore, and account-sync merge rules.
import { test, expect } from "../fixtures/keel.mjs";
import { guardTracker } from "../fixtures/tracker-guard.mjs";

const reset = `() => { localStorage.clear(); state = normalize(null); state.updatedAt = 0; act = {}; actCache = {}; closeModal(); render(); }`;
const VIEWS = ["today", "focus", "tasks", "timeline", "apps", "reports", "projects", "settings"];
async function renderAll(keel) {
  const errors = [];
  keel.page.on("pageerror", e => errors.push(e.message));
  for (const v of VIEWS) await keel.ev(`v => { ui.view = v; render(); }`, v);
  return errors;
}

test.describe("migrations", () => {
  test("a state saved by the first Keel version (no settings.v2, no ml/plan/activity fields) loads and upgrades", async ({ keel }) => {
    const v1 = { v: 1, updatedAt: 5, projects: [{ id: "p_work", name: "Work", slot: 0 }], tasks: [{ id: "t", title: "Old task", projectId: "p_work", priority: 2, due: "2026-11-10", estimate: 30, notes: "", subtasks: [], done: false, doneAt: null, createdAt: 1 }], entries: [{ id: "e", type: "focus", start: Date.UTC(2026, 10, 10, 8), end: Date.UTC(2026, 10, 10, 9), dur: 3600000, projectId: "p_work", taskId: "t", note: "", switches: 0 }], active: null, settings: { dailyGoalMin: 300, theme: "auto" } };
    await keel.page.evaluate(s => localStorage.setItem("keel.v1", JSON.stringify(s)), v1);
    await keel.page.reload();
    const out = await keel.ev(`() => ({ tasks: state.tasks.length, entries: state.entries.length, goal: state.settings.dailyGoalMin, theme: state.settings.theme, v2: state.settings.v2, keep: state.settings.actKeepDays, rules: state.appRules, work: dayStats(todayKey()).work })`);
    expect(out).toEqual({ tasks: 1, entries: 1, goal: 300, theme: "dark", v2: true, keep: 30, rules: {}, work: 3600000 });
    expect(await renderAll(keel)).toEqual([]);
  });
  test("migration is idempotent and every field survives a save → reload round trip", async ({ keel }) => {
    await keel.ev(reset);
    const out = await keel.ev(`() => {
      state.tasks.push({ id: "a", title: "T", done: false, createdAt: 1, energy: "H", subtasks: [{ id: "s", title: "step", done: true }] });
      state.entries.push({ id: "e", type: "work", start: 1, end: 2, dur: 1 });
      state.appRules["a:Code"] = { cat: "design", projectId: "p_work" };
      state.actMeta = { importedAt: 1, device: "Mac", source: "file" };
      mlState().w.prio = 1.7; state.plan = { day: todayKey(), items: [], later: [], accepted: true }; state.planSkips = { day: todayKey(), ids: ["x"] }; state.lastCleanup = 123;
      save();
      const once = JSON.stringify(normalize(JSON.parse(localStorage.getItem(LS_KEY))));
      const twice = JSON.stringify(normalize(JSON.parse(once)));
      return { same: once === twice, before: JSON.stringify(state), after: once };
    }`);
    expect(out.same).toBe(true);
    expect(JSON.parse(out.after)).toEqual(JSON.parse(out.before));
  });
  test("activity stored by the previous Keel version (keel.act.v1) is moved to the compact format once", async ({ keel }) => {
    await keel.page.evaluate(() => { localStorage.clear(); localStorage.setItem("keel.act.v1", JSON.stringify({ "2026-11-10": [{ s: Date.UTC(2026, 10, 10, 9), e: Date.UTC(2026, 10, 10, 10), app: "Code" }, { s: 1, e: 0, app: "bad" }] })); });
    await keel.page.reload();
    const out = await keel.ev(`() => ({ act, v1: localStorage.getItem("keel.act.v1"), v2: JSON.parse(localStorage.getItem("keel.act.v2")).v })`);
    expect(out.act).toEqual({ "2026-11-10": [{ s: Date.UTC(2026, 10, 10, 9), e: Date.UTC(2026, 10, 10, 10), app: "Code" }] });
    expect(out.v1).toBeNull();
    expect(out.v2).toBe(2);
  });
  test("an activity file from tracker version 1 (no version / tzOffset fields) is accepted", async ({ keel }) => {
    await keel.ev(reset);
    const n = await keel.ev(`f => { importActivity(f, true); return act["2026-11-10"].length; }`, { source: "keel-tracker", days: { "2026-11-10": [{ s: Date.UTC(2026, 10, 10, 9), e: Date.UTC(2026, 10, 10, 10), app: "Code" }] } });
    expect(n).toBe(1);
  });
});

test.describe("rollback", () => {
  // tests/js/fixtures/prev/index.html is the previous release (end of Phase 3), kept to prove data survives a downgrade.
  test("the previous version opens data saved by this version without errors, and nothing is lost coming back", async ({ keel }) => {
    const errors = [];
    keel.page.on("pageerror", e => errors.push(e.message));
    await keel.ev(reset);
    const saved = await keel.ev(`() => { state.tasks.push({ id: "t", title: "Rollback task", done: false, createdAt: 1 }); state.entries.push({ id: "e", type: "work", start: Date.now() - HOUR, end: Date.now(), dur: HOUR }); act[todayKey()] = [{ s: Date.now() - HOUR, e: Date.now() - 30*MIN, app: "Code" }, { s: Date.now() - 30*MIN, e: Date.now(), app: "Safari", domain: "x.com", title: "Hi" }]; saveAct(); save(); return JSON.stringify(act); }`);
    await keel.page.goto("/tests/js/fixtures/prev/index.html");
    for (const v of ["today", "focus", "tasks", "timeline", "apps", "reports", "projects", "settings"]) await keel.page.evaluate(`ui.view = "${v}"; render();`);
    expect(await keel.page.evaluate("[state.tasks.length, state.entries.length]")).toEqual([1, 1]);
    await keel.page.evaluate(`state.tasks.push({ id: "t2", title: "Added in previous version", done: false, createdAt: 2 }); save(); saveAct(); cleanupKeel(false);`);
    await keel.page.goto("/index.html");
    expect(await keel.ev(`() => state.tasks.map(t => t.id)`)).toEqual(["t", "t2"]);
    expect(await keel.ev(`() => JSON.stringify(act)`)).toBe(saved);
    expect(errors).toEqual([]);
  });
});

test.describe("validation of restored and stored data (constraints)", () => {
  test("restore rejects files that aren't Keel backups and changes nothing", async ({ keel }) => {
    await keel.ev(reset);
    await keel.ev(`() => { state.tasks.push({ id: "keep", title: "Keep me", done: false, createdAt: 1 }); save(); }`);
    await keel.page.locator('#nav [data-view="settings"]').click();
    for (const bad of ["", "not json", "[]", '{"tasks": {}}', '{"tasks": [], "entries": "x"}', "null"]) {
      await keel.page.locator('[data-act="import"]').click();
      await keel.page.locator('.modal textarea[name="j"]').fill(bad);
      await keel.page.locator(".modal button.primary").click();
      await expect(keel.page.locator("#imp-err")).toContainText("doesn't look like a Keel backup");
      await keel.page.locator('.modal [data-act="modal-close"]').click();
    }
    expect(await keel.ev(`() => state.tasks.map(t => t.id)`)).toEqual(["keep"]);
  });
  test("a backup with malformed records restores without breaking any page", async ({ keel }) => {
    await keel.ev(reset);
    const backup = { tasks: [null, 5, { title: 7 }, { id: "ok", title: "Fine", done: false, createdAt: 1 }], entries: [{}, null, { id: "e", type: "nope", start: "x", end: null, dur: -5 }], projects: [null, { name: "No id" }], settings: { dailyGoalMin: "lots", workStart: 99 } };
    await keel.page.locator('#nav [data-view="settings"]').click();
    await keel.page.locator('[data-act="import"]').click();
    await keel.page.locator('.modal textarea[name="j"]').fill(JSON.stringify(backup));
    await keel.page.locator(".modal button.primary").click();
    expect(await renderAll(keel)).toEqual([]);
    const out = await keel.ev(`() => ({ tasks: state.tasks.every(t => t && typeof t === "object" && typeof t.id === "string" && typeof t.title === "string"), entries: state.entries.every(e => e && Number.isFinite(e.start) && Number.isFinite(e.end) && e.dur >= 0), goal: Number.isFinite(state.settings.dailyGoalMin), start: state.settings.workStart <= 23 })`);
    expect(out).toEqual({ tasks: true, entries: true, goal: true, start: true });
  });
  test("settings inputs are clamped to their allowed ranges", async ({ keel }) => {
    await keel.ev(reset);
    await keel.page.locator('#nav [data-view="settings"]').click();
    for (const [f, v, expected] of [["focusMin", "0", 5], ["focusMin", "999", 180], ["workStart", "-3", 0], ["dailyGoalMin", "100000", 960]]) {
      const input = keel.page.locator(`#set-${f}`);
      await input.fill(v); await input.press("Tab");
      expect(await keel.ev(`f => state.settings[f]`, f)).toBe(expected);
    }
    await keel.page.locator("#set-workStart").fill("20"); await keel.page.locator("#set-workStart").press("Tab");
    await keel.page.locator("#set-workEnd").fill("10"); await keel.page.locator("#set-workEnd").press("Tab");
    expect(await keel.ev(`() => state.settings.workEnd > state.settings.workStart`)).toBe(true);
  });
});

test.describe("relationships and cascades", () => {
  test("deleting a project keeps its tasks and time, shown as 'No project'", async ({ keel }) => {
    await keel.ev(reset);
    await keel.ev(`() => { state.tasks.push({ id: "t", title: "Task", projectId: "p_learn", done: false, createdAt: 1 }); state.entries.push({ id: "e", type: "focus", start: Date.now() - HOUR, end: Date.now(), dur: HOUR, projectId: "p_learn" }); ui.taskProject = "p_learn"; render(); }`);
    await keel.page.locator('#nav [data-view="projects"]').click();
    await keel.page.locator('[data-act="del-proj"][data-id="p_learn"]').click();
    await keel.page.locator('[data-act="confirm-yes"]').click();
    const out = await keel.ev(`() => ({ proj: !!projById("p_learn"), taskProj: state.tasks[0].projectId, entries: state.entries.length, entryProj: projName(state.entries[0].projectId), filter: ui.taskProject, byProj: dayStats(todayKey()).byProj })`);
    expect(out).toEqual({ proj: false, taskProj: null, entries: 1, entryProj: "No project", filter: "all", byProj: { _none: 3600000 } });
    expect(await renderAll(keel)).toEqual([]);
  });
  test("deleting a task keeps its logged time, detaches the running session and drops it from the plan", async ({ keel }) => {
    await keel.ev(reset);
    await keel.ev(`() => {
      state.tasks.push({ id: "t", title: "Gone soon", due: todayKey(), done: false, createdAt: 1, subtasks: [] }, { id: "u", title: "Stays", due: todayKey(), done: false, createdAt: 2, subtasks: [] });
      state.entries.push({ id: "e", type: "focus", start: Date.now() - HOUR, end: Date.now() - 30*MIN, dur: 30*MIN, taskId: "t" });
      startSession({ type: "focus", mode: "open", taskId: "t" });
      state.plan = buildPlan(); state.plan.accepted = true; ui.view = "tasks"; ui.expanded = "t"; render();
    }`);
    await keel.page.locator('[data-act="del-task"][data-id="t"]').click();
    await keel.page.locator('[data-act="confirm-yes"]').click();
    const out = await keel.ev(`() => ({ tasks: state.tasks.map(t => t.id), entryTask: state.entries[0].taskId, activeTask: state.active.taskId, planned: planForDay(todayKey()).map(i => i.taskId) })`);
    expect(out.tasks).toEqual(["u"]);
    expect(out.entryTask).toBe("t");
    expect(out.activeTask).toBeNull();
    expect(out.planned).not.toContain("t");
    expect(await renderAll(keel)).toEqual([]);
    await keel.ev(`() => { ui.view = "reports"; render(); }`);
    await expect(keel.page.locator("#view")).toContainText("Deleted task");
  });
  test("erase everything clears tasks, time, activity, learning and plans", async ({ keel }) => {
    await keel.ev(reset);
    await keel.ev(`() => { state.tasks.push({ id: "t", title: "x", done: false, createdAt: 1 }); state.entries.push({ id: "e", type: "work", start: 1, end: 2, dur: 1 }); act = { "2026-11-10": [{ s: 1, e: 5000, app: "A" }] }; saveAct(); mlState().w.prio = 2; state.plan = { day: todayKey(), items: [] }; save(); }`);
    await keel.page.locator('#nav [data-view="settings"]').click();
    await keel.page.locator('[data-act="reset"]').click();
    await keel.page.locator('[data-act="confirm-yes"]').click();
    await keel.page.reload();
    const out = await keel.ev(`() => ({ tasks: state.tasks.length, entries: state.entries.length, act: Object.keys(act).length, w: mlState().w, labels: Object.keys(mlState().labels).length, docs: mlState().nb.docs, plan: state.plan })`);
    expect(out).toEqual({ tasks: 0, entries: 0, act: 0, w: { prio: 1, energy: 1.2, switch: 0.35, quick: 0.6, urgency: 1 }, labels: 0, docs: { L: 0, M: 0, H: 0 }, plan: null });   // learning back to a fresh model
  });
});

test.describe("all-or-nothing writes", () => {
  test("when browser storage is full, Keel keeps working and tells the user their changes aren't being saved", async ({ keel }) => {
    await keel.ev(reset);
    await keel.page.evaluate(() => { const real = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (String(k).startsWith("keel")) throw new DOMException("Quota exceeded", "QuotaExceededError"); return real.call(this, k, v); }; });
    const errors = [];
    keel.page.on("pageerror", e => errors.push(e.message));
    await keel.page.locator('#nav [data-view="tasks"]').click();
    await keel.page.locator("#qa-input").fill("Pay rent");
    await keel.page.locator("#qa-input").press("Enter");
    expect(errors).toEqual([]);
    expect(await keel.ev(`() => state.tasks.length`)).toBe(1);
    await expect(keel.page.locator("body")).toContainText(/storage is full|couldn't save|not being saved/i);
  });
  test("a failed restore leaves the current data untouched (no half-applied state)", async ({ keel }) => {
    await keel.ev(reset);
    await keel.ev(`() => { state.tasks.push({ id: "keep", title: "Keep", done: false, createdAt: 1 }); save(); }`);
    const before = await keel.ev(`() => localStorage.getItem(LS_KEY)`);
    await keel.page.locator('#nav [data-view="settings"]').click();
    await keel.page.locator('[data-act="import"]').click();
    await keel.page.locator('.modal textarea[name="j"]').fill('{"tasks": [], "entries": [], "settings": ');
    await keel.page.locator(".modal button.primary").click();
    expect(await keel.ev(`() => localStorage.getItem(LS_KEY)`)).toBe(before);
  });
  test("the running session survives a reload exactly", async ({ keel }) => {
    await keel.ev(reset);
    await keel.ev(`() => { startSession({ type: "focus", mode: "pomodoro", minutes: 25, projectId: "p_work" }); state.active.start -= 10 * MIN; pauseSession(); save(); }`);
    const before = await keel.ev(`() => JSON.stringify(state.active)`);
    await keel.page.reload();
    expect(await keel.ev(`() => JSON.stringify(state.active)`)).toBe(before);
  });
});

test.describe("completed items are hidden where they should be", () => {
  test("done tasks leave Today, Upcoming, All open, Due today, the planner, the timer picker and the log-time picker", async ({ keel }) => {
    await keel.ev(reset);
    await keel.ev(`() => { state.tasks.push({ id: "d", title: "Finished thing", due: todayKey(), done: true, doneAt: Date.now() - DAY, createdAt: 1, subtasks: [] }, { id: "o", title: "Open thing", due: todayKey(), done: false, createdAt: 2, subtasks: [] }); save(); }`);
    const shows = async (view, extra = "") => { await keel.ev(`v => { ui.view = v; ${extra} render(); }`, view); return (await keel.page.locator("#view").innerText()).includes("Finished thing"); };
    expect(await shows("tasks", `ui.taskFilter = "today";`)).toBe(false);
    expect(await shows("tasks", `ui.taskFilter = "open";`)).toBe(false);
    expect(await shows("tasks", `ui.taskFilter = "upcoming";`)).toBe(false);
    expect(await shows("tasks", `ui.taskFilter = "done";`)).toBe(true);
    expect(await shows("today")).toBe(false);
    expect(await shows("focus")).toBe(false);
    expect(await keel.ev(`() => buildPlan().items.some(i => i.taskId === "d")`)).toBe(false);
    await keel.page.keyboard.press("l");
    expect(await keel.page.locator('.modal select[name="taskId"] option').allInnerTexts()).not.toContain("Finished thing");
  });
});

test.describe("volume: a heavy year of data", () => {
  test("1 year of sessions, 600 tasks and 30 heavy activity days stay fast and within storage limits", async ({ keel }) => {
    test.setTimeout(120_000);
    await keel.ev(reset);
    const sizes = await keel.ev(`() => {
      let seed = 20261110; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
      for (let i = 0; i < 600; i++) state.tasks.push({ id: "t" + i, title: "Task number " + i + " about writing reports", projectId: ["p_work","p_learn","p_personal"][i % 3], priority: i % 4, due: addDays(todayKey(), (i % 20) - 10), estimate: 15 + (i % 8) * 15, notes: "", subtasks: [], done: i % 3 === 0, doneAt: i % 3 === 0 ? Date.now() - (i % 30) * DAY : null, createdAt: i });
      for (let d = 0; d < 365; d++) for (let j = 0; j < 10; j++) { const s = dayStart(addDays(todayKey(), -d)) + (8 + j) * HOUR; state.entries.push({ id: "e" + d + "_" + j, type: ["focus","work","meeting","break"][j % 4], start: s, end: s + 45 * MIN, dur: 45 * MIN, projectId: "p_work", taskId: "t" + ((d * 10 + j) % 600), note: "", switches: j % 3 }); }
      const apps = ["Code", "Google Chrome", "Slack", "Figma", "Terminal", "Safari", "Notes", "Spotify"], doms = ["github.com", "youtube.com", "docs.google.com", "x.com", "stackoverflow.com"];
      for (let d = 0; d < 30; d++) { const day = addDays(todayKey(), -d), segs = []; let t = dayStart(day) + 8 * HOUR; for (let k = 0; k < 800; k++) { const app = apps[Math.floor(rnd() * apps.length)], br = /Chrome|Safari/.test(app); const len = (10 + Math.floor(rnd() * 120)) * 1000; segs.push({ s: t, e: t + len, app, ...(br ? { domain: doms[Math.floor(rnd() * doms.length)], title: "Some page title that is fairly long, about this long" } : {}) }); t += len + 2000; } act[day] = segs; }
      save(); saveAct();
      return { state: localStorage.getItem(LS_KEY).length * 2, act: (localStorage.getItem(LS_ACT) || "").length * 2, total: lsBytes() };
    }`);
    const timings = await keel.ev(`views => { const out = {}; for (const v of views) { ui.view = v; ui.reportRange = "30d"; const t0 = performance.now(); render(); out[v] = Math.round(performance.now() - t0); } const t0 = performance.now(); buildPlan(); out.plan = Math.round(performance.now() - t0); return out; }`, VIEWS);
    console.log("storage bytes", sizes, "render ms", timings);
    expect(sizes.total).toBeLessThan(4 * 1024 * 1024);                                   // approved target: < 4 MB
    expect(timings.today).toBeLessThan(150);                                               // approved target: dashboard < 150 ms
    for (const v of VIEWS) expect(timings[v]).toBeLessThan(1000);
    expect(timings.plan).toBeLessThan(50);
  });
});

test.describe("backup and restore", () => {
  test("a backup restored into a fresh browser reproduces the same data, including app activity", async ({ keel, browser }) => {
    await keel.ev(reset);
    await keel.ev(`() => {
      state.tasks.push({ id: "t", title: "Backed up", done: false, createdAt: 1, subtasks: [] });
      state.entries.push({ id: "e", type: "focus", start: Date.now() - HOUR, end: Date.now(), dur: HOUR, projectId: "p_work" });
      state.appRules["a:Code"] = { cat: "design" };
      act = { [todayKey()]: [{ s: Date.now() - HOUR, e: Date.now() - 30 * MIN, app: "Code" }] }; saveAct(); save();
    }`);
    let copied = null;
    await keel.page.exposeFunction("__grab", t => { copied = t; });
    await keel.page.evaluate(() => { navigator.clipboard.writeText = async t => window.__grab(t); });
    await keel.page.locator('#nav [data-view="settings"]').click();
    await keel.page.locator('[data-act="export"]').click();
    await expect.poll(() => copied).not.toBeNull();
    const original = await keel.ev(`() => ({ state: JSON.parse(JSON.stringify(state)), act: JSON.parse(JSON.stringify(act)) })`);

    const ctx = await browser.newContext();
    const fresh = await ctx.newPage();
    await guardTracker(fresh);
    await fresh.route(/fonts\.|keel-tracker\.invalid/, r => r.abort());
    await fresh.goto("/index.html");
    await fresh.locator('#nav [data-view="settings"]').click();
    await fresh.locator('[data-act="import"]').click();
    await fresh.locator('.modal textarea[name="j"]').fill(copied);
    await fresh.locator(".modal button.primary").click();
    await fresh.reload();
    const restored = await fresh.evaluate("({ state: JSON.parse(JSON.stringify(state)), act: JSON.parse(JSON.stringify(act)) })");
    await ctx.close();
    const strip = s => { const rest = { ...s }; delete rest.updatedAt; return rest; };
    expect(strip(restored.state)).toEqual(strip(original.state));
    expect(restored.act).toEqual(original.act);
  });
});

test.describe("account sync merge rules (claude.ai only)", () => {
  // A fake `db` stands in for the platform store so the merge logic can be tested offline.
  const fakeDb = `remote => { const store = { ...remote }; window.__store = store; const doc = path => ({ async get() { const k = path.split("/").pop(); return { exists: k in store, data: () => store[k] }; }, async set(v) { store[path.split("/").pop()] = JSON.parse(JSON.stringify(v)); } }); return { doc }; }`;
  test("account changes replace local data that has no unsynced changes, including activity days", async ({ keel }) => {
    await keel.ev(reset);
    const out = await keel.ev(`async () => {
      state.tasks.push({ id: "local", title: "Local", done: false, createdAt: 1 }); state.updatedAt = 100;
      localStorage.setItem("keel.sync.v1", JSON.stringify({ at: 100 }));          // this device last synced at 100 and hasn't changed since
      const db = (${fakeDb})({ core: { v: 1, updatedAt: 200, projects: state.projects, tasks: [{ id: "remote", title: "Remote", done: false, createdAt: 1 }], settings: {}, months: ["2026-11"], actDays: ["2026-11-10"] }, "log-2026-11": { entries: [{ id: "e", type: "work", start: 1, end: 2, dur: 1 }] }, "act-2026-11-10": { day: "2026-11-10", segs: [{ s: 1, e: 5000, app: "Code" }] } });
      window.claude = { use: async n => n === "db" ? db : n === "user" ? { id: async () => "u1" } : null };
      await Sync.init();
      for (let i = 0; i < 50 && (Sync.running || Sync.status !== "synced"); i++) await new Promise(r => setTimeout(r, 20));   // let the background write settle
      return { tasks: state.tasks.map(t => t.id), entries: state.entries.length, act: Object.keys(act), status: Sync.status };
    }`);
    expect(out).toEqual({ tasks: ["remote"], entries: 1, act: ["2026-11-10"], status: "synced" });
  });
  test("newer local data is pushed to the account", async ({ keel }) => {
    await keel.ev(reset);
    const out = await keel.ev(`async () => {
      state.tasks.push({ id: "local", title: "Local", done: false, createdAt: 1 }); state.updatedAt = Date.now();
      const db = (${fakeDb})({ core: { v: 1, updatedAt: 1, tasks: [], months: [], actDays: [] } });
      window.claude = { use: async n => n === "db" ? db : n === "user" ? { id: async () => "u1" } : null };
      await Sync.init(); await Sync.flush();
      return { local: state.tasks.map(t => t.id), remote: window.__store.core.tasks.map(t => t.id) };
    }`);
    expect(out).toEqual({ local: ["local"], remote: ["local"] });
  });
  test("a brand-new device takes everything from the account", async ({ keel }) => {
    await keel.ev(reset);
    const out = await keel.ev(`async () => {
      const db = (${fakeDb})({ core: { v: 1, updatedAt: 500, projects: state.projects, tasks: [{ id: "r", title: "From account", done: false, createdAt: 1 }], settings: { dailyGoalMin: 240 }, months: [], actDays: [] } });
      window.claude = { use: async n => n === "db" ? db : n === "user" ? { id: async () => "u1" } : null };
      await Sync.init();
      return { tasks: state.tasks.map(t => t.id), goal: state.settings.dailyGoalMin, synced: JSON.parse(localStorage.getItem("keel.sync.v1")).at };
    }`);
    expect(out).toEqual({ tasks: ["r"], goal: 240, synced: 500 });
  });
  test("edits made on two devices before syncing are both kept", async ({ keel }) => {
    await keel.ev(reset);
    const out = await keel.ev(`async () => {
      state.tasks.push({ id: "fromLaptop", title: "Laptop task", done: false, createdAt: 1 }); state.updatedAt = 100;
      const db = (${fakeDb})({ core: { v: 1, updatedAt: 200, projects: state.projects, tasks: [{ id: "fromPhone", title: "Phone task", done: false, createdAt: 2 }], settings: {}, months: [], actDays: [] } });
      window.claude = { use: async n => n === "db" ? db : n === "user" ? { id: async () => "u1" } : null };
      await Sync.init();
      return state.tasks.map(t => t.id).sort();
    }`);
    expect(out).toEqual(["fromLaptop", "fromPhone"]);
  });
});
