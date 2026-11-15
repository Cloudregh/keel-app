// Grades a recorded Daily coach run (Phase 10). Makes no AI calls: the answers were collected on claude.ai by
// eval/coach/page and exported from the artifact's db to eval/results/coach-<runId>.json.
//   node eval/coach/run.mjs [eval/results/coach-<runId>.json]   (default: the newest recorded run)
// Exit code 1 if a locked threshold is missed. Also imported by eval/run-evals.mjs as the regression baseline check.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { grade, stopClaims, pctClaims, projectionClaims } from "./rubric.mjs";
import { INSTRUCTIONS, EVAL_SET_FOR } from "./prompt.mjs";

const sha = s => createHash("sha256").update(s).digest("hex").slice(0, 12);
const RES = new URL("../results/", import.meta.url);
const THRESH = { rubricPass: 0.90, ungroundedMax: 0.05 };   // docs/test-strategy.md §6, locked in Phase 1

const arg = process.argv.slice(2).find(a => a.endsWith(".json") && !a.endsWith("run.mjs"));
const files = readdirSync(RES).filter(f => /^coach-run-.*\.json$/.test(f)).sort();
// every recorded run is graded (oldest first), each against its own eval set and prompt version
const targets = arg ? [arg] : files.map(f => new URL(f, RES));

