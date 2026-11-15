# Keel: final test report (Phase 14)

Date: 2026-11-15 · QA sign-off run from a clean state · Owner: Cloudregh

## Verdict

**READY WITH KNOWN ISSUES**, final once the two changes added after the review (Mac notifications; setup without Terminal) pass CI and the Mac checks in "Still to run".

Why:
- Every approved Phase 1 target is met. Values were measured from a clean copy or, where noted, in the phase that owns them.
- No bug is open: 65 of the 67 recorded bugs are fixed and verified, and the other 2 were closed by decision. Each fix has a test that fails on the old code. Bugs 1 and 2 and accepted risks A5 and A6 were fixed on 2026-11-15, after the first sign-off review.
- The "known issues" are 5 accepted limitations (A1–A4, A7), none of which can lose or expose data.
- AI spend was $0.
- CI runs the critical suites on every push and pull request, and its first run passed.

## Still to run

| Item | Status |
|---|---|
| macOS browsers, clean copy | **Done** for 5bc1963: Firefox 65/65 and WebKit 65/65, twice each. **Re-run needed** for the two changes (73 tests per browser now): `bash tests/run-mac-browsers.sh` |
| Chromium on the owner's Mac | **Done** for 5bc1963: security-xss 9/9 (finding 69); long-output 100/100 over 10 repeats |
| CI | **Passed** on 891306a and 0632a7f. 5bc1963 and f07ed7a: results not yet reported. The setup change needs its own run, plus the new `tracker-app` workflow |
| Vercel (https://keel-app-five.vercel.app) | **Done** for 5bc1963, checked through the commit status and the live site. `index.html` is byte-identical to the repo's; the page's files return 200; the tracker, `pyproject.toml`, `package.json`, `README.md` and `docs/` return 404; the page loads with no console errors |
| Real Mac notifications | The tracker accepted the test schedule and marked the notification sent (f07ed7a); **the owner to confirm it appeared on screen** |
| Keel Tracker.app | **To do:** push, let the `tracker-app` workflow build and check it, tag `tracker-v1.0.0` to publish, then download, open and approve it on the Mac. The first build can only run on GitHub's Mac runners: it couldn't be tried from the test machine |

## Change after the review: Mac notifications (2026-11-15, owner's request)

The tracker now shows macOS notifications, also with no Keel tab open:
- focus and break ends, plus a break nudge at the break-reminder setting;
- a reminder 2 minutes before each task in today's accepted plan;
- an end-of-day summary at the workday end: tracked time, the top 3 apps by name, tasks done;
- tracker problems: still paused after 2 h, an unclean shutdown, or Keel not connected by midday on a day with 30+ minutes of use.

How it works:
- Keel sends a short schedule (`POST /schedule`: next 24 h, at most 50 items, titles ≤ 80 characters) on its regular tracker check, only when the schedule changed.
- **Settings → Notifications** has a switch for each kind, plus "Hide task names".
- Safety: the schedule endpoint has the same origin and Host protections as the rest of the API. Text is cleaned and capped, and reaches `osascript` only as arguments to a fixed script, so a task title can't run as AppleScript. Notification text is never logged. The schedule file is private (0600). Nothing is sent inside claude.ai.
- Tests: `test_notifications.py` (24), `notify-schedule.spec` (8), `notifications.spec` (4). All the tracker tests, and 11 of the 12 Keel tests, fail on the previous version; the 12th is a guard that nothing is sent inside claude.ai. Two existing tests that list every tracker request now expect the new `POST /schedule` first.
- Documented in `docs/tracker-api.md` and the README.
- The planner code and its predictions are unchanged. The app hash is now 2907a15c4a40.


## Change after the review: setup without Terminal (2026-11-15, owner's request)

A new user no longer needs Python, Terminal or a config file. In Keel's Apps view, a Mac user sees **Turn on app tracking**:
1. download Keel Tracker;
2. move it to Applications and open it;
3. approve it once with **Open Anyway**, since it's unsigned for now (owner's choice).

Keel finds the tracker by itself; it checks every 5 s while that screen is open.

The app (`tracker/app_main.py`, built from the same tested tracker code):
- registers its own executable to start at login, starts tracking and says so;
- opened again, offers Open Keel / Pause or Resume / Turn off tracking. Turning off asks first and keeps the recorded activity;
- if opened straight from Downloads, asks to be moved to Applications first;
- allows both Keel sites by default.

The `tracker-app` workflow builds it on a macOS runner and publishes `Keel-Tracker.zip` to GitHub Releases on `tracker-v*` tags. The build is a universal binary (Apple silicon and Intel), ad-hoc signed, and checked for both architectures, the signature and a self-test of the bundled tracker. The Python route stays under "Advanced"; non-Mac computers get a note and the file import.

