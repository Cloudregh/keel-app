# Keel: final test report (Phase 14)

Date: 2026-11-15 · QA sign-off run from a clean state · Owner: Cloudregh

## Verdict

**READY WITH KNOWN ISSUES** (provisional: the Firefox and WebKit clean run on the owner's Mac is still to come; see "Still to run").

Why:
- Every approved Phase 1 target is met, measured from a clean copy or, where noted, in the phase that owns it.
- No Critical or High issue is open. 62 of the 66 recorded bugs are fixed and verified, each with a test that fails on the old code.
- What remains is 2 Low bugs and a short list of accepted limitations, none of which can lose data or expose it.
- AI spend was $0.

## Still to run

| Item | Why it isn't done yet | How |
|---|---|---|
| Firefox and WebKit end-to-end, each twice, from a clean copy | These browsers can't run in the cloud workspace. They last ran in Phase 5, with 34 tests; there are now 63 | On the Mac: `bash tests/run-mac-browsers.sh` (copies the project to a temporary folder, installs from the lockfile, runs each browser twice; your real tracker and data are never touched) |

## The clean run (2026-11-15)

Fresh copy of the project with no `node_modules`, `.venv`, caches or earlier results. Installed from the lockfiles with `npm ci` and `pip install -r requirements-dev.lock`. Node 22.23.4, Python 3.13.18, Playwright 1.65.0, pytest 9.0.3.

| Step | Command | Result |
|---|---|---|
| Baseline | parse every inline script, `sw.js`, `manifest.json`; `py_compile` the tracker | OK |
| Lint, format and type check | `npm run lint` (ESLint, ruff check, ruff format, mypy) | 0 issues |
| Dependency and secret audit | `npm run audit` (npm audit, pip-audit); gitleaks (Phase 6) | 0 vulnerabilities |
| Tracker tests (Python) | `npm run test:py` | 350 passed, 0 failed, 0 skipped; coverage 98.63% |
| Logic, ML, AI and security tests | `npm run test:js` (unit project) | 303 passed, 0 failed, 0 skipped; line 100%, char 96.8% |
| End-to-end, Chromium | `npx playwright test --project=chromium`, run twice | 63/63, then 63/63; 0 flaky |
| End-to-end, Firefox and WebKit | `bash tests/run-mac-browsers.sh` on the Mac | pending (see above) |
| Model eval (planner) | `node eval/planner/run.mjs` | 13/13 checks pass; reproducible |
| AI evals (coach, red-team) | `npm run eval` (re-grades every stored run, $0) | shipped coach-v6 runs pass (run 8, red-team run 3); historical runs 1 and 5 and red-team run 1 are still shown failing, as recorded, which makes the command exit 1 |
| Datasets | `node eval/data/build.mjs --check` | 13 of 13 byte-identical |
| Golden predictions | `node eval/planner/golden.mjs` | identical to the stored file (300 effort, 40 durations, 20 plans) |
| Security regression set | test_security.py (123), security-xss (7), csp (3), ai-safety (11), planner-attack (35), coach-attack (18), audit | all pass (part of the rows above) |
| Short load test | `python3 perf/tracker_bench.py --levels 1,4,16 --seconds 5 --cpu-minutes 2`; `perf/tracker_rss_tabs.py` ×3 | `/status` p95: 1.1 ms (1 client), 24 ms (4), 43 ms (16 at full CPU); 0 errors; 3 tabs together: 53.1–56.1 MB; idle CPU 0.33% |

## Targets (locked in Phase 1)

| Area | Target | Threshold | Measured | Result |
|---|---|---|---|---|
| All | Test suites pass / flaky | 100% pass, 0 flaky | 716/716 (350 + 303 + 63) in the clean run; Chromium twice with 0 flaky; Firefox/WebKit pending | PASS (pending FF/WK) |
| Logic | Tracker (Python) line coverage | ≥ 85% | 98.63% | PASS |
| Logic | JS business-logic line coverage | ≥ 80% | 100% lines, 96.8% characters (the gate uses the lower) | PASS |
| Security | Open Critical/High findings | 0 | 0 (both Highs, 26 and 44, fixed) | PASS |
| Security | Disallowed origin / wrong Host requests succeeding | 0% | 0% (84/84 unauthorized calls refused; test_security.py, clean run) | PASS |
| Effort classifier | Macro-F1, held-out synthetic set | ≥ 0.70, ≥ majority +0.15, ≥ keyword-only | 0.842; +0.675 over majority; +0.085 over keyword-only | PASS |
| Effort classifier | Best–worst slice gap | ≤ 0.15 F1 | estimate 0.011, project 0.120 | PASS |
| Effort classifier | New vocabulary after 20 corrections | ≥ 0.80 | 1.00 | PASS |
| Duration predictor | Median abs log error vs raw estimate | ≥ 30% lower | 47.1% lower | PASS |
| Planner | Hard-constraint violations, 500 seeded days | 0 | 0 | PASS |
| Planner | `buildPlan` p95, 30 tasks + 30 days | < 50 ms | 2 ms (eval); 1 ms desktop, 4 ms at 4× CPU (perf.spec, clean run) | PASS |
| Daily coach | Rubric pass rate, synthetic days | ≥ 90% | 100.0% (run 8, coach-v6, rubric v3) | PASS |
| Daily coach | Responses stating numbers not in the input | ≤ 5% | 2.7% (run 8) | PASS |
| Daily coach | Injection success via titles/notes | 0% | 0 of 108 (red-team run 3, coach-v6) | PASS |
| Daily coach | Output rendered as HTML / script executed | 0 | 0 (ai-safety.spec, clean run) | PASS |
| Frontend | Serious/critical axe violations | 0 on every page | 0 (quality.spec, every view, both themes, 3 sizes; Chromium clean run) | PASS (FF/WK pending) |
| Frontend | Console errors (excluding offline fonts) | 0 on every page | 0 (quality.spec, clean run) | PASS (FF/WK pending) |
| Frontend | Chromium, WebKit, Firefox × 390/768/1440 px | all pass | Chromium all pass (clean run); Firefox, WebKit pending | **Pending** |
| Performance | Tracker `/status` p95 | < 50 ms | 0.97 ms (Phase 12, 1,000 requests); 1.1 ms (clean run) | PASS |
| Performance | Tracker CPU avg (10 min) / RSS | < 2% / < 60 MB | owner's Mac: 0.64% worst case (tracker 0.18% + helpers 0.46%) / 15.9 MB | PASS |
| Performance | Lighthouse mobile LCP / CLS / TBT | < 2.5 s / < 0.1 / < 300 ms | 1.06–1.12 s / 0 / 36–128 ms (3 runs on this app version, after fix 68) | PASS |
| Performance | Dashboard render, 30 days of activity | < 150 ms | p95 13 ms desktop, 66 ms at 4× CPU (Phase 12); with a year of data every view p95 ≤ 29 ms desktop (clean run) | PASS |
| Storage | Browser storage, 30 heavy days | < 4 MB | 2.54 MB | PASS |
| Storage | Tracker file / log | ≤ cap / ≤ 1 MB | 1.52 MB (cap 20 MB) / log trimmed at 1 MB (tested) | PASS |
| Cost | Paid API spend | $0 | $0 | PASS |

## Test counts

| Layer | Suite | Tests |
|---|---|---|
| Tracker logic and data | test_tracker_unit (61), test_tracker_data (4), test_data_quality (64), test_port_override (3), test_smoke (2) | 134 |
| Tracker API and integration | test_tracker_api (65), test_tracker_integration (17) | 82 |
| Tracker security | test_security | 123 |
| Tracker resilience and logs | test_resilience (10), test_log_privacy (1) | 11 |
| **Python total** | | **350** |
| App logic | logic-core (37), logic-timer-data (20), logic-planner-client (23), pickers (8), smoke (2), bug9 (1), bugs20-25 (7) | 98 |
| Data integrity and pipeline | data-integrity (21), data-pipeline (22) | 43 |
| ML serving and robustness | serving (21), planner-fixes (7), planner-attack (35) | 63 |
| AI eval tooling and safety | coach-eval (50), coach-v2 (9), coach-attack (18), ai-safety (11) | 88 |
| Security (browser) | security-xss | 7 |
| Performance | perf | 4 |
| **Unit total** | | **303** |
| End-to-end | journeys (21), quality (6), csp (3), ai-ui (10), ai-provider (5), model-parity (2), tasks-tick (3), resilience (12), log-privacy (1) | **63 per browser** |

Flaky tests: **0**. Every browser suite ran twice. One test-code race (a fake clock outrunning real network replies) was found in Phase 13 and fixed in the test before sign-off; 6 parallel repeats passed 54/54.

## ML results, per model (planner-v2.2, code 7531df56160e; datasets effort-v2 1a057392bd27, duration-v1 3eefa22e8f34, energy-v1 fc5f409702bb)

| Model | Result |
|---|---|
| Effort classifier (naive Bayes, on-device) | Macro-F1 0.842 [0.785, 0.891]. Slice gaps 0.011 (estimate) and 0.120 (project). New vocabulary: 1.00 accuracy after 20 corrections. Calibration ECE 0.119 (was 0.364 before fix 39) |
| Duration predictor (Bayesian shrinkage) | Error vs the raw estimate 47.1% lower |
| Ordering weights (pairwise perceptron) | A quick-win preference rises +0.239 after 30 identical moves; all weights stay within ½–2× of default |
| Plan builder | 0 hard-constraint violations over 500 seeded days; p95 2 ms |
| Serving | The same predictions in Chromium, Firefox and WebKit (golden file, Phase 9; re-checked in Chromium today); a failing model falls back to safe defaults and says so |

## AI results, per feature

| Feature | Version | Result |
|---|---|---|
| Daily coach | prompt coach-v6 c1e66fd50ff2; eval set coach-eval-v4 98c97dd250a7 (50 synthetic days × 3); rubric coach-rubric-v3; model: the claude.ai platform default (not reported by the platform) | Run 8: rubric 100.0%, ungrounded numbers 2.7%, 150/150 answers |
| Daily coach, red-team | attack set coach-attack-v1 2a6c50b03d18 (36 attacks × 3) | Run 3: 0 of 108 attacks succeeded; nothing private leaked; output is never run as HTML or script |
| Daily coach, provider failures | | Slow, rate-limited, hung (20 s note, 90 s stop) and failed provider are all handled (ai-provider.spec, ai-ui.spec) |

## Open bugs and accepted risks

| # | Severity | What | Owner | Status |
|---|---|---|---|---|
| 1 | Low | In the Claude desktop app's built-in browser, calls from the page to the local tracker are blocked by that browser's per-site approval. Use Chrome, Arc, Brave or Edge, or import the activity file | Cloudregh | Open |
| 2 | Low | Planner: when a long task is split and only part 1 fits today, the rest isn't listed under "Doesn't fit today" | Cloudregh | Open |
| A1 | Low | The coach eval is "lite": 50 synthetic days, run on the platform's default model, which isn't reported. A model change by the platform isn't detected automatically; re-run the eval page after a visible change | Cloudregh | Accepted (Phase 1) |
| A2 | Low | Known gaps in the coach grader, written down before the runs: numbers written as words aren't checked; a correct sum tied to the wrong goal can pass (docs/ai-eval.md) | Cloudregh | Accepted (Phase 10) |
| A3 | Info | Request tracing and AI monitoring are N/A (owner's decision, 2026-11-14); alerts and ML drift dashboards are N/A (Phase 1); local health indicators are used instead | Cloudregh | Accepted |
| A4 | Info | A host that doesn't compress pages would push mobile LCP over target (2.58 s uncompressed). GitHub Pages compresses | Cloudregh | Accepted (Phase 12) |
| A5 | Info | The tracker API's 5-connection queue stalls from about 16–32 simultaneous clients, far beyond 1–3 tabs. After such a burst the Linux test process stays at about 68 MB, because Python keeps the memory; normal use is 15.9 MB on the Mac | Cloudregh | Accepted (Phase 12) |
| A6 | Info | Tracker log lines about its own files include the file path, which contains the macOS user name. Local only | Cloudregh | Accepted (Phase 13) |
| A7 | Info | Tests use synthetic data only; no real activity, tasks or coach conversations were used, by rule | Cloudregh | By design |

## AI spend

**$0.00 (budget $0).** All AI calls in tests are mocked. The coach evals (8 runs × 150 answers) and red-team runs (3 × 108) ran inside claude.ai on the owner's Claude plan, as approved in Phase 1, so nothing was billed per call. `npm run eval` only re-grades stored answers.

## How to re-run

Setup, once: `npm ci` (on the Mac: `npm ci --include=dev`), then `python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.lock && npx playwright install`.

| Suite | Command | Every pull request? |
|---|---|---|
| Lint, format and type check | `npm run lint` | **Yes** |
| Dependency audit | `npm run audit` | **Yes** |
| Tracker tests + coverage gate | `npm run test:py` | **Yes** |
| Logic, ML, AI-safety and security tests + coverage gate | `npm run test:js` | **Yes** |
| End-to-end, 3 browsers | `npm run test:e2e` (Mac: see docs/test-progress.md "Environment notes", or `bash tests/run-mac-browsers.sh`) | **Yes** |
| Planner eval | `node eval/planner/run.mjs` | **Yes** (fast, deterministic) |
| Shipped coach runs re-graded | `node eval/coach/run.mjs eval/results/coach-run-20261114122555.json` and `node eval/coach/attack.mjs eval/results/coach-attack-run-20261114121818.json` | **Yes** (update the file names after a new run) |
| Datasets unchanged | `node eval/data/build.mjs --check` | **Yes** |
| All evals, with history | `npm run eval` | No (exits 1 because historical runs failed, by design) |
| Live coach eval / red-team | the claude.ai eval pages (docs/ai-eval.md), then export and grade | No: after a coach prompt change or a visible model change |
| Golden predictions | `node eval/planner/golden.mjs` | No: after a planner change; the parity test runs on every PR |
| Load and resource tests | `perf/tracker_bench.py`, `perf/tracker_rss_tabs.py`, `perf/serve_gzip.py` + Lighthouse, `perf/mac_tracker_cpu.sh`, `perf/mac_child_cpu.sh` (docs/performance.md) | No: before a release |

**CI.** The repository has no CI pipeline. The every-pull-request suites are written as a ready GitHub Actions workflow in `docs/ci-tests.yml`, using Chromium, Firefox and WebKit on Ubuntu with no AI calls. To turn it on, copy it to `.github/workflows/tests.yml` and push.

## Where the evidence is

- docs/test-progress.md: phase status, bugs and decisions.
- docs/test-strategy.md: scope and targets.
- docs/datasets.md and docs/model-eval.md: ML.
- docs/ai-eval.md: AI.
- docs/performance.md: Phase 12.
- docs/resilience.md: Phase 13.
- docs/tracker-api.md: the tracker's API contract.
- eval/results/ and perf/results/: raw results.
