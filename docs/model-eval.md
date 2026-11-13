# Keel planner: model evaluation (Phase 8)

## Protocol (written 2026-11-12, before any metric was computed)

Everything below was fixed before running the evaluation. Nothing is tuned on a test split. Thresholds are the ones approved and locked in Phase 1 (docs/test-strategy.md §6).

**Models under test** (index.html, planner section, sha in eval/manifest.json):
1. Effort classifier (`predictEffort`): Light / Medium / Heavy with probabilities.
2. Duration predictor (`predictDuration`): planned minutes for a task.
3. Plan builder (`buildPlan`), with the energy curve (`energyCurve`) and ordering weights (`learnOrder`).

**Harness:** `npm run eval` (eval/planner/run.mjs). It loads the real app in headless Chromium with the clock fixed at 2026-11-10 10:00 Africa/Accra, the AI and tracker off, and a fresh profile per run. It writes the results to `eval/results/planner-<app sha>.json`.

### Effort classifier

- **Primary metric:** macro-F1 on `effort-v1` **test** (150 rows, 75 tasks) for the model **as shipped**, with no corrections. That is what every user gets on day 1, and it's the stricter case. A secondary result with the 102 **train** rows given as user corrections (`setEffort`) is also reported, but it isn't used for pass/fail.
- **95% confidence interval:** bootstrap over tasks (both phrasings resampled together), 2,000 resamples, seed 20261110.
- **Baselines:**
  - *Majority class:* predict the most common training label. Training is balanced, so ties go to Medium.
  - *Keyword only:* count title + notes words (same tokens and stemming as the app) in the built-in keyword list per class, and predict the class with the most hits. Ties and no hits go to Medium. No metadata.
  - *Production:* the previous release (tests/js/fixtures/prev/index.html) run through the same harness.
- **Pass:** macro-F1 ≥ 0.70, at least 0.15 above majority class, at least equal to keyword-only, and at least equal to production.
- **Slices** (gap between best and worst macro-F1 ≤ 0.15):
  - *Estimate:* "has an estimate" vs "no estimate".
  - *Project:* work / personal / study / none.

  Macro-F1 is computed over the labels present in each slice. Slices with fewer than 20 rows are reported but not judged. Phrasing variant (1 vs 2) is reported as extra.
- **New vocabulary:** `effort-newvocab-v1` has 60 farm and market tasks whose words are mostly outside the keyword list. They have no estimate, priority 1, no project and no steps, so only the words carry signal. A seeded pick of 20 tasks (7 Light, 7 Medium, 6 Heavy) is given as corrections through `setEffort`, as a user would. Accuracy is measured on the other 40. **Pass: ≥ 0.80.** Accuracy before the corrections is also reported.
- **Calibration** (no threshold): Brier score, expected calibration error (10 bins) and a reliability table on test.
- **Robustness** (no threshold, reported):
  - typos (one character in a word swapped);
  - estimate removed;
  - title in capitals;
  - extra filler words;
  - out-of-range metadata (estimate −5, 10,000, NaN; priority 9);
  - a 5,000-character title;
  - adversarial keyword stuffing ("email reply call" added to Heavy tasks).
- **Error analysis:** the 20 test errors with the highest confidence, grouped by likely cause.
- **Explainability:** the top features for each class, with a sanity check.

### Duration predictor

- **Data:** `duration-users-v1`, 20 simulated users, each with a personal bias b ~ Uniform(1.4, 1.8). For each user: actual = estimate × b × exp(N(0, 0.35)), 60 tasks over 30 days. Each user's first 40 tasks are history (loaded as finished tasks with tracked time) and the last 20 are test.
- **Primary metric:** median absolute log error |ln(predicted / actual)| over all 400 test tasks, against the raw estimate |ln(estimate / actual)|. **Pass: the model's error is at least 30% lower.** Per-user results are reported. `duration-v1` (overrun 1.1 / 1.3 / 1.6) is reported as extra, without a threshold.

