// Safari (2026-11-23): Safari won't let the https website reach Keel Tracker at http://127.0.0.1, so Keel Tracker
// also serves Keel there. In Safari the website offers "Open Keel on this Mac"; the local copy says it's ready, the
// website hands it a backup inside the browser, and the local copy restores it only after the user agrees.
// Runs in Chromium posing as Safari: both sites are served from this repository's index.html by page routing (the
// website at its real https address, the local copy at 127.0.0.1:47821), so the tested code is exactly what ships.
// The tracker API stays fake (guardTracker); the real tracker serving these files is covered by tests/py/test_web.py.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { TRACKER, guardTracker, cors } from "../fixtures/tracker-guard.mjs";

const WEB = "https://keel-app-five.vercel.app", LOCAL = "http://127.0.0.1:47821";
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15";
const PAGE = readFileSync(new URL("../../../index.html", import.meta.url));
const html = { status: 200, contentType: "text/html; charset=utf-8", body: PAGE };

test.use({ userAgent: SAFARI, serviceWorkers: "block", timezoneId: "Africa/Accra" });

async function setup(context) {
  await context.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" }));   // a Mac
  await guardTracker(context);
  await context.route(TRACKER, r => r.request().url().endsWith("/status")
    ? r.fulfill({ status: 200, contentType: "application/json", headers: cors(r.request()), body: JSON.stringify({ app: "keel-tracker", version: "1.0.0", paused: false, now: Date.now(), allowed: true, storage: { fileBytes: 0, keepDays: 90 } }) })
    : r.fulfill({ status: 200, contentType: "application/json", headers: cors(r.request()), body: JSON.stringify({ days: {} }) }));
  await context.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await context.route(u => u.origin === WEB && (u.pathname === "/" || u.pathname === "/index.html"), r => r.fulfill(html));
  await context.route(u => u.origin === LOCAL && (u.pathname === "/" || u.pathname === "/index.html"), r => r.fulfill(html));
  await context.route(u => [WEB, LOCAL].includes(u.origin) && /\.(json|svg)$/.test(u.pathname), r => r.fulfill({ status: 404, body: "" }));
}
const seedWebsite = `() => { localStorage.clear(); state = normalize(null);
  state.tasks.push({ id: "t1", title: "Write proposal", projectId: null, priority: 2, due: null, estimate: 45, done: false, notes: "", subtasks: [], created: Date.now() });
  state.tasks.push({ id: "t2", title: "Email Ama", projectId: null, priority: 1, due: null, estimate: 10, done: false, notes: "", subtasks: [], created: Date.now() });
  const st = Date.now() - 3 * 3600e3; state.entries.push({ id: "e1", type: "focus", start: st, end: st + 3600e3, dur: 3600e3, projectId: null, note: "" });
  act = { "2026-11-20": [{ s: 0, e: 600000, app: "Code" }] }; save(); saveAct(); ui.view = "apps"; render(); }`;

async function openFromWebsite(page, context) {
  await page.goto(`${WEB}/`);
  await page.evaluate(`(${seedWebsite})()`);                                       // has app activity: the Apps page shows it
  const [local] = await Promise.all([context.waitForEvent("page"), page.locator("#view").getByRole("button", { name: "Open Keel on this Mac" }).click()]);
  await local.waitForLoadState();
  expect(new URL(local.url()).origin).toBe(LOCAL);
  return local;
}

test("Safari: the website hands its data to Keel on this Mac after the user agrees", async ({ page, context }) => {
  await setup(context);
  const local = await openFromWebsite(page, context);
  const dialog = local.getByRole("dialog");
  await expect(dialog).toContainText("Bring your Keel data to this Mac?");
  await expect(dialog).toContainText("keel-app-five.vercel.app has 2 tasks, 1 time entry and 1 day of app activity");
  await expect(dialog).toContainText("Keel on this Mac is empty, so nothing is lost.");
  expect(local.url()).toBe(`${LOCAL}/`);                                         // the #from= hint is cleared
  expect(await local.evaluate("state.tasks.length")).toBe(0);                // nothing changes before the user agrees
  await dialog.getByRole("button", { name: "Bring it over" }).click();
  await expect(local.locator(".toast")).toContainText("Your data is here now");
  expect(await local.evaluate("({ tasks: state.tasks.map(t => t.title), entries: state.entries.length, act: Object.keys(act) })"))
    .toEqual({ tasks: ["Write proposal", "Email Ama"], entries: 1, act: ["2026-11-20"] });
  expect(await local.evaluate('JSON.parse(localStorage.getItem(LS_KEY) || "{}").tasks?.length')).toBe(2);   // saved, not just in memory
  await expect(page.locator(".toast")).toContainText("Your data is now in Keel on this Mac");
  // The local copy connects to the tracker by itself.
  await expect.poll(() => local.evaluate("TR.state")).toBe("online");
});

