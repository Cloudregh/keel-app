// Business-logic unit tests: focus/break timer engine, away-time handling, break reminder, state migration,
// activity import & categorisation, browser cleanup, sync document shaping, manual time entry validation.
import { test, expect } from "../fixtures/keel.mjs";

const reset = `() => { state = normalize(null); state.updatedAt = 0; act = {}; actCache = {}; closeModal(); render(); }`;

test.describe("timer engine", () => {
  test("start, pause, resume and finish logs an entry with paused time excluded", async ({ keel }) => {
    await keel.ev(reset);
    const out = await keel.ev(`() => {
      startSession({ type: "focus", mode: "open", taskId: null, projectId: "p_work" });
      state.active.start -= 40 * MIN; state.active.pausedTotal = 10 * MIN;
      pauseSession(); const paused = !!state.active.pausedAt; pauseSession();
      const r = finishSession();
      return { paused, entry: r.entry, active: state.active };
    }`);
    expect(out.paused).toBe(true);
    expect(out.active).toBeNull();
    expect(out.entry).toMatchObject({ type: "focus", projectId: "p_work", dur: 30 * 60000 });
  });
  test("sessions under 30 seconds are not logged; discard logs nothing", async ({ keel }) => {
    await keel.ev(reset);
    const out = await keel.ev(`() => {
      startSession({ type: "focus", mode: "open" }); state.active.start -= 29000; const a = finishSession();
      startSession({ type: "focus", mode: "open" }); state.active.start -= 3600000; const b = finishSession({ discard: true });
      return { a: a.entry, b: b.entry, n: state.entries.length };
    }`);
    expect(out).toEqual({ a: null, b: null, n: 0 });
    await expect(keel.page.locator("#toasts")).toContainText("Session discarded");
  });
  test("starting a session while one runs finishes the first silently", async ({ keel }) => {
    await keel.ev(reset);
    const out = await keel.ev(`() => {
      state.tasks.push({ id: "t1", title: "Write", projectId: "p_learn", done: false, createdAt: 1 });
      startSession({ type: "focus", mode: "open" }); state.active.start -= 10 * MIN;
      startSession({ type: "focus", mode: "pomodoro", minutes: 25, taskId: "t1" });
      return { logged: state.entries.length, active: state.active };
    }`);
    expect(out.logged).toBe(1);
    expect(out.active).toMatchObject({ mode: "pomodoro", plannedMs: 25 * 60000, taskId: "t1", projectId: "p_learn" });
  });
  test("a completed pomodoro logs exactly its planned length and auto-starts a short break", async ({ keel }) => {
    await keel.ev(reset);
    const out = await keel.ev(`() => {
      state.settings.autoBreak = true;
      startSession({ type: "focus", mode: "pomodoro", minutes: 25 });
      state.active.start -= 31 * MIN; state.active.pausedTotal = 2 * MIN;
      tick();
      return { entry: state.entries[0], active: state.active };
    }`);
    expect(out.entry).toMatchObject({ type: "focus", dur: 25 * 60000, pomo: true });
    expect(out.entry.end - out.entry.start).toBe(27 * 60000);
    expect(out.active).toMatchObject({ type: "break", plannedMs: 5 * 60000 });
  });
  test("every 4th pomodoro gets a long break", async ({ keel }) => {
    await keel.ev(reset);
    const active = await keel.ev(`() => {
      for (let i = 0; i < 3; i++) state.entries.push({ id: "p"+i, type: "focus", start: Date.now() - (5-i)*HOUR, end: Date.now() - (5-i)*HOUR + 25*MIN, dur: 25*MIN, pomo: true });
      startSession({ type: "focus", mode: "pomodoro", minutes: 25 }); state.active.start -= 26 * MIN; tick();
      return state.active;
    }`);
    expect(active).toMatchObject({ type: "break", plannedMs: 15 * 60000 });
  });
  test("without auto-break, a dialog offers the break; break end offers the next focus", async ({ keel }) => {
    await keel.ev(reset);
    await keel.ev(`() => { state.settings.autoBreak = false; startSession({ type: "focus", mode: "pomodoro", minutes: 25 }); state.active.start -= 26 * MIN; tick(); }`);
    await expect(keel.page.locator(".modal")).toContainText("Focus session complete");
    await keel.page.locator('[data-act="start-break"]').click();
    expect(await keel.ev(`() => state.active.type`)).toBe("break");
    await keel.ev(`() => { state.active.start -= 6 * MIN; tick(); }`);
    await expect(keel.page.locator(".modal")).toContainText("Break's over");
    await keel.page.locator('[data-act="start-focus-after-break"]').click();
    expect(await keel.ev(`() => [state.active.type, state.active.plannedMs]`)).toEqual(["focus", 25 * 60000]);
  });
  test("a pomodoro that ended while the page was closed is logged on the next load", async ({ keel }) => {
    await keel.ev(reset);
    await keel.ev(`() => { startSession({ type: "focus", mode: "pomodoro", minutes: 25 }); state.active.start -= 3 * HOUR; localStorage.setItem(LS_KEY, JSON.stringify(state)); }`);
    await keel.page.reload();
    expect(await keel.ev(`() => [state.active, state.entries.length, state.entries[0].dur]`)).toEqual([null, 1, 25 * 60000]);
  });
  test("away time: remove it, or log it as a break", async ({ keel }) => {
    await keel.ev(reset);
    const out = await keel.ev(`() => {
      startSession({ type: "focus", mode: "open" }); state.active.start -= HOUR;
      A["away-remove"]({ dataset: { ms: String(20 * MIN) } });
      const afterRemove = activeElapsed();
      A["away-break"]({ dataset: { ms: String(10 * MIN), from: String(Date.now() - 10 * MIN) } });
      return { afterRemove, afterBreak: activeElapsed(), brk: state.entries.find(e => e.type === "break") };
    }`);
    expect(out.afterRemove).toBe(40 * 60000);
    expect(out.afterBreak).toBe(30 * 60000);
    expect(out.brk).toMatchObject({ dur: 10 * 60000, note: "Away from screen" });
  });
  test("break reminder appears after the configured stretch and can be snoozed", async ({ keel }) => {
    await keel.ev(reset);
    await keel.ev(`() => { state.settings.breakReminderMin = 60; startSession({ type: "focus", mode: "open" }); state.active.start -= 70 * MIN; render(); }`);
    await expect(keel.page.locator(".banner")).toContainText("without a break");
    await keel.page.locator('[data-act="snooze-break"]').click();
    await expect(keel.page.locator(".banner")).toHaveCount(0);
  });
});