### Plan builder

- **500 seeded random days:**
  - 0–30 tasks, mixed due dates (overdue, today, tomorrow, later, none), estimates, priorities and steps;
  - "now" between 06:00 and 20:00;
  - work hours from 7–10 to 16–21;
  - chronotype random;
  - 0–30 days of focus history.
- **Hard constraints** (all must have 0 violations):
  1. No two items overlap.
  2. Every overdue task comes before every task that isn't overdue.
  3. Parts of a split task are in order.
  4. A break comes before any task that would start after 75 or more minutes of continuous work.
  5. Heavy work is at most 240 minutes, except Heavy tasks due today or overdue.
  6. Nothing is scheduled before "now".
- **Latency:** 30 tasks with 30 days of history. 200 runs with caches cleared before each, so every run is the worst case. **Pass: p95 < 50 ms** (desktop Chromium).
- **Energy curve** (no threshold): correlation of the learned curve with `energy-v1.trueCurve` after the 21 history days, against the built-in prior.
- **Ordering weights** (no threshold): sanity check that 30 consistent "move the quick task up" choices raise the quick-win weight and change the order.

### Reproducibility

The planner is trained online, so "retraining" means replaying the same data. The whole evaluation is run twice from fresh profiles. **Tolerance: identical numbers (0 difference)**, because nothing in it is random except the seeded data and bootstrap.

### Protocol addendum (written 2026-11-12, after the first run, before any of the following was computed; owner approved fixes 37, 39–42 and option B for 38)

- **38, new vocabulary v2** (`effort-newvocab-v2`): the same 60 farm and market tasks.
  - The corrections are chosen to *cover the vocabulary*: one task for each distinct first word (the verb: "Feed", "Weed", "Harvest", …), taking the first in list order, which gives 18. Then 2 more are picked by seed from the rest, for 20 in all. The other 40 are the test.
  - Pass: accuracy ≥ 0.80, the locked threshold. v1's result (0.575) stays in the report next to it, not replaced.
  - v2 was designed after seeing v1 fail, and the report says so.
- **39, calibration:** the temperature's two constants (T = a + b × number of features; now a = 1, b = 0.15) are refitted by grid search (a ∈ 0.20–2.00 in steps of 0.05, b ∈ 0–0.30 in steps of 0.01). They minimise log-loss on the effort-v1 **validation** split (48 rows) for the model as shipped.
  - The test split isn't touched while fitting.
  - Temperature doesn't change which class wins, so accuracy and F1 must stay identical. Success: test ECE below the shipped 0.364.
- **40, duration:** plan at the median, and add the 75th-percentile buffer only when the person's history is erratic (spread > 0.35, the model's existing default spread).
  - The locked threshold (≥ 30% better on the 1.4–1.8× users) must still pass.
  - duration-v1 is reported, with the goal of being no worse than the raw estimate.
- **41, ordering weights:** step 0.08 → 0.02, plus a pull of 5% per move back toward each default.
  - Success: after 30 identical "quick task up" moves, the quick-win weight rises by ≥ 0.15, and every weight stays between half and double its default.
  - A stronger order check is added: a Light 10-minute task that starts *behind* a Heavy task in a peak hour, reported as is.
- **42, leakage check:** a new data test flags any note or title sentence used 3 or more times that appears in only one class.
  - It must flag effort-v1, which proves the check works, and pass effort-v2.
  - effort-v2 is effort-v1 with the notes replaced by sentences drawn by seed from one shared, label-neutral pool. It's reported next to v1; v1 stays the primary dataset, because the Phase 8 protocol named it.
- **37, overdue first:** checked by the existing 500-day constraint test (must reach 0) and a unit test replaying day 241.

### Protocol addendum 2 (written 2026-11-12, before any of the following was computed; owner chose "try a model change" for finding 38)

