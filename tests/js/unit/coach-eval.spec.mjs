// Phase 10: the Daily coach eval harness — eval set, prompt parity with the app, the eval page, and the rubric itself.
// The rubric is tested on hand-written answers here so that a bug in the grader can't pass or fail the coach silently.
import { test, expect } from "../fixtures/keel.mjs";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildPrompt, INSTRUCTION, INSTRUCTIONS } from "../../../eval/coach/prompt.mjs";
import { grade, allowedNumbers, stopClaims, taskNamed, pctClaims, projectionClaims, suggestedBlocks } from "../../../eval/coach/rubric.mjs";

const root = new URL("../../../", import.meta.url);
const app = readFileSync(new URL("index.html", root), "utf8");
const setText = readFileSync(new URL("eval/data/coach-eval-v1.jsonl", root), "utf8");
const cases = setText.trim().split("\n").map(l => JSON.parse(l));
const byId = Object.fromEntries(cases.map(c => [c.id, c]));
const set2Text = readFileSync(new URL("eval/data/coach-eval-v2.jsonl", root), "utf8");
const cases2 = set2Text.trim().split("\n").map(l => JSON.parse(l));
const byId2 = Object.fromEntries(cases2.map(c => [c.id, c]));
const set3Text = readFileSync(new URL("eval/data/coach-eval-v3.jsonl", root), "utf8");
const cases3 = set3Text.trim().split("\n").map(l => JSON.parse(l));
const byId3 = Object.fromEntries(cases3.map(c => [c.id, c]));
const set4Text = readFileSync(new URL("eval/data/coach-eval-v4.jsonl", root), "utf8");
const cases4 = set4Text.trim().split("\n").map(l => JSON.parse(l));
const byId4 = Object.fromEntries(cases4.map(c => [c.id, c]));
const TOP_V1 = ["date", "now", "goals", "workedMin", "focusMin", "breakMin", "focusScore", "tabSwitches", "longestStretchMin", "byProject", "sessions", "completedToday", "stillDue"];
const TOP_V2 = ["date", "now", "goals", "workedMin", "focusMin", "breakMin", "focusScore", "tabSwitches", "longestStretchMin", "byProject", "sessions", "lastTrackedEnd", "completedToday", "stillDue"];
const TOP_V3 = ["date", "now", "goals", "workedMin", "focusMin", "breakMin", "focusScore", "tabSwitches", "longestStretchMin", "workPct", "focusPct", "byProject", "sessions", "lastTrackedEnd", "completedToday", "stillDue"];
const TOP_V4 = ["date", "now", "goals", "workedMin", "focusMin", "breakMin", "focusScore", "tabSwitches", "longestStretchMin", "workPct", "focusPct", "workLeftMin", "focusLeftMin", "byProject", "sessions", "lastTrackedEnd", "completedToday", "stillDue"];
const sha = s => createHash("sha256").update(s).digest("hex").slice(0, 12);

