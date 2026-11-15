/* global TR, state, Sync */
// Phase 13: each dependency of the page fails or slows down, then comes back. For each, Keel must not hang, must
// retry on a calm schedule (no retry storm), must fall back where designed, must tell the user in plain words, and
// must recover by itself when the dependency returns.
// Dependencies: the local tracker API, account sync (claude.ai `db`), browser storage, Google Fonts.
// (The coach provider: ai-provider.spec + ai-ui.spec. The planner model: serving.spec. Offline start-up via the
// service worker: journeys.spec J11. Tracker-side dependencies: tests/py/test_resilience.py.)
import { test, expect } from "../fixtures/keel.mjs";
import { TRACKER, cors, preflight } from "../fixtures/tracker-guard.mjs";

const NOW = new Date("2026-11-10T10:00:00Z");
const STATUS = { app: "keel-tracker", version: 2, running: true, paused: false, pausedUntil: null, startedAt: 1, current: { app: "Code", domain: "" }, idle: false, todayMs: 1800000, device: "Mac", now: 1, storage: { fileBytes: 2048, logBytes: 10, keepDays: 30, maxFileMb: 20, days: 1, lastCleanup: null } };
const ACTIVITY = { source: "keel-tracker", version: 2, device: "Mac", updatedAt: 1, days: { "2026-11-10": [{ s: Date.UTC(2026, 10, 10, 8), e: Date.UTC(2026, 10, 10, 8, 40), app: "Code" }] } };

// A fake tracker whose behaviour the test switches while the page runs: ok | down | hang | blocked | badActivity.
async function switchableTracker(page) {
  const t = { mode: "ok", hits: [] };
  await page.unroute(TRACKER);
  await page.route(TRACKER, async route => {
    if (await preflight(route)) return;
    const url = new URL(route.request().url());
    t.hits.push({ mode: t.mode, path: url.pathname });
    if (t.mode === "down") return route.abort("connectionrefused");
    if (t.mode === "hang") return;                                   // never answers
    const h = cors(route.request());
    if (t.mode === "blocked") return route.fulfill({ status: 403, headers: h, contentType: "application/json", body: '{"error":"This page isn\'t allowed to use the Keel tracker."}' });
    if (url.pathname === "/activity" && t.mode === "badActivity") return route.fulfill({ headers: h, contentType: "application/json", body: '{"days":"nope"}' });
    return route.fulfill({ headers: h, contentType: "application/json", body: JSON.stringify(url.pathname === "/activity" ? ACTIVITY : STATUS) });
  });
  return t;
}
// Fake timers from page start, so the app's own 1 s tick and poll schedule can be fast-forwarded.
async function withFakeClock(page) {
  await page.clock.install({ time: NOW });
  await page.evaluate(() => { localStorage.setItem("keel.ui.v1", JSON.stringify({ ...(JSON.parse(localStorage.getItem("keel.ui.v1") || "{}")), trSeen: true })); });
  await page.reload();
  await page.waitForFunction(() => typeof window.render === "function");
}
const trk = page => page.locator("#trk");
// Advance the page's fake clock 1 s at a time with a short real pause, so real replies from the fake tracker arrive
// before the app's own 3 s timeout (fake time) can fire. One big runFor would outrun the network.
async function advance(page, ms) { for (let t = 0; t < ms; t += 1000) { await page.clock.runFor(Math.min(1000, ms - t)); await page.waitForTimeout(15); } }