- **Change:** `featurize` adds a verb feature `_v:<first word of the title>` (stop words skipped, same stemming), repeated k times so it can outweigh shared nouns. k = 0 is today's model. The verb feature gets no keyword prior.
- **Choosing k, on validation data only:**
  - A new set, `effort-newvocab-val-v1`: 60 hand-labelled tailoring-shop tasks from a different trade than the farm test. The same nouns ("wedding dress", "school uniforms", "choir robes") appear across Light, Medium and Heavy, and there are 18 distinct first words. The corrections are built exactly like v2: one per first word plus 2 seeded extras, 20 in all; the other 40 are validation.
  - It's frozen before anything is computed on it.
  - Candidates: k ∈ {0, 1, 2, 3, 4, 6}. Pick the k with the highest accuracy on those 40 after the 20 corrections; ties go to the smaller k.
  - Guard, also on validation data only: effort-v1 **validation** macro-F1, both as shipped and after the train corrections, may not fall by more than 0.02 from k = 0.
  - The farm test (v1, v2) and every test split stay untouched until the final run.
- **Final run:** one full `npm run eval` with the chosen k. Finding 38 passes if new vocabulary v2 reaches ≥ 0.80 **and** every other locked check still passes. Whatever the result, it's reported as is, with no second try.

## Results

### Run 2026-11-12 · app `ac19d6abf9d4` · planner `136b84fd53d9` · data effort-v1 `286e4ee9c9d1`, effort-newvocab-v1 `43d8852b653e`, duration-users-v1 `f6a7a9cf3aeb` · Chromium 153.0.8010.12 · seed 20261110