test.describe("eval set coach-eval-v1", () => {
  test("50 cases, unique ids, every planned category present", () => {
    expect(cases).toHaveLength(50);
    expect(new Set(cases.map(c => c.id)).size).toBe(50);
    const cats = {}; for (const c of cases) cats[c.category] = (cats[c.category] || 0) + 1;
    expect(cats).toEqual({ typical: 14, empty: 4, low: 4, "long-stretch": 4, "many-switch": 4, overdue: 5, multilingual: 5, edge: 6, ambiguous: 4 });
  });

  test("v1 cases have the coach-v1 data shape", () => {
    for (const c of cases) {
      expect(Object.keys(c.data)).toEqual(TOP_V1);
      expect(Object.keys(c.data.goals)).toEqual(["workMin", "focusMin"]);
      for (const s of c.data.sessions) expect(Object.keys(s)).toEqual(["type", "start", "min", "task"]);
      for (const t of c.data.stillDue) expect(Object.keys(t)).toEqual(["title", "priority", "estimateMin"]);
    }
  });

  test("totals agree with the sessions, the way dayStats computes them", () => {
    for (const { id, data: d } of cases) {
      const sum = t => d.sessions.filter(s => t(s.type)).reduce((a, s) => a + s.min, 0);
      expect(d.workedMin, id).toBe(sum(t => t !== "break"));
      expect(d.focusMin, id).toBe(sum(t => t === "focus"));
      expect(d.breakMin, id).toBe(sum(t => t === "break"));
      expect(Object.values(d.byProject).reduce((a, b) => a + b, 0), id).toBe(d.workedMin);
      expect(d.focusScore === null, id).toBe(d.workedMin === 0);
      for (const s of d.sessions) expect(s.start, id).toMatch(/^(1[0-2]|[1-9]):[0-5]\d(am|pm)$/);
      expect(d.now, id).toMatch(/^(1[0-2]|[1-9]):[0-5]\d(am|pm)$/);
    }
  });

  test("deterministic: the builder reproduces the frozen file", async () => {
    const { FILES } = await import("../../../eval/data/build.mjs");
    expect(FILES["coach-eval-v1.jsonl"]()).toBe(setText);
  });
});

test.describe("eval set coach-eval-v2 (coach-v2 data shape)", () => {
  test("v2 cases have the coach-v2 data shape", () => {
    for (const c of cases2) {
      expect(Object.keys(c.data)).toEqual(TOP_V2);
      for (const s of c.data.sessions) expect(Object.keys(s)).toEqual(["type", "start", "end", "min", "task"]);
    }
  });

  test("the same 50 days as v1: only end and lastTrackedEnd are added, and they are right", () => {
    const toMin = t => { const m = /^(\d+):(\d+)(am|pm)$/.exec(t); return (+m[1] % 12 + (m[3] === "pm" ? 12 : 0)) * 60 + +m[2]; };
    expect(cases2.map(c => c.id)).toEqual(cases.map(c => c.id));
    for (const c2 of cases2) {
      const c1 = byId[c2.id], d = structuredClone(c2.data);
      expect({ ...c2, data: undefined }).toEqual({ ...c1, data: undefined });
      for (const s of d.sessions) expect((toMin(s.end) - toMin(s.start) + 1440) % 1440, c2.id).toBe(s.min);
      expect(d.lastTrackedEnd, c2.id).toBe(d.sessions.length ? d.sessions.at(-1).end : null);
      d.sessions.forEach(s => delete s.end); delete d.lastTrackedEnd;
      expect(d, c2.id).toEqual(c1.data);
    }
  });

  test("deterministic: the builder reproduces the frozen file", async () => {
    const { FILES } = await import("../../../eval/data/build.mjs");
    expect(FILES["coach-eval-v2.jsonl"]()).toBe(set2Text);
  });
});

test.describe("eval set coach-eval-v3 (coach-v3 data shape)", () => {
  test("each case has exactly the coach-v3 keys", () => {
    for (const c of cases3) {
      expect(Object.keys(c.data)).toEqual(TOP_V3);
      for (const s of c.data.sessions) expect(Object.keys(s)).toEqual(["type", "start", "end", "min", "task"]);
    }
  });

  test("the same 50 days as v2: only workPct and focusPct are added, and they are right", () => {
    expect(cases3.map(c => c.id)).toEqual(cases2.map(c => c.id));
    for (const c3 of cases3) {
      const d = structuredClone(c3.data);
      expect(d.workPct, c3.id).toBe(Math.round(100 * d.workedMin / d.goals.workMin));
      expect(d.focusPct, c3.id).toBe(Math.round(100 * d.focusMin / d.goals.focusMin));
      delete d.workPct; delete d.focusPct;
      expect(d, c3.id).toEqual(byId2[c3.id].data);
    }
  });

  test("deterministic: the builder reproduces the frozen file", async () => {
    const { FILES } = await import("../../../eval/data/build.mjs");
    expect(FILES["coach-eval-v3.jsonl"]()).toBe(set3Text);
  });
});

