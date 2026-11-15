# Resilience, logging and monitoring (Phase 13)

Keel is a single-user app with no server of its own. It is one page that keeps data in the browser, plus an optional local tracker on the owner's Mac. The coach runs only inside claude.ai. So Phase 13 is **adapted** (docs/test-strategy.md §5, row 13, approved in Phase 1):
- the dependencies are the ones Keel really has (below);
- logging is the tracker's log file and the browser console;
- **alerts and drift dashboards are N/A**, replaced by local health indicators that the user sees.

Tests: `tests/js/e2e/resilience.spec.mjs` (11), `tests/js/e2e/log-privacy.spec.mjs` (1), `tests/py/test_resilience.py` (10), `tests/py/test_log_privacy.py` (1). Earlier suites cover the rest, as listed. All dependencies are faked; nothing real is contacted.

## Dependency failures

For each dependency, the test simulates a failure or slowdown and checks five things: Keel doesn't hang, retries calmly, falls back, tells the user, and recovers when the dependency comes back.

| Dependency | Failure simulated | No hang | Calm retry | Fallback | Message to the user | Recovers | Result |
|---|---|---|---|---|---|---|---|
| Tracker API (page side) | down (connection refused) | yes | every 60 s while down (4–6 checks in 5 min), every 10 s when connected; only while the tab is visible; "Check again" button | keeps the last activity; file import still works | "Tracker not connected · Not running on this computer" | yes, by itself within 60 s, activity reloads | PASS |
| | hung (never answers) | gives up after 3 s | as above | as above | "Tracker not connected" | yes | PASS |
| | blocked (403, site not allowed) | yes | as above | as above | "This site isn't allowed yet", with the exact `allowed_origins` fix in Apps | yes, once allowed | PASS |
| | activity unreadable | yes | activity pulled every minute | status still live | "Couldn't load activity from the tracker" (not "not running") | yes, the message clears | PASS |
| | slow (1.5 s), server error (500), paused | journeys.spec J5–J6 | | | | | PASS |
| Account sync (claude.ai `db`) | store unreachable while saving | yes | one retry after 8–12 s, then on the next change | saved in this browser | "Account not reachable — saved locally" | yes, "Saved to your account"; nothing lost | PASS |
| | account storage full | yes | on the next change | saved in this browser | "Account storage full — saved locally" | yes, both changes synced | PASS |
| | not available at all | yes | n/a | "saved in this browser" mode | "Saved in this browser" | n/a | PASS |
| | hangs at start-up | the app is usable meanwhile | n/a | local | "Account not reachable — saved locally" after 10 s | yes, syncs when it answers | PASS |
| Browser storage | full (QuotaExceededError) | yes | every change tries again | keeps working in memory | banner: "Browser storage is full, so your latest changes aren't being saved", with Clean up now | yes, the banner goes and everything is saved | PASS |
| Google Fonts | blocked / offline | yes | n/a | system fonts | none needed | n/a | PASS |
| | slow or hung | yes: usable after about 0.1 s (was 8.45 s with an 8 s delay) | n/a | system fonts until they arrive | none needed | yes: the fonts are applied when they arrive, under the real CSP | PASS (fix 68) |
| Coach provider | slow, rate-limited, hung, failed | ai-provider.spec, ai-ui.spec: 20 s note, 90 s stop, clear messages, daily cap, retry works | | | | | PASS (Phase 12, fix 63) |
| Planner model | a model throws | serving.spec: safe defaults, and the plan says so | | | | | PASS (Phase 9, fix 45) |
| Network (whole app) | offline after the first visit | journeys.spec J11: the service worker serves the app | | | | | PASS |
| Disk (tracker) | full while saving | yes | next save on schedule (30 s), no tight loop | keeps recording in memory | "Couldn't write activity file: …" in tracker.log | yes, everything recorded meanwhile is saved | PASS |
| | config can't be written | yes | | pause works in memory | | yes, persisted once writable | PASS |
| | activity file corrupt | yes | | the damaged file is kept as `keel-activity.corrupt-<date-time>.json`; a new file is started | "The activity file couldn't be read. It was kept as …" in tracker.log | history is kept; cleanup never deletes the kept copy | PASS (fix 65) |
| | huge activity file | | | import refused over 25 MB; tracker file capped (20 MB) | "too large to be a Keel activity file" | | PASS (Phases 3, 6) |
| macOS helpers | `ioreg` / `lsappinfo` fail or time out | 3 s timeout | every 5 s sample | nothing recorded for that sample | n/a | yes, recording resumes | PASS |
| | `osascript` denied (Automation) or times out | 4 s timeout | backs off 10 min (no prompt storm) | app recorded without the site | n/a | yes, the tab is read again once allowed | PASS |
| | an unexpected error while sampling | yes | the next 5 s sample | that one sample is skipped | "Skipped one activity sample: <type> at keel_tracker.py line N", at most once a minute per error | yes: tracking carries on | PASS (fix 66) |
| Tracker API (server side) | an error while answering | yes | | | 500 with a JSON error pointing to tracker.log; the log names the type and location only | the server keeps serving | PASS (fix 67) |
| | client stops sending mid-request | 5 s per-request timeout (bug 28) | | | | | PASS |

