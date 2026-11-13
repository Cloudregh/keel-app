// coach-eval-v1: 50 synthetic days for the Daily coach (Phase 10). Every case is invented; no real person's data.
// Each case is the exact `data` object the app sends (same keys, same units, same time format as index.html),
// built from a list of sessions so the totals always agree with the sessions, the way dayStats() computes them.
// Frozen once results exist: change it only by adding coach-eval-v2, never by editing these cases.

const pad = n => String(n).padStart(2, "0");
const fmt = min => { let h = Math.floor(min / 60) % 24; const m = min % 60, ap = h >= 12 ? "pm" : "am"; h = h % 12 || 12; return `${h}:${pad(m)}${ap}`; };

/** spec: { id, category, date, now (min since midnight), goals, sessions: [[type, startMin, min, task|null, project|null, switches]], completed, due } */
function day(spec) {
  const g = spec.goals || { workMin: 360, focusMin: 240 }, breakReminderMin = 90;
  const list = spec.sessions.map(([type, start, min, task = null, project = null, switches = 0]) => ({ type, start, min, task, project, switches }));
  let work = 0, focus = 0, brk = 0, switches = 0, longest = 0, cur = 0, lastEnd = null;
  const byProject = {};
  for (const e of list) {
    if (e.type === "break") { brk += e.min; cur = 0; lastEnd = e.start + e.min; continue; }
    work += e.min;
    if (e.type === "focus") { focus += e.min; switches += e.switches; }
    const p = e.project || "No project"; byProject[p] = (byProject[p] || 0) + e.min;
    if (lastEnd !== null && e.start - lastEnd >= 10) cur = 0;
    cur += e.min; longest = Math.max(longest, cur); lastEnd = e.start + e.min;
  }
  let score = null;
  if (work > 0) {
    const goalPart = Math.min(1, focus / g.focusMin), ratio = focus / work;
    const breakHealth = longest <= breakReminderMin ? 1 : breakReminderMin / longest;
    const switchPart = 1 - Math.min(1, (switches / Math.max(focus / 60, 0.25)) / 10);
    score = Math.round(100 * (0.45 * goalPart + 0.25 * ratio + 0.15 * breakHealth + 0.15 * (focus > 0 ? switchPart : 0)));
  }
  const data = {
    date: spec.date, now: fmt(spec.now), goals: { workMin: g.workMin, focusMin: g.focusMin },
    workedMin: work, focusMin: focus, breakMin: brk, focusScore: score, tabSwitches: switches, longestStretchMin: longest,
    byProject,
    sessions: list.map(e => ({ type: e.type, start: fmt(e.start), min: e.min, task: e.task })),
    completedToday: spec.completed || [],
    stillDue: (spec.due || []).map(([title, priority = 0, estimateMin = null]) => ({ title, priority, estimateMin })),
  };
  return { id: spec.id, category: spec.category, note: spec.note || "", data };
}

const D = "2026-11-12";
// helpers to lay out a run of sessions back to back from a start time
function run(start, parts) { const out = []; let t = start; for (const [type, min, task, project, sw] of parts) { out.push([type, t, min, task ?? null, project ?? null, sw ?? 0]); t += min; } return out; }

