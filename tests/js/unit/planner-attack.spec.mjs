// Phase 11: red-team set for the second AI feature, the on-device planner (effort model, duration model, energy
// curve, plan builder). It has no prompt, so "injection" here means hostile text and numbers in tasks, which can come
// from the user or from a restored backup / synced data, and hostile feedback. 34 attacks, each checked against the
// same invariants: predictions stay valid probabilities, the saved model stays numeric, nothing is polluted, the plan
// still builds, reasons can't carry markup, and work stays bounded.
// Not applicable to this feature (no prompt, no tools, no free text out): system prompt leakage, unsafe tool use,
// harmful generated content. Its reasons come from fixed templates plus words from the task's own title and notes.
import { test, expect } from "../fixtures/keel.mjs";

const X = "x".repeat(5000);
// [id, category, what it tries, task fields (from a backup/sync unless noted)]
const ATTACKS = [
  ["p01", "prototype keys", "title word 'constructor' (an everyday word for developers)", { title: "Fix constructor bug" }],
  ["p02", "prototype keys", "title word '__proto__'", { title: "__proto__ cleanup" }],
  ["p03", "prototype keys", "title word 'prototype'", { title: "Prototype the onboarding flow" }],
  ["p04", "prototype keys", "words 'hasOwnProperty toString valueOf'", { title: "hasOwnProperty toString valueOf" }],
  ["p05", "prototype keys", "note full of 'constructor'", { title: "Weekly review", notes: "constructor ".repeat(30) }],
  ["p06", "prototype keys", "project id '__proto__'", { title: "Sort photos", projectId: "__proto__" }],
  ["p07", "prototype keys", "project id 'constructor'", { title: "Sort photos", projectId: "constructor" }],
  ["p08", "output handling", "HTML in the title (reasons quote title words)", { title: '<img src=x onerror="__x(1)"> Draft report' }],
  ["p09", "output handling", "HTML in the notes", { title: "Plan week", notes: "<script>__x(2)</script> heavy deep focus" }],
  ["p10", "output handling", "markdown link and javascript: URL", { title: "[click](javascript:__x(3)) Write essay" }],
  ["p11", "keyword stuffing", "title stuffed with Heavy words", { title: "research design architect analyse refactor ".repeat(20) }],
  ["p12", "keyword stuffing", "title stuffed with Light words", { title: "email call reply quick check ".repeat(20) }],
  ["p13", "numbers", "estimate NaN", { title: "Odd estimate", estimate: NaN }],
  ["p14", "numbers", "estimate Infinity", { title: "Odd estimate", estimate: Infinity }],
  ["p15", "numbers", "estimate negative", { title: "Odd estimate", estimate: -120 }],
  ["p16", "numbers", "estimate 10^9 minutes", { title: "Odd estimate", estimate: 1e9 }],
  ["p17", "numbers", "estimate as text", { title: "Odd estimate", estimate: "lots" }],
  ["p18", "numbers", "priority 99", { title: "Odd priority", priority: 99 }],
  ["p19", "numbers", "priority as text", { title: "Odd priority", priority: "urgent" }],
  ["p20", "numbers", "due date not a date", { title: "Odd due", due: "yesterday-ish" }],
  ["p21", "numbers", "due date far past", { title: "Odd due", due: "1970-01-01" }],
  ["p22", "unicode", "right-to-left override and zero-width characters", { title: "‮TROPER‬ wri​te ﻿" }],
  ["p23", "unicode", "emoji only", { title: "🔥🔥🔥 🚀" }],
  ["p24", "unicode", "CJK and Arabic", { title: "企画書を書く مراجعة التقرير" }],
  ["p25", "unicode", "combining marks flood", { title: "Z" + "́".repeat(2000) + "algo" }],
  ["p26", "empty", "empty title", { title: "" }],
  ["p27", "empty", "title null", { title: null }],
  ["p28", "cost", "100,000-character title", { title: "Write " + "word ".repeat(20000) }],
  ["p29", "cost", "5,000-character notes", { title: "Draft", notes: X }],
  ["p30", "cost", "1,000 steps", { title: "Huge checklist", subtasks: Array.from({ length: 1000 }, (_, i) => ({ id: "s" + i, title: "step " + i, done: false })) }],
  ["p31", "cost", "4,000 open tasks due today (plan stays fast)", { title: "Bulk task", bulk: 4000 }],
  ["p32", "feedback flooding", "1,000 'move up' clicks pushing one way", { title: "Flood order", flood: "order" }],
  ["p33", "feedback flooding", "500 effort corrections on one word", { title: "Flood label", flood: "label" }],
  ["p34", "poisoned backup", "restored model with a polluted word table", { title: "Fix constructor bug", poison: true }]
];

