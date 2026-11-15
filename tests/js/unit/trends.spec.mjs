// Trend charts on Reports (feature added 2026-11-15): the line drawing, the averages and the comparison with the
// period before, the Top apps panel, and that names from the tracker can't inject markup.
// Runs inside the real page (Tue 10 Nov 2026, 10:00 Africa/Accra) so the tested code is exactly what ships.
import { test, expect } from "../fixtures/keel.mjs";

const RESET = `() => { localStorage.clear(); state = normalize(null); state.settings.weekStart = 1; act = {}; actCache = {}; ui.reportRange = "week"; }`;
// Adds a tracked entry of `min` minutes starting at 08:00 on the given day (offset from today).
const ADD = `([off, min, type]) => { const k = addDays(todayKey(), off), st = dayStart(k) + 8 * HOUR;
  state.entries.push({ id: "e" + Math.random(), type: type || "work", start: st, end: st + min * MIN, dur: min * MIN, projectId: null, note: "" }); actCache = {}; }`;
const ACT = `([off, app, min]) => { const k = addDays(todayKey(), off), st = dayStart(k) + 8 * HOUR + (act[k] || []).length * 2 * HOUR;
  (act[k] = act[k] || []).push({ s: st, e: st + min * MIN, app }); actCache = {}; }`;

test.describe("monoPath: the smooth line", () => {
  test("empty and single points", async ({ keel }) => {
    expect(await keel.ev("() => monoPath([])")).toBe("");
    expect(await keel.ev("() => monoPath([[5, 7]])")).toBe("M5,7");
  });
  test("passes through every point, in order", async ({ keel }) => {
    const pts = [[0, 50], [10, 20], [20, 80], [30, 80], [40, 5]];
    const d = await keel.ev("p => monoPath(p)", pts);
    const ends = [d.match(/^M([\d.-]+),([\d.-]+)/).slice(1).map(Number), ...[...d.matchAll(/C[^C]* ([\d.-]+),([\d.-]+)/g)].map(m => [+m[1], +m[2]])];
    expect(ends).toEqual(pts);
  });
  test("never overshoots: control points stay between their two neighbours (a 0 day never dips below the baseline)", async ({ keel }) => {
    const ys = [100, 100, 10, 100, 100, 60, 100, 0, 100];
    const pts = ys.map((y, i) => [i * 10, y]);
    const d = await keel.ev("p => monoPath(p)", pts);
    const segs = [...d.matchAll(/C([\d.-]+),([\d.-]+) ([\d.-]+),([\d.-]+) ([\d.-]+),([\d.-]+)/g)].map(m => m.slice(1).map(Number));
    expect(segs).toHaveLength(pts.length - 1);
    segs.forEach((s, i) => {
      const lo = Math.min(ys[i], ys[i + 1]) - 0.05, hi = Math.max(ys[i], ys[i + 1]) + 0.05;
      for (const y of [s[1], s[3]]) { expect(y).toBeGreaterThanOrEqual(lo); expect(y).toBeLessThanOrEqual(hi); }
    });
  });
  test("a flat run stays flat", async ({ keel }) => {
    const d = await keel.ev("() => monoPath([[0, 40], [10, 40], [20, 40]])");
    expect(d.match(/[\d.-]+,([\d.-]+)/g).map(p => +p.split(",")[1])).toEqual(Array(7).fill(40));
  });
});

test.describe("trendSummary: averages and change", () => {
  const H = 3600e3;
  const cases = [
    ["durations: zero days count, % change", [2 * H, 0, H], [H, H, H], "dur", { avg: H, change: 0 }],
    ["durations: +50%", [2 * H, H], [H, H], "dur", { avg: 1.5 * H, change: 50 }],
    ["durations: future days (null) are left out", [2 * H, null, null], [H, null, null], "dur", { avg: 2 * H, change: 100 }],
    ["durations: nothing before → no % (no divide by zero)", [H], [0], "dur", { avg: H, change: null }],
    ["nothing now → no average and no change", [null, null], [H, H], "dur", { avg: null, change: null }],
    ["score: mean of days with a score, change in points", [70, null, 60], [50, 60, null], "score", { avg: 65, change: 10 }],
    ["score: no earlier scores → no change", [70], [null], "score", { avg: 70, change: null }],
    ["share: points, rounded", [66.4, 66.6], [60, 60], "pct", { avg: 66.5, change: 7 }]
  ];
  for (const [name, cur, prev, kind, want] of cases) {
    test(name, async ({ keel }) => {
      expect(await keel.ev("([c, p, k]) => trendSummary(c, p, k)", [cur, prev, kind])).toEqual(want);
    });
  }
});

