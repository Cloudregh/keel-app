// The fixed inputs for prediction parity (Phase 9), as one in-page script shared by the golden recorder
// (eval/planner/golden.mjs) and the cross-browser check (tests/js/e2e/model-parity.spec.mjs).
// Input: the effort-v1 rows. Output: effort probabilities (as shipped and after the train corrections),
// duration predictions for one simulated person, and 20 seeded day plans.
export const GOLDEN_SCRIPT = `rows => {
  const rng = (seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; })(20261110);
  const fresh = () => { state.ml = null; mlState(); state.tasks = []; state.entries = []; state.active = null; state.planSkips = null; state.plan = null; state.updatedAt++; };
  const test = rows.filter(r => r.split === "test"), train = rows.filter(r => r.split === "train");
  const eff = () => test.map(r => { const o = predictEffort(r); return { id: r.id, best: o.best, p: [o.p.L, o.p.M, o.p.H] }; });
  fresh(); const effortCold = eff();
  for (const r of train) setEffort({ ...r }, r.label);
  const effortWarm = eff();
  fresh();
  const now = Date.now(), durations = [];
  for (let i = 0; i < 40; i++) {
    const r = train[i % train.length], est = [15, 30, 45, 60, 90][i % 5], actual = Math.round(est * (1.2 + rng() * 0.6));
    state.tasks.push({ id: "h" + i, title: r.title, notes: "", estimate: est, priority: 1, subtasks: [], done: true, doneAt: now - (i + 1) * 3600e3 });
    state.entries.push({ id: "e" + i, type: "focus", start: now - (i + 1) * 3600e3 - actual * 60e3, end: now - (i + 1) * 3600e3, dur: actual * 60e3, taskId: "h" + i, switches: 0 });
  }
  state.updatedAt++;
  for (const r of test.slice(0, 40)) durations.push({ id: r.id, min: predictDuration({ ...r, id: "q" + r.id, estimate: r.estimate || 30 }).min, minNoEstimate: predictDuration({ ...r, id: "z" + r.id, estimate: 0 }).min });
  const plans = [], k = todayKey();
  for (let d = 0; d < 20; d++) {
    fresh();
    state.tasks = Array.from({ length: 4 + Math.floor(rng() * 14) }, (_, i) => { const r = test[Math.floor(rng() * test.length)]; return { id: "d" + d + "t" + i, title: r.title, notes: "", estimate: [0, 15, 30, 60, 120, 180][Math.floor(rng() * 6)], priority: Math.floor(rng() * 4), due: [null, k, addDays(k, -1), addDays(k, 1)][Math.floor(rng() * 4)], subtasks: [], done: false }; });
    state.updatedAt++;
    plans.push(buildPlan().items.map(i => [i.kind, i.taskId || null, i.start, i.end, i.eff || null, i.part || null]));
  }
  return { version: typeof PLANNER_VERSION === "string" ? PLANNER_VERSION : null, effortCold, effortWarm, durations, plans };
}`;