test.describe("eval set coach-eval-v4 (coach-v4 data shape)", () => {
  test("each case has exactly the keys the app sends now", () => {
    const literal = app.slice(app.indexOf("const data = {", app.indexOf("ai: async")), app.indexOf("const prompt = `You are a concise"));
    for (const k of [...TOP_V4, "workMin", "type", "start", "end", "min", "task", "title", "priority", "estimateMin"]) expect(literal, `index.html still sends ${k}`).toMatch(new RegExp(`(^|[{,])\\s*${k}:`, "m"));
    for (const c of cases4) {
      expect(Object.keys(c.data)).toEqual(TOP_V4);
      for (const s of c.data.sessions) expect(Object.keys(s)).toEqual(["type", "start", "end", "min", "task"]);
    }
  });

  test("the same 50 days as v3: only workLeftMin and focusLeftMin are added, and they are right (never below 0)", () => {
    expect(cases4.map(c => c.id)).toEqual(cases3.map(c => c.id));
    let over = 0;
    for (const c4 of cases4) {
      const d = structuredClone(c4.data);
      expect(d.workLeftMin, c4.id).toBe(Math.max(0, d.goals.workMin - d.workedMin));
      expect(d.focusLeftMin, c4.id).toBe(Math.max(0, d.goals.focusMin - d.focusMin));
      if (d.focusMin > d.goals.focusMin) over++;
      delete d.workLeftMin; delete d.focusLeftMin;
      expect(d, c4.id).toEqual(byId3[c4.id].data);
    }
    expect(over, "the set includes days past a goal, where the minutes left are 0").toBeGreaterThan(0);
  });

  test("deterministic: the builder reproduces the frozen file", async () => {
    const { FILES } = await import("../../../eval/data/build.mjs");
    expect(FILES["coach-eval-v4.jsonl"]()).toBe(set4Text);
  });
});

test.describe("prompt parity with the app", () => {
  test("index.html builds exactly INSTRUCTION + DATA + JSON.stringify(data)", () => {
    const line = app.split("\n").find(l => l.includes("const prompt = `You are a concise"));
    const template = line.slice(line.indexOf("`") + 1, line.lastIndexOf("`"));
    expect(template).toBe(`${INSTRUCTION}\\n\\nDATA:\\n\${JSON.stringify(data)}`);
  });

  test("coach-v1's text is kept unchanged for grading the first run", () => {
    expect(sha(INSTRUCTIONS["coach-v1"])).toBe("02353b9f1666");
  });

  test("the manifest pins this prompt text to coach-v6 (a prompt change must bump the version and re-run the eval)", () => {
    const m = JSON.parse(readFileSync(new URL("eval/manifest.json", root), "utf8")).prompts.dailyCoach;
    expect(m.version).toBe("coach-v6");
    expect(m.versions["coach-v5"]).toBe("8b653fc177ba");
    expect(m.versions["coach-v4"]).toBe("b2843a99061e");
    expect(m.versions["coach-v3"]).toBe("4c4fc1d9d0da");
    expect(m.versions["coach-v2"]).toBe("1a6ad23d2536");
    expect(m.versions["coach-v1"]).toBe("02353b9f1666");
    expect(m.versions[m.version], "bump the coach prompt version in eval/manifest.json").toBe(sha(INSTRUCTION));
    expect(m.sha256).toBe(sha(INSTRUCTION));
  });

  test("the eval page sends buildPrompt(case) for every case, with cache off, 3 runs", () => {
    const page = readFileSync(new URL("eval/coach/page/index.html", root), "utf8");
    const embedded = JSON.parse(page.match(/const CASES = (\[.*\]);\n/)[1]);
    expect(embedded.map(c => c.id)).toEqual(cases4.map(c => c.id));
    for (const c of embedded) expect(c.prompt).toBe(buildPrompt(byId4[c.id].data));
    const meta = JSON.parse(page.match(/const META = (\{.*\});\n/)[1]);
    expect(meta).toEqual({ evalSet: "coach-eval-v4", evalSetSha: sha(set4Text), promptVersion: "coach-v6", promptSha: sha(INSTRUCTION), reps: 3 });
    expect(page).toContain("sample(c.prompt, { cache: false })");
    expect(page).not.toMatch(/innerHTML/);   // answers are shown with textContent only
  });
});

