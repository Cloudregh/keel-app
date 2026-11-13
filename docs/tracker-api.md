# Keel tracker local API

Base URL: `http://127.0.0.1:47821`. The port can be changed with `KEEL_TRACKER_PORT`, but only for tests. The API only listens on this Mac.

## Access rules

- The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`. Anything else gets **403** (protects against DNS rebinding).
- Requests with **no `Origin`** header (for example `curl` or the CLI on the same Mac) are allowed.
- Requests from a browser must come from an allowed origin. That means `http://localhost[:port]`, `http://127.0.0.1[:port]`, or an entry in `allowed_origins` in `~/Keel Activity/config.json`. Any other origin, including `null`, gets **403**, and POSTs from it change nothing.
- An allowed origin is echoed in `Access-Control-Allow-Origin`, together with `Vary: Origin` and `Access-Control-Allow-Private-Network: true`.
- Every response body is JSON (`Content-Type: application/json; charset=utf-8`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`) and never contains a stack trace.
- A connection that stops sending is closed after 5 seconds.

## Endpoints

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| OPTIONS | any | — | **204** with `Access-Control-Allow-Methods: GET, POST, OPTIONS`, `Access-Control-Allow-Headers: Content-Type`, `Access-Control-Max-Age: 600` | 403 (bad Host or origin) |
| GET | `/status` | — | 200 `Status` | 403 |
| GET | `/activity?days=N` | — | 200 `Activity`, at most `min(N, keep_days)` days (N defaults to `keep_days`) | 403 |
| POST | `/pause` | `{"minutes": number}` (optional) | 200 `Status`. A positive `minutes` pauses until then; anything else pauses until resumed | 403 |
| POST | `/resume` | — | 200 `Status` | 403 |
| POST | `/cleanup` | — | 200 `Status` plus `removedDays: int` | 403 |
| POST | `/settings` | `{"keepDays": int 1–365, "maxFileMb": number 1–500}` (both optional; out-of-range values are ignored) | 200 `Status`. Settings are saved and a cleanup runs | 403 |
| any | any other path | — | — | **404** `{"error": string}` |

A body that isn't valid JSON (including `NaN` and `Infinity`, which JSON doesn't allow) is treated as `{}`.
Every POST also returns **400** `{"error": "Bad Content-Length"}` if `Content-Length` is negative or not a number, and **413** `{"error": "Request body too large"}` if the body is over 2 MB; either way nothing changes.

## Files

`~/Keel Activity` is readable by this account only (folder `0700`; `config.json`, `tracker.log` and `keel-activity.json` `0600`).

## Schemas

`Status`:

```json
{
  "app": "keel-tracker", "version": 2, "running": true,
  "paused": false, "pausedUntil": null,
  "startedAt": 0, "current": {"app": "string", "domain": "string"},
  "idle": false, "todayMs": 0, "device": "string", "now": 0,
  "storage": {"fileBytes": 0, "logBytes": 0, "keepDays": 30, "maxFileMb": 20, "days": 0, "lastCleanup": null}
}
```

- `pausedUntil` is epoch milliseconds when the pause has an end time, or `null` when paused indefinitely or not paused.
- `current` is `null` while paused or idle.
- `storage.lastCleanup` is epoch milliseconds, or `null` before the first cleanup.

`Activity` (also the format of `keel-activity.json`):

```json
{
  "source": "keel-tracker", "version": 2, "device": "string", "updatedAt": 0, "tzOffsetMin": 0,
  "days": {"YYYY-MM-DD": [{"s": 0, "e": 0, "app": "string", "domain": "string?", "title": "string?"}]}
}
```

- `s` and `e` are epoch milliseconds, with `e - s >= 1000`.
- `domain` is lowercase with no `www.`.
- `title` is at most 90 characters, and is dropped from days older than 7.

`Error`: `{"error": "string"}`
