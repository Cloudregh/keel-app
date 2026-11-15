// Evaluation suite entry point (kept separate from `npm test`).
// Phase 8 adds the planner model evals; Phase 10 adds the Daily coach (lite) eval; Phase 11 the coach red-team.
// AI_BUDGET is $0: this runner refuses to call any paid API and only runs on-device models
// or recorded/claude.ai-plan evaluations explicitly approved in docs/test-progress.md.
//
// Exit code (owner's decision, 2026-11-15): decided by the shipped versions only, which are the planner eval and the
// latest coach and red-team runs of the shipped prompt (eval/manifest.json). Every recorded run is still graded and
// printed, so historical failures stay visible. Thresholds and graders are unchanged. A shipped prompt with no
// recorded run fails, so an unevaluated prompt can't pass.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url)));
const suites = ["planner", "coach"].filter(s => existsSync(new URL(`./${s}/run.mjs`, import.meta.url)));
const shipped = manifest.prompts.dailyCoach.version;
console.log(`Keel evals · app ${manifest.app.sha256} · planner ${manifest.models.planner.version} · coach ${shipped}`);
if (!suites.length) { console.log("No eval suites yet (added in Phases 8 and 10)."); process.exit(0); }

const gate = [];   // [name, pass, detail]
if (suites.includes("planner")) {
  await import("./planner/run.mjs");
  gate.push(["planner eval", !process.exitCode, manifest.models.planner.version]);
  process.exitCode = 0;
}
const RES = new URL("./results/", import.meta.url);
const latestFor = pattern => readdirSync(RES).filter(f => pattern.test(f)).sort().reverse()
  .find(f => JSON.parse(readFileSync(new URL(f, RES), "utf8")).promptVersion === shipped);
const gradeAlone = (script, file) => spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), fileURLToPath(new URL(file, RES))], { stdio: "ignore" }).status === 0;
if (suites.includes("coach")) {
  console.log(`\nAll recorded coach runs, graded for the record (only the latest ${shipped} run decides the exit code):`);
  await import("./coach/run.mjs");
  process.exitCode = 0;
  const f = latestFor(/^coach-run-.*\.json$/);
  gate.push([`coach eval, latest ${shipped} run`, !!f && gradeAlone("./coach/run.mjs", f), f ? "run-" + f.replace(/^coach-run-|\.json$/g, "") : "none recorded"]);
}
if (existsSync(new URL("./coach/attack.mjs", import.meta.url))) {
  const { main } = await import("./coach/attack.mjs");
  main();
  const f = latestFor(/^coach-attack-run-.*\.json$/);
  gate.push([`coach red-team, latest ${shipped} run`, !!f && gradeAlone("./coach/attack.mjs", f), f ? "run-" + f.replace(/^coach-attack-run-|\.json$/g, "") : "none recorded"]);
}
console.log("\nExit code decided by the shipped versions:");
for (const [name, ok, detail] of gate) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
process.exitCode = gate.every(g => g[1]) ? 0 : 1;