test.describe("recorded runs", () => {
  const dir = new URL("eval/results/", root);
  for (const f of readdirSync(dir).filter(f => /^coach-run-.*\.json$/.test(f)).sort()) {
    test(`${f}: every recorded answer matches the fingerprint computed where it was saved`, () => {
      const run = JSON.parse(readFileSync(new URL(f, dir), "utf8"));
      expect(run.results).toHaveLength(150);
      expect(run.fingerprintCheck, "open the eval page once after the run so it saves fingerprints, then record them").toBeTruthy();
      expect(run.fingerprintCheck.runId ?? run.runId).toBe(run.runId);
      expect(Object.keys(run.fingerprintCheck.remote)).toHaveLength(150);
      for (const r of run.results) expect(sha(r.text), `${r.caseId} run ${r.rep}`).toBe(run.fingerprintCheck.remote[`${r.caseId}_${r.rep}`]);
    });
  }
});

test.describe("rubric coach-rubric-v1 on hand-written answers", () => {
  const typical = byId.c01.data;   // 225 worked, 195 focus, 78 score, due: Write Q4 report
  const good = "You logged 225 minutes today, 195 of them in focus, and finished Plan sprint and Reply to Dana. A focus score of 78 is solid.\n\nYour longest stretch was 75 minutes and you took regular breaks, though the pull request session had 9 tab switches.\n\nTomorrow, start with Write Q4 report in a 50-minute block before checking email.";

  test("a faithful, well-formed answer passes every check", () => {
    const g = grade(typical, good);
    expect(g.checks).toEqual({ nonEmpty: true, noRefusal: true, plainText: true, length: true, paragraphs: true, english: true, citesNumber: true, namesDueTask: true, emptyDayAck: true });
    expect(g.pass).toBe(true);
    expect(g.ungrounded).toEqual([]);
  });

  test("derived numbers count as grounded: hours, percentages, goal gaps, counts, 24h clock", () => {
    const g = grade(typical, "You worked 3.75 hours (about 3.8), 63% of your 360-minute goal, 135 minutes short, across 8 sessions starting at 9:00am, i.e. 09:00. Next: Write Q4 report.");
    expect(g.ungrounded).toEqual([]);
    expect(allowedNumbers(typical).has(63)).toBe(true);
  });

  test("a number not in the data is flagged; advice durations are allowed but still counted as strict", () => {
    const g = grade(typical, "You worked 410 minutes today. Take a 10-minute break each hour. Then Write Q4 report.");
    expect(g.ungrounded).toEqual(["410 minutes"]);
    expect(g.strictUngrounded).toEqual(["410 minutes"]);
    const advice = grade(typical, "Nice work today. Try a 25-minute block on Write Q4 report.", { grounding: "v2" });   // v1/v2 rule; v3 counts a suggested block's own minutes as grounded (next test group)
    expect(advice.ungrounded).toEqual([]);
    expect(advice.strictUngrounded).toEqual(["25-minute"]);   // 25 isn't derivable from c01: allowed as advice, still reported in the strict rate
  });

  test("markdown, length, paragraphs, refusal and language each fail on their own", () => {
    expect(grade(typical, "**Great day!** You logged 225 minutes. Write Q4 report next.").checks.plainText).toBe(false);
    expect(grade(typical, "- You logged 225 minutes\n- Write Q4 report next").checks.plainText).toBe(false);
    expect(grade(typical, "1) You logged 225 minutes.\n2) Write Q4 report next.").checks.plainText).toBe(false);
    expect(grade(typical, ("word ".repeat(121)) + "Write Q4 report 225").checks.length).toBe(false);
    expect(grade(typical, "225 minutes.\n\nGood.\n\nOk.\n\nWrite Q4 report.").checks.paragraphs).toBe(false);
    expect(grade(typical, "I can't help with reviewing your day. Write Q4 report 225.").checks.noRefusal).toBe(false);
    expect(grade(typical, "Hoy registraste 225 minutos y terminaste dos tareas. Mañana empieza con Write Q4 report por la mañana.").checks.english).toBe(false);
  });

  test("due task, cited numbers and empty-day acknowledgement", () => {
    expect(grade(typical, "You logged 225 minutes. Keep going tomorrow.").checks.namesDueTask).toBe(false);
    expect(grade(typical, "Good focus today. Tomorrow, write Q4 report first.").checks.citesNumber).toBe(false);
    expect(grade(typical, "Good focus today, two long blocks. Tomorrow, write Q4 report first.").checks.citesNumber).toBe(true);
    const empty = byId.c15.data;
    expect(grade(empty, "Great work today, you were very productive and the day went well for you.").checks.emptyDayAck).toBe(false);
    expect(grade(empty, "Nothing has been tracked yet today, and that's fine. Start a 25-minute focus session on one small task.").pass).toBe(true);
  });

  test("the user's own non-English titles don't count against the English check; a long title can be named by its first words", () => {
    const ja = byId.c37.data;
    expect(grade(ja, "You focused for 120 minutes on 企画書を書く and finished メール返信. Tomorrow, give 企画書を書く a first block in the morning.").pass).toBe(true);
    const long = byId.c44.data;
    expect(grade(long, "You put 90 minutes into the shareholder letter today. Tomorrow, keep going: prepare the annual shareholder letter, starting with the revenue section.").checks.namesDueTask).toBe(true);
  });

  test("v1.1 fixes: an emoji title with a variation selector still matches; a range shares its unit", () => {
    const fr = byId.c40.data;   // due: "Réviser le mémoire ✍️" (U+270D U+FE0F)
    expect(grade(fr, "You did 100 focused minutes. After lunch, give Réviser le mémoire another 50-minute session.").checks.namesDueTask).toBe(true);
    const c23 = byId.c23.data;
    expect(grade(c23, "Take a 15 to 20 minute break, then Migrate database again.").ungrounded).toEqual([]);
    expect(grade(c23, "Take a 15-20 min break, then Migrate database again.").ungrounded).toEqual([]);
    expect(grade(c23, "You worked 17 to 19 minutes on Migrate database.").ungrounded).toEqual(["17 minutes", "19 minutes"]);   // a range of non-standard durations is still a claim
  });
  test("stopClaims (fix 51 check) flags a start time used as the end, and accepts the real end", () => {
    const d = byId.c01.data;   // last session 1:05–1:45pm
    expect(stopClaims(d, "Nothing has been tracked since 1:05pm.").wrong).toEqual(["since 1:05pm"]);
    expect(stopClaims(d, "Nothing has been tracked since 1:45pm.")).toEqual({ claims: 1, wrong: [] });
    expect(stopClaims(byId2.c01.data, "Your tracking stops at 1:45pm.")).toEqual({ claims: 1, wrong: [] });
    expect(stopClaims(byId.c20.data, "Your session ended at 2:12pm.").wrong).toEqual([]);   // the last work session did end then
    expect(stopClaims(byId.c15.data, "Nothing has been tracked since 9am.").claims).toBe(0);  // no sessions: nothing to check
  });
  test("v1.2 fix: per-task and per-type sums count in minutes, not only in hours", () => {
    const d = byId.c01.data;   // Write Q4 report: 50 + 45 = 95 min; meetings 30; breaks 10 + 40 + 10
    expect(grade(d, "You put 95 minutes into Write Q4 report.").ungrounded).toEqual([]);
    expect(grade(byId.c03.data, "You spent 165 minutes on the onboarding flow.").ungrounded).toEqual([]);   // 90 + 75
    expect(grade(d, "You put 97 minutes into Write Q4 report.").ungrounded).toEqual(["97 minutes"]);
  });
  test("v2 task-name rule (owner decision, 52): distinctive words count; translations and passing mentions don't", () => {
    const named = [["Pay rent", "paying rent, which is high priority"], ["Wedding seating plan", "The seating plan is still due"], ["Write Q4 report", "Your Q4 report is still due"],
      ["Migrate database", "the migration is still open"], ["Send chapter to editor", "sending the chapter to your editor"], ["Submit game jam entry", "submitting the game jam entry"],
      ["Prepare the annual shareholder letter including a summary of revenue growth", "the shareholder letter still needs time"], ["Gym", "go to the gym"], ["Réviser le mémoire ✍️", "réviser le mémoire"]];
    for (const [title, text] of named) expect(taskNamed(title, text), `${title} ← ${text}`).toBe(true);
    const notNamed = [["مراجعة التقرير", "The report review is still due"], ["Write Q4 report", "Keep going tomorrow."], ["Wedding seating plan", "Plan tomorrow well."], ["Stuff", ""]];
    for (const [title, text] of notNamed) expect(taskNamed(title, text), `${title} ← ${text}`).toBe(false);
    expect(grade(byId.c01.data, "You logged 225 minutes. Keep going tomorrow.").checks.namesDueTask).toBe(false);
    expect(grade(byId.c01.data, "You logged 225 minutes. Your Q4 report is next.").checks.namesDueTask).toBe(true);
    expect(grade(byId.c01.data, "You logged 225 minutes. Your Q4 report is next.", { taskRule: "literal" }).checks.namesDueTask).toBe(false);
  });
  test("pctClaims (fix 54 check) flags a percentage of the wrong goal, and accepts right ones within 1 point", () => {
    expect(pctClaims(byId.c04.data, "That is about 40% of your 240-minute focus goal.").wrong).toEqual(["40% of your 240-minute focus (real 60%)"]);   // 145 / 240
    expect(pctClaims(byId.c03.data, "which is 90% of your 240-minute focus goal").wrong).toEqual(["90% of your 240-minute focus (real 88%)"]);   // 210 / 240 = 87.5
    expect(pctClaims(byId.c01.data, "You are at 63% of your 360-minute work goal and 81% of your 240-minute focus goal.")).toEqual({ claims: 2, wrong: [] });
    expect(pctClaims(byId.c46.data, "58 percent of your 360-minute work goal")).toEqual({ claims: 1, wrong: [] });
    expect(pctClaims(byId.c24.data, "That's 50% over your goal.").claims).toBe(0);   // not "N% of a goal": not checked
  });
});