test.describe("trendsSection on Reports", () => {
  test("nothing tracked → no Trends section", async ({ keel }) => {
    await keel.ev(RESET);
    expect(await keel.ev("() => trendsSection(rangeDays())")).toBe("");
  });

  test("this week vs the same days last week; days still ahead are not drawn", async ({ keel }) => {
    await keel.ev(RESET);
    // This week: Mon 9 = 2h, Tue 10 (today) = 1h. Same days last week: Mon 2 = 1h, Tue 3 = 1h.
    for (const a of [[-1, 120, "focus"], [0, 60, "work"], [-8, 60, "focus"], [-7, 60, "work"]]) await keel.ev(ADD, a);
    const html = await keel.ev("() => trendsSection(rangeDays())");
    const doc = await keel.page.evaluate(h => { const d = document.createElement("div"); d.innerHTML = h; return {
      cards: [...d.querySelectorAll(".trend")].map(c => ({ id: c.dataset.trend, v: c.querySelector(".tr-v").textContent.trim(), delta: c.querySelector(".delta").textContent.replace(/\s+/g, " ").trim(),
        pts: c.querySelectorAll(".tr-pt").length, dots: c.querySelectorAll(".tr-pt circle").length, tips: [...c.querySelectorAll(".tr-pt")].map(g => g.dataset.tip) })),
      apps: d.querySelectorAll(".tr-app").length }; }, html);
    expect(doc.cards.map(c => c.id)).toEqual(["work", "focus", "score"]);      // no activity → no Productive share card
    const work = doc.cards[0];
    expect(work.v).toBe("1h 30m avg");
    expect(work.delta).toBe("↑ 50% vs same days last week");
    expect(work.pts).toBe(7);                                                  // one hover target per day of the week
    expect(work.dots).toBe(2);                                                 // only Mon and Tue have a value
    expect(work.tips[0]).toContain("Worked: 2h");
    expect(work.tips[6]).toContain("not yet");
    const focus = doc.cards[1];
    expect(focus.delta).toBe("↑ 100% vs same days last week");               // 2h+0 vs 1h+0 over two days
    expect(doc.apps).toBe(0);
  });

  test("30 days: a hover target for every day and the previous 30 days as the comparison", async ({ keel }) => {
    await keel.ev(RESET);
    await keel.ev(ADD, [-3, 90]); await keel.ev(ADD, [-33, 30]);
    const r = await keel.ev(`() => { ui.reportRange = "30d"; const d = document.createElement("div"); d.innerHTML = trendsSection(rangeDays());
      const c = d.querySelector('[data-trend="work"]'); return { pts: c.querySelectorAll(".tr-pt").length, delta: c.querySelector(".delta").textContent.replace(/\\s+/g, " ").trim() }; }`);
    expect(r.pts).toBe(30);
    expect(r.delta).toBe("↑ 200% vs previous 30 days");
  });

  test("Top apps: ranked by time, change vs the period before, 'new' when absent before", async ({ keel }) => {
    await keel.ev(RESET);
    for (const a of [[-1, "Code", 60], [0, "Code", 30], [-1, "Slack", 40], [-8, "Code", 45], [-7, "Code", 0]]) await keel.ev(ACT, a);
    const r = await keel.ev(`() => { const d = document.createElement("div"); d.innerHTML = trendsSection(rangeDays());
      return { cards: [...d.querySelectorAll(".trend")].map(c => c.dataset.trend),
        apps: [...d.querySelectorAll(".tr-app")].map(a => ({ n: a.querySelector(".n").textContent.trim(), v: a.querySelector(".v").textContent.trim(), delta: a.querySelector(".delta").textContent.trim(), spark: !!a.querySelector("svg.spark path.tr-line") })) }; }`);
    expect(r.cards).toEqual(["work", "focus", "score", "prod"]);
    expect(r.apps).toEqual([
      { n: "Code", v: "1h 30m", delta: "↑ 100%", spark: true },
      { n: "Slack", v: "40m", delta: "new", spark: true }
    ]);
  });

  test("app and site names from the tracker are shown as text, never as markup", async ({ keel }) => {
    await keel.ev(RESET);
    await keel.ev(ACT, [-1, '<img src=x onerror="window.__pwned=1">', 50]);
    const r = await keel.ev(`() => { const d = document.createElement("div"); d.innerHTML = trendsSection(rangeDays()); document.body.append(d);
      const out = { imgs: d.querySelectorAll("img").length, name: d.querySelector(".tr-app .n span").textContent }; d.remove(); return out; }`);
    expect(r.imgs).toBe(0);
    expect(r.name).toBe('<img src=x onerror="window.__pwned=1">');
    expect(await keel.ev("() => window.__pwned || 0")).toBe(0);
  });
});