export const COACH_CASES = [
  // ---- typical (14) ----
  day({ id: "c01", category: "typical", date: D, now: 17 * 60 + 30, sessions: run(9 * 60, [["focus", 50, "Write Q4 report", "Work", 6], ["break", 10], ["focus", 45, "Write Q4 report", "Work", 4], ["meeting", 30, null, "Work"], ["break", 40], ["focus", 60, "Review pull requests", "Work", 9], ["break", 10], ["focus", 40, "Plan sprint", "Work", 3]]), completed: ["Plan sprint", "Reply to Dana"], due: [["Write Q4 report", 3, 120]] }),
  day({ id: "c02", category: "typical", date: D, now: 16 * 60, sessions: run(8 * 60 + 30, [["focus", 25, "Study chapter 4", "Study", 2], ["break", 5], ["focus", 25, "Study chapter 4", "Study", 1], ["break", 5], ["focus", 25, "Flashcards", "Study", 3], ["break", 30], ["focus", 50, "Problem set 3", "Study", 5]]), completed: ["Flashcards"], due: [["Problem set 3", 2, 90]] }),
  day({ id: "c03", category: "typical", date: D, now: 18 * 60, sessions: run(10 * 60, [["focus", 90, "Design onboarding flow", "Product", 12], ["break", 15], ["meeting", 60, null, "Product"], ["focus", 45, "Update roadmap", "Product", 7], ["break", 45], ["focus", 75, "Design onboarding flow", "Product", 10]]), completed: ["Update roadmap"], due: [] }),
  day({ id: "c04", category: "typical", date: D, now: 12 * 60 + 15, sessions: run(9 * 60, [["focus", 40, "Inbox zero", "Admin", 15], ["break", 10], ["focus", 60, "Budget spreadsheet", "Finance", 8], ["break", 10], ["focus", 45, "Budget spreadsheet", "Finance", 4]]), completed: [], due: [["Budget spreadsheet", 2, 180], ["Call the bank", 1, 15]] }),
  day({ id: "c05", category: "typical", date: D, now: 15 * 60 + 45, sessions: run(7 * 60 + 45, [["focus", 55, "Fix login bug", "App", 5], ["break", 10], ["focus", 55, "Fix login bug", "App", 6], ["meeting", 15, null, "App"], ["break", 60], ["focus", 30, "Write release notes", "App", 2]]), completed: ["Fix login bug", "Write release notes"], due: [] }),
  day({ id: "c06", category: "typical", date: D, now: 19 * 60, goals: { workMin: 480, focusMin: 300 }, sessions: run(8 * 60, [["focus", 60, "Client proposal", "Agency", 8], ["break", 10], ["focus", 60, "Client proposal", "Agency", 6], ["meeting", 45, null, "Agency"], ["break", 50], ["focus", 50, "Moodboard", "Agency", 11], ["break", 10], ["focus", 50, "Invoice clients", "Admin", 3], ["meeting", 30, null, "Agency"]]), completed: ["Invoice clients"], due: [["Client proposal", 3, 60]] }),
  day({ id: "c07", category: "typical", date: D, now: 14 * 60, goals: { workMin: 240, focusMin: 120 }, sessions: run(10 * 60, [["focus", 35, "Edit podcast episode", "Podcast", 4], ["break", 10], ["focus", 35, "Edit podcast episode", "Podcast", 2], ["break", 20], ["focus", 30, "Write show notes", "Podcast", 1]]), completed: ["Write show notes"], due: [["Edit podcast episode", 2, 90]] }),
  day({ id: "c08", category: "typical", date: D, now: 17 * 60, sessions: run(9 * 60 + 15, [["meeting", 60, null, "Team"], ["focus", 30, "Prepare slides", "Team", 3], ["meeting", 45, null, "Team"], ["break", 30], ["meeting", 60, null, "Team"], ["focus", 45, "Prepare slides", "Team", 5]]), completed: [], due: [["Prepare slides", 2, 60]], note: "meeting-heavy" }),
  day({ id: "c09", category: "typical", date: D, now: 13 * 60 + 20, sessions: run(8 * 60, [["focus", 90, "Thesis literature review", "Thesis", 3], ["break", 20], ["focus", 90, "Thesis literature review", "Thesis", 4]]), completed: [], due: [["Thesis literature review", 3, 240]] }),
  day({ id: "c10", category: "typical", date: D, now: 18 * 60 + 10, sessions: run(9 * 60, [["focus", 45, "Customer emails", "Support", 20], ["break", 10], ["focus", 45, "Customer emails", "Support", 18], ["break", 30], ["focus", 60, "Knowledge base article", "Support", 6], ["break", 10], ["focus", 40, "Bug triage", "Support", 9]]), completed: ["Bug triage", "Knowledge base article"], due: [] }),
  day({ id: "c11", category: "typical", date: D, now: 11 * 60, sessions: run(8 * 60 + 30, [["focus", 50, "Morning writing", "Book", 0], ["break", 10], ["focus", 50, "Morning writing", "Book", 1]]), completed: [], due: [["Send chapter to editor", 2, 20]] }),
  day({ id: "c12", category: "typical", date: D, now: 16 * 60 + 40, goals: { workMin: 420, focusMin: 240 }, sessions: run(8 * 60 + 10, [["focus", 70, "Data cleaning", "Research", 7], ["break", 15], ["focus", 70, "Regression models", "Research", 5], ["break", 45], ["meeting", 30, null, "Research"], ["focus", 80, "Regression models", "Research", 8]]), completed: ["Data cleaning"], due: [["Regression models", 3, 120], ["Email supervisor", 1, 10]] }),
  day({ id: "c13", category: "typical", date: D, now: 20 * 60, sessions: run(13 * 60, [["focus", 60, "Landing page copy", "Launch", 9], ["break", 10], ["focus", 60, "Landing page copy", "Launch", 7], ["break", 20], ["focus", 45, "Set up analytics", "Launch", 12], ["meeting", 30, null, "Launch"]]), completed: ["Set up analytics"], due: [["Landing page copy", 3, 30]] }),
  day({ id: "c14", category: "typical", date: D, now: 15 * 60, sessions: run(9 * 60, [["focus", 30, "Lesson planning", "School", 2], ["meeting", 120, null, "School"], ["break", 30], ["focus", 40, "Mark essays", "School", 1]]), completed: ["Lesson planning"], due: [["Mark essays", 2, 120]] }),

  // ---- empty: nothing tracked (4) ----
  day({ id: "c15", category: "empty", date: D, now: 10 * 60, sessions: [], completed: [], due: [] }),
  day({ id: "c16", category: "empty", date: D, now: 15 * 60 + 30, sessions: [], completed: [], due: [["Renew passport", 2, 30], ["Gym", 0, 60]] }),
  day({ id: "c17", category: "empty", date: D, now: 7 * 60 + 5, sessions: [], completed: [], due: [], note: "very early in the day" }),
  day({ id: "c18", category: "empty", date: D, now: 22 * 60 + 50, sessions: [], completed: [], due: [["Pay rent", 3, 5]], note: "late at night, nothing tracked" }),

  // ---- low: a few minutes only (4) ----
  day({ id: "c19", category: "low", date: D, now: 11 * 60, sessions: run(10 * 60 + 40, [["focus", 6, "Check email", null, 4]]), completed: [], due: [] }),
  day({ id: "c20", category: "low", date: D, now: 16 * 60, sessions: run(14 * 60, [["focus", 12, "Sketch logo", "Side project", 2], ["break", 5]]), completed: [], due: [["Sketch logo", 1, 45]] }),
  day({ id: "c21", category: "low", date: D, now: 9 * 60 + 15, sessions: run(9 * 60, [["meeting", 10, null, "Work"]]), completed: [], due: [["Quarterly review prep", 3, 90]] }),
  day({ id: "c22", category: "low", date: D, now: 18 * 60, sessions: run(17 * 60 + 30, [["break", 20]]), completed: [], due: [], note: "only a break was tracked" }),

  // ---- long stretch without breaks (4) ----
  day({ id: "c23", category: "long-stretch", date: D, now: 14 * 60, sessions: run(9 * 60, [["focus", 120, "Migrate database", "Infra", 3], ["focus", 120, "Migrate database", "Infra", 4]]), completed: [], due: [["Migrate database", 3, 300]] }),
  day({ id: "c24", category: "long-stretch", date: D, now: 18 * 60, sessions: run(8 * 60, [["focus", 200, "Exam revision", "Study", 6], ["break", 15], ["focus", 160, "Exam revision", "Study", 5]]), completed: [], due: [["Exam revision", 3, 480]] }),
  day({ id: "c25", category: "long-stretch", date: D, now: 17 * 60, sessions: run(9 * 60, [["meeting", 90, null, "Work"], ["focus", 150, "Contract review", "Legal", 2], ["meeting", 60, null, "Work"]]), completed: ["Contract review"], due: [] }),
  day({ id: "c26", category: "long-stretch", date: D, now: 23 * 60, sessions: run(15 * 60, [["focus", 300, "Game jam build", "Game", 14], ["break", 30], ["focus", 90, "Game jam build", "Game", 6]]), completed: [], due: [["Submit game jam entry", 3, 30]], note: "late evening, very long stretch" }),

  // ---- many tab switches (4) ----
  day({ id: "c27", category: "many-switch", date: D, now: 16 * 60, sessions: run(9 * 60, [["focus", 60, "Research competitors", "Strategy", 85], ["break", 10], ["focus", 60, "Research competitors", "Strategy", 92], ["break", 30], ["focus", 45, "Summarise findings", "Strategy", 40]]), completed: [], due: [["Summarise findings", 2, 60]] }),
  day({ id: "c28", category: "many-switch", date: D, now: 13 * 60, sessions: run(9 * 60, [["focus", 30, "Answer Slack", null, 120], ["focus", 30, "Answer Slack", null, 140], ["break", 15], ["focus", 60, "Write spec", "Platform", 70]]), completed: [], due: [["Write spec", 3, 120]] }),
  day({ id: "c29", category: "many-switch", date: D, now: 17 * 60 + 45, sessions: run(10 * 60, [["focus", 45, "Social media posts", "Marketing", 60], ["break", 10], ["focus", 45, "Social media posts", "Marketing", 75], ["break", 20], ["focus", 45, "Newsletter", "Marketing", 30]]), completed: ["Social media posts"], due: [] }),
  day({ id: "c30", category: "many-switch", date: D, now: 12 * 60, sessions: run(8 * 60, [["focus", 25, "Debug flaky test", "App", 55], ["break", 5], ["focus", 25, "Debug flaky test", "App", 48], ["break", 5], ["focus", 25, "Debug flaky test", "App", 61]]), completed: [], due: [["Debug flaky test", 2, 60]] }),

  // ---- overdue / several tasks due (5) ----
  day({ id: "c31", category: "overdue", date: D, now: 15 * 60, sessions: run(9 * 60, [["focus", 60, "Tax return", "Personal", 4], ["break", 15], ["focus", 45, "Tax return", "Personal", 3]]), completed: [], due: [["Tax return", 3, 180], ["Book dentist", 1, 10], ["Return library books", 0, 20], ["Car insurance renewal", 2, 30]] }),
  day({ id: "c32", category: "overdue", date: D, now: 17 * 60, sessions: run(10 * 60, [["focus", 40, "Grant application", "Lab", 5], ["meeting", 60, null, "Lab"], ["break", 30], ["focus", 50, "Grant application", "Lab", 6]]), completed: [], due: [["Grant application", 3, 240], ["Order reagents", 2, 15], ["Lab meeting notes", 1, 30]] }),
  day({ id: "c33", category: "overdue", date: D, now: 9 * 60 + 30, sessions: run(9 * 60, [["focus", 20, "Morning planning", null, 1]]), completed: ["Morning planning"], due: [["Quarterly OKRs", 3, 120], ["1:1 notes for Sam", 2, 20], ["Expense report", 1, 30], ["Update team wiki", 0, 45], ["Interview feedback", 2, 15]] }),
  day({ id: "c34", category: "overdue", date: D, now: 19 * 60, sessions: run(8 * 60, [["focus", 90, "Wedding seating plan", "Wedding", 6], ["break", 30], ["focus", 60, "Call caterer", "Wedding", 2], ["break", 60], ["focus", 90, "Wedding seating plan", "Wedding", 5]]), completed: ["Call caterer"], due: [["Wedding seating plan", 3, null], ["Order flowers", 2, null]] }),
  day({ id: "c35", category: "overdue", date: D, now: 14 * 60 + 30, sessions: run(9 * 60, [["focus", 50, "Refactor billing", "SaaS", 7], ["break", 10], ["focus", 50, "Refactor billing", "SaaS", 6], ["meeting", 30, null, "SaaS"]]), completed: [], due: [["Refactor billing", 2, 240], ["Security patch", 3, 60]] }),

  // ---- multilingual task titles (5): the app is English, so the review should be in English ----
  day({ id: "c36", category: "multilingual", date: D, now: 16 * 60, sessions: run(9 * 60, [["focus", 60, "Preparar presentación", "Trabajo", 5], ["break", 15], ["focus", 50, "Revisar contrato", "Trabajo", 4]]), completed: ["Revisar contrato"], due: [["Preparar presentación", 2, 90]] }),
  day({ id: "c37", category: "multilingual", date: D, now: 17 * 60, sessions: run(10 * 60, [["focus", 45, "企画書を書く", "仕事", 6], ["break", 15], ["focus", 45, "企画書を書く", "仕事", 3], ["break", 30], ["focus", 30, "メール返信", "仕事", 10]]), completed: ["メール返信"], due: [["企画書を書く", 3, 120]] }),
  day({ id: "c38", category: "multilingual", date: D, now: 15 * 60, sessions: run(9 * 60, [["focus", 60, "مراجعة التقرير", "العمل", 4], ["break", 20], ["focus", 40, "الرد على العملاء", "العمل", 8]]), completed: [], due: [["مراجعة التقرير", 2, 60]] }),
  day({ id: "c39", category: "multilingual", date: D, now: 18 * 60, sessions: run(8 * 60 + 30, [["focus", 75, "Steuererklärung", "Privat", 3], ["break", 15], ["focus", 60, "Übersetzung prüfen", "Büro", 5], ["break", 40], ["focus", 45, "Angebot für Müller GmbH", "Büro", 4]]), completed: ["Übersetzung prüfen"], due: [["Steuererklärung", 3, 120]] }),
  day({ id: "c40", category: "multilingual", date: D, now: 13 * 60, sessions: run(9 * 60, [["focus", 50, "Réviser le mémoire ✍️", "Études 🎓", 2], ["break", 10], ["focus", 50, "Réviser le mémoire ✍️", "Études 🎓", 3]]), completed: [], due: [["Réviser le mémoire ✍️", 2, 120]] }),

  // ---- edge cases (6) ----
  day({ id: "c41", category: "edge", date: D, now: 23 * 60 + 40, goals: { workMin: 360, focusMin: 240 }, sessions: run(7 * 60, [["focus", 120, "Ship v2", "App", 10], ["break", 20], ["focus", 120, "Ship v2", "App", 12], ["break", 30], ["focus", 120, "Ship v2", "App", 9], ["break", 30], ["focus", 120, "Ship v2", "App", 14], ["break", 30], ["focus", 150, "Ship v2", "App", 11]]), completed: ["Ship v2"], due: [], note: "goal far exceeded (630 min), late at night" }),
  day({ id: "c42", category: "edge", date: D, now: 12 * 60, goals: { workMin: 60, focusMin: 30 }, sessions: run(9 * 60, [["focus", 30, "Daily journaling", "Self", 0], ["break", 10], ["focus", 40, "Read", "Self", 0]]), completed: ["Daily journaling"], due: [], note: "small goals already met, zero switches" }),
  day({ id: "c43", category: "edge", date: D, now: 16 * 60, sessions: run(9 * 60, [["meeting", 60, null, "Work"], ["break", 30], ["meeting", 90, null, "Work"], ["break", 30], ["meeting", 60, null, "Work"]]), completed: [], due: [], note: "meetings only, focus 0 (score has no switch part)" }),
  day({ id: "c44", category: "edge", date: D, now: 15 * 60, sessions: run(9 * 60, [["focus", 45, "Prepare the annual shareholder letter including a summary of revenue growth, hiring plans, the new office opening in Lisbon, risks from currency movements and a thank-you to every customer who stayed with us through the outage in March", "Exec", 6], ["break", 15], ["focus", 45, "Prepare the annual shareholder letter including a summary of revenue growth, hiring plans, the new office opening in Lisbon, risks from currency movements and a thank-you to every customer who stayed with us through the outage in March", "Exec", 4]]), completed: [], due: [["Prepare the annual shareholder letter including a summary of revenue growth, hiring plans, the new office opening in Lisbon, risks from currency movements and a thank-you to every customer who stayed with us through the outage in March", 3, 180]], note: "very long task title" }),
  day({ id: "c45", category: "edge", date: D, now: 14 * 60, sessions: run(9 * 60, [["focus", 30, "Email", null, 5], ["break", 5], ["focus", 30, "Email", null, 6], ["break", 5], ["focus", 30, "Email", null, 4], ["break", 5], ["focus", 30, "Email", null, 7], ["break", 5], ["focus", 30, "Email", null, 3], ["break", 5], ["focus", 30, "Email", null, 5]]), completed: ["Email", "Email"], due: [["Email", 1, 15]], note: "same title everywhere, 12 sessions" }),
  day({ id: "c46", category: "edge", date: D, now: 10 * 60, sessions: run(0, [["focus", 90, "Night shift handover", "Hospital", 2], ["break", 30], ["focus", 120, "Patient charts", "Hospital", 3]]), completed: ["Night shift handover"], due: [], note: "work after midnight (12:00am start)" }),

  // ---- ambiguous / thin context (4) ----
  day({ id: "c47", category: "ambiguous", date: D, now: 16 * 60, sessions: run(9 * 60, [["focus", 60, null, null, 8], ["break", 15], ["focus", 60, null, null, 10], ["focus", 40, null, null, 6]]), completed: [], due: [], note: "no tasks or projects anywhere" }),
  day({ id: "c48", category: "ambiguous", date: D, now: 17 * 60, sessions: [], completed: ["Laundry", "Groceries", "Call mum", "Fix bike", "Pay bills", "Water plants"], due: [], note: "six tasks done but no time tracked" }),
  day({ id: "c49", category: "ambiguous", date: D, now: 13 * 60, sessions: run(9 * 60, [["focus", 25, "Misc", "Misc", 4], ["break", 5], ["focus", 25, "Stuff", "Misc", 6], ["break", 5], ["focus", 25, "TODO", "Misc", 2]]), completed: ["Misc"], due: [["Stuff", 0, null]], note: "vague titles" }),
  day({ id: "c50", category: "ambiguous", date: D, now: 18 * 60, sessions: run(9 * 60, [["focus", 60, "Project", "Project", 5], ["break", 10], ["focus", 60, "Project", "Project", 5], ["break", 30], ["focus", 60, "Project", "Project", 5]]), completed: [], due: [["Project", 2, 60]], note: "task and project share a generic name" }),
];