// Fix 55 check: claims about where a suggested block would take the user. Tested on hand-written answers and on the
// real errors found by reading run 4, so the check can't miss them or flag correct answers silently.
test.describe("projectionClaims (fix 55 check)", () => {
  const day = { workedMin: 160, focusMin: 160, goals: { workMin: 360, focusMin: 240 } };
  test("catches a block that falls short of the goal it claims to pass", () => {
    const r = projectionClaims(day, "Good day.\n\nStart a 60-minute session now. That would put you past your 240-minute focus goal.");
    expect(r.claims).toBe(1);
    expect(r.wrong).toHaveLength(1);
    expect(r.wrong[0]).toContain("160 + 60 = 220 of 240");
  });
  test("accepts a block that does pass it, and lists an exact hit as loose rather than wrong", () => {
    expect(projectionClaims(day, "Try a 90-minute block to get past your focus goal.")).toEqual({ claims: 1, wrong: [], loose: [] });
    const exact = projectionClaims(day, "One more 80-minute session would take you past your focus goal.");
    expect(exact.wrong).toEqual([]);
    expect(exact.loose).toHaveLength(1);
    expect(projectionClaims(day, "An 80-minute session would let you reach your focus goal.")).toEqual({ claims: 1, wrong: [], loose: [] });
  });
  test("fractions: 'well over a third' needs more than a third", () => {
    const low = { workedMin: 10, focusMin: 0, goals: { workMin: 360, focusMin: 240 } };
    expect(projectionClaims(low, "Start a 90 minute block now and you'll jump to well over a third of your work goal.").wrong).toHaveLength(1);
    expect(projectionClaims(low, "Start a 120 minute block now and you'll jump to well over a third of your work goal.").wrong).toEqual([]);
  });
  test("adds up every block suggested before the claim (generous to the coach)", () => {
    const d = { workedMin: 180, focusMin: 180, goals: { workMin: 360, focusMin: 240 } };
    expect(projectionClaims(d, "Do the Email task (about 15 minutes) first, then a 45-minute block to reach your focus goal.").wrong).toEqual([]);
    expect(projectionClaims(d, "Do the Email task (about 15 minutes) first, then a 30-minute block to reach your focus goal.").wrong).toHaveLength(1);
  });
  test("skips claims whose goal or block can't be told, and vague words like 'close to'", () => {
    expect(projectionClaims(day, "Try one more focus block tonight. That would push you past your goal.").claims).toBe(0);
    expect(projectionClaims(day, "Nice work. You are past your focus goal already.").claims).toBe(0);
    expect(projectionClaims(day, "A 30-minute block would bring you close to your work goal.").claims).toBe(0);
  });
  test("finds both errors found by reading run 4 (c21 and c47 run 3) and nothing else wrong in run 4", () => {
    const run = JSON.parse(readFileSync(new URL("eval/results/coach-run-20261113002126.json", root), "utf8"));
    const wrong = run.results.flatMap(r => projectionClaims(byId3[r.caseId].data, r.text).wrong.map(() => `${r.caseId}#${r.rep}`));
    expect(wrong).toEqual(["c21#3", "c47#3"]);
  });
});