## Findings (approved and fixed 2026-11-14)

- **65, Medium (data loss).** If `keel-activity.json` is damaged, for example cut off by a crash during a copy or a sync tool, the tracker reads it as empty. It logs nothing, and its next save 30 s later replaces the file, losing all history. Saves are atomic since fix 10, so the tracker itself doesn't cause this, but other things can. Repro: `pytest tests/py/test_resilience.py -k corrupt` (fails). **Proposed fix:** when the file exists but can't be read, rename it to `keel-activity.corrupt-<date-time>.json`, write one log line ("The activity file couldn't be read. It was kept as … and a new one was started."), then start fresh. Cleanup must not delete these kept files. **Fixed** as proposed. Test: `test_corrupt_activity_file_is_kept_aside_not_overwritten`, which fails on the old code; it also checks that cleanup keeps the copy.
- **66, Low (availability).** An exception that a helper's parser didn't foresee ends the whole tracker process. Under launchd it restarts after about 10 s, losing up to 30 s of unsaved activity. Run from Terminal, it stays stopped. If the cause repeats, for example a strange front-app answer, the tracker can't keep running long enough to save anything. Repro: `pytest tests/py/test_resilience.py -k unexpected_error` (fails). **Proposed fix:** catch errors per sample. Log the error, at most once a minute for the same message, and carry on with the next sample. **Fixed** as proposed. The log names the error type and code location but not the message, since a message can hold the data being parsed. Test: `test_unexpected_error_while_sampling_does_not_stop_tracking`, which fails on the old code; it also checks the message is not logged.
- **67, Low (contract).** An error while answering an API request closes the connection without an answer, instead of the documented JSON error. The server keeps serving, and the page already shows "Couldn't load activity from the tracker". The log gets a Python traceback, which holds no user data (see Logging). Repro: `pytest tests/py/test_resilience.py -k api_error` (fails). **Proposed fix:** catch errors in `do_GET`/`do_POST` and answer `500 {"error": "The tracker hit an error. Details are in tracker.log."}`. **Fixed** as proposed, and documented in docs/tracker-api.md. Test: `test_api_error_answers_500_json_and_keeps_serving`, which fails on the old code.
- **68, Medium (availability).** The Google Fonts stylesheet blocks the page: the app's script waits for it. Blocked fonts (offline, refused) fail fast and are fine. A font server that hangs (a filtering or captive network) leaves an empty page until it answers or the browser gives up: 8.45 s with an 8 s delay, and longer on a truly hung connection. Repro: `resilience.spec` "Google Fonts › slow" (fails). **Proposed fix:** load the font stylesheet without blocking (`media="print"` switched to `all` once loaded), so the app shows at once in system fonts and swaps when the fonts arrive. The CSP already allows this. After the fix, re-run Lighthouse to confirm LCP and CLS stay within target. **Fixed** as proposed. Usable after about 0.1 s with the font server hanging (was 8.45 s). A new test checks that the fonts still apply under the app's real CSP. Lighthouse mobile after the fix, 3 runs: LCP 1.06–1.12 s (was 1.68 s), CLS 0, TBT 36–128 ms, performance 0.99–1.0, nothing render-blocking. The boot script switches the fonts on, so the app still has no inline event handlers (the XSS baseline) (`perf/results/lighthouse/gz-fix68-*.json`).

## Logging

**Where logs are.**
- The tracker: under launchd, its stdout and stderr go to `~/Keel Activity/tracker.log`, which is capped at 1 MB by cleanup. It prints start-up lines, the activity file's path, and errors about its own files. HTTP requests aren't logged (`log_message` is silenced on purpose).
- The page: it has **no `console.*` calls** (searched: `grep -n "console\.\(log\|warn\|error\|info\|debug\)" index.html sw.js` finds nothing). The browser console only shows the browser's own messages, such as a failed request to the tracker.

