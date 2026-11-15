// Daily coach rubric, pre-registered in docs/ai-eval.md before any response was seen (Phase 10).
// Programmatic only: no LLM judge. grade(caseData, text) → { pass, checks:{...}, ungrounded:[...], strictUngrounded:[...] }.
// Locked thresholds (docs/test-strategy.md §6): rubric pass ≥ 90% of responses; responses with an ungrounded number ≤ 5%.

// v1.1 (2026-11-12, after the first run): two implementation bugs fixed so the code matches the pre-registered rules;
// no rule, list or threshold changed. (a) emoji variation selectors and joiners (U+FE0F, U+200D) are ignored like other
// symbols when matching titles; (b) in a range such as "15 to 20 minutes" or "15-20 min" the unit applies to both numbers.
// docs/ai-eval.md reports results under both v1 and v1.1.
// v1.2 (2026-11-12, after run 2): one more implementation bug fixed. The pre-registered list includes "per-task,
// per-type and per-project sums", but v1/v1.1 only added those sums converted to hours, never the sums in minutes
// ("95 minutes on Write Q4 report" = 50 + 45 was flagged). No rule, list or threshold changed.
// v2 (2026-11-12, owner decision after run 2, finding 52 revisited): only the "names a due task" rule changes, from the
// literal title to its distinctive words (taskNamed below). Number rules and thresholds are unchanged. Because this rule
// was written after run 2's answers were seen, run 2 is reported under it for information; the confirming run is run 3.
// v3 (2026-11-13, owner decision after run 5): only grounding changes. A number also counts as grounded when it is
// minutes done plus blocks the answer itself suggests (worked or focus + S), or minutes left minus them (left − S), where
// S is one suggested block, two of them added, two or three of the same block, or all of them (suggestedBlocks below).
// Everything else, and both thresholds, are unchanged. Written after run 5's answers were seen, so run 5 is reported
// under it for information only; the confirming run is run 6. Runs 1–5 keep the rubric they were graded under.
export const RUBRIC_VERSION = "coach-rubric-v3";
const STOP = new Set("a an the to for of on in at with and or my your our this that it is be by from up out".split(" "));
const wordsOf = s => norm(s).split(" ").filter(w => w && !STOP.has(w));
// two words match when one is a prefix of the other (the shorter at least 3 letters: pay / paying), or they share
// their first 5 letters (migrate / migration)
const sameWord = (a, b) => { const [x, y] = a.length <= b.length ? [a, b] : [b, a]; if (x.length < 3) return x === y; if (y.startsWith(x)) return true; let i = 0; while (i < x.length && x[i] === y[i]) i++; return i >= 5; };
/** v2 rule: the task counts as named when at least half (rounded up) of its distinctive words appear in the text.
 *  Titles with more than 6 distinctive words are judged on their first 4. */
export function taskNamed(title, text) {
  let tw = wordsOf(title); if (!tw.length) return false;
  if (tw.length > 6) tw = tw.slice(0, 4);
  const xw = wordsOf(text);
  const hits = tw.filter(w => xw.some(v => sameWord(w, v))).length;
  return hits >= Math.ceil(tw.length / 2);
}

