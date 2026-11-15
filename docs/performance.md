# Performance, load and cost (Phase 12)

Keel has no multi-user server. It is a single HTML page that keeps data in the browser, an optional local tracker on the owner's Mac with a small HTTP API on `127.0.0.1:47821`, and a Daily coach that calls Claude through the claude.ai `sample` capability on the owner's plan. So Phase 12 is **adapted** (docs/test-strategy.md §5, row 12):
- "Load" means the tracker API under one or more open Keel tabs, ramped until it breaks, and the browser app under growing data.
- "Users" means one person with up to three tabs open.

Everything ran on 2026-11-14 in the cloud test machine (Linux, 4 CPUs, Chrome 153). Nothing ran against production (the GitHub Pages site) or the owner's real tracker. AI spend: $0.

## Approved targets and results

| Target (docs/test-strategy.md §6) | Result | |
|---|---|---|
| Tracker API p95 (`/status`) < 50 ms | 0.97 ms (1,000 sequential requests, 30 heavy days loaded) | PASS |
| Tracker CPU average over 10 min < 2% / RSS < 60 MB | Mac (M4, macOS 27.0.1): tracker 0.18% + helpers 0.46% worst case (a browser always in front) = **0.64%**; RSS 15.9 MB max. Linux, lookups faked: 0.42% / 48.5 MB. 3 tabs pulling at once: 52.0–53.6 MB after fix 64 | PASS |
| Lighthouse mobile LCP < 2.5 s / CLS < 0.1 / TBT < 300 ms | 1.68 s / 0.009 / 0 ms (median of 3, compressed like GitHub Pages) | PASS |
| Dashboard render with 30 days of activity < 150 ms | p95 13 ms desktop (66 ms at 4× CPU) | PASS |
| Planner `buildPlan` p95 < 50 ms (30 tasks, 30 days of history) | p95 2 ms desktop (5 ms at 4× CPU) | PASS |
| Browser storage, 30 heavy days < 4 MB | 2.54 MB (600 tasks, 1 year of sessions, 30 × 800 app segments) | PASS |
| Tracker file / log ≤ configured cap / ≤ 1 MB | 1.52 MB file (cap 20 MB) / 0 B log | PASS |
| Paid API spend $0 | $0 | PASS |

## Tracker API (perf/tracker_bench.py)

**Method.**
- The real tracker (`tracker/keel_tracker.py`) runs unchanged: sampling loop, threaded API, saving and cleanup.
- Only its three macOS lookups (idle time, front app, browser tab) are replaced, by `perf/tracker_fake_mac.py`. It runs in a temporary home folder seeded with 30 heavy days: 800 segments a day, titles on browser segments, a 1.52 MB file, and 1.5 MB from `/activity?days=30`.
- Requests look like the web app's: a new connection each time, the allowed `Origin` header, and the same 3-second client timeout as `trFetch`.

**One tab** (what the app does: `/status` every 10 s, `/activity` once a minute):

| Endpoint | n | p50 | p95 | p99 | Errors |
|---|---|---|---|---|---|
| `/status` | 1,000 | 0.68 ms | 0.97 ms | 1.05 ms | 0 |
| `/activity?days=30` (1.5 MB) | 50 | 17 ms | 30 ms | 31 ms | 0 |

**Ramp to breaking point.** Each level ran for 10 s, with 90% `/status` and 10% `/activity` requests, each client sending its next request as soon as the last one finished:

| Clients | Requests/s | Errors | `/status` p50 / p95 / p99 (ms) | `/activity` p95 (ms) | Tracker CPU | Tracker RSS |
|---|---|---|---|---|---|---|
| 1 | 380 | 0% | 0.8 / 1.3 / 2.0 | 28 | 92% | 49 MB |
| 2 | 419 | 0% | 1.3 / 17 / 22 | 33 | 98% | 60 MB |
| 4 | 385 | 0% | 3.2 / 32 / 45 | 52 | 100% | 72 MB |
| 8 | 364 | 0% | 6.7 / 40 / 64 | 58 | 95% | 78 MB |
| 16 | 343 | 0% | 9.2 / 50 / 1,048 | 65 | 91% | 86 MB |
| 32 | 364 | 0.1% | 8.7 / 1,009 / 1,239 | 106 | 91% | 87 MB |
| 64 | 379 | 1.1% | 18 / 1,038 / 2,049 | 1,039 | 94% | 94 MB |
| 128 | 362 | 2.6% | 21 / 1,452 / 2,471 | 1,256 | 93% | 98 MB |
| 256 | 297 | 10.1% | 24 / 2,083 / 2,919 | 2,079 | 81% | 134 MB |
| 512 | 369 | 21.7% | 22 / 2,248 / 3,029 | 2,100 | 80% | 196 MB |

**What breaks first.**
1. **CPU on one core.** Throughput tops out at about 400 requests a second from the first client: Python runs the handler threads one at a time. Each `/activity` spends about 20 ms of CPU building and encoding 1.5 MB of JSON, and `/status` requests queue behind it. `/status` p95 passes the 50 ms target at 16 clients.
2. **The connection queue.** `ThreadingHTTPServer` accepts only 5 waiting connections (`request_queue_size`). From 16–32 clients, new connections are dropped and retried after 1 s by TCP, which is the jump to about 1 s in p99 and then p95. From 64 clients, some requests miss the app's 3 s timeout (1.1% errors at 64 clients, 22% at 512).
3. **Memory grows with concurrent `/activity` requests** (see finding 64).

**Headroom.** Real use is 1–3 tabs at about 0.1–0.3 requests a second, roughly 1,000–4,000 times below saturation. The API meets its target with up to 8 clients sending requests back to back, with no errors up to 16.

## Tracker CPU and memory over 10 minutes

**Linux, macOS lookups faked.** 10.0 minutes, one tab polling, 30 heavy days loaded:
- average CPU **0.42%** of one core;
- RSS **48.5 MB** maximum and at the end, flat after start-up.

Raw samples: `perf/results/tracker-20261114-122941.json`.