Tests: `test_app.py` (13) and `onboarding.spec` (4). Two existing tests that pinned the default allowed sites were updated. J12 now checks the setup screen's Import button instead of the old heading.

## The clean run (2026-11-15)

Fresh copy of the project with no `node_modules`, `.venv`, caches or earlier results. Installed from the lockfiles with `npm ci` and `pip install -r requirements-dev.lock`. Node 22.23.4, Python 3.13.18, Playwright 1.65.0, pytest 9.0.3.

| Step | Command | Result |
|---|---|---|
| Baseline | parse every inline script, `sw.js`, `manifest.json`; `py_compile` the tracker | OK |
| Lint, format and type check | `npm run lint` (ESLint, ruff check, ruff format, mypy) | 0 issues |
| Dependency and secret audit | `npm run audit` (npm audit, pip-audit); gitleaks (Phase 6) | 0 vulnerabilities |
| Tracker tests (Python) | `npm run test:py` | 350 passed, 0 failed, 0 skipped; coverage 98.63% |
| Logic, ML, AI and security tests | `npm run test:js` (unit project) | 303 passed, 0 failed, 0 skipped; line 100%, char 96.8% |
| End-to-end, Chromium | `npx playwright test --project=chromium`, run twice | 63/63, then 63/63; 0 flaky. After the 2026-11-15 fixes: 65/65 twice |
| End-to-end, Firefox and WebKit (macOS 27.0.1) | `bash tests/run-mac-browsers.sh` on the Mac | first run: Firefox 63/63 twice, WebKit 62/63 twice (a test assumed click focus, which Safari on macOS doesn't give; fixed in the test). After the fixes: **Firefox 65/65 twice, WebKit 65/65 twice** |
| CI (GitHub Actions, Ubuntu) | `.github/workflows/tests.yml`, commit d349215 | every step passed in 10 min 21 s: lint, audit, Python, unit, end-to-end in Chromium, Firefox and WebKit, evals |
| Model eval (planner) | `node eval/planner/run.mjs` | 13/13 checks pass; reproducible |
| AI evals (coach, red-team) | `npm run eval` (re-grades every stored run, $0) | shipped coach-v6 runs pass (run 8, red-team run 3). Historical runs 1 and 5 and red-team run 1 are still shown failing, as recorded. Since 2026-11-15 (owner's decision) the exit code is decided by the shipped versions only: exit 0 now. A control run marking coach-v4 as shipped exits 1 |
| Datasets | `node eval/data/build.mjs --check` | 13 of 13 byte-identical |
| Golden predictions | `node eval/planner/golden.mjs` | identical to the stored file (300 effort, 40 durations, 20 plans) |
| Security regression set | test_security.py (123), security-xss (7), csp (3), ai-safety (11), planner-attack (35), coach-attack (18), audit | all pass (part of the rows above) |
| Short load test | `python3 perf/tracker_bench.py --levels 1,4,16 --seconds 5 --cpu-minutes 2`; `perf/tracker_rss_tabs.py` ×3 | `/status` p95: 1.1 ms (1 client), 24 ms (4), 43 ms (16 at full CPU); 0 errors; 3 tabs together: 53.1–56.1 MB; idle CPU 0.33% |

## Targets (locked in Phase 1)

| Area | Target | Threshold | Measured | Result |
|---|---|---|---|---|
| All | Test suites pass / flaky | 100% pass, 0 flaky | On the current code (with both changes): 777/777 (389 + 315 + 73) in the cloud, Chromium twice with 0 flaky. For 5bc1963: Firefox and WebKit (Mac) 65/65 twice each, Mac Chromium items fixed. The Mac re-run for notifications is pending | PASS (Mac re-run pending) |
| Logic | Tracker (Python) line coverage | ≥ 85% | 97% (773 statements, 20 missed) | PASS |
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
| Frontend | Serious/critical axe violations | 0 on every page | 0 (quality.spec, every view, both themes, 3 sizes; Chromium, Firefox and CI WebKit) | PASS |
| Frontend | Console errors (excluding offline fonts) | 0 on every page | 0 (quality.spec; Chromium, Firefox and CI WebKit) | PASS |
| Frontend | Chromium, WebKit, Firefox × 390/768/1440 px | all pass | Chromium (Linux), Firefox and WebKit (macOS) all pass, twice each | PASS |
| Performance | Tracker `/status` p95 | < 50 ms | 0.97 ms (Phase 12, 1,000 requests); 1.1 ms (clean run) | PASS |
| Performance | Tracker CPU avg (10 min) / RSS | < 2% / < 60 MB | owner's Mac: 0.64% worst case (tracker 0.18% + helpers 0.46%) / 15.9 MB | PASS |
| Performance | Lighthouse mobile LCP / CLS / TBT | < 2.5 s / < 0.1 / < 300 ms | 1.06–1.12 s / 0 / 36–128 ms (3 runs on this app version, after fix 68) | PASS |
| Performance | Dashboard render, 30 days of activity | < 150 ms | p95 13 ms desktop, 66 ms at 4× CPU (Phase 12); with a year of data every view p95 ≤ 29 ms desktop (clean run) | PASS |
| Storage | Browser storage, 30 heavy days | < 4 MB | 2.54 MB | PASS |
| Storage | Tracker file / log | ≤ cap / ≤ 1 MB | 1.52 MB (cap 20 MB) / log trimmed at 1 MB (tested) | PASS |
| Cost | Paid API spend | $0 | $0 | PASS |

## Test counts

After the 2026-11-15 fixes (including finding 69) and the notifications change:

| Layer | Suite | Tests |
|---|---|---|
| Tracker logic and data | test_tracker_unit (61), test_tracker_data (4), test_data_quality (64), test_port_override (3), test_smoke (2) | 134 |
| Tracker API and integration | test_tracker_api (65), test_tracker_integration (17) | 82 |
| Tracker security | test_security | 123 |
| Tracker resilience and logs | test_resilience (11), test_log_privacy (2) | 13 |
| Tracker notifications | test_notifications | 24 |
| Tracker app (Keel Tracker.app) | test_app | 13 |
| **Python total** | | **389** |
| App logic | logic-core (37), logic-timer-data (20), logic-planner-client (24), pickers (8), smoke (2), bug9 (1), bugs20-25 (7), notify-schedule (8) | 107 |
| Data integrity and pipeline | data-integrity (21), data-pipeline (22) | 43 |
| ML serving and robustness | serving (21), planner-fixes (7), planner-attack (35) | 63 |
| AI eval tooling and safety | coach-eval (51), coach-v2 (9), coach-attack (18), ai-safety (11) | 89 |
| Security (browser) | security-xss | 9 |
| Performance | perf | 4 |
| **Unit total** | | **315** |
| End-to-end | journeys (21), quality (6), csp (3), ai-ui (10), ai-provider (5), model-parity (2), tasks-tick (4), resilience (13), log-privacy (1), notifications (4), onboarding (4) | **73 per browser** |

Flaky tests: **0** in the cloud and in the macOS Firefox/WebKit runs (every suite ran twice); the 2 Chromium-on-macOS failures were explained and fixed (finding 69, and a test timing problem); re-run on the Mac pending. Four test-tooling problems were found and fixed before sign-off:
- a fake clock outrunning real network replies (Phase 13; 54/54 over 6 parallel repeats afterwards);
- the macOS-Safari focus assumption (above);
- the long-output test's 9-second stream, which timed out on a loaded Mac (it now streams larger pieces; checks unchanged);
- `perf.spec` overwrote a tracked results file on every test run, so a local run replaced the recorded cloud numbers in commit 0632a7f. It now writes to the git-ignored `test-results/perf/`, records in `perf/results/` only with `KEEL_PERF_RECORD=1`, and every file says which machine, OS and browser measured it. The recorded clean-run file is restored, and the Mac's numbers are kept as `perf/results/web-2026-11-15-mac-m4.json`.

## ML results, per model (planner-v2.3, code 26ec832153f1; datasets effort-v2 1a057392bd27, duration-v1 3eefa22e8f34, energy-v1 fc5f409702bb)

| Model | Result |
|---|---|
| Effort classifier (naive Bayes, on-device) | Macro-F1 0.842 [0.785, 0.891]. Slice gaps 0.011 (estimate) and 0.120 (project). New vocabulary: 1.00 accuracy after 20 corrections. Calibration ECE 0.119 (was 0.364 before fix 39) |
| Duration predictor (Bayesian shrinkage) | Error vs the raw estimate 47.1% lower |
| Ordering weights (pairwise perceptron) | A quick-win preference rises +0.239 after 30 identical moves; all weights stay within ½–2× of default |
| Plan builder | 0 hard-constraint violations over 500 seeded days; p95 2 ms. planner-v2.3 (bug 2) changes only the "doesn't fit today" list; all 13 eval checks and the golden predictions are unchanged |
| Serving | The same predictions in Chromium, Firefox and WebKit (golden file, Phase 9; re-checked in Chromium today); a failing model falls back to safe defaults and says so |

## AI results, per feature

| Feature | Version | Result |
|---|---|---|
| Daily coach | prompt coach-v6 c1e66fd50ff2; eval set coach-eval-v4 98c97dd250a7 (50 synthetic days × 3); rubric coach-rubric-v3; model: the claude.ai platform default (not reported by the platform) | Run 8: rubric 100.0%, ungrounded numbers 2.7%, 150/150 answers |
| Daily coach, red-team | attack set coach-attack-v1 2a6c50b03d18 (36 attacks × 3) | Run 3: 0 of 108 attacks succeeded; nothing private leaked; output is never run as HTML or script |
| Daily coach, provider failures | | Slow, rate-limited, hung (20 s note, 90 s stop) and failed provider are all handled (ai-provider.spec, ai-ui.spec) |

## Open bugs and accepted risks

**Open bugs: none.** Finding 69 (found in Phase 14: an oversized Restore paste froze Chrome on macOS) is fixed.

Fixed on 2026-11-15:
- **Bug 1:** the setup help now says the browser may be blocking local connections, and names the Claude app's built-in browser and the alternatives. The block itself is that browser's own per-site approval, which no page can change.
- **Bug 2:** the rest of a split task is listed under "Doesn't fit today", with which parts are left.

| # | Severity | What | Owner | Status |
|---|---|---|---|---|
| A1 | Low | The coach eval is "lite": 50 synthetic days, run on the platform's default model, which isn't reported. A model change by the platform isn't detected automatically; re-run the eval page after a visible change | Cloudregh | Accepted (Phase 1) |
| A2 | Low | Known gaps in the coach grader, written down before the runs: numbers written as words aren't checked; a correct sum tied to the wrong goal can pass (docs/ai-eval.md) | Cloudregh | Accepted (Phase 10) |
| A3 | Info | Request tracing and AI monitoring are N/A (owner's decision, 2026-11-14); alerts and ML drift dashboards are N/A (Phase 1); local health indicators are used instead | Cloudregh | Accepted |
| A4 | Info | A host that doesn't compress pages would push mobile LCP over target (2.58 s uncompressed). GitHub Pages and Vercel compress | Cloudregh | Accepted (Phase 12) |
| A5 | Info | The API's 5-connection queue stalled bursts of 16–32 clients | Cloudregh | **Fixed 2026-11-15**: queue 64. No stalls or errors up to 64 clients; 3 tabs still 52.0–54.9 MB |
| A6 | Info | Log lines included the macOS user name in file paths | Cloudregh | **Fixed 2026-11-15**: paths are written from `~` |
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
| Datasets unchanged | `node eval/data/build.mjs --check` | **Yes** |
| Evals: planner + shipped coach runs decide the exit code; history is printed | `npm run eval` | **Yes** |
| Live coach eval / red-team | the claude.ai eval pages (docs/ai-eval.md), then export and grade | No: after a coach prompt change or a visible model change |
| Golden predictions | `node eval/planner/golden.mjs` | No: after a planner change; the parity test runs on every PR |
| Recorded browser performance | `KEEL_PERF_RECORD=1 KEEL_PERF_LABEL=<machine> npx playwright test --project=unit tests/js/unit/perf.spec.mjs` | No: before a release |
| Load and resource tests | `perf/tracker_bench.py`, `perf/tracker_rss_tabs.py`, `perf/serve_gzip.py` + Lighthouse, `perf/mac_tracker_cpu.sh`, `perf/mac_child_cpu.sh` (docs/performance.md) | No: before a release |

**CI.** Active: `.github/workflows/tests.yml` runs every suite marked **Yes** on every pull request and every push to `main`, in Chromium, Firefox and WebKit on Ubuntu, with no AI calls. The first run passed on commit d349215. On 2026-11-15 the actions were moved to releases that run on Node.js 24 (checkout v6, setup-node v6, setup-python v6, upload-artifact v6), which clears GitHub's Node 20 deprecation warning, and the eval step became `npm run eval`. `docs/ci-tests.yml` is a copy kept identical.

**Deploy.** GitHub Pages, or Vercel as a static site: `vercel.json` (no framework, nothing to build) and `.vercelignore` (publish only `index.html`, `sw.js`, `manifest.json` and the icons). That fixes the `PYTHON_ENTRYPOINT_NOT_FOUND` build error, and it keeps the private tracker and the test files off the web. The tracker must never be deployed as a web function.

## Where the evidence is

- docs/test-progress.md: phase status, bugs and decisions.
- docs/test-strategy.md: scope and targets.
- docs/datasets.md and docs/model-eval.md: ML.
- docs/ai-eval.md: AI.
- docs/performance.md: Phase 12.
- docs/resilience.md: Phase 13.
- docs/tracker-api.md: the tracker's API contract.
- eval/results/ and perf/results/: raw results.