test.describe("tracker API", () => {
  test("down: says it isn't running, retries once a minute (no storm), and reconnects by itself when it's back", async ({ keel: { page } }) => {
    const t = await switchableTracker(page);
    t.mode = "down";
    await withFakeClock(page);
    await advance(page, 2000);
    await expect(trk(page)).toContainText("Not running on this computer");
    await expect(trk(page).locator('[data-act="tr-retry"]')).toBeVisible();          // a manual retry is offered
    const before = t.hits.length;
    await advance(page, 5 * 60_000);
    const tries = t.hits.length - before;
    expect(tries, "status checks in 5 minutes while down").toBeGreaterThanOrEqual(4);
    expect(tries).toBeLessThanOrEqual(6);
    t.mode = "ok";                                                                   // the tracker comes back
    await advance(page, 61_000);
    await expect(trk(page)).toContainText("Tracking apps");
    expect(await page.evaluate(() => TR.state)).toBe("online");
    expect(t.hits.some(h => h.mode === "ok" && h.path === "/activity")).toBe(true);   // activity loads again
  });

  test("hung: gives up after 3 s instead of hanging, then recovers when it answers again", async ({ keel: { page } }) => {
    const t = await switchableTracker(page);
    await withFakeClock(page);
    await advance(page, 2000);
    await expect(trk(page)).toContainText("Tracking apps");
    t.mode = "hang";
    await advance(page, 10_000 + 3_500);                                        // next 10 s poll + the 3 s timeout
    await expect.poll(() => page.evaluate(() => TR.state)).toBe("offline");
    await expect(trk(page)).toContainText("Tracker not connected");
    t.mode = "ok";
    await advance(page, 61_000);
    await expect(trk(page)).toContainText("Tracking apps");
  });

  test("blocked (site not allowed): says so with directions, and connects once the site is allowed", async ({ keel: { page } }) => {
    const t = await switchableTracker(page);
    t.mode = "blocked";
    await withFakeClock(page);
    await advance(page, 2000);
    await expect(trk(page)).toContainText("This site isn't allowed yet");
    await page.locator('#nav [data-view="apps"]').click();
    await expect(page.locator("#view")).toContainText("allowed_origins");
    t.mode = "ok";
    await advance(page, 61_000);
    await expect(trk(page)).toContainText("Tracking apps");
  });

  test("bad activity data: says the activity couldn't be read (not 'not running'), and clears once it's readable", async ({ keel: { page } }) => {
    const t = await switchableTracker(page);
    t.mode = "badActivity";
    await withFakeClock(page);
    await advance(page, 2000);
    await expect(trk(page)).toContainText("Tracking apps");
    await expect(trk(page)).toContainText(/couldn't (read|load)/i);
    t.mode = "ok";
    await advance(page, 61_000);                                               // activity is pulled every minute
    await expect(trk(page)).not.toContainText(/couldn't (read|load)/i);
  });
});

// A fake claude.ai platform with a `db` whose answers the test switches: ok | fail | quota | hang.
const FAKE_PLATFORM = () => {
  const store = {}, log = [];
  const mode = { get: "ok", set: "ok", use: "ok" };
  let releaseGet = [];
  window.__plat = { store, log, mode, release: () => { const r = releaseGet; releaseGet = []; r.forEach(f => f()); } };
  const err = code => Object.assign(new Error(code), { code });
  const db = {
    doc: path => ({
      async get() {
        log.push("get " + path.split("/").pop());
        if (mode.get === "hang") await new Promise(r => releaseGet.push(r));
        if (mode.get === "fail") throw err("unavailable");
        const k = path.split("/").pop();
        return { exists: k in store, data: () => store[k] };
      },
      async set(v) {
        log.push("set " + path.split("/").pop());
        if (mode.set === "fail") throw err("unavailable");
        if (mode.set === "quota") throw err("quota_exceeded");
        store[path.split("/").pop()] = JSON.parse(JSON.stringify(v));
      }
    })
  };
  const user = { id: async () => "u-test" };
  window.claude = { use: async name => { if (mode.use === "throw") throw err("unavailable"); return name === "db" ? db : name === "user" ? user : null; } };
};
async function withPlatform(page, setup = "") {
  await page.clock.install({ time: NOW });
  await page.addInitScript(`(${FAKE_PLATFORM})(); ${setup}`);
  await page.reload();
  await page.waitForFunction(() => typeof window.render === "function");
}
const syncLabel = page => page.locator("#sync span");
async function addTask(page, text) {
  if (!(await page.locator("#qa-input").count())) await page.locator('#nav [data-view="tasks"]').click();
  await page.locator("#qa-input").fill(text);
  await page.locator("#qa-input").press("Enter");
}

test.describe("account sync", () => {
  test("store unreachable while saving: 'saved locally', one calm retry, then synced with nothing lost", async ({ keel: { page } }) => {
    await withPlatform(page);
    await page.clock.runFor(2000);
    await expect(syncLabel(page)).toHaveText("Saved to your account");
    await page.evaluate(() => { window.__plat.mode.set = "fail"; });
    await addTask(page, "Written while offline");
    await page.clock.runFor(1500);
    await expect(syncLabel(page)).toHaveText("Account not reachable — saved locally");
    const sets = () => page.evaluate(() => window.__plat.log.filter(l => l.startsWith("set ")).length);
    const n0 = await sets();
    await page.clock.runFor(7000);                                                  // no retry before 8 s
    expect(await sets()).toBe(n0);
    await page.evaluate(() => { window.__plat.mode.set = "ok"; });                  // the store comes back
    await page.clock.runFor(8000);
    await expect(syncLabel(page)).toHaveText("Saved to your account");
    const saved = await page.evaluate(() => window.__plat.store.core.tasks.map(t => t.title));
    expect(saved).toContain("Written while offline");
  });

  test("account storage full: says so, keeps working locally, syncs again once there's room", async ({ keel: { page } }) => {
    await withPlatform(page);
    await page.clock.runFor(2000);
    await page.evaluate(() => { window.__plat.mode.set = "quota"; });
    await addTask(page, "First");
    await page.clock.runFor(1500);
    await expect(syncLabel(page)).toHaveText("Account storage full — saved locally");
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("keel.v1")).tasks.map(t => t.title))).toEqual(["First"]);   // still saved in this browser
    await page.evaluate(() => { window.__plat.mode.set = "ok"; });
    await addTask(page, "Second");                                                   // the next change tries again
    await page.clock.runFor(1500);
    await expect(syncLabel(page)).toHaveText("Saved to your account");
    expect(await page.evaluate(() => window.__plat.store.core.tasks.map(t => t.title).sort())).toEqual(["First", "Second"]);
  });

  test("sync not available at all: works in 'saved in this browser' mode", async ({ keel: { page } }) => {
    await withPlatform(page, "window.__plat.mode.use = 'throw';");
    await page.clock.runFor(2000);
    await expect(syncLabel(page)).toHaveText("Saved in this browser");
    await addTask(page, "Local only");
    await expect(page.locator("#view")).toContainText("Local only");
    expect(await page.evaluate(() => Sync.db)).toBeNull();
  });

  test("store hangs at start-up: says it isn't reachable after 10 s, and syncs when it finally answers", async ({ keel: { page } }) => {
    await withPlatform(page, "window.__plat.mode.get = 'hang';");
    await page.clock.runFor(2000);
    await expect(syncLabel(page)).toHaveText("Syncing…");
    await addTask(page, "Made while waiting");                                      // the app is usable meanwhile
    await expect(page.locator("#view")).toContainText("Made while waiting");
    await page.clock.runFor(10_000);
    await expect(syncLabel(page)).toHaveText("Account not reachable — saved locally");
    await page.evaluate(() => { window.__plat.mode.get = "ok"; window.__plat.release(); });
    await page.clock.runFor(3000);
    await expect(syncLabel(page)).toHaveText("Saved to your account");
    expect(await page.evaluate(() => window.__plat.store.core.tasks.map(t => t.title))).toContain("Made while waiting");
  });
});