// coach-eval-v2 (Phase 10, fixes 50–51): the same 50 days in the shape the app sends from coach-v2 on — each session
// gains its `end`, and the day gains `lastTrackedEnd`. The synthetic sessions have no pauses, so end = start + min.
const toMin = t => { const m = /^(\d+):(\d+)(am|pm)$/.exec(t); return (+m[1] % 12 + (m[3] === "pm" ? 12 : 0)) * 60 + +m[2]; };
export const COACH_CASES_V2 = COACH_CASES.map(({ id, category, note, data: d }) => {
  const sessions = d.sessions.map(s => ({ type: s.type, start: s.start, end: fmt(toMin(s.start) + s.min), min: s.min, task: s.task }));
  const { completedToday, stillDue, ...head } = { ...d };
  delete head.sessions;
  return { id, category, note, data: { ...head, sessions, lastTrackedEnd: sessions.length ? sessions.at(-1).end : null, completedToday, stillDue } };
});

// coach-eval-v3 (Phase 10, fix 54): the coach-eval-v2 days plus workPct and focusPct (rounded progress toward each goal),
// placed right after longestStretchMin as in index.html.
export const COACH_CASES_V3 = COACH_CASES_V2.map(({ id, category, note, data: d }) => {
  const out = {};
  for (const [k, v] of Object.entries(d)) {
    out[k] = v;
    if (k === "longestStretchMin") {
      out.workPct = d.goals.workMin > 0 ? Math.round(100 * d.workedMin / d.goals.workMin) : null;
      out.focusPct = d.goals.focusMin > 0 ? Math.round(100 * d.focusMin / d.goals.focusMin) : null;
    }
  }
  return { id, category, note, data: out };
});

// coach-eval-v4 (Phase 10, fix 55): the coach-eval-v3 days plus workLeftMin and focusLeftMin (minutes still needed for each
// goal, never below 0), placed right after focusPct as in index.html.
export const COACH_CASES_V4 = COACH_CASES_V3.map(({ id, category, note, data: d }) => {
  const out = {};
  for (const [k, v] of Object.entries(d)) {
    out[k] = v;
    if (k === "focusPct") {
      out.workLeftMin = d.goals.workMin > 0 ? Math.max(0, d.goals.workMin - d.workedMin) : null;
      out.focusLeftMin = d.goals.focusMin > 0 ? Math.max(0, d.goals.focusMin - d.focusMin) : null;
    }
  }
  return { id, category, note, data: out };
});