test("Safari: 'Not now' changes nothing on this Mac and tells the website", async ({ page, context }) => {
  await setup(context);
  const local = await openFromWebsite(page, context);
  await local.getByRole("dialog").getByRole("button", { name: "Not now" }).click();
  await expect(local.getByRole("dialog")).toHaveCount(0);
  expect(await local.evaluate("state.tasks.length")).toBe(0);
  await expect(page.locator(".toast")).toContainText("Nothing was moved");
});

test("Safari: when this Mac already has data, the user is told it will be replaced", async ({ page, context }) => {
  await setup(context);
  const pre = await context.newPage();                                            // earlier use of Keel on this Mac
  await pre.goto(`${LOCAL}/`);
  await pre.evaluate(`(${"() => { state.tasks.push({ id: 'old', title: 'Old task', projectId: null, priority: 1, due: null, estimate: 0, done: false, notes: '', subtasks: [], created: Date.now() }); save(); }"})()`);
  await pre.close();
  const local = await openFromWebsite(page, context);
  await expect(local.getByRole("dialog")).toContainText("This replaces what's in Keel on this Mac now.");
});

test("an unknown site can't start the hand-over or push data into Keel on this Mac", async ({ page, context }) => {
  await setup(context);
  const EVIL = "https://evil.example";
  await context.route(u => u.origin === EVIL, r => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>x</title>" }));
  await page.goto(`${EVIL}/`);
  await page.evaluate(() => { window.got = []; addEventListener("message", e => window.got.push(e.data)); });
  const [local] = await Promise.all([context.waitForEvent("page"), page.evaluate(L => { window.w = window.open(`${L}/#from=${encodeURIComponent(location.origin)}`); }, LOCAL)]);
  await local.waitForLoadState();
  await local.waitForFunction('typeof render === "function"');
  // A site pretending to be the Keel website gets no "ready" message, and data it sends is ignored.
  await page.evaluate(L => window.w.postMessage({ type: "keel-data", backup: JSON.stringify({ tasks: [{ id: "x", title: "Injected" }], entries: [] }) }, L), LOCAL);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.got)).toEqual([]);
  await expect(local.getByRole("dialog")).toHaveCount(0);
  expect(await local.evaluate("state.tasks.length")).toBe(0);
});

test("the website ignores a 'ready' message from anywhere but Keel on this Mac", async ({ page, context }) => {
  await setup(context);
  await page.goto(`${WEB}/`);
  await page.evaluate(`(${seedWebsite})()`);
  // The "window" that sent the message is right in both cases; only the sender's origin differs.
  const sent = await page.evaluate(`(() => {
    const posted = []; window.postMessage = (d, o) => posted.push([d.type, o]);
    const ready = origin => { HANDOFF.win = window; HANDOFF.sent = false;
      dispatchEvent(new MessageEvent("message", { data: { type: "keel-ready" }, origin, source: window })); };
    ready("https://evil.example"); const evil = posted.length;
    ready("${LOCAL}");
    return { evil, local: posted };
  })()`);
  expect(sent.evil).toBe(0);                                                       // ignored: not Keel on this Mac
  expect(sent.local).toEqual([["keel-data", LOCAL]]);                              // control: the real one is answered, only to its origin
});

test("Safari, nothing tracked yet: the setup steps lead to Keel on this Mac instead of waiting for the tracker", async ({ page, context }) => {
  await setup(context);
  await page.goto(`${WEB}/`);
  await page.evaluate(`(${seedWebsite})(); act = {}; saveAct(); render();`);
  await expect(page.getByRole("heading", { name: "Turn on app tracking" })).toBeVisible();
  await expect(page.getByText("Safari doesn't let websites talk to apps on your Mac")).toBeVisible();
  await expect(page.getByText("Looking for Keel Tracker on this Mac")).toHaveCount(0);  // it can't find it from here
  await expect(page.locator("#view").getByRole("button", { name: "Open Keel on this Mac" })).toBeVisible();
  await page.evaluate(`ui.view = "today"; render();`);                             // the Dashboard's tracker card says the same
  await expect(page.locator(".trk")).toContainText("Safari can't reach it from this site");
  await expect(page.locator(".trk").getByRole("button", { name: "Open Keel on this Mac" })).toBeVisible();
  await expect(page.locator(".trk").getByRole("button", { name: "Check again" })).toHaveCount(0);
});

test("Chrome on the website: no Safari steps, Keel looks for the tracker directly", async ({ browser }) => {
  const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
  const context = await browser.newContext({ serviceWorkers: "block", userAgent: CHROME_MAC });
  await setup(context);
  const page = await context.newPage();
  await page.goto(`${WEB}/`);
  await page.evaluate(`(${seedWebsite})(); act = {}; saveAct(); render();`);
  await expect(page.getByRole("heading", { name: "Turn on app tracking" })).toBeVisible();
  await expect(page.getByText("Looking for Keel Tracker on this Mac")).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Keel on this Mac" })).toHaveCount(0);
  await context.close();
});
