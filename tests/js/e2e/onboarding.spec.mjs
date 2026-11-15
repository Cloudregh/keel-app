// Turning on app tracking without Terminal (owner's request, 2026-11-15). A new user on a Mac sees "Turn on app
// tracking": download Keel Tracker.app, open it (approving it once, since it isn't notarized), and Keel connects by
// itself, checking every 5 s while the setup screen is open. The Python route stays under "Advanced".
import { test, expect } from "../fixtures/keel.mjs";
import { TRACKER, cors, preflight } from "../fixtures/tracker-guard.mjs";

const NOW = new Date("2026-11-10T10:00:00Z");
const RELEASE = "https://github.com/Cloudregh/keel-app/releases/latest/download/Keel-Tracker.zip";
const STATUS = { app: "keel-tracker", version: 2, running: true, paused: false, current: { app: "Code", domain: "" }, idle: false, todayMs: 0, device: "Mac", now: 1, storage: {} };
const ACTIVITY = { source: "keel-tracker", version: 2, device: "Mac", updatedAt: 1, days: {} };

async function asNewUser(page, platform) {
  await page.clock.install({ time: NOW });
  await page.addInitScript(p => { Object.defineProperty(Navigator.prototype, "platform", { get: () => p }); }, platform);
  await page.evaluate(() => { localStorage.clear(); });
  await page.reload();
  await page.waitForFunction(() => typeof window.render === "function");
}
async function tracker(page) {
  const t = { up: false, hits: 0 };
  await page.unroute(TRACKER);
  await page.route(TRACKER, async route => {
    if (await preflight(route)) return;
    t.hits++;
    if (!t.up) return route.abort("connectionrefused");
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ headers: cors(route.request()), contentType: "application/json", body: path === "/schedule" ? '{"scheduled":0}' : JSON.stringify(path === "/activity" ? ACTIVITY : STATUS) });
  });
  return t;
}
async function advance(page, ms) { for (let t = 0; t < ms; t += 1000) { await page.clock.runFor(1000); await page.waitForTimeout(15); } }

test("a new Mac user sees 'Turn on app tracking' with a download, and Keel connects by itself once the app runs", async ({ keel: { page } }) => {
  const t = await tracker(page);
  await asNewUser(page, "MacIntel");
  await page.locator('#nav [data-view="apps"]').click();
  const setup = page.locator(".setup");
  await expect(setup.getByRole("heading", { name: "Turn on app tracking" })).toBeVisible();
  await expect(setup.getByRole("link", { name: "Download Keel Tracker" })).toHaveAttribute("href", RELEASE);
  await expect(setup).toContainText("Applications");
  await expect(setup).toContainText("Open Anyway");
  await expect(setup).toContainText(/starts by itself/i);
  await advance(page, 6000);
  await expect(setup).toContainText(/Looking for Keel Tracker/i);
  const before = t.hits;
  expect(before, "keeps checking while the setup screen is open").toBeGreaterThan(0);
  t.up = true;                                                                    // the user opened the app
  await advance(page, 6000);
  await expect(page.locator("#trk")).toContainText("Tracking apps");
  await expect(page.locator("#view")).toContainText(/Connected/);
});

test("the Python setup is still there under Advanced, and importing a file still works as a fallback", async ({ keel: { page } }) => {
  await tracker(page);
  await asNewUser(page, "MacIntel");
  await page.locator('#nav [data-view="apps"]').click();
  const setup = page.locator(".setup");
  await setup.getByText("Advanced: set it up with Python").click();
  await expect(setup).toContainText('python3 ~/"Keel Activity"/keel_tracker.py install');
  await expect(setup.getByRole("button", { name: "Import activity file" })).toBeVisible();
});

test("on Windows or Linux: says app tracking needs a Mac, offers no download", async ({ keel: { page } }) => {
  await tracker(page);
  await asNewUser(page, "Win32");
  await page.locator('#nav [data-view="apps"]').click();
  const setup = page.locator(".setup");
  await expect(setup).toContainText("App tracking works on macOS");
  await expect(setup.getByRole("link", { name: "Download Keel Tracker" })).toHaveCount(0);
});

test("a new user who never opens the setup screen isn't polled for a tracker", async ({ keel: { page } }) => {
  const t = await tracker(page);
  await asNewUser(page, "MacIntel");
  const start = t.hits;                                                           // one check at start-up is fine
  await advance(page, 120_000);
  expect(t.hits - start).toBe(0);
});