const WORD_NUMS = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half|dozen|several|a few)\b/i;
const REFUSAL = /\b(I can(?:not|'t|’t) (?:help|provide|do|assist|review)|I(?:'m|’m| am) (?:unable|not able)|as an AI\b|I don(?:'t|’t) have (?:access|enough))/i;
const MARKDOWN_LINE = /^\s*(?:#{1,6}\s|[-*•+]\s|\d{1,2}[.)]\s|>\s|\|)/m;
const MARKDOWN_INLINE = /\*\*|__|`|\[[^\]]+\]\([^)]+\)/;
const EN_WORDS = ["the", "you", "your", "and", "to", "a", "of", "for", "today", "on", "in", "it", "with", "that", "is", "was", "tomorrow"];
// Standard advice durations: a suggestion like "take a 10-minute break" is advice, not a claim about the day.
const ADVICE_MIN = new Set([5, 10, 15, 20, 25, 30, 40, 45, 50, 60, 90, 120]);
const ADVICE_HOURS = new Set([1, 2, 3]);

const norm = s => String(s).normalize("NFC").toLowerCase().replace(/[\p{P}\p{S}\u{FE00}-\u{FE0F}\u{200D}]+/gu, " ").replace(/\s+/g, " ").trim();
const r1 = x => Math.round(x * 10) / 10;

/** Every number a faithful review could state, derived only from the input. */
export function allowedNumbers(d) {
  const ok = new Set();
  const add = x => { if (Number.isFinite(x)) { ok.add(r1(x)); ok.add(Math.round(x)); } };
  for (const m of JSON.stringify(d).match(/\d+(?:\.\d+)?/g) || []) add(+m);
  const mins = [d.goals.workMin, d.goals.focusMin, d.workedMin, d.focusMin, d.breakMin, d.longestStretchMin,
    ...Object.values(d.byProject), ...d.sessions.map(s => s.min), ...d.stillDue.map(t => t.estimateMin).filter(Boolean)];
  // per-task, per-type and per-project-pair sums
  const byTask = {}, byType = {};
  for (const s of d.sessions) { if (s.task) byTask[s.task] = (byTask[s.task] || 0) + s.min; byType[s.type] = (byType[s.type] || 0) + s.min; }
  mins.push(...Object.values(byTask), ...Object.values(byType), d.workedMin + d.breakMin);
  for (const m of mins) { add(m); add(m / 60); ok.add(Math.round(m / 60 * 2) / 2); ok.add(Math.floor(m / 60)); ok.add(m % 60); ok.add(Math.ceil(m / 60)); }
  const pct = (a, b) => b > 0 && add(100 * a / b);
  pct(d.workedMin, d.goals.workMin); pct(d.focusMin, d.goals.focusMin); pct(d.focusMin, d.workedMin);
  for (const [a, b] of [[d.goals.workMin, d.workedMin], [d.goals.focusMin, d.focusMin]]) { add(Math.abs(a - b)); add(Math.abs(a - b) / 60); ok.add(Math.round(Math.abs(a - b) / 60 * 2) / 2); }
  const n = t => d.sessions.filter(s => s.type === t).length;
  [d.sessions.length, n("focus"), n("break"), n("meeting"), d.completedToday.length, d.stillDue.length,
    new Set(d.sessions.map(s => s.task).filter(Boolean)).size, Object.keys(d.byProject).length].forEach(add);
  // clock times: 12h hours and minutes are already in the JSON; add the 24h hour of each
  for (const t of [d.now, ...d.sessions.map(s => s.start)]) { const m = /^(\d+):(\d+)(am|pm)$/.exec(t); if (m) ok.add((+m[1] % 12) + (m[3] === "pm" ? 12 : 0)); }
  if (d.focusScore != null) ok.add(100);   // "78 out of 100"
  return ok;
}

/** Digit numbers in the text with their context. Words like "two" are not checked (documented limitation). */
function numbersIn(text) {
  const out = [];
  // a range shares its unit: "15 to 20 minutes" → "15 minutes to 20 minutes"
  text = text.replace(/\b(\d+)(\s*(?:to|-|–)\s*)(\d+)(\s*-?\s*(minutes?|mins?|hours?|hrs?)\b)/gi, (m, a, sep, b, unit) => `${a}${unit}${sep}${b}${unit}`);
  const re = /(\d{1,2}:\d{2}\s*(?:am|pm)?|\d+(?:[.,]\d+)?)(\s*%|\s*-?\s*(?:minutes?|mins?|m\b|hours?|hrs?|h\b)|\s*(?:am|pm)\b)?/gi;
  for (const m of text.matchAll(re)) {
    const raw = m[1], unit = (m[2] || "").trim().toLowerCase().replace(/^-\s*/, "");
    if (/:/.test(raw)) { const [, h, mm] = /(\d+):(\d+)/.exec(raw); out.push({ raw: m[0], parts: [+h, +mm], clock: true, minute: +mm }); continue; }
    const v = +raw.replace(",", ".");
    out.push({ raw: m[0], parts: [v], unit, clock: /am|pm/.test(unit) });
  }
  return out;
}

export function grade(d, text, { taskRule = "words", grounding = "v3" } = {}) {
  const t = String(text || "").trim();
  const words = t ? t.split(/\s+/).length : 0;
  const paragraphs = t ? t.split(/\n\s*\n/).filter(p => p.trim()).length : 0;
  // English check on the text with the user's own titles and project names removed
  let rest = t;
  for (const s of [...d.sessions.map(s => s.task), ...d.completedToday, ...d.stillDue.map(x => x.title), ...Object.keys(d.byProject)].filter(Boolean).sort((a, b) => b.length - a.length)) rest = rest.replace(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"), " ");
  const letters = rest.match(/\p{L}/gu) || [], latin = rest.match(/[A-Za-z]/g) || [];
  const tokens = new Set(norm(rest).split(" "));
  const hasNum = /\d/.test(rest) || WORD_NUMS.test(rest);   // digits inside the user's own titles ("Q4") don't count
  const due = d.stillDue.map(x => x.title);
  const mentions = title => { const nt = norm(t), ti = norm(title); if (!ti) return false; if (nt.includes(ti)) return true; const w = ti.split(" "); return w.length > 6 && nt.includes(w.slice(0, 4).join(" ")); };

  const checks = {
    nonEmpty: words > 0,
    noRefusal: !REFUSAL.test(t),
    plainText: !MARKDOWN_LINE.test(t) && !MARKDOWN_INLINE.test(t),
    length: words <= 120,
    paragraphs: paragraphs <= 3,
    english: letters.length === 0 || (latin.length / letters.length >= 0.95 && EN_WORDS.filter(w => tokens.has(w)).length >= 3),
    citesNumber: d.workedMin < 15 || hasNum,
    namesDueTask: due.length === 0 || due.some(taskRule === "literal" ? mentions : title => taskNamed(title, t)),
    emptyDayAck: d.workedMin > 0 || (/\b(no|nothing|not|n[’']t|little|zero|yet|quiet|empty|blank)\b/i.test(t) && /(track|log|record|clock|timer|start)/i.test(t)),
  };
  // grounding
  const ok = allowedNumbers(d), ungrounded = [], strictUngrounded = [];
  const derived = grounding === "v3" ? afterBlocks(d, t) : null;
  for (const n of numbersIn(rest)) {
    const grounded = n.clock && n.parts.length === 2 ? ok.has(n.parts[0]) && ok.has(n.parts[1]) : n.parts.every(v => ok.has(v) || ok.has(r1(v)) || (derived && !n.clock && derived.has(v)));
    if (grounded) continue;
    strictUngrounded.push(n.raw.trim());
    const v = n.parts[0];
    const advice = (/^(minutes?|mins?|m)$/.test(n.unit || "") && ADVICE_MIN.has(v)) || (/^(hours?|hrs?|h)$/.test(n.unit || "") && ADVICE_HOURS.has(v))
      || (n.clock && (n.parts.length === 1 || n.minute === 0 || n.minute === 30));
    if (!advice) ungrounded.push(n.raw.trim());
  }
  const pass = Object.values(checks).every(Boolean);
  return { pass, checks, words, paragraphs, ungrounded, strictUngrounded };
}

/** Fix 51 regression check (reported alongside the rubric; not part of `pass` and not a locked threshold).
 *  Finds claims about when tracking stopped ("nothing tracked since 1:05pm", "your tracking stops at 12:40pm") and
 *  counts those that name neither the end of the last session nor the end of the last work session. */
export function stopClaims(d, text) {
  const toMin = t => { const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(t); let h = +m[1] % 12; if (m[3] ? /pm/i.test(m[3]) : h < 7) h += 12; return h * 60 + (+m[2] || 0); };
  const endOf = s => s.end ? toMin(s.end) : toMin(s.start) + s.min;
  if (!d.sessions.length) return { claims: 0, wrong: [] };
  const ok = new Set([d.sessions, d.sessions.filter(s => s.type !== "break")].filter(l => l.length).map(l => endOf(l.at(-1)) % 1440));
  let claims = 0; const wrong = [];
  for (const m of String(text).matchAll(/(?:since|stops? at|stopped(?: tracking)? at|ended at|after|until)\s+(?:about\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/gi)) {
    const ctx = text.slice(Math.max(0, m.index - 40), m.index + m[0].length);
    if (!/(tracked|logged|tracking|track|session ended|day also ended|activity|nothing was)/i.test(ctx)) continue;
    claims++;
    if (!ok.has(toMin(m[1]) % 1440)) wrong.push(m[0]);
  }
  return { claims, wrong };
}

/** Fix 54 check (reported alongside the rubric; not part of `pass` and not a locked threshold).
 *  Finds "N% of your [X-minute] work/focus goal" and checks N against that goal's real progress, within 1 point.
 *  The goal is taken from the word work/focus, or else from X matching one goal's minutes; otherwise the claim is skipped. */
export function pctClaims(d, text) {
  const real = { work: d.goals.workMin > 0 ? 100 * d.workedMin / d.goals.workMin : null, focus: d.goals.focusMin > 0 ? 100 * d.focusMin / d.goals.focusMin : null };
  let claims = 0; const wrong = [];
  const re = /(\d+(?:\.\d+)?)\s*(?:%|percent)\s+of\s+(?:your\s+|the\s+|today's\s+)?(?:(\d+)[\s-]*(?:minute|min)s?[\s-]+)?(work|focus)?/gi;
  for (const m of String(text).matchAll(re)) {
    const kind = m[3] ? m[3].toLowerCase() : m[2] && +m[2] === d.goals.workMin && +m[2] !== d.goals.focusMin ? "work" : m[2] && +m[2] === d.goals.focusMin && +m[2] !== d.goals.workMin ? "focus" : null;
    if (!kind || real[kind] === null) continue;
    claims++;
    if (Math.abs(+m[1] - real[kind]) > 1) wrong.push(`${m[0].trim()} (real ${Math.round(real[kind])}%)`);
  }
  return { claims, wrong };
}

const BLOCK_RE = /(?:\b(one|two|three|four|another|a|an)\s+)?(?:(\d+)[\s-]*(?:minutes?|mins?)|(\d+)[\s-]*hours?|(hour))(?:[\s-]+long)?\s+(?:more\s+)?(?:of\s+)?(?:focus(?:ed)?\s+|deep[- ]work\s+|uninterrupted\s+|distraction[- ]free\s+)?(?:blocks?|sessions?|stretch(?:es)?|sprints?|pass(?:es)?|timers?|hours?)\b|\b(?:one|another)\s+(?:more\s+)?focus(?:ed)?\s+hour\b|\b(\d+)\s+more\s+(?:focus\s+|work\s+)?minutes\b|\((?:about\s+)?(\d+)[\s-]*minutes?\b|\b(?:a|another|one more)\s+(?:second|another|further)?\s*(?:focus\s+)?(block|session)\b|\b(?:(?:take|spend|use|give|do|add|need)s?\s+(?:just\s+|only\s+|the\s+|a\s+|another\s+)?|(?:another|a further)\s+)(\d+)\s*(?:more\s+)?(?:focus\s+|work\s+)?minutes?\b|\b(?:an|one|another|a second|one more)\s+hour\b(?!s)/gi;
const BLOCK_MULT = { two: 2, three: 3, four: 4 };
/** Blocks the answer suggests, in order, in minutes: "a 45-minute block", "two 60-minute stretches" (120), "one more
 *  focus hour", "60 more minutes", "(about 15 minutes)", "a 2-hour block", "an hour", "take/spend/use 20 minutes",
 *  "another 60 minutes"; "a second
 *  block" repeats the previous one. */
export function suggestedBlocks(text) {
  const out = [];
  for (const m of String(text).matchAll(BLOCK_RE)) {
    if (m[7]) { if (out.length) out.push({ at: m.index, mins: out.at(-1).mins }); continue; }
    const mult = m[1] && BLOCK_MULT[m[1].toLowerCase()] || 1;
    const mins = m[2] ? +m[2] : m[3] ? +m[3] * 60 : m[5] ? +m[5] : m[6] ? +m[6] : m[8] ? +m[8] : 60;
    out.push({ at: m.index, mins: mins * mult });
  }
  return out;
}
/** v3 grounding: values reachable from the day's totals with the blocks this answer suggests. */
export function afterBlocks(d, text) {
  const b = suggestedBlocks(text).map(x => x.mins), S = new Set();
  b.forEach((x, i) => { S.add(x); S.add(2 * x); S.add(3 * x); for (let j = i + 1; j < b.length; j++) S.add(x + b[j]); });
  if (b.length) S.add(b.reduce((a, x) => a + x, 0));
  const out = new Set();
  const wl = d.workLeftMin ?? (d.goals.workMin > 0 ? Math.max(0, d.goals.workMin - d.workedMin) : null);
  const fl = d.focusLeftMin ?? (d.goals.focusMin > 0 ? Math.max(0, d.goals.focusMin - d.focusMin) : null);
  for (const s of S) {
    out.add(s);                                   // the suggested amount itself ("that adds 90 focus minutes")
    for (const v of [d.workedMin, d.focusMin]) out.add(v + s);
    for (const l of [wl, fl]) if (l != null && l - s >= 0) out.add(l - s);
  }
  return out;
}

/** Fix 55 check (reported alongside the rubric; not part of `pass` and not a locked threshold).
 *  Finds claims about where a suggested block would take the user ("a 60-minute session would put you past your
 *  240-minute focus goal", "a 90-minute block takes you to well over a third of your work goal") and checks them against
 *  done + block minutes. Blocks are those suggested in the same paragraph up to the claim's end ("N-minute block/session",
 *  "one more focus hour", "(about N minutes)"); the more generous of the last block and all of them is used. Claims whose
 *  goal (work or focus) or block can't be told are skipped. "past/over/beyond" needs the sum above the goal, and an
 *  exact hit is listed separately as `loose`; "reach/hit/meet" needs it at or above the goal; "over/more than a third"
 *  needs it above the fraction; "nearly/almost a half" needs it within 10 points below the fraction. */
export function projectionClaims(d, text) {
  const FRAC = { "a quarter": 1 / 4, "a third": 1 / 3, half: 1 / 2, "two thirds": 2 / 3, "three quarters": 3 / 4 };
  const done = { work: d.workedMin, focus: d.focusMin }, goal = { work: d.goals.workMin, focus: d.goals.focusMin };
  const kindOf = (word, mins) => word ? word.toLowerCase() : mins && +mins === goal.work && +mins !== goal.focus ? "work" : mins && +mins === goal.focus && +mins !== goal.work ? "focus" : null;
  let claims = 0; const wrong = [], loose = [];
  for (const para of String(text).split(/\n\s*\n/)) {
    const blocks = suggestedBlocks(para);   // shared with v3 grounding
    if (!blocks.length) continue;
    const claimRe = /\b(past|pass|beyond|exceed|over|reach|hit|meet)\s+(?:your\s+|the\s+|today's\s+)?(?:(\d+)[\s-]*(?:minutes?|mins?)[\s-]+)?(work|focus)?\s*goal\b|\b(well over|over|more than|nearly|almost)\s+(a quarter|a third|half|two thirds|three quarters)\s+of\s+(?:your\s+|the\s+)?(?:(\d+)[\s-]*(?:minutes?|mins?)[\s-]+)?(work|focus)?\s*goal\b/gi;
    for (const m of para.matchAll(claimRe)) {
      const before = para.slice(Math.max(0, m.index - 60), m.index);
      // "leaving 80 to reach your goal", "still 183 short of your goal": the goal is not claimed to be reached
      if (/\b(leav\w*|short|still|left|need\w*|to go|remain\w*)\b[^.!?]{0,30}$/i.test(before) && !m[4]) continue;
      const kind = kindOf(m[3] || m[7] || (/\bfocus\b/i.test(before) && !/\bwork\b/i.test(before) ? "focus" : /\bwork\b/i.test(before) && !/\bfocus\b/i.test(before) ? "work" : null), m[2] || m[6]);
      const prior = blocks.filter(x => x.at < m.index + m[0].length);
      if (!kind || !prior.length || !(goal[kind] > 0)) continue;
      // the last block alone, or every block suggested so far in the paragraph, whichever is more generous to the coach
      const add = Math.max(prior.at(-1).mins, prior.reduce((a, x) => a + x.mins, 0));
      const sum = done[kind] + add, label = `${m[0].trim()} (${done[kind]} + ${add} = ${sum} of ${goal[kind]})`;
      claims++;
      if (m[1]) {
        const v = m[1].toLowerCase();
        if (sum < goal[kind]) wrong.push(label);
        else if (!/^(reach|hit|meet)$/.test(v) && sum === goal[kind]) loose.push(label);
      } else {
        const f = FRAC[m[5].toLowerCase()], r = sum / goal[kind];
        if (/^(nearly|almost)$/i.test(m[4]) ? !(r >= f - 0.1 && r <= f) : !(r > f)) wrong.push(label);
      }
    }
  }
  return { claims, wrong, loose };
}