**Tracker on a real Mac.** On macOS each 5 s sample also starts helper programs: `ioreg` (idle time), `lsappinfo` twice (front app), and `osascript` when a browser is in front (the tab). Their CPU isn't counted in the tracker's own `ps` time. `perf/mac_tracker_cpu.sh` measured the running tracker on the owner's Mac (Apple M4, macOS 27.0.1, 2026-11-14). It is read-only: it reads `ps` for 10 minutes and times one `ioreg` call.
- tracker process: **0.18%** of one core on average over 10.0 minutes; RSS **15.9 MB** maximum;
- one `ioreg` call: 10 ms CPU, about **0.20%** of a core at one call every 5 s;
- the helpers, timed with `perf/mac_child_cpu.sh` (10 runs each, the tracker's exact `ioreg` and `lsappinfo` calls; read-only, `osascript` runs `return 1` so no tab is read): `ioreg` 1 ms, `lsappinfo front` 0 ms, `lsappinfo info` 0 ms, `osascript` 22 ms per call. `/usr/bin/time` counts in 10 ms steps, so the 0 ms calls are under about 1 ms on average. Per 5 s sample that is **0.02%** of a core with no browser in front and **0.46%** with a browser always in front;
- **worst case total: 0.18% + 0.46% = 0.64%** of one core, under the 2% target. (Using the earlier, heavier full `ioreg` timing of 10 ms instead gives 0.82%, also under.)

What this leaves out: the work the browser does to answer `osascript` runs in the browser's process, not the tracker's, so it isn't counted here; `return 1` measures the cost of starting `osascript`, which is what the tracker pays.

## Browser app (tests/js/unit/perf.spec.mjs)

Repeated timings after warm-up, on desktop Chromium and at 4× CPU slowdown (a mid-range phone; reported, not a target). Raw numbers: `perf/results/web-2026-11-14.json`.

**Planner.** 30 open tasks, 60 done with 30 days of tracked sessions: `buildPlan` p50 1 ms, **p95 2 ms**, p99 3 ms (300 runs); at 4×, p95 5 ms.

**Render, per view.** 600 tasks, 1 year of sessions, 30 heavy activity days. p95 in ms, desktop / 4×:

| today | focus | tasks | timeline | apps | reports | projects | settings |
|---|---|---|---|---|---|---|---|
| **13** / 66 | 10 / 23 | 35 / 148 | 6 / 41 | 8 / 39 | 3 / 12 | 1 / 3 | 1 / 6 |

**Data-size ramp (what breaks first as data grows).** p95 in ms, desktop:

| Tasks | Sessions | Activity days | Storage | Today | Tasks view | Reports | Planner | Start-up parse |
|---|---|---|---|---|---|---|---|---|
| 600 | 1 year | 30 | 2.5 MB | 15 | 31 | 7 | 14 | 5 |
| 2,000 | 2 years | 60 | 5.2 MB | 15 | 137 | 4 | 45 | 8 |
| 5,000 | 3 years | 90 | 8.6 MB | 21 | 307 | 6 | 102 | 13 |
| 10,000 | 5 years | 180 | 9.9 MB, **storage full** | 19 | 594 | 9 | 160 | 24 |
| 20,000 | 8 years | 365 | **storage full** | 28 | 1,164 | 13 | 370 | n/a |

**What breaks first.**
1. The **Tasks view**, whose render time grows with the number of tasks: about 60 ms per 1,000 on desktop. It is the slowest view from the first step. In a real tap it gets slow with a year of tasks (finding 62).
2. The **planner** passes 50 ms at about 2,000 tasks.
3. **Browser storage** fills at about 10 MB. The app handles it as designed: the red "Browser storage is full" banner appears and nothing crashes.

The dashboard (Today) stays under 30 ms throughout.

## Mobile Core Web Vitals

**Lighthouse 12.8.2, mobile** (simulated slow 4G and 4× CPU), on `index.html` served by `perf/serve_gzip.py`, which compresses like GitHub Pages:

| Run | LCP | CLS | TBT | FCP | Performance score |
|---|---|---|---|---|---|
| 1 | 1,683 ms | 0 | 0 ms | 1,683 ms | 0.99 |
| 2 | 1,680 ms | 0.009 | 0 ms | 1,680 ms | 0.99 |
| 3 | 1,684 ms | 0 | 0 ms | 1,684 ms | 0.99 |

Accessibility and best practices scored 1.0. Results: `perf/results/lighthouse/gz*.json`.

Notes:
- **Compression matters.** Served uncompressed by `python3 -m http.server`, `index.html` is 236 KB instead of 71 KB, and LCP is 2.58 s (over target). No real visitor gets that, since GitHub Pages compresses, but a host without compression would fail the target (`run1.json`).
- **Google Fonts.** They can't be reached from the test machine (the proxy blocks them). Blocking them on purpose changes nothing (1.68 s in `gznf1.json`). Lighthouse estimates up to 730 ms of render-blocking for the fonts stylesheet, but that figure can't be confirmed here. The stylesheet uses `display=swap`, so text shows in a fallback font first. **Since fix 68 (Phase 13)** the stylesheet no longer blocks the page at all: Lighthouse mobile, 3 runs, LCP 1.06–1.12 s, CLS 0, TBT 36–128 ms, performance 0.99–1.0, nothing render-blocking (`gz-fix68-*.json`).

**With a year of data, each view, at 390 px and 4× CPU.** Loaded from the local server with no network delay, so LCP here is the CPU part only. Median of 3 loads:

| View | LCP | CLS | TBT | Longest task |
|---|---|---|---|---|
| today | 408 ms | 0 | 11 ms | 245 ms |
| focus | 344 ms | 0 | 0 ms | 110 ms |
| tasks | 808 ms | 0 | 0 ms | 291 ms |
| timeline | 304 ms | 0 | 10 ms | 118 ms |
| apps | 364 ms | 0 | 0 ms | 165 ms |
| reports | 356 ms | 0.008 | 0 ms | 158 ms |
| projects | 244 ms | 0 | 0 ms | 85 ms |
| settings | 424 ms | 0 | 0 ms | 238 ms |

**Responsiveness: ticking a task in the Tasks view** (INP-style: from the click to the next frame), with 600 tasks, 220 rows shown and 6,655 DOM nodes:
- before fix 62: 498–808 ms at 4× CPU, 120–183 ms on desktop;
- after fix 62 (only the ticked row is redrawn, one full render 1.5 s after the last tick, done tasks shown 50 at a time): **106–299 ms** at 4× CPU, **24–36 ms** on desktop. `perf.spec` now checks the desktop median < 100 ms.

INP isn't among the approved targets. See finding 62.

## Daily coach: cost, latency, slow or rate-limited provider

**Cost.**
- Paid API spend is **$0**: the coach uses the owner's Claude plan through claude.ai, with no API key.
- Usage per user per day is capped at **20 reviews**, and one a minute after a finished answer (bug 27).

**Size per request.** Token counts are estimates (about 3.5–4 characters per token; no tokenizer offline):

| | Characters | Tokens (estimate) |
|---|---|---|
| Prompt, 50 eval days (coach-v6) | average 1,930, p95 2,317, max 2,495 | average about 480–550, p95 about 580–660 |
| Prompt, worst case after the fix-56 caps | about 15,200 | about 3,800–4,300 |
| Answer (run 7) | average 539, p95 623 | average about 135–155, p95 about 160–180 |

At the cap, that is at most about 20 × 0.8k ≈ 16k tokens a day of plan usage for a typical day.

**Ways to reduce cost.**
- Caching isn't worth it: each day's data differs.
- A smaller model isn't an option: `sample` doesn't let the app pin a model.
- Trimming the prompt isn't worth it: it is already about 500 tokens, and Phase 10 shows it is near the floor for the rubric. Each later instruction fixed a measured failure.

No change is recommended.

**Real latency.** Total time per request, from 1,266 recorded requests (eval runs 1–7 and red-team runs 1–2, on the owner's plan):
- p50 2.3 s, p95 3.1 s, p99 7.6 s, worst 38 s (run 1);
- 0 failures, 0 retries, and no rate limiting seen.

Time to first token wasn't recorded: the eval pages measure total time, and streaming shows text sooner.

**When the provider is slow or limits requests** (`tests/js/e2e/ai-provider.spec.mjs`, mocked provider):
- **Slow** (8 s to answer): "Thinking…" with a Stop button, and the rest of the app stays usable. The main thread is never blocked over 200 ms, and the answer shows when it arrives. PASS.
- **Rate-limited:** each press shows "The coach is busy right now. Try again in a minute." Nothing retries on its own, and the 20-a-day cap bounds attempts (the 21st press doesn't reach the provider). PASS.
- **Hung** (never answers). Before fix 63: "Thinking…" for as long as the page was open. After fix 63: with no text for 20 s, "This is taking longer than usual. You can stop and try again." appears; at 90 s the request is stopped, the retry message shows, and the attempt doesn't count toward the day. Text that is still streaming resets the clock. PASS (`ai-provider.spec`, 3 tests).

## Findings (approved and fixed 2026-11-14)

- **62, Low (responsiveness).** Ticking a task in the Tasks view takes 498–808 ms to the next frame on an emulated mid-range phone, and 120–183 ms on desktop, with a year of tasks (600; 220 rows shown). The click re-renders the whole list: about 70 ms on desktop and 170–300 ms at 4×, plus layout of a 6,655-node page. It grows by about 60 ms per 1,000 tasks. **Fixed:** on tick only that task's row is redrawn (counts updated, focus kept), with one full render 1.5 s after the last tick; Completed shows 50 at a time with "Show N more". Now 106–299 ms at 4×, 24–36 ms on desktop. Tests: `tasks-tick.spec` (3) and the `perf.spec` tap check; they fail on the old code.
- **63, Low (AI UX).** The coach has no timeout. A request that never answers shows "Thinking…" indefinitely; only Stop ends it. The recorded p99 is 7.6 s. Proposed fix: after 20 s with no text, add "This is taking longer than usual. You can stop and try again."; after 90 s, stop the request and show the retry message. Stopping a timed-out request wouldn't count toward the day. **Fixed** as proposed (`COACH_TIMEOUT` 20 s / 90 s). Tests: `ai-provider.spec` "finding 63" (3); they fail on the old code.
- **64, Low (tracker memory).** When 3 tabs pull `/activity` (30 heavy days) at the same moment, tracker RSS goes over the 60 MB target. After 20 such rounds it ended at 60.9–66.3 MB in 5 of 6 runs (56.8 MB in the other). Each request builds its own copy of the data. One tab alone stays at 48 MB. Repro: `python3 perf/tracker_rss_tabs.py`. Proposed fix: build `/activity` one request at a time (a lock), or reuse the last encoded body until the data changes. **Fixed** with the lock: one copy is alive from snapshot to encoded bytes, then it is freed and the bytes are sent outside the lock. 6 runs: **52.0–53.6 MB** (was 60.9–66.3). `/status` doesn't wait for it. Test: `test_fix64_one_activity_copy_alive_at_a_time` (4 copies alive at once before the fix, 1 after).
- **Information only, no fix proposed.** The API's 5-connection accept queue causes 1 s stalls from about 16–32 simultaneous clients. That is far beyond 1–3 tabs. **Fixed anyway on 2026-11-15 (owner's choice, accepted risk A5):** the queue is now 64. Re-measured, 5 s per level: no stalls and no errors up to 64 clients (`/status` p95 60, 98 and 151 ms at 16, 32 and 64 clients, CPU-bound), timeouts only from 128 clients (1.3%). Under that saturating load the test process reaches about 78 MB; with 3 tabs pulling together it stays at 52.0–54.9 MB (6 runs). Test: `test_api_queue_holds_bursts_of_connections` (`perf/results/tracker-20261115-113447.json`).

## Exit criteria (runbook Phase 12, adapted)

| Criterion | Evidence | Result |
|---|---|---|
| Latency and error rate meet targets at the approved load (1 user, up to 3 tabs) | `/status` p95 0.97 ms, `/activity` p95 30 ms, 0 errors; within target up to 8 clients back to back | PASS |
| Breaking point and first bottleneck documented | Ramp to 512 clients; CPU (one core, `/activity` encoding) first, then the accept queue; browser: Tasks view, then planner, then storage at about 10 MB | PASS |
| Cost per AI request and per user within target | $0 API; ≤ 20 reviews a day; about 0.5k tokens in and 0.15k out per request (estimate) | PASS |
| Provider rate limiting handled gracefully | `ai-provider.spec`: clear message, no retry storm, daily cap; slow provider keeps the app usable; a hung provider is flagged at 20 s and stopped at 90 s (fix 63) | PASS |
| Mobile Core Web Vitals meet targets | Lighthouse mobile 1.68 s / 0.009 / 0 ms; every view with a year of data within target | PASS |
| Tracker CPU / RSS (approved target) | Mac: 0.64% CPU worst case (tracker 0.18% + helpers 0.46%), 15.9 MB; 3 simultaneous pulls 52.0–53.6 MB (fix 64) | PASS |
| The regression gate passes | After fixes 62–64: lint, audit, Python 339 (coverage 98.95%), unit 303 (JS coverage 96.8%), Chromium 50 × 2, planner eval 13/13 on app fc98c93e98c5, coach evals reproduce, 13 datasets unchanged. Golden predictions identical to app 5fa42a6477f8 | PASS |
