// Phase 8: planner model evaluation. Protocol: docs/model-eval.md (written before the first run).
// Runs the real app (index.html) in headless Chromium; writes eval/results/planner-<app sha>.json and .md.
//   node eval/planner/run.mjs            evaluate (twice, and check the two runs are identical)
//   node eval/planner/run.mjs --once     evaluate once
/* global state, mlState, featurize, predictEffort, setEffort, predictDuration, buildPlan, energyCurve, learnOrder, urgencyOf, taskById, todayKey, LEX_MAP, META_PRIOR, priorCounts -- app functions, used inside page.evaluate */
import { chromium } from "@playwright/test";
import http from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const ROOT = path.resolve(new URL("../../", import.meta.url).pathname);
const SEED = 20261110;
const read = f => readFileSync(path.join(ROOT, f), "utf8");
const jsonl = f => read(f).trim().split("\n").map(l => JSON.parse(l));
const sha = s => createHash("sha256").update(s).digest("hex").slice(0, 12);
const manifest = JSON.parse(read("eval/manifest.json"));
const EFFORT = jsonl("eval/data/effort-v1.jsonl"), NEWVOCAB = jsonl("eval/data/effort-newvocab-v1.jsonl");
const EFFORT_V2 = jsonl("eval/data/effort-v2.jsonl"), NEWVOCAB_V2 = jsonl("eval/data/effort-newvocab-v2.jsonl");   // addendum (findings 38, 42)
const DUR_USERS = JSON.parse(read("eval/data/duration-users-v1.json")), DUR_V1 = JSON.parse(read("eval/data/duration-v1.json"));
const ENERGY = JSON.parse(read("eval/data/energy-v1.json"));
for (const d of Object.values(manifest.datasets)) if (sha(readFileSync(path.join(ROOT, d.file))) !== d.sha256) throw new Error(`${d.file} doesn't match its frozen hash`);

function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const C = ["L", "M", "H"];

// ---------------- metrics ----------------
function prf(rows) {   // rows: {y, yhat}
  const per = {}, labels = C.filter(c => rows.some(r => r.y === c));
  for (const c of C) {
    const tp = rows.filter(r => r.y === c && r.yhat === c).length, fp = rows.filter(r => r.y !== c && r.yhat === c).length, fn = rows.filter(r => r.y === c && r.yhat !== c).length;
    const p = tp + fp ? tp / (tp + fp) : 0, rc = tp + fn ? tp / (tp + fn) : 0;
    per[c] = { precision: p, recall: rc, f1: p + rc ? 2 * p * rc / (p + rc) : 0, support: tp + fn };
  }
  const macro = labels.reduce((a, c) => a + per[c].f1, 0) / (labels.length || 1);
  return { macroF1: macro, accuracy: rows.filter(r => r.y === r.yhat).length / (rows.length || 1), per, n: rows.length };
}
function confusion(rows) { const m = {}; for (const a of C) { m[a] = {}; for (const b of C) m[a][b] = rows.filter(r => r.y === a && r.yhat === b).length; } return m; }
function bootstrapCI(rows, stat, groupKey = "group", n = 2000) {
  const rng = mulberry32(SEED), groups = [...new Set(rows.map(r => r[groupKey]))], by = Object.fromEntries(groups.map(g => [g, rows.filter(r => r[groupKey] === g)]));
  const vals = [];
  for (let i = 0; i < n; i++) { const s = []; for (let j = 0; j < groups.length; j++) s.push(...by[groups[Math.floor(rng() * groups.length)]]); vals.push(stat(s)); }
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(0.025 * n)], vals[Math.floor(0.975 * n)]];
}
function calibration(rows) {   // rows: {y, p:{L,M,H}}
  const brier = rows.reduce((a, r) => a + C.reduce((b, c) => b + (r.p[c] - (r.y === c ? 1 : 0)) ** 2, 0), 0) / rows.length;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, conf: 0, acc: 0 }));
  for (const r of rows) { const best = C.reduce((a, c) => r.p[c] > r.p[a] ? c : a, "M"), conf = r.p[best], b = bins[Math.min(9, Math.floor(conf * 10))]; b.n++; b.conf += conf; b.acc += best === r.y ? 1 : 0; }
  const table = bins.map((b, i) => ({ bin: `${i / 10}–${(i + 1) / 10}`, n: b.n, meanConfidence: b.n ? b.conf / b.n : null, accuracy: b.n ? b.acc / b.n : null })).filter(b => b.n);
  const ece = table.reduce((a, b) => a + b.n / rows.length * Math.abs(b.meanConfidence - b.accuracy), 0);
  return { brier, ece, table };
}
const median = xs => { const s = xs.slice().sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quantile = (xs, q) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]; };
const pearson = (a, b) => { const n = a.length, ma = a.reduce((x, y) => x + y) / n, mb = b.reduce((x, y) => x + y) / n; let c = 0, va = 0, vb = 0; for (let i = 0; i < n; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; } return c / Math.sqrt(va * vb); };
const r4 = x => x === null || x === undefined ? x : Math.round(x * 10000) / 10000;

