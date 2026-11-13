// Business-logic unit tests: quick-add parser, formatting, dates, stats and focus score, reports range, sorting.
// Runs inside the real page (Tue 10 Nov 2026, 10:00 Africa/Accra) so the tested code is exactly what ships.
import { test, expect } from "../fixtures/keel.mjs";

test.describe("quick-add parser", () => {
  const cases = [
    ["Write report #work !high tomorrow 45m", { title: "Write report", projectId: "p_work", priority: 3, due: "2026-11-11", estimate: 45 }],
    ["Plan sprint !2", { title: "Plan sprint", priority: 2, due: null, estimate: 0 }],
    ["Call mum !low today", { title: "Call mum", priority: 1, due: "2026-11-10" }],
    ["Study #learn fri 1h30m", { title: "Study", projectId: "p_learn", due: "2026-11-13", estimate: 90 }],
    ["Gym tue", { title: "Gym", due: "2026-11-17" }],                 // same weekday → next week, never today
    ["Read 1.5h", { title: "Read", estimate: 90 }],
    ["Pay bill 2026-12-01", { title: "Pay bill", due: "2026-12-01" }],
    ["Ship it nextweek", { title: "Ship it", due: "2026-11-17" }],
    ["Tag #unknownproject stays", { title: "Tag #unknownproject stays", projectId: null }],
    ["Prefix #per", { title: "Prefix", projectId: "p_personal" }],
    ["Emoji ☕️ task 15m", { title: "Emoji ☕️ task", estimate: 15 }],
    ["   ", { title: "" }],
    ["!high", { title: "", priority: 3 }],
    ["Bang ! alone", { title: "Bang ! alone", priority: 0 }],
    ["m alone", { title: "m alone", estimate: 0 }],
    ["Friday review friday", { title: "Friday review", due: "2026-11-13" }],
    ["<img src=x onerror=alert(1)>", { title: "<img src=x onerror=alert(1)>" }],
    ["Call the Friday supplier", { title: "Call the Friday supplier", due: null }],          // bug 11
    ["Prepare today notes 30m", { title: "Prepare today notes", due: null, estimate: 30 }],  // bug 11: date word mid-title stays
    ["#work !high Write report tomorrow", { title: "Write report", projectId: "p_work", priority: 3, due: "2026-11-11" }],
    ["Read 2026-12-01 notes", { title: "Read 2026-12-01 notes", due: null }]
  ];
  for (const [input, expected] of cases) {
    test(`parses ${JSON.stringify(input)}`, async ({ keel }) => {
      const out = await keel.ev("s => parseQuick(s)", input);
      expect(out).toMatchObject(expected);
    });
  }
  test("very long input is handled", async ({ keel }) => {
    const out = await keel.ev("s => parseQuick(s)", "word ".repeat(5000) + "#work");
    expect(out.projectId).toBe("p_work");
    expect(out.title.length).toBeGreaterThan(20000);
  });
});

