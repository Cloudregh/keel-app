// Fixes 50 and 51 (Phase 10): the Daily coach prompt asks for a length safely under the 120-word limit, and gives the
// model each session's end time and when tracking last stopped, so it doesn't have to add start + minutes itself.
import { test, expect } from "../fixtures/keel.mjs";

test.use({ aiMode: "mock" });

async function promptFor({ page, ev, aiCalls }, setup) {
  await ev(setup);
  await page.locator('#nav [data-view="today"]').click();
  await page.locator('#ai-panel [data-act="ai"]').click();
  await expect.poll(() => aiCalls.length).toBeGreaterThan(0);
  const p = aiCalls.at(-1), i = p.indexOf("\n\nDATA:\n");
  return { instruction: p.slice(0, i), data: JSON.parse(p.slice(i + 8)) };
}

// 10:00 now (fixture clock). Focus 8:00–8:50 (50 min), break 8:50–9:00, focus 9:00–9:25 with a 5-minute pause (20 min).
const SEED = `() => {
  const t0 = dayStart(todayKey()), M = 60e3;
  state.entries.push({ id: "e1", type: "focus", start: t0 + 8 * 60 * M, end: t0 + 8 * 60 * M + 50 * M, dur: 50 * M, projectId: null, taskId: null, switches: 2 });
  state.entries.push({ id: "e2", type: "break", start: t0 + 8 * 60 * M + 50 * M, end: t0 + 9 * 60 * M, dur: 10 * M, projectId: null, taskId: null, switches: 0 });
  state.entries.push({ id: "e3", type: "focus", start: t0 + 9 * 60 * M, end: t0 + 9 * 60 * M + 25 * M, dur: 20 * M, projectId: null, taskId: null, switches: 1 });
  commit();
}`;

test("fix 50: the prompt asks for at most 90 words (well under the 120-word product limit)", async ({ keel }) => {
  const { instruction } = await promptFor(keel, SEED);
  expect(instruction).toMatch(/at most 90 words/);
  expect(instruction).not.toMatch(/under 120 words/);
});

test("fix 51: each session carries its end time, and the data says when tracking last stopped", async ({ keel }) => {
  const { data } = await promptFor(keel, SEED);
  expect(data.sessions.map(s => [s.start, s.end, s.min])).toEqual([["8:00am", "8:50am", 50], ["8:50am", "9:00am", 10], ["9:00am", "9:25am", 20]]);
  expect(data.lastTrackedEnd).toBe("9:25am");
});

test("fix 51: a session still running ends 'now'", async ({ keel }) => {
  const running = await promptFor(keel, `() => { state.active = { type: "focus", start: dayStart(todayKey()) + 9.5 * 3600e3, pausedTotal: 0, projectId: null, taskId: null, switches: 0 }; commit(); }`);
  expect(running.data.sessions.at(-1)).toMatchObject({ start: "9:30am", end: "10:00am", min: 30 });
  expect(running.data.lastTrackedEnd).toBe("10:00am");
});

test("fix 51: nothing tracked → lastTrackedEnd is null", async ({ keel }) => {
  const { data } = await promptFor(keel, `() => {}`);
  expect(data.sessions).toEqual([]);
  expect(data.lastTrackedEnd).toBeNull();
});

// Fix 54 (coach-v3): the progress percentages are sent ready-made, so the model doesn't divide (or divide by the wrong goal).
test("fix 54: the data carries workPct and focusPct, rounded, against the right goals; the prompt says to use them", async ({ keel }) => {
  const { instruction, data } = await promptFor(keel, SEED);
  const s = await keel.ev(`() => ({ w: state.settings.dailyGoalMin, f: state.settings.focusGoalMin })`);
  expect(data.workPct).toBe(Math.round(100 * data.workedMin / s.w));
  expect(data.focusPct).toBe(Math.round(100 * data.focusMin / s.f));
  expect(Object.keys(data).indexOf("workPct")).toBe(Object.keys(data).indexOf("longestStretchMin") + 1);
  expect(instruction).toMatch(/workPct and focusPct/);
});

test("fix 54: nothing tracked → both percentages are 0", async ({ keel }) => {
  const { data } = await promptFor(keel, `() => {}`);
  expect([data.workPct, data.focusPct]).toEqual([0, 0]);
});

// Fix 55 (coach-v4): the minutes still needed for each goal are sent ready-made, so a suggestion can't overstate where a
// block would take the user.
test("fix 55: the data carries workLeftMin and focusLeftMin right after focusPct; the prompt says to check projections against them", async ({ keel }) => {
  const { instruction, data } = await promptFor(keel, SEED);
  const s = await keel.ev(`() => ({ w: state.settings.dailyGoalMin, f: state.settings.focusGoalMin })`);
  expect(data.workLeftMin).toBe(Math.max(0, s.w - data.workedMin));
  expect(data.focusLeftMin).toBe(Math.max(0, s.f - data.focusMin));
  expect(Object.keys(data).indexOf("workLeftMin")).toBe(Object.keys(data).indexOf("focusPct") + 1);
  expect(instruction).toMatch(/workLeftMin and focusLeftMin/);
});

test("fix 55: nothing tracked → the minutes left are the whole goals", async ({ keel }) => {
  const { data } = await promptFor(keel, `() => {}`);
  const s = await keel.ev(`() => ({ w: state.settings.dailyGoalMin, f: state.settings.focusGoalMin })`);
  expect([data.workLeftMin, data.focusLeftMin]).toEqual([s.w, s.f]);
});

test("fix 55: past a goal → 0 minutes left, never negative", async ({ keel }) => {
  const { data } = await promptFor(keel, SEED.replace("commit();", "state.settings.focusGoalMin = 1; state.settings.dailyGoalMin = 1; commit();"));
  expect(data.workedMin).toBeGreaterThan(1);
  expect([data.workLeftMin, data.focusLeftMin]).toEqual([0, 0]);
});

