# Keel AI evaluation (Phase 10)

Keel has one LLM feature: the **Daily coach** (C9), a short review of the day written by Claude through the claude.ai `sample` capability. It only exists when Keel runs as a claude.ai artifact, and it uses the owner's own Claude plan (no API key, no billing to Keel). The on-device planner is a classical model, evaluated in Phase 8 (docs/model-eval.md).

Approved scope (Phase 1, docs/test-strategy.md): **lite, throwaway.** AI_BUDGET is **$0**.

## Pre-registration (written 2026-11-12, before any answer was collected)

### What is evaluated

| Item | Version | Fingerprint |
|---|---|---|
| Prompt | `coach-v1` | `02353b9f1666` (sha-256 of the instruction text before `\n\nDATA:\n`; `eval/coach/prompt.mjs`) |
| Eval set | `coach-eval-v1` | `263c88268105` (50 cases; datasheet in docs/datasets.md) |
| Rubric | `coach-rubric-v1` | `eval/coach/rubric.mjs`, tested on hand-written answers in `tests/js/unit/coach-eval.spec.mjs` |
| Model | chosen by claude.ai, not pinnable | recorded per answer when `sample` reports `modelApplied` |
| App | `index.html` `207a615b983a` | |

A unit test pins the prompt: `index.html` must build exactly `INSTRUCTION + "\n\nDATA:\n" + JSON.stringify(data)`, the manifest must map `coach-v1` to this fingerprint, and the eval page must send `buildPrompt(case)` for every case. If the app's prompt changes, the test fails until the version is bumped and the eval is re-run.

### How answers are collected

`eval/coach/page/index.html` (built by `eval/coach/make-page.mjs`) is published as a private claude.ai artifact with the `sample` and `db` capabilities. The owner opens it and presses **Run evaluation**. It sends each case's prompt 3 times (150 requests), one at a time, with `cache: false` so repeats are real repeats, and the same default model tier the app uses. On `rate_limited` it waits 60 s, at most 3 attempts per request. Each raw answer is saved to the artifact's db with the run id, case, repetition, time taken and model reported. The page never grades anything.

Claude (in chat) then reads the saved answers with `db_query`, writes them unchanged to `eval/results/coach-<runId>.json`, and runs `node eval/coach/run.mjs`.

### Rubric `coach-rubric-v1` (programmatic; no LLM judge)

An answer **passes** only if every check holds:

| Check | Rule | From the product requirement |
|---|---|---|
| nonEmpty | at least one word | |
| noRefusal | no "I can't help / I'm unable / as an AI / I don't have access" | must not refuse a normal day |
| plainText | no Markdown: no heading, bullet (`-`, `*`, `•`, `+`), numbered list line (`1.` / `1)`), quote, table, `**`, `__`, backticks or links | "plain text (no markdown, no headings, no bullet symbols)" |
| length | ≤ 120 words | "under 120 words total" |
| paragraphs | ≤ 3 paragraphs (blank-line separated) | "three short paragraphs at most" |
| english | with the user's own titles and project names removed, ≥ 95% of letters are Latin and ≥ 3 common English words appear | the app is English; non-English titles must not switch the language |
| citesNumber | if ≥ 15 minutes were worked, the answer states at least one number (digits or a number word), not counting digits inside the user's titles | "citing specific numbers" |
| namesDueTask | if `stillDue` is non-empty, at least one due title appears (case- and punctuation-insensitive; a title longer than 6 words may be named by its first 4) | "naming a specific task if one is due" |
| emptyDayAck | if nothing was worked, the answer says so (a negation word and a tracking word) | "If almost nothing was tracked, say so kindly" |

**Grounding (hallucinated numbers),** reported separately. Every number written in digits is checked against the numbers a faithful review could state from that day's data: every number in the data, minutes as hours (rounded to 0.1 and 0.5, whole hours and leftover minutes), per-task, per-type and per-project sums, percentages of the goals, the gap to each goal, counts of sessions, breaks, meetings, tasks and projects, the 24-hour form of each time, and 100 (for "out of 100"). A number is **advice, not a claim**, and is allowed when it is a standard duration written as a duration (5, 10, 15, 20, 25, 30, 40, 45, 50, 60, 90 or 120 minutes; 1, 2 or 3 hours) or a clock time on the hour or half hour. An answer is **ungrounded** if it has any other number. The **strict** rate (no advice allowance) is reported too, for information.