test.describe("formatting and dates", () => {
  test("fmtDur", async ({ keel }) => {
    expect(await keel.ev(`() => [fmtDur(0), fmtDur(29999), fmtDur(30000), fmtDur(60*60000), fmtDur(65*60000), fmtDur(-5), fmtDur(0,{zero:"—"}), fmtDur(25*3600000)]`))
      .toEqual(["0m", "0m", "1m", "1h", "1h 5m", "0m", "—", "25h"]);
  });
  test("fmtClock", async ({ keel }) => {
    expect(await keel.ev(`() => [fmtClock(0), fmtClock(59999), fmtClock(25*60000), fmtClock(3723000), fmtClock(-1)]`))
      .toEqual(["00:00", "00:59", "25:00", "1:02:03", "00:00"]);
  });
  test("fmtTime 12-hour", async ({ keel }) => {
    expect(await keel.ev(`() => [fmtTime(dayStart("2026-11-10")), fmtTime(dayStart("2026-11-10")+12*HOUR+5*MIN), fmtTime(dayStart("2026-11-10")+23*HOUR+59*MIN)]`))
      .toEqual(["12:00am", "12:05pm", "11:59pm"]);
  });
  test("day keys, month/year boundaries and relative names", async ({ keel }) => {
    expect(await keel.ev(`() => [todayKey(), addDays("2026-11-30",1), addDays("2026-12-31",1), addDays("2026-03-01",-1), addDays("2024-02-28",1), monthKey(dayStart("2026-11-10")), fmtDay("2026-11-10"), fmtDay("2026-11-11"), fmtDay("2026-11-09"), fmtDay("2026-11-13"), fmtDay("2026-11-13", true)]`))
      .toEqual(["2026-11-10", "2026-12-01", "2027-01-01", "2026-02-28", "2024-02-29", "2026-11", "Today", "Tomorrow", "Yesterday", "Fri 13 Nov", "Friday, 13 Nov"]);
  });
  test("escaping and helpers", async ({ keel }) => {
    expect(await keel.ev(`() => [esc('<a href="x">&\\'</a>'), esc(null), slug("Deep Work!"), clamp(5,0,3), clamp(-1,0,3), fmtBytes(500), fmtBytes(2048), fmtBytes(3*1048576), inkOn("#eda100"), inkOn("#6250d6"), inkOn("var(--x)")]`))
      .toEqual(["&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;", "", "deepwork", 3, 0, "500 B", "2 KB", "3.0 MB", "#000", "#fff", "#fff"]);
  });
  test("bug 22: text on every project colour, in both themes, meets WCAG AA (4.5:1)", async ({ keel }) => {
    const worst = await keel.ev(`() => {
      const lin = v => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      const lum = h => { const x = h.slice(1), n = parseInt(x.length === 3 ? [...x].map(d => d + d).join("") : x, 16); return 0.2126 * lin(n >> 16 & 255) + 0.7152 * lin(n >> 8 & 255) + 0.0722 * lin(n & 255); };
      const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => p - q); return (y + 0.05) / (x + 0.05); };
      return Math.min(...[...PAL_L, ...PAL_D].map(c => ratio(inkOn(c), c)));
    }`);
    expect(worst).toBeGreaterThanOrEqual(4.5);
  });
});

test.describe("day stats and focus score", () => {
  const setup = `entries => { state.entries = entries.map(([type, startH, mins, projectId, switches, pomo]) => { const s = dayStart("2026-11-10") + startH * HOUR; return { id: uid(), type, start: s, end: s + mins * MIN, dur: mins * MIN, projectId, switches: switches || 0, pomo: !!pomo }; }); state.active = null; return dayStats("2026-11-10"); }`;
  test("totals by type and project, sessions, pomodoros", async ({ keel }) => {
    const st = await keel.ev(setup, [["focus", 1, 50, "p_work", 2, true], ["break", 2, 10], ["meeting", 3, 30, "p_work"], ["work", 4, 20, null], ["focus", 5, 25, "p_learn", 0, true]]);
    expect(st.work).toBe(125 * 60000);
    expect(st.focus).toBe(75 * 60000);
    expect(st.brk).toBe(10 * 60000);
    expect(st.meeting).toBe(30 * 60000);
    expect(st.sessions).toBe(2);
    expect(st.pomos).toBe(2);
    expect(st.switches).toBe(2);
    expect(st.byProj).toEqual({ p_work: 80 * 60000, _none: 20 * 60000, p_learn: 25 * 60000 });
    expect(st.score).toBeGreaterThanOrEqual(0);
    expect(st.score).toBeLessThanOrEqual(100);
  });
  test("no work → no score; entries crossing midnight are clipped to the day", async ({ keel }) => {
    expect((await keel.ev(setup, [])).score).toBeNull();
    const st = await keel.ev(setup, [["work", -1, 120, null]]);           // 23:00 yesterday → 01:00 today
    expect(st.work).toBe(60 * 60000);
  });
  test("perfect day scores 100; switching and long stretches lower it", async ({ keel }) => {
    const perfect = await keel.ev(setup, [["focus", 9, 90, "p_work"], ["break", 10.5, 15], ["focus", 10.75, 90, "p_work"]]);
    expect(perfect.score).toBe(100);
    const noisy = await keel.ev(setup, [["focus", 9, 180, "p_work", 40], ["work", 12, 60, null]]);
    expect(noisy.score).toBeLessThan(perfect.score);
    expect(noisy.longest).toBe(240 * 60000);
  });
  test("a 10-minute gap counts as a break in the longest stretch", async ({ keel }) => {
    const st = await keel.ev(setup, [["work", 9, 60, null], ["work", 10 + 10 / 60, 60, null]]);
    expect(st.longest).toBe(60 * 60000);
  });
  test("currentStretch and the running session", async ({ keel }) => {
    const out = await keel.ev(`() => { state.entries = [{ id: "a", type: "work", start: Date.now() - 99*MIN, end: Date.now() - 39*MIN, dur: 60*MIN }];
      state.active = { id: "x", type: "focus", mode: "open", start: Date.now() - 30*MIN, pausedTotal: 5*MIN, pausedAt: null, plannedMs: 0, switches: 0 };
      return { stretch: currentStretch(), elapsed: activeElapsed(), all: allEntries().length, work: dayStats(todayKey()).work }; }`);
    expect(out.elapsed).toBe(25 * 60000);
    expect(out.all).toBe(2);
    expect(out.stretch).toBe(85 * 60000);                                  // 9-min gap (< 10) → still one stretch
    expect(out.work).toBe(85 * 60000);
  });
  test("paused session doesn't count paused time", async ({ keel }) => {
    expect(await keel.ev(`() => { const a = { start: Date.now() - 20*MIN, pausedTotal: 0, pausedAt: Date.now() - 5*MIN }; return activeElapsed(a); }`)).toBe(15 * 60000);
  });
});

