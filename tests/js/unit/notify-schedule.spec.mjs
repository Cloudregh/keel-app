// Mac notifications (owner's request, 2026-11-15): Keel builds the schedule the tracker turns into macOS
// notifications. notifySchedule(now) returns { items, summaryAt, tasksDone, prefs } for POST /schedule.
import { test, expect } from "../fixtures/keel.mjs";

const MIN = 60_000, HOUR = 60 * MIN;
const NOW = new Date("2026-11-10T10:00:00Z").getTime();   // the fixture's clock; Africa/Accra is UTC
const reset = `() => { state = normalize(null); state.updatedAt = 0; render(); }`;
const task = (id, title, extra = {}) => ({ id, title, projectId: null, priority: 0, due: null, estimate: 30, notes: "", subtasks: [], done: false, doneAt: null, createdAt: 1, ...extra });
const plan = (items, extra = {}) => ({ day: "2026-11-10", createdAt: NOW - HOUR, items, later: [], overflow: false, accepted: true, version: "planner-v2.3", ...extra });
const ptask = (taskId, startMin, dur = 30, part = 1, parts = 1) => ({ kind: "task", taskId, start: NOW + startMin * MIN, end: NOW + (startMin + dur) * MIN, dur, eff: "M", reason: "x", part, parts });

