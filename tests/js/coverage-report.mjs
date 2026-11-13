// Merges Chrome (V8) coverage from the unit tests and reports coverage of Keel's business-logic functions.
// Run: KEEL_COVERAGE=1 npx playwright test --project=unit && node tests/js/coverage-report.mjs
// Two numbers are reported; the gate uses the LOWER one (index.html has many long one-line statements,
// so "line" coverage alone would flatter it):
//   line coverage  = lines (in business functions) whose first code character was executed
//   char coverage  = non-whitespace characters (in business functions) inside executed ranges
import { readFileSync, writeFileSync } from "node:fs";

export const BUSINESS = [
  "parseQuick", "fmtDur", "fmtClock", "fmtTime", "fmtDay", "addDays", "keyToDate", "dayKey", "monthKey", "dayStart", "todayKey", "clamp", "slug", "esc",
  "normalize", "clipDur", "dayStats", "currentStretch", "activeElapsed", "allEntries", "taskSpent", "pomosToday",
  "startSession", "pauseSession", "finishSession", "onTimerComplete", "taskSort", "rangeDays",
  "importActivity", "defaultCat", "catOf", "actStats", "actBlocks", "cleanupKeel", "lsBytes", "fmtBytes", "inkOn", "docs",
  "featurize", "priorCounts", "predictEffort", "trainEffort", "untrainEffort", "effortOf", "setEffort", "learnFromDone",
  "durationStats", "predictDuration", "energyCurve", "urgencyOf", "buildPlan", "reasonFor", "planForDay", "learnOrder", "insightFor",
  "trFetch", "trPoll", "trPost", "readActivityFile"
];
const THRESHOLD = Number(process.env.KEEL_JS_COVERAGE_MIN || 80);

const lines = readFileSync("coverage/js-v8.jsonl", "utf8").trim().split("\n").map(l => JSON.parse(l));
let source = null, covered = null;
const spans = new Map();
for (const { entries } of lines) {
  for (const e of entries) {
    if (!e.source || !e.source.includes("function parseQuick")) continue;   // the app's inline script
    if (source === null) { source = e.source; covered = new Uint8Array(source.length); }
    if (e.source !== source) throw new Error("coverage came from different app versions");
    const counts = new Int32Array(source.length).fill(-1);
    const ranges = e.functions.flatMap(f => f.ranges.map((r, i) => ({ ...r, fn: f.functionName, first: i === 0 })))
      .sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
    for (const r of ranges) counts.fill(r.count, r.startOffset, r.endOffset);
    for (let i = 0; i < counts.length; i++) if (counts[i] > 0) covered[i] = 1;
    for (const f of e.functions) if (BUSINESS.includes(f.functionName) && !spans.has(f.functionName)) spans.set(f.functionName, [f.ranges[0].startOffset, f.ranges[0].endOffset]);
  }
}
if (!source) throw new Error("no coverage for index.html found");
const missingFns = BUSINESS.filter(n => !spans.has(n));
const rows = [];
let L = 0, Lc = 0, C = 0, Cc = 0;
for (const [name, [s, e]] of [...spans].sort((a, b) => a[1][0] - b[1][0])) {
  let l = 0, lc = 0, c = 0, cc = 0, i = s;
  while (i < e) {
    let j = source.indexOf("\n", i); if (j === -1 || j > e) j = e;
    const text = source.slice(i, j); const k = text.search(/\S/);
    if (k !== -1 && !/^\s*(\/\/|\/\*|\*)/.test(text) && !/^\s*[}\])]*[;,]?\s*$/.test(text)) { l++; if (covered[i + k]) lc++; }
    for (let p = i; p < j; p++) if (!/\s/.test(source[p])) { c++; if (covered[p]) cc++; }
    i = j + 1;
  }
  rows.push({ name, line: (100 * lc / l).toFixed(0) + "%", char: (100 * cc / c).toFixed(0) + "%" });
  L += l; Lc += lc; C += c; Cc += cc;
}
const linePct = 100 * Lc / L, charPct = 100 * Cc / C, gate = Math.min(linePct, charPct);
console.table(rows);
console.log(`Business-logic functions: ${spans.size}/${BUSINESS.length}${missingFns.length ? " (never loaded: " + missingFns.join(", ") + ")" : ""}`);
console.log(`Line coverage ${linePct.toFixed(1)}% · char coverage ${charPct.toFixed(1)}% · gate (lower) ${gate.toFixed(1)}% · threshold ${THRESHOLD}%`);
writeFileSync("coverage/js-summary.json", JSON.stringify({ linePct, charPct, gate, threshold: THRESHOLD, functions: rows, missingFns }, null, 2));
if (missingFns.length || gate < THRESHOLD) process.exit(1);
