// Evaluation suite entry point (kept separate from `npm test`).
// Phase 8 adds the planner model evals; Phase 10 adds the Daily coach (lite) eval; Phase 11 the coach red-team.
// AI_BUDGET is $0: this runner refuses to call any paid API and only runs on-device models
// or recorded/claude.ai-plan evaluations explicitly approved in docs/test-progress.md.
import { readFileSync, existsSync } from "node:fs";
const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url)));
const suites = ["planner", "coach"].filter(s => existsSync(new URL(`./${s}/run.mjs`, import.meta.url)));
console.log(`Keel evals · app ${manifest.app.sha256} · planner ${manifest.models.planner.version} · coach ${manifest.prompts.dailyCoach.version}`);
if (!suites.length) { console.log("No eval suites yet (added in Phases 8 and 10)."); process.exit(0); }
for (const s of suites) await import(`./${s}/run.mjs`);
if (existsSync(new URL("./coach/attack.mjs", import.meta.url))) { const { main } = await import("./coach/attack.mjs"); if (main()) process.exitCode = 1; }