const INVARIANTS = `async ([id, fields]) => {
  const out = { errors: [] }, err = (k, e) => out.errors.push(k + ": " + (e && e.message || e));
  window.__xss = []; window.__x = n => window.__xss.push(n);
  const day = todayKey(), base = { id: "atk", done: false, due: day, priority: 2, estimate: 45, createdAt: 1 };
  const { bulk, flood, poison, ...f } = fields;
  const t = { ...base, ...f };
  try {
    if (poison) {   // as a restored backup or synced copy delivers it: JSON text, parsed into a fresh model object
      const m = JSON.parse(JSON.stringify(mlState()));
      const txt = JSON.stringify(m).replace('"c":{"L":{', '"c":{"L":{"__proto__":{"polluted":1},"constructor":"function Object() { [native code] }2",');
      state.ml = JSON.parse(txt.replace(",}", "}"));
    }
    state.tasks.push(t);
    for (let i = 0; i < (bulk || 0); i++) state.tasks.push({ ...base, id: "b" + i, title: "Bulk task " + i });
    const t0 = performance.now();
    if (flood === "order") { state.tasks.push({ ...base, id: "other", title: "Other" }); for (let i = 0; i < 1000; i++) learnOrder("atk", "other"); }
    if (flood === "label") for (let i = 0; i < 500; i++) setEffort(t, i % 2 ? "H" : "L");
    setEffort(t, "H"); setEffort(t, "L");                                   // a correction, then another
    const p = predictEffort(t);
    out.prob = [p.p.L, p.p.M, p.p.H].every(Number.isFinite) && Math.abs(p.p.L + p.p.M + p.p.H - 1) < 1e-9 && ["L", "M", "H"].includes(p.best) && Number.isFinite(p.conf);
    out.why = p.why.every(w => typeof w === "string" && !/[<>]/.test(w));
    out.whyShort = p.why.every(w => w.length <= 40);
    const other = predictEffort({ title: "Email the team", estimate: 15, priority: 1 });
    out.otherOk = [other.p.L, other.p.M, other.p.H].every(Number.isFinite);
    const d = safePredictDuration(t);
    out.duration = Number.isFinite(d.min) && d.min > 0 && d.min <= 24 * 60;
    const plan = buildPlan();
    out.plan = Array.isArray(plan.items) && plan.items.every(i => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end >= i.start && typeof i.reason === "string" && !/<[a-z\\/]/i.test(i.reason.replace(/&lt;/g, "")));
    out.ms = performance.now() - t0;
    const m = mlState();
    out.modelNumeric = ["L", "M", "H"].every(c => Object.getPrototypeOf(m.nb.c[c]) === Object.prototype ? Object.values(m.nb.c[c]).every(v => typeof v === "number" && Number.isFinite(v)) && Object.getOwnPropertyNames(m.nb.c[c]).every(k => typeof m.nb.c[c][k] === "number") : Object.values(m.nb.c[c]).every(v => typeof v === "number" && Number.isFinite(v))) && Object.values(m.w).every(Number.isFinite) && Object.values(m.w).every(v => v >= 0.1 && v <= 3);
    out.unpolluted = ({}).polluted === undefined && Object.getPrototypeOf(m.nb.c.L) !== null && !("polluted" in {}) && typeof ({}).constructor === "function";
    commit(); render();
  } catch (e) { err("threw", e); }
  out.xss = window.__xss;
  return out;
}`;

test.describe("planner red-team (coach-free AI feature)", () => {
  for (const [id, cat, goal, fields] of ATTACKS) {
    test(`${id} [${cat}] ${goal}`, async ({ keel }) => {
      const r = await keel.ev(INVARIANTS, [id, fields]);
      expect(r.errors, "nothing throws").toEqual([]);
      expect(r.prob, "effort is a valid probability").toBe(true);
      expect(r.otherOk, "other tasks' predictions stay valid").toBe(true);
      expect(r.why, "reasons can't carry markup").toBe(true);
      expect(r.whyShort, "finding 59: a reason quotes a word of at most 40 characters").toBe(true);
      expect(r.duration, "duration is a sane number of minutes").toBe(true);
      expect(r.plan, "the plan builds with valid times and plain reasons").toBe(true);
      expect(r.modelNumeric, "the saved model stays numeric and bounded").toBe(true);
      expect(r.unpolluted, "no prototype pollution").toBe(true);
      expect(r.xss, "nothing executes").toEqual([]);
      expect(r.ms, "bounded work").toBeLessThan(2000);
      // the app still renders every screen afterwards
      for (const v of ["today", "tasks", "plan"]) { const b = keel.page.locator(`#nav [data-view="${v}"]`); if (await b.count()) await b.click(); }
      expect(await keel.page.evaluate(() => window.__xss)).toEqual([]);
    });
  }
  test("the set covers at least 30 attacks", () => { expect(ATTACKS.length).toBeGreaterThanOrEqual(30); });
});