// ---------------- browser ----------------
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml" };
function serve() {
  const server = http.createServer((q, r) => {
    const rel = decodeURIComponent(new URL(q.url, "http://x").pathname), f = path.join(ROOT, path.normalize(rel));
    if (!f.startsWith(ROOT) || !existsSync(f) || !statSync(f).isFile()) { r.writeHead(404).end(); return; }
    r.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" }).end(readFileSync(f));
  });
  return new Promise(res => server.listen(0, "127.0.0.1", () => res(server)));
}
async function openApp(browser, base, file = "index.html", at = "2026-11-10T10:00:00Z") {
  const ctx = await browser.newContext({ timezoneId: "Africa/Accra", locale: "en-GB", serviceWorkers: "block", bypassCSP: true });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com|:47821\//, r => r.abort());
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.clock.setFixedTime(new Date(at));
  await page.goto(`${base}/${file}`);
  await page.waitForFunction("typeof state === 'object' && typeof predictEffort === 'function'");
  return { page, ctx, errors };
}
const fresh = `state.ml = null; mlState(); state.tasks = []; state.entries = []; state.active = null; state.planSkips = null; state.plan = null; state.updatedAt = (state.updatedAt || 0) + 1;`;
const predictAll = (page, rows) => page.evaluate(rows => rows.map(r => { const o = predictEffort(r); return { id: r.id, p: o.p, best: o.best, why: o.why }; }), rows);