if (!targets.length) {
  console.log("coach: no recorded run in eval/results yet (Phase 10 collects one on claude.ai).");
}
for (const file of targets) {
  const run = JSON.parse(readFileSync(file, "utf8"));
  const setText = readFileSync(new URL(`../data/${run.evalSet}.jsonl`, import.meta.url), "utf8");
  const cases = Object.fromEntries(setText.trim().split("\n").map(l => JSON.parse(l)).map(c => [c.id, c]));
  const INSTRUCTION = INSTRUCTIONS[run.promptVersion];
  if (EVAL_SET_FOR[run.promptVersion] !== run.evalSet) throw new Error(`${run.runId}: eval set ${run.evalSet} doesn't belong to ${run.promptVersion}`);
  const problems = [];
  if (run.evalSetSha !== sha(setText)) problems.push(`eval set changed since the run (${run.evalSetSha} → ${sha(setText)})`);
  if (run.promptSha !== sha(INSTRUCTION)) problems.push(`prompt changed since the run (${run.promptSha} → ${sha(INSTRUCTION)})`);
  const rows = run.results.filter(r => r.ok);
  // Each run is graded under the rubric pre-registered for it: runs exported before v3 (no `rubric` field) under v2
  // grounding, runs exported as coach-rubric-v3 under v3. The other version is shown for information.
  const rubric = run.rubric || "coach-rubric-v2", grounding = rubric === "coach-rubric-v3" ? "v3" : "v2", other = grounding === "v3" ? "v2" : "v3";
  const graded = rows.map(r => ({ ...r, g: grade(cases[r.caseId].data, r.text, { grounding }) }));
  const n = graded.length, expect = Object.keys(cases).length * run.reps;
  const passRate = graded.filter(r => r.g.pass).length / n;
  const literalPass = graded.filter(r => grade(cases[r.caseId].data, r.text, { taskRule: "literal", grounding }).pass).length / n;   // v1.2 rule, for comparison
  const ungRate = graded.filter(r => r.g.ungrounded.length).length / n;
  const strictRate = graded.filter(r => r.g.strictUngrounded.length).length / n;
  const otherUngRate = graded.filter(r => grade(cases[r.caseId].data, r.text, { grounding: other }).ungrounded.length).length / n;
  const byCheck = {};
  for (const r of graded) for (const [k, v] of Object.entries(r.g.checks)) byCheck[k] = (byCheck[k] || 0) + (v ? 0 : 1);
  const byCase = {};
  for (const r of graded) (byCase[r.caseId] ||= []).push(r.g.pass);
  const inconsistent = Object.entries(byCase).filter(([, v]) => v.some(Boolean) && !v.every(Boolean)).map(([k, v]) => `${k} (${v.filter(Boolean).length}/${v.length})`);
  const alwaysFail = Object.entries(byCase).filter(([, v]) => !v.some(Boolean)).map(([k]) => k);
  const byCat = {};
  for (const r of graded) { const c = cases[r.caseId].category; (byCat[c] ||= [0, 0]); byCat[c][0] += r.g.pass; byCat[c][1]++; }
  const stops = graded.map(r => stopClaims(cases[r.caseId].data, r.text)), stopN = stops.reduce((a, x) => a + x.claims, 0), stopWrong = stops.flatMap((x, i) => x.wrong.map(w => `${graded[i].caseId}#${graded[i].rep} "${w}"`));
  const pcts = graded.map(r => pctClaims(cases[r.caseId].data, r.text)), pctN = pcts.reduce((a, x) => a + x.claims, 0), pctWrong = pcts.flatMap((x, i) => x.wrong.map(w => `${graded[i].caseId}#${graded[i].rep} "${w}"`));
  const projs = graded.map(r => projectionClaims(cases[r.caseId].data, r.text)), projN = projs.reduce((a, x) => a + x.claims, 0), at = i => `${graded[i].caseId}#${graded[i].rep}`, projWrong = projs.flatMap((x, i) => x.wrong.map(w => `${at(i)} "${w}"`)), projLoose = projs.flatMap((x, i) => x.loose.map(w => `${at(i)} "${w}"`));
  // like-for-like with run 1: grounding judged without the end times that coach-v2 adds to the data
  let likeForLike = null;
  if (run.evalSet === "coach-eval-v2") {
    const v1 = Object.fromEntries(readFileSync(new URL("../data/coach-eval-v1.jsonl", import.meta.url), "utf8").trim().split("\n").map(l => JSON.parse(l)).map(c => [c.id, c]));
    likeForLike = graded.filter(r => grade(v1[r.caseId].data, r.text, { grounding }).ungrounded.length).length / n;
  }
  const words = graded.map(r => r.g.words).sort((a, b) => a - b);
  const caseVar = Object.values(byCase).map(v => { const p = v.filter(Boolean).length / v.length; return p * (1 - p); });

  const verdicts = [
    [`all ${expect} answers collected`, n === expect, `${n}/${expect} ok, ${run.results.length - n} failed requests`],
    [`rubric pass rate ≥ ${THRESH.rubricPass * 100}%`, passRate >= THRESH.rubricPass, `${(passRate * 100).toFixed(1)}%`],
    [`responses with an ungrounded number ≤ ${THRESH.ungroundedMax * 100}%`, ungRate <= THRESH.ungroundedMax, `${(ungRate * 100).toFixed(1)}% (strict, no advice allowance: ${(strictRate * 100).toFixed(1)}%)`],
    ["eval set and prompt version unchanged since the run", problems.length === 0, problems.join("; ") || "same"],
  ];
  console.log(`\nDaily coach eval · ${run.runId} · ${run.evalSet} ${run.evalSetSha} · ${run.promptVersion} ${run.promptSha} · ${rubric} · model ${[...new Set(rows.map(r => r.modelApplied || "platform default (not reported)"))].join(", ")}`);
  for (const [name, ok, detail] of verdicts) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
  console.log(`  ungrounded rate under ${other} grounding (information only): ${(otherUngRate * 100).toFixed(1)}%`);
  console.log(`  rubric pass rate with the literal task-name rule (v1.2, for comparison): ${(literalPass * 100).toFixed(1)}%`);
  console.log(`  failures by check: ${JSON.stringify(byCheck)}`);
  console.log(`  pass by category: ${Object.entries(byCat).map(([k, [p, t]]) => `${k} ${p}/${t}`).join(", ")}`);
  console.log(`  words: median ${words[Math.floor(n / 2)]}, max ${words.at(-1)} · mean per-case pass variance ${(caseVar.reduce((a, b) => a + b, 0) / caseVar.length).toFixed(3)}`);
  console.log(`  claims about when tracking stopped (fix 51 regression check, not a locked threshold): ${stopN}, wrong ${stopWrong.length} in ${new Set(stopWrong.map(w => w.split(" ")[0])).size} answers${stopWrong.length ? ": " + stopWrong.join("; ") : ""}`);
  if (likeForLike !== null) console.log(`  ungrounded rate counting end times as ungrounded (like-for-like with run 1, information only): ${(likeForLike * 100).toFixed(1)}%`);
  console.log(`  goal-percentage claims (fix 54 check, not a locked threshold): ${pctN}, wrong ${pctWrong.length}${pctWrong.length ? ": " + pctWrong.join("; ") : ""}`);
  console.log(`  claims about where a suggested block takes the user (fix 55 check, not a locked threshold): ${projN}, wrong ${projWrong.length}${projWrong.length ? ": " + projWrong.join("; ") : ""}; past a goal only exactly reached: ${projLoose.length}${projLoose.length ? ": " + projLoose.join("; ") : ""}`);
  console.log(`  answers over 120 words: ${graded.filter(r => r.g.words > 120).length}`);
  console.log(`  inconsistent cases (pass sometimes): ${inconsistent.join(", ") || "none"}`);
  console.log(`  cases failing every run: ${alwaysFail.join(", ") || "none"}`);
  const report = {
    runId: run.runId, rubric, otherGroundingUngroundedRate: otherUngRate, promptVersion: run.promptVersion, stopClaims: { claims: stopN, wrong: stopWrong }, pctClaims: { claims: pctN, wrong: pctWrong }, projectionClaims: { claims: projN, wrong: projWrong, loose: projLoose }, literalTaskRulePassRate: literalPass, evalSet: run.evalSet, n, passRate, ungroundedRate: ungRate, strictUngroundedRate: strictRate,
    byCheck, byCat, inconsistent, alwaysFail,
    failures: graded.filter(r => !r.g.pass || r.g.ungrounded.length).map(r => ({ case: r.caseId, rep: r.rep, failed: Object.entries(r.g.checks).filter(([, v]) => !v).map(([k]) => k), ungrounded: r.g.ungrounded, text: r.text })),
  };
  writeFileSync(new URL(`coach-graded-${run.runId}.json`, RES), JSON.stringify(report, null, 1) + "\n");
  if (verdicts.some(v => !v[1])) process.exitCode = 1;
}