test.describe("state migration", () => {
  test("normalize fills defaults, keeps data and migrates the theme once", async ({ keel }) => {
    const out = await keel.ev(`() => {
      const fresh = normalize(null);
      const old = normalize({ tasks: [{ id: "a" }], entries: "bad", projects: null, settings: { theme: "auto", dailyGoalMin: 120 } });
      const again = normalize({ settings: { theme: "light", v2: true } });
      return { fresh: [fresh.projects.length, fresh.settings.theme, fresh.settings.actKeepDays], old: [old.tasks.length, old.entries.length, old.projects.length, old.settings.theme, old.settings.dailyGoalMin, old.settings.v2], again: again.settings.theme, rules: typeof normalize({ appRules: [1] }).appRules };
    }`);
    expect(out.fresh).toEqual([3, "dark", 30]);
    expect(out.old).toEqual([1, 0, 3, "dark", 120, true]);
    expect(out.again).toBe("light");
    expect(out.rules).toBe("object");
  });
});

test.describe("activity import & categories", () => {
  const seg = (h, m, app, domain, title) => ({ s: Date.UTC(2026, 10, 10, h, m), e: Date.UTC(2026, 10, 10, h, m + 10), app, ...(domain ? { domain } : {}), ...(title ? { title } : {}) });
  test("rejects files that aren't from the tracker", async ({ keel }) => {
    for (const bad of [null, {}, { source: "other", days: {} }, { source: "keel-tracker" }, { source: "keel-tracker", days: "x" }]) {
      expect(await keel.ev(`o => { try { importActivity(o, true); return "accepted"; } catch (e) { return e.message; } }`, bad)).toBe("not keel");
    }
  });
  test("validates, trims and prunes imported segments", async ({ keel }) => {
    await keel.ev(reset);
    const out = await keel.ev(`f => { importActivity(f, true); return act; }`, {
      source: "keel-tracker", device: "Mac", updatedAt: 1,
      days: {
        "2026-11-10": [seg(9, 0, "A".repeat(100), "X.COM", "t".repeat(200)), { s: 5, e: 1, app: "Backwards" }, { s: 1, e: 2 }, { s: "x", e: 2, app: "NaN" }, null],
        "2026-09-01": [seg(9, 0, "Old")],
        "not-a-day": [seg(9, 0, "Bad key")],
        "2026-11-09": "not an array"
      }
    });
    expect(Object.keys(out)).toEqual(["2026-11-10"]);
    expect(out["2026-11-10"]).toHaveLength(1);
    expect(out["2026-11-10"][0].app).toHaveLength(60);
    expect(out["2026-11-10"][0].domain).toBe("x.com");
    expect(out["2026-11-10"][0].title).toHaveLength(90);
  });
  test("default categories for apps and sites, without false matches", async ({ keel }) => {
    const out = await keel.ev(`keys => keys.map(k => defaultCat(k))`, [
      "a:Code", "a:Terminal", "a:Figma", "a:Microsoft Word", "a:Notes", "a:zoom.us", "a:Slack", "a:Discord", "a:Spotify", "a:Safari", "a:Claude",
      "a:Archive Utility", "a:Finder", "a:Keynote", "a:Music",
      "d:github.com", "d:docs.google.com", "d:developer.apple.com", "d:figma.com", "d:meet.google.com", "d:mail.google.com", "d:x.com", "d:youtube.com", "d:news.example.com", "d:notgithub.com"
    ]);
    expect(out).toEqual([
      "code", "code", "design", "docs", "docs", "meetings", "comms", "social", "entertainment", "browsing", "browsing",
      "other", "other", "docs", "entertainment",
      "code", "docs", "code", "design", "meetings", "comms", "social", "entertainment", "browsing", "browsing"
    ]);
  });
  test("stats: totals, productive/distracting, switches, user rules and projects", async ({ keel }) => {
    await keel.ev(reset);
    const out = await keel.ev(`segs => {
      act = { "2026-11-10": segs }; actCache = {};
      const before = actStats("2026-11-10");
      state.appRules["a:Slack"] = { cat: "code", projectId: "p_work" }; actCache = {};
      const after = actStats("2026-11-10");
      return { total: before.total, prod: before.prod, dist: before.dist, switches: before.switches, top: before.items[0].key, prodAfter: after.prod, byProj: after.byProj, blocks: actBlocks("2026-11-10").map(b => b.cat) };
    }`, [seg(9, 0, "Code"), seg(9, 10, "Google Chrome", "youtube.com", "Video"), seg(9, 20, "Slack"), seg(9, 30, "Code"), seg(9, 40, "Code")]);
    expect(out.total).toBe(50 * 60000);
    expect(out.prod).toBe(30 * 60000);
    expect(out.dist).toBe(10 * 60000);
    expect(out.switches).toBe(3);
    expect(out.top).toBe("a:Code");
    expect(out.prodAfter).toBe(40 * 60000);
    expect(out.byProj).toEqual({ p_work: 10 * 60000 });
    expect(out.blocks).toEqual(["code", "entertainment", "code"]);
  });
  test("live import never interrupts typing", async ({ keel }) => {
    await keel.page.locator('#nav [data-view="tasks"]').click();
    await keel.page.locator("#qa-input").fill("half-typed");
    await keel.ev(`f => importActivity(f, true, "live")`, { source: "keel-tracker", days: { "2026-11-10": [seg(9, 0, "Code")] } });
    await expect(keel.page.locator("#qa-input")).toHaveValue("half-typed");
    await expect(keel.page.locator("#qa-input")).toBeFocused();
  });
});