// ---------------- evaluation ----------------
async function evaluate(browser, base) {
  const out = { meta: {}, effort: {}, newVocab: {}, duration: {}, planner: {}, energy: {}, ordering: {} };
  const { page, ctx, errors } = await openApp(browser, base);
  const test = EFFORT.filter(r => r.split === "test"), train = EFFORT.filter(r => r.split === "train");
  const join = (rows, preds) => rows.map((r, i) => ({ ...r, y: r.label, yhat: preds[i].best, p: preds[i].p, why: preds[i].why }));

  // ---- effort: as shipped (primary) ----
  await page.evaluate(fresh);
  const cold = join(test, await predictAll(page, test));
  const macro = rows => prf(rows).macroF1;
  out.effort.primary = { ...prf(cold), ci95: bootstrapCI(cold, macro), confusion: confusion(cold) };
  // baselines
  const majority = test.map(r => ({ ...r, y: r.label, yhat: "M" }));
  out.effort.baselines = { majority: prf(majority).macroF1 };
  const kw = await page.evaluate(rows => rows.map(r => { const n = { L: 0, M: 0, H: 0 }; for (const tok of featurize({ title: r.title, notes: r.notes })) if (!tok.includes("_") && LEX_MAP[tok]) n[LEX_MAP[tok]]++; const m = Math.max(n.L, n.M, n.H); const best = ["L", "M", "H"].filter(c => n[c] === m); return m === 0 || best.length > 1 ? "M" : best[0]; }), test);
  out.effort.baselines.keywordOnly = prf(test.map((r, i) => ({ ...r, y: r.label, yhat: kw[i] }))).macroF1;
  // secondary: after the train split as user corrections
  await page.evaluate(rows => { for (const r of rows) setEffort({ ...r }, r.label); }, train);
  const warm = join(test, await predictAll(page, test));
  out.effort.withTrainCorrections = { ...prf(warm), ci95: bootstrapCI(warm, macro) };
  { // sensitivity (added after the first run): corrections and test both without the leaky notes
    await page.evaluate(fresh);
    await page.evaluate(rows => { for (const r of rows) setEffort({ ...r, notes: "" }, r.label); }, train);
    const noNotes = test.map(r => ({ ...r, notes: "" })), w2 = join(noNotes, await predictAll(page, noNotes));
    out.effort.withTrainCorrectionsNoNotes = { ...prf(w2), ci95: bootstrapCI(w2, macro) };
    await page.evaluate(fresh);
    const c2 = join(noNotes, await predictAll(page, noNotes));
    out.effort.primaryNoNotes = { ...prf(c2), ci95: bootstrapCI(c2, macro) };
    await page.evaluate(fresh);
    await page.evaluate(rows => { for (const r of rows) setEffort({ ...r }, r.label); }, train);
  }
  // slices (primary model)
  const slice = (name, fn) => { const groups = {}; for (const r of cold) (groups[fn(r)] ||= []).push(r); return Object.fromEntries(Object.entries(groups).map(([k, rows]) => [k, { n: rows.length, macroF1: prf(rows).macroF1, accuracy: prf(rows).accuracy, judged: rows.length >= 20 }])); };
  out.effort.slices = { estimate: slice("estimate", r => r.estimate ? "has estimate" : "no estimate"), project: slice("project", r => r.projectId || "none"), phrasing: slice("phrasing", r => "variant " + r.id.split("-")[1]) };
  const gap = s => { const v = Object.values(s).filter(x => x.judged).map(x => x.macroF1); return Math.max(...v) - Math.min(...v); };
  out.effort.sliceGap = { estimate: gap(out.effort.slices.estimate), project: gap(out.effort.slices.project) };
  out.effort.calibration = calibration(cold);
  out.effort.calibrationWithCorrections = calibration(warm);
  // robustness (primary model)
  await page.evaluate(fresh);
  const rng = mulberry32(SEED + 7);
  const typo = s => { const w = s.split(" "); const i = w.reduce((b, x, j) => x.length > w[b].length ? j : b, 0); const x = w[i]; if (x.length > 3) { const k = 1 + Math.floor(rng() * (x.length - 2)); w[i] = x.slice(0, k) + x[k + 1] + x[k] + x.slice(k + 2); } return w.join(" "); };
  const variants = {
    clean: r => r, typo: r => ({ ...r, title: typo(r.title) }), noEstimate: r => ({ ...r, estimate: 0 }), capitals: r => ({ ...r, title: r.title.toUpperCase() }),
    filler: r => ({ ...r, title: r.title + " today if possible thanks" }), keywordStuffing: r => r.label === "H" ? { ...r, title: r.title + " email reply call" } : r,
    notesRemoved: r => ({ ...r, notes: "" }),   // added after the first run: effort-v1 notes are one fixed sentence per class (label leakage)
  };
  out.effort.robustness = {};
  const cleanPred = cold.map(r => r.yhat);
  for (const [name, f] of Object.entries(variants)) {
    const rows = test.map(f), preds = await predictAll(page, rows), j = join(rows, preds);
    out.effort.robustness[name] = { macroF1: prf(j).macroF1, changed: j.filter((r, i) => r.yhat !== cleanPred[i]).length / j.length };
  }
  out.effort.outOfRange = await page.evaluate(() => {
    const cases = { "estimate -5": { title: "Write report", estimate: -5 }, "estimate 10000": { title: "Write report", estimate: 10000 }, "estimate NaN": { title: "Write report", estimate: NaN }, "priority 9": { title: "Write report", priority: 9 },
      "5000-char title": { title: "word ".repeat(1000) }, "empty": {}, "emoji only": { title: "🚀🔥✅" }, "subtasks not array": { title: "Plan", subtasks: "x" } };
    const res = {};
    for (const [k, t] of Object.entries(cases)) { try { const o = predictEffort(t), s = o.p.L + o.p.M + o.p.H; res[k] = { ok: Number.isFinite(s) && Math.abs(s - 1) < 1e-9 && ["L", "M", "H"].includes(o.best), best: o.best }; } catch (e) { res[k] = { ok: false, error: String(e.message || e) }; } }
    return res;
  });
  // error analysis: 20 most confident mistakes
  const lexHits = await page.evaluate(rows => rows.map(r => { const n = { L: 0, M: 0, H: 0 }; for (const tok of featurize({ title: r.title, notes: r.notes })) if (!tok.includes("_") && LEX_MAP[tok]) n[LEX_MAP[tok]]++; return n; }), test);
  const errorsRanked = cold.map((r, i) => ({ ...r, hits: lexHits[i], conf: r.p[r.yhat] })).filter(r => r.y !== r.yhat).sort((a, b) => b.conf - a.conf || a.id.localeCompare(b.id));
  const bucket = e => !e ? "none" : e <= 15 ? "xs" : e <= 30 ? "s" : e <= 60 ? "m" : e <= 120 ? "l" : "xl";
  const cause = r => {
    const total = r.hits.L + r.hits.M + r.hits.H;
    if (r.hits[r.yhat] > 0 && r.hits[r.y] === 0) return "a keyword from the predicted class (wording points the other way)";
    if (total === 0 && !r.estimate) return "no known keyword and no estimate (nothing to go on)";
    if (total === 0) return "no known keyword; estimate or other metadata decided";
    if ((r.y === "M") !== (r.yhat === "M")) return "Medium boundary: mixed or weak signals";
    return "other";
  };
  out.effort.worstErrors = errorsRanked.slice(0, 20).map(r => ({ id: r.id, title: r.title, label: r.y, predicted: r.yhat, confidence: r.conf, estimate: r.estimate, estimateBucket: bucket(r.estimate), keywordHits: r.hits, why: r.why, cause: cause(r) }));
  out.effort.errorCauses = errorsRanked.reduce((a, r) => (a[cause(r)] = (a[cause(r)] || 0) + 1, a), {});
  // explainability: strongest features per class, cold and after corrections
  const topFeatures = () => page.evaluate(() => {
    const toks = new Set(Object.keys(LEX_MAP).concat(Object.keys(META_PRIOR)));
    const nb = mlState().nb; for (const c of ["L", "M", "H"]) Object.keys(nb.c[c]).forEach(t => toks.add(t));
    const score = {};
    for (const tok of toks) {
      const pc = priorCounts(tok), lp = {};
      for (const c of ["L", "M", "H"]) lp[c] = Math.log(((nb.c[c][tok] || 0) + (pc ? pc[c] : 0) + 1) / (nb.n[c] + 40 + 600));
      for (const c of ["L", "M", "H"]) (score[c] ||= []).push([tok, lp[c] - Math.max(...["L", "M", "H"].filter(o => o !== c).map(o => lp[o]))]);
    }
    return Object.fromEntries(Object.entries(score).map(([c, l]) => [c, l.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 12).map(([t, v]) => [t, Math.round(v * 100) / 100])]));
  });
  out.effort.topFeatures = { asShipped: await topFeatures() };
  await page.evaluate(rows => { for (const r of rows) setEffort({ ...r }, r.label); }, train);
  out.effort.topFeatures.afterTrainCorrections = await topFeatures();

  // ---- new vocabulary (v1: random corrections, as first registered; v2: corrections cover every verb, addendum) ----
  const newVocab = async data => {
    await page.evaluate(fresh);
    const nvTest = data.filter(r => r.split === "test"), nvCorr = data.filter(r => r.split === "corrections");
    const before = join(nvTest, await predictAll(page, nvTest));
    await page.evaluate(rows => { for (const r of rows) setEffort({ ...r }, r.label); }, nvCorr);
    const after = join(nvTest, await predictAll(page, nvTest));
    return { corrections: nvCorr.length, testN: nvTest.length, accuracyBefore: prf(before).accuracy, accuracyAfter: prf(after).accuracy, macroF1After: prf(after).macroF1, confusionAfter: confusion(after),
      ci95After: bootstrapCI(after.map(r => ({ ...r, group: r.id })), rows => prf(rows).accuracy), errorsAfter: after.filter(r => r.y !== r.yhat).map(r => ({ title: r.title, label: r.y, predicted: r.yhat })) };
  };
  out.newVocab = await newVocab(NEWVOCAB);
  out.newVocabV2 = await newVocab(NEWVOCAB_V2);
  // ---- effort-v2 (label-neutral notes, addendum): as shipped on its test split ----
  await page.evaluate(fresh);
  const v2test = EFFORT_V2.filter(r => r.split === "test"), v2 = join(v2test, await predictAll(page, v2test));
  out.effortV2 = { ...prf(v2), ci95: bootstrapCI(v2, macro), calibration: calibration(v2) };

  // ---- duration ----
  const durEval = (tasks) => page.evaluate(({ tasks, fresh }) => {
    eval(fresh);
    const hist = tasks.filter(t => t.split === "history"), test = tasks.filter(t => t.split === "test");
    for (const t of hist) {
      state.tasks.push({ id: t.id, title: t.title, notes: "", estimate: t.estimate, priority: 1, projectId: null, subtasks: [], done: true, doneAt: t.doneAt, createdAt: t.doneAt - 86400e3 });
      state.entries.push({ id: "e-" + t.id, type: "focus", start: t.doneAt - t.actualMin * 60e3, end: t.doneAt, dur: t.actualMin * 60e3, taskId: t.id, projectId: null, switches: 0 });
    }
    state.updatedAt++;
    return test.map(t => ({ id: t.id, estimate: t.estimate, actual: t.actualMin, predicted: predictDuration({ id: "new-" + t.id, title: t.title, notes: "", estimate: t.estimate, priority: 1, subtasks: [] }).min }));
  }, { tasks, fresh });
  const durPreds = [], perUser = [];
  for (const u of DUR_USERS) {
    const p = await durEval(u.tasks); durPreds.push(...p);
    perUser.push({ user: u.user, bias: u.bias, modelMedAbsLog: median(p.map(x => Math.abs(Math.log(x.predicted / x.actual)))), rawMedAbsLog: median(p.map(x => Math.abs(Math.log(x.estimate / x.actual)))) });
  }
  const model = median(durPreds.map(x => Math.abs(Math.log(x.predicted / x.actual)))), raw = median(durPreds.map(x => Math.abs(Math.log(x.estimate / x.actual))));
  const dRng = mulberry32(SEED + 9), boots = [];
  for (let i = 0; i < 2000; i++) { const s = durPreds.map(() => durPreds[Math.floor(dRng() * durPreds.length)]); boots.push(1 - median(s.map(x => Math.abs(Math.log(x.predicted / x.actual)))) / median(s.map(x => Math.abs(Math.log(x.estimate / x.actual))))); }
  boots.sort((a, b) => a - b);
  out.duration.users = { n: durPreds.length, modelMedAbsLog: model, rawMedAbsLog: raw, reduction: 1 - model / raw, reductionCI95: [boots[50], boots[1949]], usersBetterThanRaw: perUser.filter(u => u.modelMedAbsLog < u.rawMedAbsLog).length, perUser };
  const v1 = await durEval(DUR_V1);
  out.duration.v1 = { n: v1.length, modelMedAbsLog: median(v1.map(x => Math.abs(Math.log(x.predicted / x.actual)))), rawMedAbsLog: median(v1.map(x => Math.abs(Math.log(x.estimate / x.actual)))) };
  out.duration.v1.reduction = 1 - out.duration.v1.modelMedAbsLog / out.duration.v1.rawMedAbsLog;
  out.meta.pageErrors = errors.slice();
  await ctx.close();

  // ---- energy curve: evaluated the morning after the 21 history days ----
  {
    const { page, ctx } = await openApp(browser, base, "index.html", "2026-10-22T10:00:00Z");
    const res = await page.evaluate(({ sessions, fresh }) => {
      eval(fresh); const prior = energyCurve().curve.slice();
      state.entries = sessions.filter(s => s.split === "history").map(s => ({ ...s, projectId: null, switches: 0 })); state.updatedAt++;
      return { prior, learned: energyCurve().curve.slice(), learnedDays: energyCurve().learnedDays };
    }, { sessions: ENERGY.sessions, fresh });
    const H = Array.from({ length: 17 }, (_, i) => i + 6), pick = c => H.map(h => c[h]);
    const testMin = Array(24).fill(0); for (const s of ENERGY.sessions.filter(s => s.split === "test")) testMin[new Date(s.start).getUTCHours()] += s.dur / 60e3;
    const top4 = c => H.slice().sort((a, b) => c[b] - c[a]).slice(0, 4), share = c => top4(c).reduce((a, h) => a + testMin[h], 0) / testMin.reduce((a, b) => a + b, 0);
    out.energy = { learnedDays: res.learnedDays, corrWithTrue: { prior: pearson(pick(res.prior), pick(ENERGY.trueCurve)), learned: pearson(pick(res.learned), pick(ENERGY.trueCurve)) },
      testFocusInTop4Hours: { prior: share(res.prior), learned: share(res.learned) }, top4Hours: { prior: top4(res.prior), learned: top4(res.learned) } };
    await ctx.close();
  }

  // ---- plan builder: 500 seeded random days ----
  {
    const { page, ctx } = await openApp(browser, base);
    const rng = mulberry32(SEED + 11), titles = EFFORT.filter(r => r.split !== "test").map(r => r.title);
    const violations = { overlap: 0, overdueNotFirst: 0, partsOutOfOrder: 0, noBreakAfter75: 0, heavyOver240: 0, beforeNow: 0 }, examples = [];
    let itemsTotal = 0, emptyDays = 0;
    for (let d = 0; d < 500; d++) {
      const dayDate = Date.UTC(2026, 10, 10 + (d % 40)), now = dayDate + Math.floor((6 + rng() * 14) * 60) * 60e3;
      const dk = new Date(dayDate).toISOString().slice(0, 10), add = n => new Date(dayDate + n * 86400e3).toISOString().slice(0, 10);
      const nTasks = Math.floor(rng() * 31), tasks = [];
      for (let i = 0; i < nTasks; i++) {
        const due = [null, null, add(-3), add(-1), dk, dk, add(1), add(2), add(7)][Math.floor(rng() * 9)];
        tasks.push({ id: `d${d}t${i}`, title: titles[Math.floor(rng() * titles.length)], notes: "", estimate: [0, 5, 15, 30, 45, 60, 90, 120, 180, 240, 300][Math.floor(rng() * 11)], priority: Math.floor(rng() * 4),
          projectId: ["p_work", "p_personal", null][Math.floor(rng() * 3)], due, subtasks: [], done: false, createdAt: now - 86400e3 });
      }
      const histDays = Math.floor(rng() * 31), entries = [];
      for (let h = 1; h <= histDays; h++) for (let k = 0; k < 3; k++) { const s = dayDate - h * 86400e3 + (8 + Math.floor(rng() * 10)) * 3600e3; entries.push({ id: `h${d}-${h}-${k}`, type: "focus", start: s, end: s + 45 * 60e3, dur: 45 * 60e3, projectId: null, switches: 0 }); }
      const settings = { workStart: 7 + Math.floor(rng() * 4), workEnd: 16 + Math.floor(rng() * 6) }, chrono = ["morning", "intermediate", "evening"][Math.floor(rng() * 3)];
      await page.clock.setFixedTime(new Date(now));
      const r = await page.evaluate(({ tasks, entries, settings, chrono, fresh }) => {
        eval(fresh); state.tasks = tasks; state.entries = entries; Object.assign(state.settings, settings); mlState().chrono = chrono; state.updatedAt++;
        const now = Date.now(), plan = buildPlan();
        return { now, items: plan.items.map(i => i.kind === "task" ? { ...i, overdue: urgencyOf(taskById(i.taskId), now) >= 20, forced: !!(taskById(i.taskId).due && taskById(i.taskId).due <= todayKey()) } : i) };
      }, { tasks, entries, settings, chrono, fresh });
      const it = r.items, tasksOnly = it.filter(i => i.kind === "task"), bad = [];
      itemsTotal += tasksOnly.length; if (!tasksOnly.length) emptyDays++;
      for (let i = 1; i < it.length; i++) if (it[i].start < it[i - 1].end) bad.push("overlap");
      const firstNonOverdue = tasksOnly.findIndex(i => !i.overdue); if (firstNonOverdue >= 0 && tasksOnly.slice(firstNonOverdue).some(i => i.overdue)) bad.push("overdueNotFirst");
      for (const t of tasksOnly) if (t.part > 1) { const prev = tasksOnly.find(o => o.taskId === t.taskId && o.part === t.part - 1); if (!prev || prev.start > t.start) bad.push("partsOutOfOrder"); }
      let run = 0; for (const i of it) { if (i.kind === "break") { run = 0; continue; } if (run >= 75) { bad.push("noBreakAfter75"); break; } run += i.dur; }
      if (tasksOnly.filter(i => i.eff === "H" && !i.forced).reduce((a, i) => a + i.dur, 0) > 240) bad.push("heavyOver240");
      if (it.some(i => i.start < r.now)) bad.push("beforeNow");
      for (const b of new Set(bad)) { violations[b]++; if (examples.length < 12) examples.push({ day: d, rule: b, now: new Date(r.now).toISOString(), items: it.map(i => `${new Date(i.start).toISOString().slice(11, 16)}–${new Date(i.end).toISOString().slice(11, 16)} ${i.kind === "task" ? `${i.taskId} ${i.eff}${i.overdue ? " OVERDUE" : ""}${i.forced ? " due" : ""}${i.parts > 1 ? ` p${i.part}/${i.parts}` : ""}` : "break"}`) }); }
    }
    out.planner.constraints = { days: 500, plannedTasks: itemsTotal, emptyDays, violations, totalViolatingDays: null, examples };
    // latency: 30 tasks, 30 days of history, caches cleared each run
    await page.clock.setFixedTime(new Date("2026-11-10T09:00:00Z"));
    const times = await page.evaluate(({ fresh, titles }) => {
      eval(fresh);
      const now = Date.now(), k = todayKey();
      for (let i = 0; i < 30; i++) state.tasks.push({ id: "lt" + i, title: titles[i], notes: "", estimate: [15, 30, 60, 120][i % 4], priority: i % 4, projectId: ["p_work", null][i % 2], due: i % 3 ? k : null, subtasks: [], done: false, createdAt: now });
      for (let d = 1; d <= 30; d++) for (let j = 0; j < 6; j++) { const s = now - d * 86400e3 + j * 3600e3; state.entries.push({ id: `le${d}-${j}`, type: "focus", start: s, end: s + 40 * 60e3, dur: 40 * 60e3, taskId: j % 2 ? null : "done" + d, projectId: null, switches: 0 }); }
      const out = [];
      for (let i = 0; i < 230; i++) { state.updatedAt++; const t0 = performance.now(); buildPlan(); const ms = performance.now() - t0; if (i >= 30) out.push(ms); }   // 30 warm-up runs
      return out;
    }, { fresh, titles });
    out.planner.latencyMs = { runs: times.length, median: median(times), p95: quantile(times, 0.95), max: Math.max(...times) };
    // ordering weights sanity
    out.ordering = await page.evaluate(fresh => {
      eval(fresh); const k = todayKey();
      state.tasks = [{ id: "quick", title: "Reply to the landlord", estimate: 10, priority: 1, due: k, subtasks: [], done: false }, { id: "long", title: "Review the budget", estimate: 60, priority: 1, due: k, subtasks: [], done: false }];
      const firstTask = () => { state.updatedAt++; return buildPlan().items.find(i => i.kind === "task").taskId; };
      const before = { ...mlState().w }, firstBefore = firstTask();
      for (let i = 0; i < 30; i++) learnOrder("quick", "long");
      const res = { weightsBefore: before, weightsAfter: { ...mlState().w }, firstBefore, firstAfter: firstTask() };
      // stronger check (addendum): a 10-minute Light task that starts behind a Heavy task in a peak hour
      eval(fresh);
      state.tasks = [{ id: "heavy", title: "Write the grant proposal", estimate: 90, priority: 2, due: k, subtasks: [], done: false }, { id: "quick", title: "Reply to the landlord", estimate: 10, priority: 2, due: k, subtasks: [], done: false }];
      const peakBefore = firstTask();
      for (let i = 0; i < 30; i++) learnOrder("quick", "heavy");
      res.peakHour = { firstBefore: peakBefore, firstAfter: firstTask(), weightsAfter: { ...mlState().w } };
      return res;
    }, fresh);
    await ctx.close();
  }

  // ---- production (previous release) on the same primary test ----
  {
    const { page, ctx } = await openApp(browser, base, "tests/js/fixtures/prev/index.html");
    await page.evaluate(fresh);
    const prod = join(test, await predictAll(page, test));
    out.effort.baselines.production = prf(prod).macroF1;
    out.effort.baselines.productionSameAsCurrent = prod.every((r, i) => r.yhat === cold[i].yhat);
    await ctx.close();
  }
  return out;
}