test.describe("browser storage", () => {
  test("full: banner while changes can't be saved; it goes away and everything is saved once there's room", async ({ keel: { page } }) => {
    await page.evaluate(() => {
      window.__full = true;
      const real = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) { if (window.__full && String(k).startsWith("keel")) throw new DOMException("Quota exceeded", "QuotaExceededError"); return real.call(this, k, v); };
    });
    await addTask(page, "Made while full");
    await expect(page.locator("#storage-banner")).toContainText("aren't being saved");
    await expect(page.locator("#view")).toContainText("Made while full");          // the app keeps working
    await page.evaluate(() => { window.__full = false; });                           // the user frees space
    await addTask(page, "Made after");
    await expect(page.locator("#storage-banner")).toHaveCount(0);
    await page.reload();
    await expect(page.locator("#view")).toContainText("Made while full");
    await expect(page.locator("#view")).toContainText("Made after");
    expect(await page.evaluate(() => state.tasks.length)).toBe(2);
  });
});

test.describe("Google Fonts", () => {
  test("blocked: the page renders in the fallback fonts and works", async ({ keel: { page } }) => {
    // The shared fixture already aborts every Google Fonts request.
    await expect(page.locator("#nav button").first()).toBeVisible();
    const family = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(family).toMatch(/system-ui|-apple-system|sans-serif/);
    await addTask(page, "Fonts are down");
    await expect(page.locator("#view")).toContainText("Fonts are down");
  });

  test("slow (8 s, then fails): the app is usable within 3 s, not only once the font server gives up", async ({ keel: { page } }) => {
    // A font server that hangs (a filtering network, a captive portal) answers late or times out. Here it fails
    // after 8 s; in real networks a hung connection can take far longer.
    await page.unroute(/fonts\.(googleapis|gstatic)\.com/);
    await page.route(/fonts\.(googleapis|gstatic)\.com/, async route => { await new Promise(r => setTimeout(r, 8000)); await route.abort("timedout").catch(() => {}); });
    const t0 = Date.now();
    await page.goto("/index.html", { waitUntil: "commit" });
    await expect(page.locator("#nav button").first()).toBeVisible({ timeout: 15_000 });
    const shownMs = Date.now() - t0;
    console.log(`fonts slow: app usable after ${shownMs} ms`);
    expect(shownMs, "time until the app is usable with the font stylesheet hanging").toBeLessThan(3000);
  });
});

test.describe("Google Fonts available (fix 68)", () => {
  test.use({ bypassCSP: false });                                                     // the app's real policy: the inline onload must run
  test("the font stylesheet is still applied once it arrives", async ({ keel: { page } }) => {
    await page.unroute(/fonts\.(googleapis|gstatic)\.com/);
    await page.route(/fonts\.googleapis\.com/, route => route.fulfill({ contentType: "text/css", body: "body{--font-probe:loaded}" }));
    await page.route(/fonts\.gstatic\.com/, route => route.abort());
    const csp = [];
    page.on("console", m => { if (/Content Security Policy|Refused/i.test(m.text())) csp.push(m.text()); });
    await page.reload();
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--font-probe").trim())).toBe("loaded");
    expect(await page.locator('link[href*="fonts.googleapis.com/css2"]').getAttribute("media")).toBe("all");
    expect(csp).toEqual([]);
  });
});