test.describe("cleanup and storage", () => {
  test("retention settings remove old activity, sessions and completed tasks only", async ({ keel }) => {
    await keel.ev(reset);
    const out = await keel.ev(`() => {
      act = { [addDays(todayKey(), -40)]: [], [addDays(todayKey(), -10)]: [], [todayKey()]: [] };
      state.entries = [{ id: "old", type: "work", start: Date.now() - 200*DAY, end: Date.now() - 200*DAY + HOUR, dur: HOUR }, { id: "new", type: "work", start: Date.now() - DAY, end: Date.now() - DAY + HOUR, dur: HOUR }];
      state.tasks = [{ id: "oldDone", done: true, doneAt: Date.now() - 100*DAY }, { id: "newDone", done: true, doneAt: Date.now() - DAY }, { id: "open", done: false }];
      state.appRules = { "a:X": {}, "a:Y": { cat: "code" } };
      const first = cleanupKeel(false);
      state.settings.keepEntriesDays = 90; state.settings.keepDoneDays = 30; state.settings.actKeepDays = 7;
      const second = cleanupKeel(true);
      return { first, second, days: Object.keys(act).length, entries: state.entries.map(e => e.id), tasks: state.tasks.map(t => t.id), rules: Object.keys(state.appRules) };
    }`);
    expect(out.first).toEqual({ days: 1, entries: 0, tasks: 0 });   // defaults: 30-day activity, keep sessions/tasks forever
    expect(out.second).toEqual({ days: 1, entries: 1, tasks: 1 });
    expect(out.days).toBe(1);
    expect(out.entries).toEqual(["new"]);
    expect(out.tasks).toEqual(["newDone", "open"]);
    expect(out.rules).toEqual(["a:Y"]);
    await expect(keel.page.locator("#toasts")).toContainText("Cleaned up");
  });
  test("storage size estimate counts only Keel's keys", async ({ keel }) => {
    const out = await keel.ev(`() => { localStorage.setItem("other", "x".repeat(10000)); const a = lsBytes(); localStorage.setItem("keel.test", "x".repeat(1000)); return lsBytes() - a; }`);
    expect(out).toBe((9 + 1000) * 2);
  });
  test("sync documents: per-month logs, per-day activity, titles dropped from oversized days", async ({ keel }) => {
    await keel.ev(reset);
    const out = await keel.ev(`() => {
      state.entries = [{ id: "a", start: Date.UTC(2026, 9, 31), end: Date.UTC(2026, 9, 31) + HOUR, dur: HOUR }, { id: "b", start: Date.UTC(2026, 10, 1), end: Date.UTC(2026, 10, 1) + HOUR, dur: HOUR }];
      act = { "2026-11-10": Array.from({ length: 2500 }, (_, i) => ({ s: i, e: i + 5000, app: "Safari", domain: "x.com", title: "T".repeat(90) })), "2026-11-09": [{ s: 1, e: 5000, app: "A", title: "keep" }] };
      const d = Sync.docs();
      return { keys: Object.keys(d).sort(), months: d.core.months, actDays: d.core.actDays, bigHasTitle: d["act-2026-11-10"].segs.some(s => "title" in s), smallTitle: d["act-2026-11-09"].segs[0].title, bigSize: JSON.stringify(d["act-2026-11-10"]).length, actUntouched: "title" in act["2026-11-10"][0] };
    }`);
    expect(out.keys).toEqual(["act-2026-11-09", "act-2026-11-10", "core", "log-2026-10", "log-2026-11"]);
    expect(out.months).toEqual(["2026-10", "2026-11"]);
    expect(out.actDays).toEqual(["2026-11-09", "2026-11-10"]);
    expect(out.bigHasTitle).toBe(false);
    expect(out.smallTitle).toBe("keep");
    expect(out.bigSize).toBeLessThan(256 * 1024);
    expect(out.actUntouched).toBe(true);
  });
});