function verdicts(r) {
  const e = r.effort, v = [];
  const add = (name, value, ok, rule) => v.push({ name, value, rule, pass: ok });
  add("Effort macro-F1 (as shipped, test)", e.primary.macroF1, e.primary.macroF1 >= 0.70, "≥ 0.70");
  add("… over majority-class baseline", e.primary.macroF1 - e.baselines.majority, e.primary.macroF1 - e.baselines.majority >= 0.15, "≥ +0.15");
  add("… vs keyword-only baseline", e.primary.macroF1 - e.baselines.keywordOnly, e.primary.macroF1 >= e.baselines.keywordOnly, "≥ 0");
  add("… vs production (previous release)", e.primary.macroF1 - e.baselines.production, e.primary.macroF1 >= e.baselines.production, "≥ 0");
  add("Slice gap: estimate", e.sliceGap.estimate, e.sliceGap.estimate <= 0.15, "≤ 0.15");
  add("Slice gap: project", e.sliceGap.project, e.sliceGap.project <= 0.15, "≤ 0.15");
  add("New vocabulary v2 accuracy after 20 corrections (option B)", r.newVocabV2.accuracyAfter, r.newVocabV2.accuracyAfter >= 0.80, "≥ 0.80");
  add("Duration: error reduction vs raw estimate", r.duration.users.reduction, r.duration.users.reduction >= 0.30, "≥ 30%");
  const viol = Object.values(r.planner.constraints.violations).reduce((a, b) => a + b, 0);
  add("Planner hard-constraint violations (500 days)", viol, viol === 0, "= 0");
  add("buildPlan p95 latency (ms)", r.planner.latencyMs.p95, r.planner.latencyMs.p95 < 50, "< 50 ms");
  const w = r.ordering.weightsAfter, d = r.ordering.weightsBefore;
  add("Ordering weights after 30 identical moves: quick-win rise (bug 41)", w.quick - d.quick, w.quick - d.quick >= 0.15, "≥ +0.15");
  add("Ordering weights stay within ½–2× of default (bug 41)", Math.min(...["prio", "energy", "quick"].map(k => w[k] / d[k])), ["prio", "energy", "quick"].every(k => w[k] >= d[k] / 2 && w[k] <= d[k] * 2), "all in [0.5, 2]");
  add("Calibration: test ECE below the shipped 0.364 (bug 39)", r.effort.calibration.ece, r.effort.calibration.ece < 0.364, "< 0.364");
  return v;
}