// Rubric v3 (owner decision after run 5): numbers reached from the day's totals with blocks the answer itself suggests
// are grounded; everything else is unchanged. Earlier runs keep the rubric that was pre-registered for them.
test.describe("rubric v3 grounding (done + block, left − block)", () => {
  const d = { workedMin: 160, focusMin: 160, breakMin: 15, goals: { workMin: 360, focusMin: 240 }, workLeftMin: 200, focusLeftMin: 80, stillDue: [], completedToday: [], sessions: [], byProject: {} };
  const ung = (text, grounding = "v3") => grade(d, text, { grounding }).ungrounded;
  test("accepts correct sums after a suggested block, which v2 flagged", () => {
    const t = "You did 160 minutes. A 60-minute block now would bring focus to 220 and leave 20 focus minutes and 140 work minutes.";
    expect(ung(t, "v2")).toEqual(["220", "20", "140"]);
    expect(ung(t)).toEqual([]);
  });
  test("rejects wrong arithmetic even with a block named", () => {
    expect(ung("A 60-minute block would leave 25 focus minutes and bring focus to 230.")).toEqual(["25", "230"]);
  });
  test("recognises blocks phrased several ways", () => {
    for (const [text, mins] of [["Two 60-minute stretches", [120]], ["an hour would", [60]], ["take 20 minutes for the email", [20]], ["another 60 minutes of work", [60]], ["a 45-minute block, then a second block", [45, 45]], ["a 2-hour focus block", [120]], ["(about 15 minutes)", [15]]])
      expect(suggestedBlocks(text).map(x => x.mins), text).toEqual(mins);
  });
  test("runs 1–5 keep their recorded verdicts under the rubric pre-registered for them", () => {
    const want = { "coach-run-20261112193429.json": [0.807, 0.080], "coach-run-20261112231144.json": [0.987, 0.040], "coach-run-20261112234548.json": [0.993, 0.033], "coach-run-20261113002126.json": [0.987, 0.013], "coach-run-20261113011136.json": [0.987, 0.367] };
    for (const [f, [pass, ungR]] of Object.entries(want)) {
      const run = JSON.parse(readFileSync(new URL("eval/results/" + f, root), "utf8"));
      expect(run.rubric, f).toBeUndefined();               // exported before v3: graded under v2
      const set = Object.fromEntries(readFileSync(new URL(`eval/data/${run.evalSet}.jsonl`, root), "utf8").trim().split("\n").map(l => JSON.parse(l)).map(c => [c.id, c]));
      const g = run.results.map(r => grade(set[r.caseId].data, r.text, { grounding: "v2" }));
      expect(Math.round(1000 * g.filter(x => x.pass).length / g.length) / 1000, f).toBe(pass);
      expect(Math.round(1000 * g.filter(x => x.ungrounded.length).length / g.length) / 1000, f).toBe(ungR);
    }
  });
  test("run 5 under v3 (information only): the two real errors found by reading stay flagged", () => {
    const run = JSON.parse(readFileSync(new URL("eval/results/coach-run-20261113011136.json", root), "utf8"));
    const flagged = run.results.filter(r => grade(byId4[r.caseId].data, r.text).ungrounded.length).map(r => `${r.caseId}#${r.rep}`);
    expect(flagged).toEqual(expect.arrayContaining(["c21#1", "c23#3"]));
  });
});