test.describe("manual time entry validation", () => {
  async function submit(page, { start, end, date = "2026-11-10" }) {
    await page.keyboard.press("l");
    // Set the picker fields' values directly (the pickers themselves are tested in pickers.spec.mjs).
    await page.evaluate(([d, s, e]) => { for (const [n, v] of [["date", d], ["start", s], ["end", e]]) document.querySelector(`.modal input[name="${n}"]`).value = v; }, [date, start, end]);
    await page.locator(".modal button.primary").click();
  }
  test("valid entry is logged; end before start wraps past midnight", async ({ keel }) => {
    await keel.ev(reset);
    await submit(keel.page, { start: "08:00", end: "09:30" });
    expect(await keel.ev(`() => state.entries.map(e => e.dur)`)).toEqual([90 * 60000]);
    await submit(keel.page, { start: "23:00", end: "01:00", date: "2026-11-08" });
    expect(await keel.ev(`() => state.entries[1].dur`)).toBe(2 * 3600000);
  });
  test("rejects entries over 16 hours and entries in the future", async ({ keel }) => {
    await keel.ev(reset);
    await submit(keel.page, { start: "01:00", end: "18:00", date: "2026-11-09" });
    await expect(keel.page.locator("#entry-err")).toHaveText("Entries can be at most 16 hours long.");
    await keel.page.locator('[data-act="modal-close"]').first().click();
    await submit(keel.page, { start: "11:00", end: "12:00" });
    await expect(keel.page.locator("#entry-err")).toHaveText("That start time is in the future.");
    expect(await keel.ev(`() => state.entries.length`)).toBe(0);
  });
});
