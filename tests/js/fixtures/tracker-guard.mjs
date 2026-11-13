// Test isolation for the local tracker (added in Phase 5).
// WebKit's request interception doesn't see calls to 127.0.0.1, so on a developer's Mac those tests reached the
// real tracker. To make that impossible in every browser, each test page rewrites requests for the tracker's
// address to a reserved, never-resolving host (`keel-tracker.invalid`, RFC 2606), which page.route can intercept in
// every browser and which can't reach anything if a route is missing. (A same-origin path would be caught by the
// app's service worker before page.route sees it.) Only the URL changes; the app's fetch, timeouts and error
// handling are unchanged.
export const FAKE_TRACKER = "http://keel-tracker.invalid";
export const TRACKER = /^http:\/\/keel-tracker\.invalid\//;

export async function guardTracker(target) {   // a Page or a BrowserContext
  await target.addInitScript(fake => {
    const realFetch = window.fetch.bind(window);
    const TRACKER_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):47821/;
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return TRACKER_URL.test(url) ? realFetch(url.replace(TRACKER_URL, fake), init) : realFetch(input, init);
    };
  }, FAKE_TRACKER);
}

// The real tracker answers with these CORS headers (tracker/keel_tracker.py `_cors`, `do_OPTIONS`); fakes must too,
// or WebKit rightly rejects the cross-origin response.
export const cors = req => ({ "access-control-allow-origin": req.headers()["origin"] || "*", "vary": "Origin", "access-control-allow-private-network": "true" });
export async function preflight(route) {           // true if this was a CORS preflight, answered like the real tracker
  if (route.request().method() !== "OPTIONS") return false;
  await route.fulfill({ status: 204, headers: { ...cors(route.request()), "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "Content-Type", "access-control-max-age": "600" } });
  return true;
}