Known limitations, accepted in advance: numbers written as words aren't grounding-checked; the advice allowance could hide a wrong claim that happens to be a round duration; "names a due task" is literal, so a translated or paraphrased title fails; tone ("warm") is not scored.

### Thresholds (locked in Phase 1, not changed here)

| Metric | Threshold |
|---|---|
| Rubric pass rate over all 150 answers | ≥ 90% |
| Answers with an ungrounded number | ≤ 5% |

### Consistency

Each case runs 3 times. Reported: the per-case pass count, every case that passes sometimes and fails other times, every case that fails all 3 times, and the mean per-case pass variance.

### Not applicable

| Runbook item | Why |
|---|---|
| Structured output validity | the coach returns plain text that is shown as text; nothing is parsed |
| RAG retrieval and "no answer" | no retrieval |
| Agents and tool calling | the coach has no tools, no actions and no loop |
| LLM judge validation | no LLM judge is used; grading is programmatic, and the grader is unit-tested |
| Refusing what it should refuse | the user sends no free text, only their own day; injection through titles and notes is Phase 11 |

### Cost

API cost **$0**: no API key exists and Keel calls no paid API. The 150 requests count against the owner's Claude plan usage like 150 short chat messages (each about 450 input and ≤ 200 output tokens). 0% of the $0 AI_BUDGET.

## Results: run `run-20261112193429` (2026-11-12)

**Verdict: FAILED.** Both locked thresholds are missed. No threshold, rule or case was changed after the answers were seen.