function strip(r) { const c = JSON.parse(JSON.stringify(r)); delete c.planner.latencyMs; return c; }   // timing varies run to run
function round(o) { return JSON.parse(JSON.stringify(o, (k, v) => typeof v === "number" && !Number.isInteger(v) ? r4(v) : v)); }

const server = await serve(), base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.PW_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PW_CHROMIUM_EXECUTABLE } : {});
try {
  const once = process.argv.includes("--once");
  const t0 = Date.now(), r1 = round(await evaluate(browser, base));
  let reproducible = null;
  if (!once) { const r2 = round(await evaluate(browser, base)); reproducible = JSON.stringify(strip(r1)) === JSON.stringify(strip(r2)); }
  const appSha = sha(read("index.html"));
  const result = { generatedAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), app: appSha, plannerModel: manifest.models.planner, datasets: manifest.datasets, seed: SEED, browser: browser.version(), reproducible, verdicts: verdicts(r1), ...r1 };
  mkdirSync(path.join(ROOT, "eval/results"), { recursive: true });
  const file = path.join(ROOT, `eval/results/planner-${appSha}.json`);
  writeFileSync(file, JSON.stringify(result, null, 1) + "\n");
  console.log(`Planner eval · app ${appSha} · planner ${manifest.models.planner.sha256} · reproducible: ${reproducible}`);
  for (const v of result.verdicts) console.log(`${v.pass ? "PASS" : "FAIL"}  ${v.name}: ${typeof v.value === "number" ? r4(v.value) : v.value} (${v.rule})`);
  console.log(`→ ${path.relative(ROOT, file)}`);
  process.exitCode = result.verdicts.every(v => v.pass) && reproducible !== false ? 0 : 1;
} finally { await browser.close(); server.close(); }
