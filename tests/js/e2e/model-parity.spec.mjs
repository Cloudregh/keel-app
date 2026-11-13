// Phase 9: prediction parity. Every browser must reproduce the evaluated model's outputs for a fixed set of inputs
// (golden file recorded by eval/planner/golden.mjs in the evaluation setup). Classes and plans must match exactly;
// probabilities to 1e-9.
import { test, expect } from "../fixtures/keel.mjs";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { GOLDEN_SCRIPT } from "../fixtures/golden-inputs.mjs";

const golden = JSON.parse(readFileSync(new URL("../fixtures/data/golden-planner.json", import.meta.url), "utf8"));
const effort = readFileSync(new URL("../../../eval/data/effort-v1.jsonl", import.meta.url), "utf8").trim().split("\n").map(l => JSON.parse(l));

test("the golden file belongs to this version of the app", () => {
  const sha = createHash("sha256").update(readFileSync(new URL("../../../index.html", import.meta.url), "utf8")).digest("hex").slice(0, 12);
  expect(golden.app, "re-record with: node eval/planner/golden.mjs").toBe(sha);
});

test("this browser gives the evaluated model's outputs for the fixed inputs", async ({ keel: { page } }) => {
  const got = await page.evaluate(`(${GOLDEN_SCRIPT})(${JSON.stringify(effort)})`);
  expect(got.version).toBe(golden.plannerVersion);
  const close = (a, b) => a.every((x, i) => Math.abs(x - b[i]) < 1e-9);
  for (const key of ["effortCold", "effortWarm"]) {
    expect(got[key].map(r => r.best), key).toEqual(golden[key].map(r => r.best));
    const off = got[key].filter((r, i) => !close(r.p, golden[key][i].p)).map(r => r.id);
    expect(off, `${key} probabilities`).toEqual([]);
  }
  expect(got.durations).toEqual(golden.durations);
  expect(got.plans).toEqual(golden.plans);
});