**Search for secrets and personal data (evidence).**
- `tests/py/test_log_privacy.py` plants private values:
  - in the data the tracker records: an app name, a site, a window title with a token-like string;
  - in requests: query strings, request bodies, an Origin header, a Host header, malformed JSON, an unknown method and a non-HTTP line.
- It then runs the tracking loop through disk-full and cleanup errors, calls every API path, good and bad, and forces a handler traceback. It searches all captured stdout and stderr: **none of the 7 planted values appears**, and no line contains activity JSON.
- `tests/js/e2e/log-privacy.spec.mjs` does the same in the browser. It plants a task title, an app, a site, a window title and a token. It loads live activity, then makes the tracker answer 500 and then go down, and runs a coach review. Every console message, page error and failed request is collected: **none of the 5 planted values appears**.
- Secrets in the repository are checked on every gate run by `npm run audit` (gitleaks, Phase 6).
- Paths: since 2026-11-15 (accepted risk A6, fixed at the owner's request) every log line writes the home folder as `~`, so the log never holds the macOS user name (`test_log_writes_the_home_folder_as_tilde`).

**Tracing a request end to end: N/A (owner's decision).** There is no request ID. A "request" here is one call from the page to the tracker on the same Mac. The browser's Network panel shows each one (method, path, status, time), and the tracker deliberately writes nothing per request, so that no activity ends up in its log. **Decision (owner, 2026-11-14): N/A** for this app, as recommended. Adding a request ID would cost an extra CORS preflight on every poll for little gain on one machine.

## Monitoring

**Health checks and indicators (in place of alerts, approved).** Each has a test that triggers it, so the user is told whenever something is wrong:

| What the user sees | Triggered by | Test |
|---|---|---|
| Tracker card: Tracking apps / Paused / Idle / Not running / Site not allowed / Couldn't load activity | tracker `/status` health check every 10–60 s | resilience.spec, journeys.spec J5–J6 |
| Tracker panel: storage size, days kept, last cleanup | `/status` storage block | test_tracker_unit `storage_obj`, journeys.spec |
| Sync status: Saved to your account / Syncing… / Account not reachable / Account storage full / Saved in this browser | every sync write | resilience.spec |
| Storage-full banner with Clean up now | every save | resilience.spec, data-integrity.spec |
| Plan note when the planner falls back to defaults | a model error | serving.spec |
| Coach: "taking longer than usual", "didn't answer in time", busy, daily limit | each review | ai-provider.spec, ai-ui.spec |
| `python3 keel_tracker.py status` in Terminal | the tracker's API, or the file when it isn't running | test_tracker_integration |

**ML drift: N/A (approved).** Each user's models learn on their own device from their own corrections. No data leaves the device, so there is no shared reference set to compare against. Calibration and accuracy were checked offline in Phases 8–9.

**AI monitoring: N/A (owner's decision).** Prompts and answers aren't logged; nothing leaves the browser except the `sample` call itself. There is no feedback button, and no way to add real reviews to the eval set. **Decision (owner, 2026-11-14): N/A** for this release, as recommended. Privacy comes first, and the eval set stays synthetic, which also keeps test data and real data apart. A local 👍/👎 with a deliberate export is a possible future feature.

## Exit criteria (runbook Phase 13, adapted)

| Criterion | Evidence | Result |
|---|---|---|
| Every dependency failure simulated; graceful degradation and recovery | Table above: 23 cases, all pass after fixes 65–68 | PASS |
| A single request traced end to end in the logs | No request IDs, by design | N/A (owner's decision, 2026-11-14) |
| No secrets or unapproved personal data in logs (show the search) | test_log_privacy.py, log-privacy.spec, gitleaks | PASS |
| Alerts triggered and received in staging | N/A (approved). Local health indicators all triggered by tests | PASS (adapted) |
| Drift monitoring for ML, AI monitoring for AI | Drift N/A (approved in Phase 1); AI monitoring N/A (owner's decision, 2026-11-14) | N/A |
| The regression gate passes | After fixes 65–68: lint and audit clean; Python 350 of 350 (coverage 98.6%); unit 303 of 303 (JS coverage 96.8%); Chromium 63 of 63, twice, with no flaky tests; planner eval 13 of 13; coach evals reproduce; 13 datasets unchanged; golden predictions identical | PASS |
