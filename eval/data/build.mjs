// Builds Keel's frozen evaluation datasets (Phase 7). Deterministic: same seed → byte-identical files.
//   node eval/data/build.mjs           write the files
//   node eval/data/build.mjs --check   rebuild in memory and compare with the files on disk (no writes)
// The labels are decided here, by hand, from what each task is — never from any model's output.
import { writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { BASES } from "./effort-bases.mjs";
import { COACH_CASES, COACH_CASES_V2, COACH_CASES_V3, COACH_CASES_V4 } from "./coach-cases.mjs";

export const SEED = 20261110;
const DIR = new URL("./", import.meta.url);

function mulberry32(a) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const pick = (rng, xs) => xs[Math.floor(rng() * xs.length)];
const normal = rng => { let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
function shuffle(rng, xs) { const a = xs.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// ---- 1. Effort: 150 hand-labelled tasks × 2 phrasings, split by task (group) so phrasings never cross splits ----
const EST = { L: [5, 10, 10, 15, 15, 20, 30], M: [30, 30, 45, 45, 60, 60, 90], H: [90, 120, 120, 180, 180, 240] };
const STEPS = { L: [0, 0, 0, 0, 1], M: [0, 0, 1, 2, 3], H: [0, 2, 3, 4, 5, 6] };
const PRIO = { L: [0, 0, 1, 1, 2], M: [0, 1, 1, 2, 2, 3], H: [1, 2, 2, 3, 3] };
const PROJECTS = ["p_work", "p_personal", "p_study", null];
export function buildEffort(seed = SEED) {
  const rng = mulberry32(seed);
  const rows = [];
  for (const label of ["L", "M", "H"]) {
    const groups = shuffle(rng, BASES[label]);
    // per class: 25 test, 8 validation, rest train (the online model's "your corrections")
    groups.forEach((b, gi) => {
      const split = gi < 25 ? "test" : gi < 33 ? "val" : "train";
      b.titles.forEach((title, vi) => {
        const noEst = rng() < 0.25;
        const steps = pick(rng, STEPS[label]);
        rows.push({
          id: `${b.id}-${vi + 1}`, group: b.id, split, label, title,
          notes: vi === 1 && b.notes ? b.notes : "",
          estimate: noEst ? 0 : pick(rng, EST[label]),
          priority: pick(rng, PRIO[label]),
          projectId: pick(rng, PROJECTS),
          subtasks: Array.from({ length: steps }, (_, i) => ({ id: `${b.id}-${vi + 1}-s${i + 1}`, title: `Step ${i + 1}`, done: false })),
        });
      });
    });
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

// ---- 2. Duration: one person's finished tasks over 60 days; earlier 2/3 = history, later 1/3 = test ----
// True behaviour (hidden from the model): actual = estimate × exp(N(log overrun, 0.35)), overrun L 1.1, M 1.3, H 1.6.
const OVERRUN = { L: 1.1, M: 1.3, H: 1.6 };
export function buildDuration(seed = SEED + 1) {
  const rng = mulberry32(seed);
  const start = Date.UTC(2026, 8, 1, 8);   // 2026-09-01
  const effort = buildEffort();
  const rows = [];
  for (let i = 0; i < 150; i++) {
    const label = pick(rng, ["L", "L", "M", "M", "M", "H", "H"]);
    // titles come from the effort *train* split only: finishing a task also trains the effort model, so test titles must never appear here
    const src = pick(rng, effort.filter(r => r.split === "train" && r.label === label && r.estimate > 0));
    const estimate = src.estimate;
    const actualMin = Math.max(3, Math.round(estimate * Math.exp(Math.log(OVERRUN[label]) + 0.35 * normal(rng))));
    const doneAt = start + Math.floor(i / 150 * 60 * 86400e3) + Math.floor(rng() * 6 * 3600e3);
    rows.push({ id: `dur-${String(i + 1).padStart(3, "0")}`, label, title: src.title, estimate, actualMin, doneAt, split: i < 100 ? "history" : "test" });
  }
  return rows;
}

// ---- 3. Energy: 30 days of focus sessions from a known personal curve; days 1–21 = history, 22–30 = test ----
export const TRUE_CURVE = [0, 0, 0, 0, 0, 0, 0.05, 0.2, 0.7, 1.0, 0.95, 0.7, 0.35, 0.25, 0.45, 0.6, 0.55, 0.35, 0.2, 0.25, 0.3, 0.15, 0.05, 0];
export function buildEnergy(seed = SEED + 2) {
  const rng = mulberry32(seed);
  const sessions = [];
  for (let d = 0; d < 30; d++) {
    const day = new Date(Date.UTC(2026, 9, 1 + d));
    if ([0, 6].includes(day.getUTCDay())) continue;            // weekdays only
    for (let h = 6; h < 23; h++) {
      if (rng() > TRUE_CURVE[h] * 0.9) continue;
      const startMin = Math.floor(rng() * 20), len = 20 + Math.floor(rng() * 35);
      const s = Date.UTC(2026, 9, 1 + d, h, startMin);
      sessions.push({ id: `en-${sessions.length + 1}`, type: "focus", start: s, end: s + len * 60e3, dur: len * 60e3, split: d < 21 ? "history" : "test" });
    }
  }
  return { timezone: "UTC", trueCurve: TRUE_CURVE, sessions };
}

// ---- 4. New vocabulary: 60 farm and market tasks, mostly outside the keyword list (Phase 8, frozen) ----
// Only the words carry signal: no estimate, priority 1, no project, no steps. 20 seeded picks (7 L, 7 M, 6 H) are
// given as user corrections; the other 40 are the test.
const NEWVOCAB = {
  L: ["Feed the chickens", "Collect eggs from the coop", "Top up the chickens' water", "Spray the tomato seedlings", "Count the egg trays",
    "Feed the goats", "Collect eggs from the second coop", "Spray the pepper seedlings", "Refill the goats' water trough", "Lock the coop for the night",
    "Count the crates at the stall", "Note today's egg tally", "Feed the ducks", "Spray the garden beds", "Collect eggs and wipe the trays",
    "Top up the ducks' water", "Lock the storeroom", "Count the feed sacks", "Note the stall takings", "Refill the drinkers in the coop"],
  M: ["Weed the cassava plot", "Prune the cocoa trees on the east plot", "Mend the coop fencing", "Restock the stall with yams", "Weed the maize plot",
    "Prune the cocoa trees near the river", "Mend the goat pen gate", "Restock the stall with plantain", "Grade and sort the eggs for market", "Weed the pepper plot",
    "Mend the irrigation hose", "Restock the feed store", "Prune the orange trees", "Grade the cocoa beans after drying", "Weed around the young cocoa seedlings",
    "Mend the stall awning", "Restock the chicken feed", "Grade the plantain bunches", "Prune the mango trees", "Mend the storeroom door"],
  H: ["Harvest the cocoa on the east plot", "Clear the bush for the new plot", "Construct new drying racks", "Ferment and turn the cocoa beans", "Harvest the cassava field",
    "Clear the overgrown back plot", "Construct the second chicken coop", "Ferment the new batch of cocoa", "Harvest the maize field", "Clear land for the plantain suckers",
    "Construct a goat shelter", "Harvest the cocoa near the river", "Dig the new irrigation trench", "Construct raised beds for the nursery", "Clear and burn the field debris",
    "Dig a trench for the borehole pump", "Harvest and bag the groundnuts", "Ferment and dry the late cocoa", "Dig foundations for the storeroom", "Construct the market stall shelves"],
};
export function buildNewVocab(seed = SEED + 3) {
  const rng = mulberry32(seed), rows = [];
  for (const [label, n] of [["L", 7], ["M", 7], ["H", 6]]) {
    const order = shuffle(rng, NEWVOCAB[label].map((t, i) => i));
    NEWVOCAB[label].forEach((title, i) => rows.push({ id: `nv-${label.toLowerCase()}${String(i + 1).padStart(2, "0")}`, label, title, notes: "", estimate: 0, priority: 1, projectId: null, subtasks: [], split: order.indexOf(i) < n ? "corrections" : "test" }));
  }
  return rows;
}

// ---- 5. Duration users: 20 simulated people with a 1.4–1.8× overrun (the Phase 1 threshold's population) ----
export function buildDurationUsers(seed = SEED + 4) {
  const rng = mulberry32(seed), effort = buildEffort();
  const pool = { L: effort.filter(r => r.split === "train" && r.label === "L"), M: effort.filter(r => r.split === "train" && r.label === "M"), H: effort.filter(r => r.split === "train" && r.label === "H") };
  const users = [];
  for (let u = 0; u < 20; u++) {
    const bias = +(1.4 + 0.4 * rng()).toFixed(3), tasks = [];
    const start = Date.UTC(2026, 9, 1, 8);
    for (let i = 0; i < 60; i++) {
      const label = pick(rng, ["L", "L", "M", "M", "M", "H", "H"]), src = pick(rng, pool[label]);
      const estimate = pick(rng, EST[label]);
      const actualMin = Math.max(3, Math.round(estimate * bias * Math.exp(0.35 * normal(rng))));
      tasks.push({ id: `u${u + 1}-t${i + 1}`, label, title: src.title, estimate, actualMin, doneAt: start + Math.floor(i / 60 * 30 * 86400e3) + Math.floor(rng() * 4 * 3600e3), split: i < 40 ? "history" : "test" });
    }
    users.push({ user: `u${u + 1}`, bias, tasks });
  }
  return users;
}

// ---- 6. New vocabulary v2 (finding 38): corrections cover the vocabulary — one task per distinct first word
// (taken in list order), plus 2 seeded extras, 20 in all. Designed after v1 failed; reported next to v1.
export function buildNewVocabV2(seed = SEED + 5) {
  const rng = mulberry32(seed), all = [];
  for (const label of ["L", "M", "H"]) NEWVOCAB[label].forEach((title, i) => all.push({ id: `nv-${label.toLowerCase()}${String(i + 1).padStart(2, "0")}`, label, title, notes: "", estimate: 0, priority: 1, projectId: null, subtasks: [] }));
  const seen = new Set(), corr = new Set();
  for (const r of all) { const verb = r.title.split(" ")[0].toLowerCase(); if (!seen.has(verb)) { seen.add(verb); corr.add(r.id); } }
  const rest = shuffle(rng, all.filter(r => !corr.has(r.id)));
  for (const r of rest.slice(0, 20 - corr.size)) corr.add(r.id);
  return all.map(r => ({ ...r, split: corr.has(r.id) ? "corrections" : "test" }));
}

// ---- 7. Effort v2 (finding 42): effort-v1 with label-neutral notes drawn by seed from one shared pool.
const NEUTRAL_NOTES = ["Ask Ama if anything is unclear.", "See the shared folder for details.", "Do this before Friday if possible.", "Kofi mentioned this on Monday.",
  "Use the laptop, not the phone.", "Remember to tick it off afterwards.", "Linked to last week's list.", "Can be done from home.", "Check the calendar first.",
  "Keep the receipt or confirmation.", "Started this once already.", "Not urgent, but don't forget.", "Needs the office wifi.", "Write down anything odd.", "From the Sunday planning list."];
// Each class cycles through the same seeded order of the pool, so every sentence is spread across classes by
// construction. (A first version drew each note independently and, by chance, put one sentence on 3 Heavy tasks
// only; that tripped the leakage check before anything was evaluated, so the construction was changed.)
export function buildEffortV2(seed = SEED + 6) {
  const order = shuffle(mulberry32(seed), NEUTRAL_NOTES), next = { L: 0, M: 0, H: 0 };
  return buildEffort().map(r => ({ ...r, notes: r.notes ? order[next[r.label]++ % order.length] : "" }));
}

// ---- 8. Validation vocabulary (finding 38, addendum 2): a tailoring shop. Only for choosing the verb weight.
// Nouns are shared across classes on purpose ("wedding dress", "school uniforms"); 18 distinct first words, like v2.
const VALVOCAB = {
  L: ["Iron the finished shirts", "Iron the school uniforms", "Iron the wedding dress", "Pin the hem on the skirt", "Pin the sleeves on Ama's dress",
    "Thread the sewing machine", "Thread the overlocker", "Thread the embroidery machine", "Label the customer bags", "Label the fabric shelves",
    "Wrap the finished kaba", "Wrap the school uniforms for pickup", "Wrap the choir robes for delivery", "Sweep the workshop floor", "Sweep under the cutting table",
    "Tally the day's sales", "Tally the button stock", "Text Esi her fitting time", "Text the fabric supplier", "Text Kofi that his suit is ready"],
  M: ["Alter the trousers for Kofi", "Alter the wedding dress hem", "Alter the suit sleeves", "Alter the choir robes", "Hem the school uniforms",
    "Hem the skirt for Abena", "Hem the curtains", "Hem the bridesmaids' dresses", "Patch the torn jeans", "Patch the school uniforms",
    "Patch the bag lining", "Patch the workshop apron", "Measure Ama for the kaba", "Measure the groom's party", "Measure the choir for robes",
    "Measure the hotel windows for curtains", "Fit the wedding dress on the bride", "Fit Kofi's suit", "Fit the school uniforms", "Fit the bridesmaids' dresses"],
  H: ["Sew the wedding dress", "Sew the groom's suit", "Sew the school uniforms order", "Sew the curtains for the hotel", "Sew the choir robes",
    "Draft patterns for the choir robes", "Draft the pattern for the kaba", "Draft a new shirt pattern", "Draft patterns for the uniform order", "Embroider the wedding dress bodice",
    "Embroider the choir robes", "Embroider the church banner", "Embroider the logo on the school uniforms", "Tailor the three-piece suit", "Tailor the bridesmaids' dresses",
    "Tailor Kofi's kaftan", "Tailor the wedding party outfits", "Upholster the shop chairs", "Upholster the client's sofa", "Upholster the waiting-room bench"],
};
export function buildValVocab(seed = SEED + 8) {
  const rng = mulberry32(seed), all = [];
  for (const label of ["L", "M", "H"]) VALVOCAB[label].forEach((title, i) => all.push({ id: `vv-${label.toLowerCase()}${String(i + 1).padStart(2, "0")}`, label, title, notes: "", estimate: 0, priority: 1, projectId: null, subtasks: [] }));
  const seen = new Set(), corr = new Set();
  for (const r of all) { const verb = r.title.split(" ")[0].toLowerCase(); if (!seen.has(verb)) { seen.add(verb); corr.add(r.id); } }
  for (const r of shuffle(rng, all.filter(r => !corr.has(r.id))).slice(0, 20 - corr.size)) corr.add(r.id);
  return all.map(r => ({ ...r, split: corr.has(r.id) ? "corrections" : "val" }));
}

export const FILES = {
  "effort-v1.jsonl": () => buildEffort().map(r => JSON.stringify(r)).join("\n") + "\n",
  "duration-v1.json": () => JSON.stringify(buildDuration(), null, 1) + "\n",
  "energy-v1.json": () => JSON.stringify(buildEnergy(), null, 1) + "\n",
  "effort-newvocab-v1.jsonl": () => buildNewVocab().map(r => JSON.stringify(r)).join("\n") + "\n",
  "duration-users-v1.json": () => JSON.stringify(buildDurationUsers(), null, 1) + "\n",
  "effort-newvocab-v2.jsonl": () => buildNewVocabV2().map(r => JSON.stringify(r)).join("\n") + "\n",
  "effort-v2.jsonl": () => buildEffortV2().map(r => JSON.stringify(r)).join("\n") + "\n",
  "effort-newvocab-val-v1.jsonl": () => buildValVocab().map(r => JSON.stringify(r)).join("\n") + "\n",
  "coach-eval-v1.jsonl": () => COACH_CASES.map(r => JSON.stringify(r)).join("\n") + "\n",
  "coach-eval-v2.jsonl": () => COACH_CASES_V2.map(r => JSON.stringify(r)).join("\n") + "\n",
  "coach-eval-v3.jsonl": () => COACH_CASES_V3.map(r => JSON.stringify(r)).join("\n") + "\n",
  "coach-eval-v4.jsonl": () => COACH_CASES_V4.map(r => JSON.stringify(r)).join("\n") + "\n",
};
export const sha = s => createHash("sha256").update(s).digest("hex").slice(0, 12);

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes("--check");
  let bad = 0;
  for (const [name, make] of Object.entries(FILES)) {
    const text = make(), url = new URL(name, DIR);
    if (check) {
      const disk = readFileSync(url, "utf8");
      const ok = disk === text; bad += !ok;
      console.log(`${ok ? "same" : "DIFFERENT"}  ${name}  ${sha(disk)}`);
    } else { writeFileSync(url, text); console.log(`wrote ${name}  ${sha(text)}`); }
  }
  process.exit(bad ? 1 : 0);
}
