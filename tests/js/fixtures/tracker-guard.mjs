// Test isolation for the local tracker (added in Phase 5).
// WebKit's request interception doesn't see calls to 127.0.0.1, so on a developer's Mac those tests reached the
// real tracker. To make that impossible in every browser, each test page rewrites requests for the tracker's
// address to a reserved, never-resolving host (`keel-tracker.invalid`, RFC 2606), which page.route can intercept in
// every browser and which can't reach anything if a route is missing. (A same-origin path would be caught by the
// app's service worker before page.route sees it.) Only the URL changes; the app's fetch, timeouts and error
// handling are unchanged.
export const FAKE_TRACKER = "http://keel-tracker.invalid";
export const TRACKER = /^http:\/\/keel-tracker\.invalid\//;

// { refuse: true }: for specs that run under the app's real Content-Security-Policy. The policy allows the real
// tracker address but not the fake host, and WebKit applies it before page.route sees the request, logging a CSP
// error that a real visit would never show. So instead each tracker request fails in the page exactly as when the
// tracker isn't running (a TypeError from fetch), and is recorded in window.__trackerCalls with the page it came from.
export async function guardTracker(target, { refuse = false } = {}) {   // a Page or a BrowserContext
  await target.addInitScript(([fake, refuse]) => {
    const realFetch = window.fetch.bind(window);
    const TRACKER_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):47821/;
    window.__trackerCalls = [];
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!TRACKER_URL.test(url)) return realFetch(input, init);
      if (refuse) {
        const view = typeof ui !== "undefined" ? ui.view : null;   // eslint-disable-line no-undef -- the app's global, read at call time
        window.__trackerCalls.push({ url: url.replace(TRACKER_URL, ""), view });
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return realFetch(url.replace(TRACKER_URL, fake), init);
    };
  }, [FAKE_TRACKER, refuse]);
}

// The real tracker answers with these CORS headers (tracker/keel_tracker.py `_cors`, `do_OPTIONS`); fakes must too,
// or WebKit rightly rejects the cross-origin response.
export const cors = req => ({ "access-control-allow-origin": req.headers()["origin"] || "*", "vary": "Origin", "access-control-allow-private-network": "true" });
export async function preflight(route) {           // true if this was a CORS preflight, answered like the real tracker
  if (route.request().method() !== "OPTIONS") return false;
  await route.fulfill({ status: 204, headers: { ...cors(route.request()), "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "Content-Type", "access-control-max-age": "600" } });
  return true;
}
