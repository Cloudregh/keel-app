// Bug 39: refit the effort classifier's temperature constants on the effort-v1 VALIDATION split only.
// Grid: a ∈ 0.20–2.00 (step 0.05), b ∈ 0–0.30 (step 0.01); objective: mean log-loss of the model as shipped.
// The test split is never read here.
/* global state, mlState, predictEffort, TEMP -- app globals, used inside page.evaluate */
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("../../", import.meta.url).pathname);
const val = readFileSync(path.join(ROOT, "eval/data/effort-v1.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l)).filter(r => r.split === "val");
const browser = await chromium.launch(process.env.PW_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PW_CHROMIUM_EXECUTABLE } : {});
const page = await browser.newPage();
await page.goto("file://" + path.join(ROOT, "index.html"));
await page.waitForFunction("typeof predictEffort === 'function' && typeof TEMP === 'object'");
const res = await page.evaluate(rows => {
  state.ml = null; mlState();
  const loss = () => rows.reduce((s, r) => s - Math.log(Math.max(1e-12, predictEffort(r).p[r.label])), 0) / rows.length;
  const shipped = { ...TEMP }, base = loss();
  let best = { a: TEMP.a, b: TEMP.b, loss: base };
  for (let a = 0.2; a <= 2.0001; a += 0.05) for (let b = 0; b <= 0.3001; b += 0.01) {
    TEMP.a = +a.toFixed(2); TEMP.b = +b.toFixed(2);
    const l = loss(); if (l < best.loss - 1e-12) best = { a: TEMP.a, b: TEMP.b, loss: l };
  }
  Object.assign(TEMP, shipped);
  return { n: rows.length, shipped: { ...shipped, loss: base }, best };
}, val);
console.log(JSON.stringify(res));
await browser.close();