Raw results: `eval/results/planner-ac19d6abf9d4.json`. **Reproducibility:** the whole evaluation was run twice from fresh profiles, and every number was identical (tolerance 0; latency excluded because it's a timing).

#### Verdicts against the locked thresholds

| Check | Result | Threshold | |
|---|---|---|---|
| Effort macro-F1 (as shipped, test) | 0.8416 | ≥ 0.70 | PASS |
| … over majority-class baseline | 0.6749 | ≥ +0.15 | PASS |
| … vs keyword-only baseline | 0.0849 | ≥ 0 | PASS |
| … vs production (previous release) | 0 | ≥ 0 | PASS |
| Slice gap: estimate | 0.0107 | ≤ 0.15 | PASS |
| Slice gap: project | 0.1196 | ≤ 0.15 | PASS |
| New vocabulary accuracy after 20 corrections | 0.575 | ≥ 0.80 | **FAIL** |
| Duration: error reduction vs raw estimate | 0.3918 | ≥ 30% | PASS |
| Planner hard-constraint violations (500 days) | 1 | = 0 | **FAIL** |
| buildPlan p95 latency (ms) | 2 | < 50 ms | PASS |

#### Effort classifier

- **As shipped (primary):** macro-F1 **0.842** (95% CI [0.784, 0.891]), accuracy 0.847, n = 150.
  - Per class F1: Light 0.860, Medium 0.747, Heavy 0.917.
  - Medium is the weakest class (recall 0.680). It's confused both ways; Heavy is never missed.
- **Confusion (rows = truth):**

  | | → L | → M | → H |
  |---|---|---|---|
  | L | 43 | 7 | 0 |
  | M | 7 | 34 | 9 |
  | H | 0 | 0 | 50 |
- **Baselines:**
  - majority class 0.167;
  - keyword only 0.757;
  - production (previous release) 0.842, with identical predictions on every test row (fixes 34 and 36 don't change English cold-start predictions).
- **With the 102 train rows as corrections (secondary):** macro-F1 0.876 [0.814, 0.930].
- **Dataset flaw found during this phase (label leakage in notes):** in effort-v1 a quarter of the tasks carry notes, and every note is the *same sentence per class* (e.g. every Heavy note is "Block out a long stretch of quiet time for this."). That puts label information into a feature, and the Phase 7 leakage check didn't look for it.
  - Sensitivity, added after the first run and disclosed as such: with notes removed, the shipped model scores **0.811** [0.740, 0.876], and the corrected model 0.876 [0.818, 0.925].
  - So the headline is inflated by about 0.03, and both still clear 0.70, with the CI lower bound above it. effort-v1 stays frozen as is; see finding 41.
- **Slices** (as shipped; gap = best − worst macro-F1):
  - Estimate: has estimate 0.844 (n 105) vs none 0.833 (n 45). Gap **0.011**.
  - Project: none 0.911, work 0.792, personal 0.795, study 0.896. Gap **0.120**.
  - Phrasing (not judged): variant 1 0.798, variant 2 0.879. The difference is mostly the leaky notes, which only variant 2 has.
  - Language slices aren't possible: every task is English. Protected attributes don't apply.
- **Calibration:** as shipped, Brier 0.458, ECE **0.364**. The model is strongly *underconfident*:

  | Confidence | n | Mean confidence | Accuracy |
  |---|---|---|---|
  | 0.3–0.4 | 35 | 0.35 | 0.74 |
  | 0.4–0.5 | 53 | 0.43 | 0.83 |
  | 0.5–0.6 | 33 | 0.53 | 0.85 |
  | 0.6–0.7 | 20 | 0.63 | 1.00 |
  | 0.7–0.8 | 8 | 0.73 | 1.00 |
  | 0.8–0.9 | 1 | 0.81 | 1.00 |

  After corrections: Brier 0.206, ECE 0.135. The app shows "unsure" below 0.5, so most correct guesses are shown as unsure (finding 39).
- **Robustness** (macro-F1; share of predictions that changed):
  - Clean: 0.842 (0.0% changed)
  - One typo in the longest word: 0.828 (1.3% changed)
  - Estimate removed: 0.792 (14.0% changed)
  - Title in capitals: 0.842 (0.0% changed)
  - Filler words added: 0.835 (1.3% changed)
  - "email reply call" added to Heavy tasks (adversarial): 0.646 (19.3% changed)
  - Notes removed: 0.811 (2.7% changed)

  The model ignores capitals, tolerates typos and filler, and degrades when the estimate is missing. Deliberate keyword stuffing can push a Heavy task down. That needs the user to type misleading words, so it's not a real attack surface.
  Out-of-range input never throws and always returns valid probabilities (8/8 cases): estimate −5 / 10,000 / NaN, priority 9, a 5,000-character title, empty, emoji only, and steps that aren't a list.
- **Error analysis:** the 20 most confident mistakes (all 23 errors grouped by likely cause: a keyword from the predicted class (wording points the other way): 6, no known keyword; estimate or other metadata decided: 9, Medium boundary: mixed or weak signals: 1, no known keyword and no estimate (nothing to go on): 7):

  | Task | Truth → predicted | Confidence | Estimate | Likely cause |
  |---|---|---|---|---|
  | Prepare questions for the doctor | M → H | 0.55 | l | a keyword from the predicted class (wording points the other way) |
  | Clear out the garage shelves | M → H | 0.54 | l | no known keyword; estimate or other metadata decided |
  | Fix the leaking bathroom tap | M → H | 0.52 | l | no known keyword; estimate or other metadata decided |
  | Plan the weekend trip itinerary | M → H | 0.51 | l | a keyword from the predicted class (wording points the other way) |
  | Align with marketing on the launch calendar | M → H | 0.51 | l | a keyword from the predicted class (wording points the other way) |
  | Check the office printer works with every laptop | M → L | 0.48 | s | a keyword from the predicted class (wording points the other way) |
  | Back up the laptop | M → L | 0.45 | s | no known keyword; estimate or other metadata decided |
  | Match receipts to the expense report | M → H | 0.44 | s | a keyword from the predicted class (wording points the other way) |
  | Assemble the new bookshelf | M → L | 0.44 | s | no known keyword; estimate or other metadata decided |
  | Meal prep for the week | M → L | 0.43 | s | no known keyword; estimate or other metadata decided |
  | Set up the new laptop | M → H | 0.43 | l | no known keyword; estimate or other metadata decided |
  | Cook dinner for guests | M → H | 0.43 | m | no known keyword; estimate or other metadata decided |
  | Watch the online lecture | M → L | 0.43 | s | no known keyword; estimate or other metadata decided |
  | Mentor session with junior designer | M → H | 0.42 | l | no known keyword; estimate or other metadata decided |
  | Reconcile expense report | M → L | 0.35 | s | Medium boundary: mixed or weak signals |
  | Respond to the client's change requests | M → L | 0.35 | m | a keyword from the predicted class (wording points the other way) |
  | Forward tax letter to accountant | L → M | 0.33 | none | no known keyword and no estimate (nothing to go on) |
  | Approve Akua's vacation request | L → M | 0.33 | none | no known keyword and no estimate (nothing to go on) |
  | Fill in the attendance form | L → M | 0.33 | none | no known keyword and no estimate (nothing to go on) |
  | Track the parcel delivery | L → M | 0.33 | none | no known keyword and no estimate (nothing to go on) |

  Patterns:
  - (a) Medium tasks phrased with a Heavy keyword ("Prepare…", "Plan…", "…report") or a Light one ("Check…", "Respond…").
  - (b) Medium tasks with no known keyword, where the estimate decides; a long estimate tips them to Heavy.
  - (c) Light tasks with no keyword and no estimate fall back to an exact three-way tie (0.33), which defaults to Medium.

  None suggest a code bug. They're the expected limits of a keyword prior, and they're what corrections are for.
- **Explainability:** strongest features as shipped. Light: `_est:s`, `_est:xs`, `book`, `buy`, `call`, `cancel`, `check`, `confirm`. Medium: `brainstorm`, `clean`, `configure`, `document`, `gym`, `interview`, `meet`, `not`. Heavy: `_est:l`, `_est:xl`, `_prio:3`, `_subs:many`, `analysi`, `analyze`, `architect`, `article`.
  - These make sense: short estimates point to Light, long estimates, top priority and many steps to Heavy, and the keyword list does the rest.
  - One oddity: `not` (the stem of "notes") is a Medium keyword, which is harmless.
  - After corrections the top Medium and Heavy features include the leaky note sentences ("need some focus", "block long stretch quiet"), which confirms the dataset flaw above.

#### Effort classifier: new vocabulary

- Accuracy on the 40 test tasks: **0.325 before** corrections, **0.575 after** the 20 corrections (95% CI [0.425, 0.725]). **FAIL** against ≥ 0.80.
- **Why:** the seeded pick of 20 corrections misses most of the vocabulary. 13 of the 40 test tasks share no word with any correction of their own class: every "Feed…", "Top up…" and "Refill…" chore, and every "Clear…" and "Dig…" job. No learner can get those from these corrections.
  - A word-overlap vote over the corrections, a rough upper bound, scores 0.525. Even counting every task that shares a word with its own class as correct, the ceiling is about 0.68.
  - So the shortfall comes from how the test samples corrections, not from the model. See finding 38; the decision is the owner's.

#### Duration predictor

- **20 simulated users with a 1.4–1.8× overrun, 400 test tasks:** median absolute log error 0.280 vs 0.460 for the raw estimate. That's **39.2% lower** (bootstrap 95% CI 25.9–47.8%). The model beats the raw estimate for 17/20 users. **PASS.**
- **duration-v1** (overruns of only 1.1–1.6×, no threshold): model 0.385 vs raw 0.262, so the model is *worse* than the estimate here.
  - The predictor deliberately plans at about the 75th percentile once it has 10 tasks of history, which adds a safety buffer.
  - For people who already estimate well, that buffer is larger than their actual overrun (finding 40).

#### Plan builder

- **500 seeded days, 2157 planned task blocks** (79 days with nothing to plan). Violations: overlap 0, overdueNotFirst 1, partsOutOfOrder 0, noBreakAfter75 0, heavyOver240 0, beforeNow 0. **FAIL (1).**
- The violation: an overdue Light task was scheduled *second*, after a Heavy task due today. Overdue tasks get a +3 bonus, but a Heavy task in a high-energy hour can still score more, so "overdue first" isn't guaranteed (finding 37).
- **Latency** (30 tasks, 30 days of history, caches cleared every run, 200 runs): median 1 ms, **p95 2 ms**, max 5 ms. **PASS.** Chromium rounds timer values to 0.1 ms or coarser.

#### Energy curve and ordering weights (no thresholds)

- **Energy curve** after 15 learned days: correlation with the true curve rises from 0.827 (built-in prior) to **0.918**. The four top hours are the same set (9, 10, 11, 12 am) in both, and they hold 42% of the test days' focus time.
- **Ordering weights:** after 30 "move the quick task up" choices, the quick-win weight rose from 0.6 to 2.43, as intended. But the priority weight hit its ceiling (3) and the **energy weight hit its floor (0.1)**, so a few dozen moves effectively switch off energy matching (finding 40b).
  - The order didn't change, but only because the quick task was already first. The sanity check was too weak to show a change; I'll strengthen it if the weights are fixed.


### Run 2026-11-12 (after fixes 37, 39–42) · app `044f74054d44` · planner `5dff0884a9fa` · same data and seed, plus effort-v2 `1a057392bd27` and effort-newvocab-v2 `6096dfc0a5f6`

Raw results: `eval/results/planner-044f74054d44.json`. Two full runs were identical.

| Check | Before fixes | After fixes | Threshold | |
|---|---|---|---|---|
| Effort macro-F1, as shipped (effort-v1 test) | 0.842 [0.785, 0.891] | 0.842 [0.785, 0.891] | ≥ 0.70 | PASS |
| … with leaky notes removed / on effort-v2 (neutral notes) | 0.811 | 0.811 [0.740, 0.876] / 0.811 [0.740, 0.876] | (reported) | |
| Over majority / vs keyword-only / vs production | +0.675 / +0.085 / 0 | unchanged (temperature doesn't change predictions) | ≥ +0.15 / ≥ 0 / ≥ 0 | PASS |
| Slice gaps: estimate / project | 0.011 / 0.120 | unchanged | ≤ 0.15 | PASS |
| Calibration on test: Brier / ECE | 0.458 / 0.364 | **0.294 / 0.119** (with corrections 0.196 / 0.090) | ECE < 0.364 (addendum) | PASS |
| New vocabulary v1 (random corrections) | 0.575 | 0.575 | (reported) | |
| **New vocabulary v2 (corrections cover every verb)** | — | **0.750** [0.600, 0.875] (before corrections 0.375) | ≥ 0.80 | **FAIL** |
| Duration: error vs raw, 1.4–1.8× users | −39.2% | **−47.1%** [−35.3%, −52.9%]; better than raw for 19/20 users | ≥ 30% lower | PASS |
| Duration-v1 (overrun 1.1–1.6×, noisy) | +46.6% worse | +46.6% worse | goal: no worse (addendum) | not met |
| Planner hard-constraint violations, 500 days | 1 | **0** | 0 | PASS |
| buildPlan p95 | 2 ms | 2 ms | < 50 ms | PASS |
| Ordering weights after 30 identical moves | quick 0.6→2.43, energy 1.2→0.1 | quick 0.6→0.84 (+0.24), energy 1.2→1.05; all weights 0.87–1.4× default | ≥ +0.15; ½–2× | PASS |

**Notes on run 2:**
- **Calibration (39):** the temperature constants were fitted on the 48 validation rows only (a = 0.45, b = 0; validation log-loss 0.792 → 0.446) and applied once to the test split.
  - Which class wins is unchanged, so every accuracy and F1 above is identical.
  - It's now slightly *over*confident at the top: answers shown at 98% are right 91% of the time. That's much closer than before, when 35–55% answers were right 80% of the time.
- **Duration-v1 (40):** this simulated person's history varies by about ±35% (noise σ 0.35), which is right at the "erratic" line (spread > 0.35). So the buffer still applies, as designed, and the model stays worse than the raw estimate for them.
  - The locked population (1.4–1.8× users) improved from 39% to 47%.
  - The cutoff wasn't adjusted after seeing this.
- **Ordering (41), stronger check:** even in a peak hour, the 10-minute Light task was already planned first, before any moves. A quick task due today wins on value per minute, so this check couldn't show a change in order either. The weight bounds are the evidence.
- **New vocabulary v2 (38): 30/40 correct.**
  - The errors: 7 Medium jobs went to Light or Heavy ("Mend the storeroom door", "Restock the chicken feed", "Grade the plantain bunches"), and 3 Heavy "Construct…" jobs went to Light or Medium.
  - **Cause:** naive Bayes weighs every word equally, so the shared *nouns* outvote the verb. "Construct the second **chicken coop**" becomes Light because "chicken" and "coop" appear in 9 Light corrections, against one "Construct…" correction. Medium also had only 5 corrections, against 9 Light.
  - That's a real modelling limit. Unlike v1, the test now gives the model the vocabulary. See finding 38 for the decision.

### Run 2026-11-12 (after fix 38, addendum 2) · app `5b13f510fe07` · planner `a0d007e910fa` · plus effort-newvocab-val-v1 `9d24dc5cf0ef` (validation only)

Raw results: `eval/results/planner-5b13f510fe07.json`. Two full runs were identical. **All 13 checks pass.**

- **Choosing the verb weight** (`eval/planner/fit-verb-weight.mjs`, validation data only):

  | k | Tailoring validation accuracy (40) | effort-v1 val, as shipped | effort-v1 val, after train corrections |
  |---|---|---|---|
  | 0 (before) | 0.625 | 0.895 | 0.875 |
  | 1 | 0.800 | 0.895 | 0.895 |
  | 2 | 0.900 | 0.895 | 0.916 |
  | **3 (chosen)** | **1.000** | 0.895 | 0.916 |
  | 4 | 1.000 | 0.895 | 0.895 |
  | 6 | 1.000 | 0.895 | 0.895 |

  k = 3 is the smallest weight with the best validation accuracy, and it passes the guard.
- **Final run on the farm test (once):**
  - **New vocabulary v2: 40/40 = 1.000** (before corrections 0.375). PASS.
  - v1 (random corrections) went from 0.575 to 0.675 [0.525, 0.825], about the ceiling those corrections allow (≈ 0.68).
- **Everything else:**
  - The model as shipped is unchanged: the verb feature carries no keyword prior, so it has no effect until the user corrects something. Effort macro-F1 is 0.842, predictions are identical to production, and calibration ECE is 0.119.
  - Duration −47.1%, 0 planner violations, p95 3 ms, ordering weights bounded.
- **Side effects, reported:** with all 102 effort-v1 train corrections, test macro-F1 moves from 0.876 to 0.863 (95% CI 0.802–0.916), and calibration ECE from 0.090 to 0.105. Both are within noise and well above every threshold.
- **Caveats:**
  - The farm and tailoring sets were written by the same person, from the same template idea (verb + shared nouns). A perfect 1.000 on 40 tasks says the verb feature fixes *this* pattern; it doesn't say real tasks will be classified perfectly.
  - Feature tests in data-pipeline.spec were updated to include the three verb features (the expected lists are still exact).