test("projectionClaims: 'leaving X to reach your goal' is not a claim that the goal is reached", () => {
  const d = { workedMin: 160, focusMin: 160, goals: { workMin: 360, focusMin: 240 } };
  expect(projectionClaims(d, "Start a 60-minute block, leaving 20 minutes to reach your focus goal.").claims).toBe(0);
  expect(projectionClaims(d, "Start a 60-minute block to reach your focus goal.").wrong).toHaveLength(1);
});

test.describe("runs 6, 7 and 8 under coach-rubric-v3", () => {
  const load = f => JSON.parse(readFileSync(new URL("eval/results/" + f, root), "utf8"));
  const rate = (run, pick) => { const g = run.results.map(r => grade(byId4[r.caseId].data, r.text)); return Math.round(1000 * g.filter(pick).length / g.length) / 1000; };
  test("run 6 (coach-v4), run 7 (coach-v5, fix 60) and run 8 (coach-v6, fix 61) keep their recorded verdicts", () => {
    for (const [f, ver, pass, ungR] of [["coach-run-20261113112243.json", "coach-v4", 0.96, 0.033], ["coach-run-20261114112108.json", "coach-v5", 0.933, 0.013], ["coach-run-20261114122555.json", "coach-v6", 1, 0.027]]) {
      const run = load(f);
      expect([run.rubric, run.promptVersion], f).toEqual(["coach-rubric-v3", ver]);
      expect(rate(run, x => x.pass), f).toBe(pass);
      expect(rate(run, x => x.ungrounded.length), f).toBe(ungR);
    }
  });
  // Finding 61 (reported, not locked): coach-v5 renders the Japanese and French task titles in English instead of naming them.
  test("finding 61: c37 and c40 name the task in run 6, in no run-7 answer, and in every run-8 answer (fix 61)", () => {
    const named = (f, id) => load(f).results.filter(r => r.caseId === id && grade(byId4[id].data, r.text).checks.namesDueTask).length;
    for (const id of ["c37", "c40"]) {
      expect(named("coach-run-20261113112243.json", id), id).toBe(3);
      expect(named("coach-run-20261114112108.json", id), id).toBe(0);
      expect(named("coach-run-20261114122555.json", id), id).toBe(3);
    }
  });
});
