// Bug 38 (addendum 2): choose the verb weight k on VALIDATION data only.
//   metric: accuracy on effort-newvocab-val-v1 "val" rows after its 20 corrections
//   guard:  effort-v1 "val" macro-F1, as shipped and after the train corrections, may drop ≤ 0.02 vs k = 0
// No test split is read here.
/* global state, mlState, predictEffort, setEffort -- app globals, used inside page.evaluate */
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("../../", import.meta.url).pathname);
const rows = f => readFileSync(path.join(ROOT, f), "utf8").trim().split("\n").map(l => JSON.parse(l));
const vocab = rows("eval/data/effort-newvocab-val-v1.jsonl"), effort = rows("eval/data/effort-v1.jsonl");
const data = { corr: vocab.filter(r => r.split === "corrections"), vval: vocab.filter(r => r.split === "val"), train: effort.filter(r => r.split === "train"), eval: effort.filter(r => r.split === "val") };
if (Object.values(data).some(d => d.some(r => r.split === "test"))) throw new Error("test rows must not be used here");

const browser = await chromium.launch(process.env.PW_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PW_CHROMIUM_EXECUTABLE } : {});
const page = await browser.newPage();
await page.goto("file://" + path.join(ROOT, "index.html"));
await page.waitForFunction("typeof predictEffort === 'function' && typeof VERB_WEIGHT === 'number'");
const results = await page.evaluate(({ data, ks }) => {
  const macro = list => { const f = ["L", "M", "H"].map(c => { const tp = list.filter(r => r.y === c && r.p === c).length, fp = list.filter(r => r.y !== c && r.p === c).length, fn = list.filter(r => r.y === c && r.p !== c).length; const pr = tp + fp ? tp / (tp + fp) : 0, rc = tp + fn ? tp / (tp + fn) : 0; return pr + rc ? 2 * pr * rc / (pr + rc) : 0; }); return f.reduce((a, b) => a + b) / 3; };
  const run = rs => rs.map(r => ({ y: r.label, p: predictEffort(r).best }));
  const out = [];
  for (const k of ks) {
    eval(`VERB_WEIGHT = ${k}`);   // a script-scope "let" in the app, not a window property
    state.ml = null; mlState(); for (const r of data.corr) setEffort({ ...r }, r.label);
    const vv = run(data.vval), vocabAcc = vv.filter(r => r.y === r.p).length / vv.length;
    state.ml = null; mlState(); const cold = macro(run(data.eval));
    for (const r of data.train) setEffort({ ...r }, r.label); const warm = macro(run(data.eval));
    out.push({ k, vocabAcc, effortValCold: cold, effortValWarm: warm });
  }
  eval("VERB_WEIGHT = 0");
  return out;
}, { data, ks: [0, 1, 2, 3, 4, 6] });
const base = results[0];
for (const r of results) r.guardOk = base.effortValCold - r.effortValCold <= 0.02 && base.effortValWarm - r.effortValWarm <= 0.02;
const ok = results.filter(r => r.guardOk), best = ok.reduce((a, r) => r.vocabAcc > a.vocabAcc ? r : a, ok[0]);
console.table(results.map(r => ({ k: r.k, "val vocab acc": r.vocabAcc.toFixed(3), "effort-v1 val cold": r.effortValCold.toFixed(3), "effort-v1 val warm": r.effortValWarm.toFixed(3), guard: r.guardOk })));
console.log("chosen k =", best.k);
await browser.close();