| | Value |
|---|---|
| Model | chosen by claude.ai (`sample` did not report `modelApplied`), default tier, `cache: false` |
| Prompt / eval set / app | `coach-v1` `02353b9f1666` / `coach-eval-v1` `263c88268105` / `207a615b983a` |
| Answers | 150 of 150 (50 cases × 3), 0 failed requests, 0 truncated, 0 retries; median 2.8 s, max 38.4 s |
| Raw answers | `eval/results/coach-run-20261112193429.json` (copied from the artifact's db; all 150 texts match the sha-256 fingerprints the page computed from its own copy, checked by a unit test) |
| Graded | `eval/results/coach-graded-run-20261112193429.json` (v1.1) and `….rubric-v1.json` / `.txt` (v1) |
| Spend | $0 API; 150 requests on the owner's Claude plan |

### Against the locked thresholds

| Metric | Threshold | rubric v1 (as pre-registered code) | rubric v1.1 (2 grader bugs fixed) |
|---|---|---|---|
| Rubric pass rate | ≥ 90% | **72.7%** FAIL | **74.0%** FAIL |
| Answers with an ungrounded number | ≤ 5% | **12.7%** FAIL | **8.0%** FAIL |
| (strict, no advice allowance; information only) | | 32.0% | 32.0% |

**Grader bugs found while checking the failures, fixed in v1.1** (test code; each has a unit test that fails on v1): (a) the French due title "Réviser le mémoire ✍️" ends in an invisible emoji variation selector (U+FE0F), which v1 didn't strip, so no answer could ever match it; (b) in a range like "a 15 to 20 minute break" v1 attached the unit only to the second number, so the first was treated as a bare number rather than an advice duration. Neither fix changes a rule; both make the code do what the pre-registration says. v1.1 is the version used from here on, and both are reported.

### Failures by check (v1.1)

| Check | Answers failing | What happened |
|---|---|---|
| length (≤ 120 words) | **29 (19.3%)** | Median 112 words, max 133. The answers run long, in all categories. This alone caps the pass rate at 80.7% |
| namesDueTask | 12 (8.0%) | All 12 name the task in their own words instead of its title: "paying rent" (Pay rent), "the seating plan" (Wedding seating plan), "the shareholder letter" (the 230-character title), "the migration", "the flaky test", "submitting the game jam entry". The rule is literal by design (a pre-registered limitation) |
| nonEmpty, noRefusal, plainText, paragraphs, english, citesNumber, emptyDayAck | 0 | No Markdown, no refusals, always English (including all 15 multilingual answers, which kept the user's titles as written), every empty day acknowledged kindly |

Pass rate by category (v1.1): typical 30/42, empty 10/12, low 11/12, long-stretch 8/12, many-switch 11/12, overdue 11/15, multilingual 11/15, edge 10/18, ambiguous 9/12.

### Grounding: what the 12 flagged answers actually say

I checked each flagged number by hand against its case. **All 12 are correct derivations that the pre-registered list doesn't include**, not invented numbers:

| Kind | Example | Answers |
|---|---|---|
| when the last session ended (start + minutes) | "nothing tracked since 11:15am" (c02), "after 12:25pm" (c39) | 6 |
| estimate minus time already spent | "75 minutes of estimated work left" (c04), "about 80 remain" (c14) | 2 |
| projection | "that would bring your focus total to 160 minutes" (c38), "put you at 220 minutes" (c47) | 2 |
| other arithmetic | "50% over" (c24: 360 vs 240), "about 1.2 switches per minute" (c29: 165 / 135) | 2 |

So by the locked metric the coach fails (8.0%), but none of the flagged numbers is wrong.

**The opposite problem, which the metric misses:** a separate check of every claim about when tracking stopped (63 such claims) found **6 wrong ones**, each using a session's start time as if it were its end ("nothing has been tracked since 1:05pm" when the last session ran 1:05–1:45pm; c01, c07, c27, c28, c30, c31). Reading the answers also found c47 run 3 ("10:15 to 12:55", should be 11:55) and c28 run 1 ("one hour into a longer day" at 1pm). That's **8 answers (5.3%) with a wrong time claim**, all with numbers that appear in the data, so the grounding check passes them. Likely cause: the data gives each session's start and length but not its end, so the model has to add them up and sometimes doesn't.

### Consistency (3 runs per case)

- 22 of 50 cases pass on some runs and fail on others: c03, c04, c05, c06, c08, c09, c10, c12, c13, c18, c20, c23, c30, c33, c34, c35, c37, c39, c40, c45, c47, c50. Most are length (112–133 words is right at the limit) or a due task sometimes paraphrased.
- 3 cases fail every run: c26 (game jam entry always paraphrased), c44 (the 230-character title, always "the shareholder letter"), c46 (always over 120 words).
- Mean per-case pass variance 0.098 (0 = every case the same on all 3 runs).

### Exit criteria

| Criterion | Status |
|---|---|
| Versioned eval set for every AI feature | **Met**: coach-eval-v1, 50 cases |
| Correctness and hallucination thresholds | **Not met**: 74.0% < 90%; 8.0% > 5% |
| Structured output validity 100% | Not applicable (plain text) |
| RAG | Not applicable |
| Agents and tool calling | Not applicable |
| Inconsistent cases reported; LLM judge validated | **Met**: 22 inconsistent, 3 always failing; no LLM judge |
| Results versioned, spend in budget, regression gate passes | **Met**: this file, $0, gate below |

### Findings (report-only; not fixed)

See docs/test-progress.md, bugs 50–52.

## Run 2 pre-registration: coach-v2 (written 2026-11-12, before any answer was collected)

Owner decision (2026-11-12): **approve fixes 50 and 51, keep the rules** (finding 52 stays as is: the rubric is not loosened).

| Item | Version | Fingerprint |
|---|---|---|
| Prompt | `coach-v2` | `1a6ad23d2536`. Changes from v1: "Three short paragraphs at most, under 120 words total" → "Two or three short paragraphs, at most 90 words in total"; adds "Each session has its start and end time, and lastTrackedEnd is when tracking last stopped." |
| Data shape | coach-v2 | each session gains `end`; the day gains `lastTrackedEnd` (null when nothing was tracked) |
| Eval set | `coach-eval-v2` | `c1c4fd724e3a`: the same 50 days as v1 in the v2 shape. A unit test checks that only `end` and `lastTrackedEnd` differ and that each `end` is start + minutes |
| Rubric | `coach-rubric-v1.1` | unchanged |
| App | `index.html` `8a88a93f3c06` | |

Same method as run 1: 150 requests (3 per case), `cache: false`, raw answers saved in the artifact's db, copied into the repo and checked against the page's fingerprints, then graded by `node eval/coach/run.mjs`.

**Thresholds (locked, unchanged):** rubric pass ≥ 90%; answers with an ungrounded number ≤ 5%. Phase 10 passes only if both are met.

**Reported, not locked:**
- Answers over 120 words (run 1: 29).
- The fix 51 check, `stopClaims`: claims about when tracking stopped that name neither the end of the last session nor the end of the last work session (run 1: 6 wrong out of 63). Expected to fall now that the end times are given.

Because the session end times are now in the data, end times count as grounded under the existing rule ("every number in the data"). That follows from the data change, not a rule change, and it will lower the ungrounded rate. For a like-for-like comparison, the report also gives the run 2 ungrounded rate counting end-time numbers as ungrounded.

## Results: run 2, `run-20261112231144` (coach-v2, 2026-11-12)

**Verdict: FAILED, narrowly.** The ungrounded-number threshold is now met; the rubric pass rate is 88.7% against ≥ 90%. Every remaining failure is a due task named in the coach's own words, which the rule (kept as locked by the owner, finding 52) counts as a miss.

| | Value |
|---|---|
| Model | chosen by claude.ai (`modelApplied` not reported), default tier, `cache: false` |
| Prompt / eval set / app | `coach-v2` `1a6ad23d2536` / `coach-eval-v2` `c1c4fd724e3a` / `8a88a93f3c06` |
| Answers | 150 of 150, 0 failed, 0 truncated, 0 retries; median 2.2 s, max 3.1 s |
| Raw answers | `eval/results/coach-run-20261112231144.json` |
| Spend | $0 API; 150 requests on the owner's Claude plan |

### Against the locked thresholds

| Metric | Threshold | Run 1 (coach-v1) | Run 2 (coach-v2), rubric v1.1 | Run 2, rubric v1.2 |
|---|---|---|---|---|
| Rubric pass rate | ≥ 90% | 74.0% | **88.7%** FAIL | **88.7%** FAIL |
| Answers with an ungrounded number | ≤ 5% | 8.0% | 5.3% FAIL | **4.0%** PASS |
| Ungrounded, end times counted as ungrounded (like-for-like with run 1; information) | | 8.0% | 12.7% | 11.3% |
| Strict, no advice allowance (information) | | 31.3% | 31.3% | 30.0% |

**Third grader bug, fixed in v1.2** (test code, unit test fails on v1.1): the pre-registered grounding list includes "per-task, per-type and per-project sums", but the code only added those sums converted to hours, never in minutes. So "you already put in 95 minutes" on a task worked 50 + 45 minutes was flagged. Fixing it changes run 2's ungrounded rate from 5.3% to 4.0% and run 1's not at all (8.0%). No rule or threshold changed; all versions are reported. Because this fix moves a metric across its threshold after the answers were seen, it should be read with that in mind: under the code as it stood before run 2, the number threshold was missed by one answer.

### What changed from run 1

| | Run 1 | Run 2 |
|---|---|---|
| Answers over 120 words | 29 (19.3%) | **0** (median 95, max 115) |
| Wrong claims about when tracking stopped | 6 of 63 | **0 of 119** |
| namesDueTask failures | 12 | 17 |
| Cases inconsistent across runs | 22 | 6 (c01, c09, c11, c18, c23, c38) |
| Cases failing every run | 3 | 2 (c34, c44) |
| Mean per-case pass variance | 0.098 | 0.027 |

Fixes 50 and 51 worked as intended: no answer is too long, and no answer gets the end of tracking wrong.

### What still fails

- **namesDueTask, 17 answers (all of run 2's rubric failures).** Each names the due task in its own words: "Your Q4 report" (Write Q4 report), "the literature review", "sending the chapter to your editor", "paying rent", "the migration", "the seating plan" (Wedding seating plan, all 3 runs), "the report review" (the Arabic title), "the shareholder letter" (the 230-character title, all 3 runs). Shorter answers seem to paraphrase more.
- **Grounding, 6 answers flagged under v1.2; all 6 numbers are correct** but outside the pre-registered list: minutes since tracking stopped ("the last 14 minutes"), estimate minus time spent ("about 20 remain"), projections ("close to 200 minutes", "near 150 focus minutes"), a range ending in a non-standard duration ("60 to 80 minute block"), and "45 focused minutes" (an adjective between number and unit).
- **Wrong numbers the checks miss.** Reading the answers turned up at least 2 wrong percentages whose numbers happen to appear in the data: c03 run 3 says 210 of 240 focus minutes is "90%" (it's 87.5%), and c04 run 2 says 145 focus minutes is "about 40% of your 240-minute focus goal" (that's 40% of the 360-minute work goal). The grounding check can't catch a real number used for the wrong thing.

### Consistency

6 inconsistent cases (above), 2 always failing (c34, c44: always paraphrase the due task), mean per-case pass variance 0.027.

### Exit criteria after run 2

| Criterion | Status |
|---|---|
| Versioned eval set for every AI feature | Met |
| Correctness threshold (≥ 90%) | **Not met (88.7%)** |
| Hallucination threshold (≤ 5%) | Met under v1.2 (4.0%); not met under the code before run 2 (5.3%) |
| Structured output, RAG, agents | Not applicable |
| Inconsistent cases reported; no LLM judge | Met |
| Results versioned, spend in budget, gate passes | Met once the run 2 fingerprint check is recorded |

Run 2's 150 answers match the page's own fingerprints (150 of 150, checked by a unit test).

## Rubric v2: the task-name rule loosened (owner decision, 2026-11-12, after run 2)

Owner decision on finding 52: **"revisit 52 and loosen the task-name rule."** Only the "names a due task" check changes. The grounding rules, the other checks and both thresholds stay as they are.

**New rule (`taskNamed`, coach-rubric-v2):** a due task counts as named when at least half (rounded up) of its distinctive words appear in the answer. Distinctive words are the title's words without common short words (a, the, to, for, of, your, …). Two words match when one starts with the other and the shorter has at least 3 letters (pay / paying), or when they share their first 5 letters (migrate / migration). For a title with more than 6 distinctive words, only its first 4 count. A translated title doesn't count as named. Unit tests cover the cases seen so far, both ways.

**Caveat.** This rule and the v1.2 grader fix were both settled after run 2's answers were seen. Run 2's score under them is real but not independent evidence, because the rule was written knowing which answers it would decide. So:

| Run | Rule | Rubric pass (≥ 90%) | Ungrounded (≤ 5%) | Status of the evidence |
|---|---|---|---|---|
| 1 (coach-v1) | v2 | 80.7% | 8.0% | post-hoc |
| 2 (coach-v2) | v2 | **98.7%** | **4.0%** | post-hoc |
| 2 (coach-v2) | literal rule (v1.2) | 88.7% | 4.0% | as locked before |

Under v2, run 2's only rubric failures are c38 runs 1 and 3, which call the Arabic title "مراجعة التقرير" "the report review" (a translation, not the title). Only c38 is inconsistent across runs, and the mean per-case pass variance is 0.004.

## Run 3 pre-registration (confirmation; written 2026-11-12, before any run 3 answer exists)

- Prompt `coach-v2` (`1a6ad23d2536`) and eval set `coach-eval-v2` (`c1c4fd724e3a`), both unchanged. App `8a88a93f3c06`.
- Rubric `coach-rubric-v2` exactly as committed now. No change to the rubric, the cases or the thresholds after run 3's answers are seen. Any bug found in the grader after that is reported, not fixed for this verdict.
- Same method: 150 requests, `cache: false`, fingerprint-checked export.
- **Phase 10 passes only if run 3 meets both thresholds: rubric pass ≥ 90% and ungrounded ≤ 5%.** Also reported: the literal-rule pass rate, answers over 120 words, wrong "tracking stopped" claims, and consistency.

## Results: run 3, `run-20261112234548` (coach-v2, rubric v2 pre-registered; 2026-11-12)

**Verdict: PASSED.** Both locked thresholds are met on fresh answers graded by the rubric committed before the run. Nothing in the rubric, cases or thresholds changed after the answers were seen.

| | Value |
|---|---|
| Prompt / eval set / app | `coach-v2` `1a6ad23d2536` / `coach-eval-v2` `c1c4fd724e3a` / `8a88a93f3c06` |
| Answers | 150 of 150, 0 failed, 0 truncated, 0 retries; all 150 match the page's fingerprints (unit test) |
| Raw / graded | `eval/results/coach-run-20261112234548.json` / `coach-graded-run-20261112234548.json` |
| Spend | $0 API; 150 requests on the owner's Claude plan |

| Metric | Threshold | Run 3 |
|---|---|---|
| Rubric pass rate (v2) | ≥ 90% | **99.3%** PASS |
| Answers with an ungrounded number | ≤ 5% | **3.3%** PASS |
| Rubric pass with the literal task-name rule (information) | | 88.7% |
| Answers over 120 words | | 0 (median 92, max 116) |
| Wrong "tracking stopped" claims | | 0 of 121 |
| Wrong goal-percentage claims (fix 54 check, added after run 3) | | 0 of 42 |
| Inconsistent cases / always failing | | 1 (c38) / none |
| Mean per-case pass variance | | 0.004 |

The one rubric failure: c38 run 3 calls the Arabic title "the report review" (a translation). The five flagged numbers are all correct arithmetic outside the pre-registered list ("the last 14 minutes", "95 minutes are unaccounted for", "about 20 remain", "past 160 focus minutes"). Reading the answers found one wrong claim the checks miss: c43 run 1 says a 90-minute block "would put you past your work goal" (210 + 90 = 300 of 360).

## Fix 54 and run 4 pre-registration (coach-v3; written 2026-11-13, before any run 4 answer exists)

Owner approved fix 54 on 2026-11-13. The data now carries `workPct` and `focusPct` (rounded progress toward each goal), and the prompt says to use them instead of calculating percentages. That makes a new prompt version, `coach-v3` (`4c4fc1d9d0da`), and run 3's pass applies to coach-v2, not to what the app now sends. So the shipped prompt gets its own run:

- Prompt `coach-v3`, eval set `coach-eval-v3` (`d8e9ff910994`: the coach-eval-v2 days plus the two fields, tested), app `18a1cb294823`.
- Rubric `coach-rubric-v2`, unchanged. `pctClaims` (fix 54 check) and `stopClaims` are reported, not locked. On runs 1 to 3, `pctClaims` finds exactly the two errors found by reading (run 2, c03 and c04) and nothing else.
- **Phase 10 closes as PASSED only if run 4 meets both thresholds** (rubric pass ≥ 90%, ungrounded ≤ 5%). No rubric, case or threshold change after run 4's answers are seen.

## Results: run 4, `run-20261113002126` (coach-v3, the shipped prompt; 2026-11-13)

**Verdict: PASSED.** Both locked thresholds are met on fresh answers to the prompt the app now sends, graded by the rubric committed before the run. Nothing in the rubric, cases or thresholds changed after the answers were seen.

| | Value |
|---|---|
| Prompt / eval set / app | `coach-v3` `4c4fc1d9d0da` / `coach-eval-v3` `d8e9ff910994` / `18a1cb294823` |
| Answers | 150 of 150, 0 failed, 0 truncated, 0 retries; all 150 match the page's fingerprints (unit test) |
| Raw / graded | `eval/results/coach-run-20261113002126.json` / `coach-graded-run-20261113002126.json` |
| Spend | $0 API; 150 requests on the owner's Claude plan |

| Metric | Threshold | Run 4 |
|---|---|---|
| Rubric pass rate (v2) | ≥ 90% | **98.7%** PASS |
| Answers with an ungrounded number | ≤ 5% | **1.3%** PASS |
| Ungrounded with no advice allowance (information) | | 24.7% |
| Rubric pass with the literal task-name rule (information) | | 90.7% |
| Answers over 120 words | | 0 (median 93, max 111) |
| Wrong "tracking stopped" claims | | 0 of 122 |
| Wrong goal-percentage claims (fix 54 check) | | 0 of 204 |
| Inconsistent cases / always failing | | 1 (c38) / none |
| Mean per-case pass variance | | 0.004 |

Fix 54 worked as intended: answers now quote goal percentages far more often (204 claims against 42 in run 3) and none is wrong.

The two rubric failures are c38 runs 2 and 3, which again call the Arabic title "مراجعة التقرير" "the report review" (a translation). The two flagged numbers: c14 run 3 suggests a "60 to 80 minute session" (advice; 80 is the remaining estimate but isn't on the pre-registered list) and c35 run 2 says "3.5 hours of the workday possibly left" (made up). Reading all 150 answers found two wrong claims about where a suggested block would take the user, which no check covers: c21 run 3 says a 90-minute block takes work to "well over a third" of the goal (10 + 90 = 100 of 360, 28%), and c47 run 3 says a 60-minute session puts focus "past" the 240-minute goal (160 + 60 = 220). Several answers also say "past" the focus goal where the sum only reaches it exactly (c09 run 2, c50 runs 1 and 3). These are reported, not counted: projection claims are not part of the locked rubric.

### Phase 10 exit criteria (final, after run 4)

| Criterion | Status | Evidence |
|---|---|---|
| A versioned eval set exists for every AI feature | **Met** | Daily coach: coach-eval-v1/v2/v3 (50 cases each: typical, empty, low, long-stretch, many-switch, overdue, multilingual, edge, ambiguous); fingerprints in eval/manifest.json, checked by `build.mjs --check` (11 of 11 identical). Planner: its own datasets (Phases 8–9) |
| Each feature meets its approved correctness and hallucination thresholds | **Met** | Coach run 4 (shipped prompt coach-v3): 98.7% ≥ 90%, 1.3% ≤ 5%. Planner eval 13 of 13 |
| Structured output validity is 100% | Not applicable | The coach returns plain text; the plainText check passed 150 of 150 |
| RAG retrieval and "no answer" behaviour | Not applicable | No retrieval. Empty-day behaviour is covered by emptyDayAck: 12 of 12 |
| Agent/tool-calling tests | Not applicable | No tools or agents |
| Inconsistent cases reported; LLM judge validated | **Met** | 1 inconsistent case (c38), none always failing, variance 0.004; no LLM judge (programmatic rubric only) |
| Results versioned, spend within budget, regression gate passes | **Met** | This file, model/prompt/eval-set versions per run; $0 API spend (AI_BUDGET $0); gate on 2026-11-13: lint OK, audit OK, pytest 338, unit 211 (coverage 96.7%), Chromium E2E 42/42 twice, `run-evals.mjs` all current checks pass |

## Fix 55 and run 5 pre-registration (coach-v4; written 2026-11-13, before any run 5 answer exists)

Owner approved fix 55 on 2026-11-13 ("fix 55 and continue"). The data now carries `workLeftMin` and `focusLeftMin` (minutes still needed for each goal, never below 0), and the prompt adds one sentence: "workLeftMin and focusLeftMin are the minutes still needed to reach each goal; check any claim about where a suggested block would take the user against them." That makes prompt `coach-v4` (`b2843a99061e`), so run 4's pass applies to coach-v3, not to what the app now sends.

New check `projectionClaims` (eval/coach/rubric.mjs; reported, not locked). It finds claims like "a 60-minute session would put you past your focus goal" or "well over a third of your work goal" and checks them against minutes done + the blocks suggested before the claim in the same paragraph (the more generous of the last block and all of them). "Past/over" an exactly reached goal is listed as `loose`, not wrong. On the recorded runs it finds:

| Run | Claims | Wrong | Loose |
|---|---|---|---|
| 1 (coach-v1) | 7 | 0 | 0 |
| 2 (coach-v2) | 5 | 1 (c28 run 2: a 60-minute timer to "hit your focus goal", 120 + 60 = 180 of 240) | 0 |
| 3 (coach-v2) | 4 | 2 (c10 run 2: 235 of 240 called "past"; c45 run 2: 225 of 240 called "reach") | 1 |
| 4 (coach-v3) | 7 | 2 (c21 and c47 run 3, the two found by reading) | 3 |

I read every flagged answer: all five "wrong" ones are real errors. A unit test pins that the check finds exactly c21 and c47 in run 4. Known gap: a block with no minutes ("one more focus block") is skipped.

Run 5, pre-registered:
- Prompt `coach-v4` (`b2843a99061e`), eval set `coach-eval-v4` (`98c97dd250a7`: the coach-eval-v3 days plus the two fields, tested), app `f76929d4a8b6`, eval page rebuilt (`051dc0eeda54`).
- Rubric `coach-rubric-v2`, unchanged; `stopClaims`, `pctClaims` and `projectionClaims` reported, not locked.
- Same method: 150 requests, `cache: false`, fingerprint-checked export.
- **Phase 10 stays PASSED only if run 5 meets both thresholds** (rubric pass ≥ 90%, ungrounded ≤ 5%). No rubric, case or threshold change after run 5's answers are seen. If run 5 fails, I report it and you decide (keep coach-v4, or roll back to coach-v3, which passed).

Gate after fix 55 (2026-11-13): lint, audit OK; pytest 338; unit 223 (coverage 96.7%); Chromium E2E 42/42 twice; planner eval 13/13; 12 datasets identical to their frozen hashes; golden planner predictions identical (only the app sha changed). The coach-v1 lines in `run-evals.mjs` still show run 1 failing, as recorded.