test.describe("reports helpers and sorting", () => {
  test("week ranges respect the chosen week start", async ({ keel }) => {
    const r = await keel.ev(`() => { const out = {}; for (const [range, ws] of [["week",1],["lastweek",1],["week",0],["week",6],["14d",1],["30d",1]]) { ui.reportRange = range; state.settings.weekStart = ws; const d = rangeDays(); out[range+ws] = [d[0], d[d.length-1], d.length]; } return out; }`);
    expect(r.week1).toEqual(["2026-11-09", "2026-11-15", 7]);
    expect(r.lastweek1).toEqual(["2026-11-02", "2026-11-08", 7]);
    expect(r.week0).toEqual(["2026-11-08", "2026-11-14", 7]);
    expect(r.week6).toEqual(["2026-11-07", "2026-11-13", 7]);
    expect(r["14d1"]).toEqual(["2026-10-28", "2026-11-10", 14]);
    expect(r["30d1"][2]).toBe(30);
  });
  test("taskSort: priority, then due date (no date last), then creation", async ({ keel }) => {
    const order = await keel.ev(`() => [
      { title: "low-nodue", priority: 1, due: null, createdAt: 1 },
      { title: "high-later", priority: 3, due: "2026-11-20", createdAt: 2 },
      { title: "high-soon", priority: 3, due: "2026-11-11", createdAt: 3 },
      { title: "low-soon-old", priority: 1, due: "2026-11-11", createdAt: 4 },
      { title: "low-soon-new", priority: 1, due: "2026-11-11", createdAt: 5 }
    ].sort(taskSort).map(t => t.title)`);
    expect(order).toEqual(["high-soon", "high-later", "low-soon-old", "low-soon-new", "low-nodue"]);
  });
  test("taskSpent sums tracked time per task, excluding breaks", async ({ keel }) => {
    expect(await keel.ev(`() => { state.entries = [{ type: "focus", taskId: "t1", dur: 10*MIN }, { type: "break", taskId: "t1", dur: 5*MIN }, { type: "work", taskId: "t1", dur: 2*MIN }, { type: "work", taskId: "t2", dur: MIN }]; state.active = null; return taskSpent(); }`))
      .toEqual({ t1: 12 * 60000, t2: 60000 });
  });
});