test.describe("notifySchedule", () => {
  test("plan: a reminder 2 minutes before each upcoming task of today's accepted plan", async ({ keel: { ev } }) => {
    await ev(reset);
    const out = await ev(`([ts, p]) => { state.tasks = ts; state.plan = p; return notifySchedule(${NOW}); }`, [
      [task("a", "Write the report"), task("b", "Call the bank"), task("c", "Done already", { done: true, doneAt: NOW - HOUR }), task("d", "Started already")],
      plan([ptask("d", -10), ptask("a", 30, 60), ptask("b", 100), ptask("c", 140), { kind: "break", start: NOW + 90 * MIN, end: NOW + 100 * MIN, reason: "Lunch" }])
    ]);
    const plans = out.items.filter(i => i.kind === "plan");
    expect(plans.map(i => [i.title, i.at])).toEqual([["Next up: Write the report", NOW + 28 * MIN], ["Next up: Call the bank", NOW + 98 * MIN]]);
    expect(plans[0].body).toBe("Starts at 10:30am · 1h");
    expect(new Set(out.items.map(i => i.id)).size).toBe(out.items.length);                     // ids are unique
  });

  test("plan: nothing for a plan that isn't accepted, is for another day, or starts within 2 minutes", async ({ keel: { ev } }) => {
    await ev(reset);
    const kinds = p => ev(`([ts, p]) => { state.tasks = ts; state.plan = p; return notifySchedule(${NOW}).items.filter(i => i.kind === "plan").length; }`, [[task("a", "A")], p]);
    expect(await kinds(plan([ptask("a", 30)], { accepted: false }))).toBe(0);
    expect(await kinds(plan([ptask("a", 30)], { day: "2026-11-09" }))).toBe(0);
    expect(await kinds(plan([ptask("a", 1)]))).toBe(0);
    expect(await kinds(plan([ptask("a", 30)]))).toBe(1);
  });

  test("a running pomodoro: 'Focus session done' at its end; a break: 'Break's over'; a paused session: nothing", async ({ keel: { ev } }) => {
    await ev(reset);
    const at = (active) => ev(`(a) => { state.tasks = [${JSON.stringify(task("t", "Deep work"))}]; state.active = a; return notifySchedule(${NOW}).items.filter(i => i.kind !== "plan").map(i => [i.kind, i.title, i.at]); }`, active);
    const base = { id: "s1", taskId: "t", projectId: null, pausedTotal: 0, pausedAt: null, note: "" };
    expect(await at({ ...base, type: "focus", mode: "pomodoro", plannedMs: 25 * MIN, start: NOW - 10 * MIN })).toContainEqual(["focus", "Focus session done", NOW + 15 * MIN]);
    expect(await at({ ...base, type: "focus", mode: "pomodoro", plannedMs: 25 * MIN, start: NOW - 10 * MIN, pausedTotal: 5 * MIN })).toContainEqual(["focus", "Focus session done", NOW + 20 * MIN]);
    expect(await at({ ...base, type: "break", mode: "pomodoro", plannedMs: 5 * MIN, start: NOW - MIN })).toEqual([["break", "Break's over", NOW + 4 * MIN]]);
    expect(await at({ ...base, type: "focus", mode: "pomodoro", plannedMs: 25 * MIN, start: NOW - 10 * MIN, pausedAt: NOW - MIN })).toEqual([]);
  });

  test("break nudge: when the current focus stretch reaches the break-reminder setting, unless a pomodoro ends first", async ({ keel: { ev } }) => {
    await ev(reset);
    const nudges = (active, reminder = 90) => ev(`([a, r]) => { state.settings.breakReminderMin = r; state.active = a; return notifySchedule(${NOW}).items.filter(i => i.kind === "break").map(i => [i.title, i.at]); }`, [active, reminder]);
    const open = { id: "s2", type: "focus", mode: "open", plannedMs: 0, start: NOW - 30 * MIN, pausedTotal: 0, pausedAt: null, taskId: null, projectId: null, note: "" };
    expect(await nudges(open)).toEqual([["Time for a break", NOW + 60 * MIN]]);
    expect(await nudges(open, 120)).toEqual([["Time for a break", NOW + 90 * MIN]]);
    expect(await nudges({ ...open, mode: "pomodoro", plannedMs: 50 * MIN })).toEqual([]);          // the pomodoro ends first
  });

  test("hide task names: no task title anywhere, generic wording instead", async ({ keel: { ev } }) => {
    await ev(reset);
    const out = await ev(`([ts, p]) => { state.settings.notifyHideNames = true; state.tasks = ts; state.plan = p;
      state.active = { id: "s3", type: "focus", mode: "pomodoro", plannedMs: 25 * MIN, start: ${NOW}, pausedTotal: 0, pausedAt: null, taskId: "a", projectId: null, note: "" };
      return notifySchedule(${NOW}); }`, [[task("a", "Planted secret title")], plan([ptask("a", 30)])]);
    expect(JSON.stringify(out)).not.toContain("Planted secret title");
    expect(out.items.find(i => i.kind === "plan").title).toBe("Next task in 2 min");
  });

  test("end of day: the summary time is today's workday end, with today's finished tasks; none after it", async ({ keel: { ev, page } }) => {
    await ev(reset);
    const out = await ev(`(ts) => { state.settings.workEnd = 18; state.tasks = ts; return notifySchedule(${NOW}); }`,
      [task("a", "A", { done: true, doneAt: NOW - HOUR }), task("b", "B", { done: true, doneAt: NOW - 30 * HOUR }), task("c", "C")]);
    expect(out.summaryAt).toBe(new Date("2026-11-10T18:00:00Z").getTime());
    expect(out.tasksDone).toBe(1);
    await page.clock.setFixedTime(new Date("2026-11-10T19:00:00Z"));
    expect((await ev(`() => notifySchedule(Date.now())`)).summaryAt).toBeNull();
  });

  test("the switches in Settings go to the tracker as preferences", async ({ keel: { ev } }) => {
    await ev(reset);
    expect((await ev(`() => notifySchedule(${NOW})`)).prefs).toEqual({ focus: true, plan: true, summary: true, tracker: true });
    const prefs = await ev(`() => { Object.assign(state.settings, { notifyFocus: false, notifyPlan: false, notifySummary: false, notifyTracker: false }); return notifySchedule(${NOW}).prefs; }`);
    expect(prefs).toEqual({ focus: false, plan: false, summary: false, tracker: false });
  });

  test("never more than 50 items, soonest first, each title at most 80 characters", async ({ keel: { ev } }) => {
    await ev(reset);
    const ts = Array.from({ length: 70 }, (_, i) => task("t" + i, "x".repeat(200)));
    const out = await ev(`([ts, p]) => { state.tasks = ts; state.plan = p; return notifySchedule(${NOW}); }`, [ts, plan(ts.map((t, i) => ptask(t.id, 10 + i)))]);
    expect(out.items.length).toBe(50);
    expect(out.items.every((x, i, a) => i === 0 || a[i - 1].at <= x.at)).toBe(true);
    expect(out.items.every(x => x.title.length <= 80)).toBe(true);
  });
});
