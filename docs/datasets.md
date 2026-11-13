# Keel evaluation datasets (frozen 2026-11-12)

Built by `eval/data/build.mjs` from a fixed seed (`20261110`); `node eval/data/build.mjs --check` rebuilds them in memory and confirms the files are byte-identical. Their SHA-256 prefixes are recorded in `eval/manifest.json`. Changing a dataset means a new version (`-v2`), never an edit, and never to make a metric pass.

All data is synthetic. No real person's tasks, activity or names are in it (the names in task titles are made up).

## `effort-v1.jsonl`: effort classifier (Light / Medium / Heavy)

- **What:** 150 tasks written and labelled by hand (`eval/data/effort-bases.mjs`), 50 per class, each phrased two ways, so 300 rows.
- **Label rules:** Light = quick admin or errands, usually under 30 min. Medium = a focused but bounded job, 30–90 min. Heavy = deep, demanding work, usually 90 min or more.
- **Metadata:** estimate (25% of rows have none), priority, project, steps and notes are drawn from the seed within each class's typical range. A check confirms no estimate contradicts its label.
- **Splits, by task (both phrasings of a task are always in the same split):**

  | Split | Tasks | Rows | Light / Medium / Heavy |
  |---|---|---|---|
  | test | 75 | 150 | 50 / 50 / 50 |
  | val | 24 | 48 | 16 / 16 / 16 |
  | train | 51 | 102 | 34 / 34 / 34 |

  "train" stands in for the owner's own corrections (the model learns online), "val" is for any tuning, and "test" is only used for the final Phase 8 metrics.
- **Leakage check** (tests/js/unit/data-pipeline.spec.mjs): 0 shared ids, 0 shared tasks, 0 exact and 0 near-duplicate titles (word Jaccard ≥ 0.6) between any two splits.
- **Known limitation:** the same person (Claude) wrote both the planner's built-in keyword list and these tasks, so the classifier may look better on this set than on the owner's real tasks. The Phase 8 report must say so, and real labelled tasks from the owner would be the best check.

## `duration-v1.json`: how long tasks really take

- **What:** one simulated person's 150 finished tasks over 60 days (from 2026-09-01). Each has a label, estimate, actual minutes and finish time.
- **Hidden truth:** actual = estimate × exp(N(ln overrun, 0.35)), with overrun 1.1 (Light), 1.3 (Medium), 1.6 (Heavy).
- **Splits:** the first 100 by time are "history", the last 50 "test". All history ends before any test task, so the model never sees the future.
- Titles come only from the effort **train** split. Finishing a task also trains the effort model, so effort test titles must never appear here.

## `energy-v1.json`: when the person focuses

- **What:** focus sessions on the weekdays of October 2026, drawn from a known 24-hour curve (`trueCurve`: peak 9–10 am, a dip after lunch, a smaller peak at 3–4 pm). Times are UTC.
- **Splits:** days 1–21 are "history" (90 sessions), days 22–30 are "test" (46 sessions).

## Personal data in the app's pipeline

| Data | Where it lives | Leaves the device? |
|---|---|---|
| Task titles and notes | Browser storage; tracker never sees them | Only in the Daily coach prompt, to the owner's own Claude account, when they ask for a review |
| App names, websites | Tracker file (`~/Keel Activity`, owner-only) and browser storage | Never (not in the coach prompt; tested) |
| Window and tab titles | Same, and dropped after 7 days in both places | Never (tested) |
| Planner model (word counts) | Browser storage | Only in the owner's own backup or claude.ai sync |

## Added in Phase 8 (frozen 2026-11-12)

| Dataset | What | Splits |
|---|---|---|
| `effort-newvocab-v1.jsonl` | 60 hand-labelled farm and market tasks (20 per class) whose words are almost all outside the keyword list; no estimate, priority 1, no project, no steps | 20 corrections (seeded random pick) / 40 test |
| `effort-newvocab-v2.jsonl` | The same 60 tasks. The corrections cover the vocabulary: one per distinct first word (18) plus 2 seeded extras. Designed after v1, because v1's random corrections left 13 test tasks with no word in common with any correction of their own class | 20 corrections / 40 test |
| `duration-users-v1.json` | 20 simulated people, each with an overrun b ~ U(1.4, 1.8) and noise exp(N(0, 0.35)), 60 tasks over 30 days; titles from the effort train split only | per user: first 40 history / last 20 test |
| `effort-v2.jsonl` | effort-v1 with the notes replaced by label-neutral sentences, balanced across classes by construction (finding 42). Everything except the notes is identical to v1, and a test checks that | as effort-v1 |

**Leakage check** (added for finding 42): no note or title sentence used 3 or more times may appear in only one class. effort-v1 fails it (its notes are one fixed sentence per class), and the check confirms that. effort-v2 passes.
| `effort-newvocab-val-v1.jsonl` | **Validation only** (finding 38, addendum 2). 60 hand-labelled tailoring-shop tasks whose nouns are shared across classes on purpose, with 18 distinct first words. Used only to choose the verb weight; never used to judge a result | 20 corrections (one per first word + 2 seeded extras) / 40 val |

## Added in Phase 10 (frozen 2026-11-12)

### `coach-eval-v1.jsonl`: 50 invented days for the Daily coach

- **What:** 50 synthetic days, each the exact `data` object the app sends to the coach (same keys, units and time format as `index.html`). Built by `eval/data/coach-cases.mjs` from lists of sessions, so totals, focus score and longest stretch agree with the sessions the way `dayStats()` computes them (tested).
- **Coverage:** typical 14, empty (nothing tracked) 4, low (a few minutes) 4, long stretch without breaks 4, many tab switches 4, several tasks due 5, non-English task titles (Spanish, Japanese, Arabic, German, French with emoji) 5, edge cases 6 (goal far exceeded, tiny goals, meetings only, a 230-character title, one repeated title, work after midnight), ambiguous or thin context 4.
- **Expected outcome:** not a reference answer. Each case is graded by the pre-registered rubric `coach-rubric-v1` (docs/ai-eval.md), which reads the case's own data to decide which numbers are grounded and which task must be named.
- **Personal data:** none. All names, titles and numbers are invented. The answers are generated on the owner's own Claude plan, and the prompts contain only these invented days.
- **Never edited to improve results.** A change means `coach-eval-v2`.
