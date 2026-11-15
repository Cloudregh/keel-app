// Phase 5: end-to-end journeys (J1–J12, J14 from docs/test-strategy.md), happy paths plus realistic failures.
// Runs in Chromium, Firefox and WebKit. Each test starts from an empty browser profile with the clock frozen at
// Tue 10 Nov 2026 10:00 (Africa/Accra). Selectors use roles and the app's data-act/data-view attributes.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "../fixtures/keel.mjs";
import { TRACKER, cors, preflight } from "../fixtures/tracker-guard.mjs";

const nav = (page, view) => page.locator(`#nav [data-view="${view}"]`).click();
async function addTask(page, text) {
  await page.locator("#qa-input").fill(text);
  await page.locator("#qa-input").press("Enter");
}
const STATUS = { app: "keel-tracker", version: 2, running: true, paused: false, pausedUntil: null, startedAt: 1, current: { app: "Code", domain: "" }, idle: false, todayMs: 1800000, device: "Mac", now: 1, storage: { fileBytes: 2048, logBytes: 10, keepDays: 30, maxFileMb: 20, days: 1, lastCleanup: null } };
const ACTIVITY = { source: "keel-tracker", version: 2, device: "Mac", updatedAt: 1, days: { "2026-11-10": [
  { s: Date.UTC(2026, 10, 10, 8), e: Date.UTC(2026, 10, 10, 8, 40), app: "Code" },
  { s: Date.UTC(2026, 10, 10, 8, 40), e: Date.UTC(2026, 10, 10, 9), app: "Google Chrome", domain: "youtube.com", title: "Music" },
  { s: Date.UTC(2026, 10, 10, 9), e: Date.UTC(2026, 10, 10, 9, 30), app: "Figma" }] } };
async function fakeTracker(page, { status = STATUS, activity = ACTIVITY, delay = 0, fail = null } = {}) {
  const posts = [];
  await page.unroute(TRACKER);
  await page.route(TRACKER, async route => {
    if (await preflight(route)) return;
    if (delay) await new Promise(r => setTimeout(r, delay));
    if (fail === "down") return route.abort("connectionrefused");
    if (fail === "500") return route.fulfill({ headers: cors(route.request()), status: 500, contentType: "application/json", body: '{"error":"boom"}' });
    const req = route.request(), url = req.url();
    if (req.method() === "POST") { posts.push(new URL(url).pathname); const paused = url.endsWith("/pause"); status = { ...status, paused, pausedUntil: paused ? Date.UTC(2026, 10, 10, 11) : null }; return route.fulfill({ headers: cors(route.request()), contentType: "application/json", body: JSON.stringify({ ...status, removedDays: 0 }) }); }
    return route.fulfill({ headers: cors(route.request()), contentType: "application/json", body: JSON.stringify(url.includes("/activity") ? activity : status) });
  });
  return posts;
}

test.describe("J1 tasks", () => {
  test("add with shortcuts, edit, add a step, complete, find in Completed, delete", async ({ keel: { page } }) => {
    await nav(page, "tasks");
    await addTask(page, "Write proposal #work !high today 45m");
    await addTask(page, "Reply to emails today 15m");
    await expect(page.locator(".task")).toHaveCount(2);
    const row = page.locator(".task", { hasText: "Write proposal" });
    await expect(row).toContainText("Work");
    await expect(row).toContainText("High");
    await row.locator('[data-act="expand"]').click();
    await page.locator("#ed-title").fill("Write Q4 proposal");
    await page.locator("#ed-title").press("Tab");
    await page.locator("#sub-new").fill("Outline sections");
    await page.locator("#sub-new").press("Enter");
    await expect(page.locator(".subtask")).toContainText("Outline sections");
    await page.locator('.editor [data-act="expand"]').click();
    await expect(page.locator(".task", { hasText: "Write Q4 proposal" })).toContainText("0/1 steps");
    await page.locator(".task", { hasText: "Write Q4 proposal" }).getByRole("checkbox").first().click();
    await expect(page.locator("#toasts")).toContainText("Completed");
    await page.locator('[data-act="task-filter"][data-f="done"]').click();
    await expect(page.locator(".task")).toHaveCount(1);
    await page.locator('.task [data-act="expand"]').click();
    await page.locator('[data-act="del-task"]').click();
    await page.locator('.modal [data-act="confirm-yes"]').click();
    await expect(page.locator(".empty")).toContainText("No completed tasks yet");
  });
  test("failure: empty quick-add is refused with a message", async ({ keel: { page } }) => {
    await nav(page, "tasks");
    await addTask(page, "   ");
    await expect(page.locator("#toasts")).toContainText("Give the task a name first");
    await expect(page.locator(".task")).toHaveCount(0);
  });
  test("empty state guides the user", async ({ keel: { page } }) => {
    await nav(page, "tasks");
    await expect(page.locator(".empty")).toContainText("You're clear for today");
  });
});

test.describe("J2 timer", () => {
  test("pomodoro on a task: start, pause, resume, finish early → logged", async ({ keel: { page, ev } }) => {
    await nav(page, "tasks");
    await addTask(page, "Read chapter today 30m");
    await nav(page, "focus");
    await page.locator('select[data-change="focus-task"]').selectOption({ label: "Read chapter" });
    await page.locator('[data-act="focus-start"]').click();
    await expect(page.locator("#tracker")).toContainText("Focus session");
    await ev(`() => { state.active.start -= 12 * MIN; }`);
    await page.locator('.controls [data-act="pause"]').click();
    await expect(page.locator(".ring .lbl")).toHaveText("Paused");
    await page.locator('.controls [data-act="pause"]').click();
    await page.locator('.controls [data-act="finish"]').click();
    await expect(page.locator("#toasts")).toContainText("Logged 12m of focus");
    await expect(page.locator(".session-list").last()).toContainText("Read chapter");
  });
  test("failure: finishing under 30 seconds logs nothing and says why", async ({ keel: { page } }) => {
    await page.keyboard.press("s");
    await page.keyboard.press("s");
    await expect(page.locator("#toasts")).toContainText("under 30 seconds");
  });
  test("discard asks first and logs nothing", async ({ keel: { page, ev } }) => {
    await nav(page, "focus");
    await page.locator('[data-act="focus-mode"][data-m="open"]').click();
    await page.locator('[data-act="focus-start"]').click();
    await ev(`() => { state.active.start -= 5 * MIN; }`);
    await page.locator('.controls [data-act="discard"]').click();
    await page.getByRole("button", { name: "Discard" }).last().click();
    expect(await ev(`() => [state.active, state.entries.length]`)).toEqual([null, 0]);
  });
});

test.describe("J3 dashboard", () => {
  test("calendar shows logged time; clicking an empty slot logs time there; day navigation", async ({ keel: { page, ev } }) => {
    await ev(`() => { state.entries.push({ id: "e1", type: "focus", start: dayStart(todayKey()) + 8 * HOUR, end: dayStart(todayKey()) + 9 * HOUR, dur: HOUR, projectId: "p_work", note: "Deep work" }); render(); }`);
    await nav(page, "today");
    await expect(page.locator(".cal .cb").first()).toContainText("Deep work");
    await expect(page.locator(".rail")).toContainText("1hr");
    const col = page.locator('.cal-col[data-act="cal-add"]');
    const h0 = Number(await col.getAttribute("data-h0"));
    const calH = await ev(`() => CAL_H`);
    // The calendar sits in its own scroll area; locator.click scrolls the spot into view first.
    await col.click({ position: { x: 20, y: (9.25 - h0) * calH + 2 } });   // 09:15, empty and in the past
    await expect(page.locator(".modal")).toContainText("Log time");
    await expect(page.locator('[data-dp="entry-start"] .dp-btn')).toContainText("9:15 AM");
    await page.locator(".modal button.primary").click();
    expect(await ev(`() => state.entries.length`)).toBe(2);
    await page.locator('[data-act="dash-day"][data-d="-1"]').click();
    await expect(page.locator(".dash-head h1")).toContainText("9 November");
    await page.locator('[data-act="dash-today"]').click();
    await expect(page.locator(".today-pill")).toBeVisible();
  });
  test("failure: clicking a future slot explains it can't be logged", async ({ keel: { page } }) => {
    await nav(page, "today");
    const col = page.locator('.cal-col[data-act="cal-add"]');
    const box = await col.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 10);
    await expect(page.locator("#toasts")).toContainText("hasn't happened yet");
  });
});

test.describe("J4 plan my day", () => {
  test("suggest an order, move a task, not today, add to calendar", async ({ keel: { page } }) => {
    await nav(page, "tasks");
    for (const t of ["Write report !high today 60m", "Reply emails today 15m", "Pay bill today", "Design slides today 45m"]) await addTask(page, t);
    await page.locator('[data-act="plan-build"]').first().click();
    const rows = page.locator(".pl-row:not(.brk)");
    await expect(rows).toHaveCount(4);
    const second = await rows.nth(1).locator(".pl-title b").innerText();
    await rows.nth(1).locator('[data-act="plan-move"][data-d="-1"]').click();
    await expect(rows.nth(0).locator(".pl-title b")).toHaveText(second);
    const skipped = await rows.nth(3).locator(".pl-title b").innerText();
    await rows.nth(3).locator('[data-act="plan-skip"]').click();
    await expect(page.locator("#toasts")).toContainText("Moved out of today's plan");
    await expect(page.locator(".pl-row:not(.brk) .pl-title b")).not.toContainText([skipped]);
    await page.locator('[data-act="plan-accept"]').click();
    await nav(page, "today");
    await expect(page.locator(".cb.plan").first()).toBeVisible();
    await expect(page.locator(".rail")).toContainText("Up next");
  });
});

test.describe("J5–J6 tracker", () => {
  test("live activity appears; pause and resume from the sidebar", async ({ keel: { page, ev } }) => {
    const posts = await fakeTracker(page);
    await ev(`() => trPoll(true)`);
    await expect(page.locator("#trk")).toContainText("Tracking apps");
    await nav(page, "apps");
    await expect(page.locator(".apps-tbl")).toContainText("Code");
    await expect(page.locator(".apps-tbl")).toContainText("youtube.com");
    await page.locator('#trk [data-act="tr-menu"]').click();
    await page.locator('#trk [data-act="tr-pause"][data-min="15"]').click();
    await expect(page.locator("#trk")).toContainText("App tracking paused");
    await page.locator('#trk [data-act="tr-resume"]').click();
    await expect(page.locator("#trk")).toContainText("Tracking apps");
    expect(posts).toEqual(["/schedule", "/pause", "/resume"]);   // the notification schedule goes first (since 2026-11-15)
  });
  test("failures: tracker down, server error, slow but alive, too slow", async ({ keel: { page, ev } }) => {
    await fakeTracker(page, { fail: "down" });
    await ev(`() => trPoll(false)`);
    await expect(page.locator("#trk")).toContainText("Not running on this computer");
    await fakeTracker(page, { fail: "500" });
    await ev(`() => trPoll(false)`);
    await expect(page.locator("#trk")).toContainText("Tracker not connected");
    await fakeTracker(page, { delay: 1500 });
    await ev(`() => trPoll(true)`);
    await expect(page.locator("#trk")).toContainText("Tracking apps");
    await page.clock.install({ time: new Date("2026-11-10T10:00:00Z") });
    await fakeTracker(page, { delay: 60_000 });
    const p = ev(`() => trPoll(false).then(() => TR.state)`);
    await page.clock.runFor(3500);
    expect(await p).toBe("offline");
  });
});

test.describe("J7 categories", () => {
  test("recategorise an app and link a site to a project", async ({ keel: { page } }) => {
    await nav(page, "apps");
    await page.setInputFiles("#act-file", "tests/js/fixtures/data/activity-2026-11-10.json");
    await page.locator('select[data-change="act-cat"][data-key="d:youtube.com"]').selectOption("docs");
    await page.locator('select[data-change="act-proj"][data-key="a:Figma"]').selectOption("p_work");
    await expect(page.locator(".kpis")).toContainText("0m");                          // nothing distracting left
    await expect(page.locator("#view")).toContainText("By project");
    await expect(page.locator('[data-act="act-reset-rules"]')).toHaveText("Reset 2 custom rules");
  });
});

test.describe("J8 reports", () => {
  test("ranges, chart, table and CSV copy", async ({ keel: { page, ev } }) => {
    await ev(`() => { for (let d = 0; d < 5; d++) state.entries.push({ id: "e" + d, type: "focus", start: dayStart(addDays(todayKey(), -d)) + 9 * HOUR, end: dayStart(addDays(todayKey(), -d)) + 10 * HOUR, dur: HOUR, projectId: "p_work", note: d ? "" : "has, comma" }); render(); }`);
    await nav(page, "reports");
    await page.locator('[data-act="range"][data-r="14d"]').click();
    await expect(page.locator(".cols .col")).toHaveCount(14);
    await expect(page.locator(".kpis")).toContainText("5h");
    let csv = null;
    await page.exposeFunction("__grab", t => { csv = t; });
    await page.evaluate(() => { navigator.clipboard.writeText = async t => window.__grab(t); });
    await page.locator('[data-act="copy-csv"]').click();
    await expect.poll(() => csv).not.toBeNull();
    const lines = csv.split("\n");
    expect(lines[0]).toBe("Date,Start,End,Minutes,Type,Project,Task,Note");
    expect(lines).toHaveLength(6);
    expect(csv).toContain('"has, comma"');
  });
  test("empty range says so", async ({ keel: { page } }) => {
    await nav(page, "reports");
    await expect(page.locator(".empty")).toContainText("No tracked time in this range");
  });
});

test.describe("J9 storage cleanup", () => {
  test("retention setting and Clean up now", async ({ keel: { page, ev } }) => {
    await ev(`() => { for (let d = 0; d < 40; d++) act[addDays(todayKey(), -d)] = [{ s: 1, e: 5000, app: "A" }]; saveAct(); render(); }`);
    await nav(page, "settings");
    await page.locator('select[data-change="setting"][data-f="actKeepDays"]').selectOption("7");
    expect(await ev(`() => Object.keys(act).length`)).toBe(8);
    await page.locator('[data-act="clean-now"]').click();
    await expect(page.locator("#toasts")).toContainText(/Nothing to clean up|Cleaned up/);
  });
});

test.describe("J10 backup, restore, erase", () => {
  test("back up, erase, restore", async ({ keel: { page, ev } }) => {
    await nav(page, "tasks");
    await addTask(page, "Keep me safe today");
    let copied = null;
    await page.exposeFunction("__grab2", t => { copied = t; });
    await page.evaluate(() => { navigator.clipboard.writeText = async t => window.__grab2(t); });
    await nav(page, "settings");
    await page.locator('[data-act="export"]').click();
    await expect.poll(() => copied).not.toBeNull();
    await page.locator('[data-act="reset"]').click();
    await page.locator('.modal [data-act="confirm-yes"]').click();
    expect(await ev(`() => state.tasks.length`)).toBe(0);
    await page.locator('[data-act="import"]').click();
    await page.locator('.modal textarea[name="j"]').fill(copied);
    await page.locator(".modal button.primary").click();
    await expect(page.locator("#toasts")).toContainText("Backup restored");
    expect(await ev(`() => state.tasks.map(t => t.title)`)).toEqual(["Keep me safe"]);
  });
  test("failure: clipboard blocked → a copy box appears instead", async ({ keel: { page } }) => {
    await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error("denied"); }; });
    await nav(page, "settings");
    await page.locator('[data-act="export"]').click();
    await expect(page.locator(".modal textarea")).toHaveValue(/"tasks"/);
  });
});

test.describe("J11 install & offline", () => {
  test.use({ serviceWorkers: "allow" });            // the one place the service worker is under test
  // Real network loss: the app is served by a server this test owns, which is shut down after the first visit.
  // (Playwright's setOffline uses Firefox's "work offline" mode, which refuses navigations before the service
  // worker can answer them; a server that has really gone away behaves the same in every browser.)
  test("the app works offline after the first visit", async ({ keel: { page } }) => {
    const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml" };
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/$/, "/index.html");
      const file = path.join(process.cwd(), path.normalize(rel));
      if (!file.startsWith(process.cwd()) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" }).end(fs.readFileSync(file));
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${server.address().port}/`;
    await page.clock.uninstall?.();
    await page.goto(url);
    await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller !== null, null, { timeout: 15_000 })
      .catch(async () => { await page.reload(); await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15_000 }); });
    await new Promise(r => { server.close(r); server.closeAllConnections(); });
    expect(await page.request.get(url).then(() => "reachable", () => "gone"), "the server is really down").toBe("gone");
    await page.reload();
    await expect(page.locator("#nav button")).toHaveCount(8);
    await page.locator('#nav [data-view="tasks"]').click();
    await expect(page.locator(".view-h, h1").first()).toBeVisible();
  });
  test("manifest is valid for installing", async ({ request }) => {
    const r = await request.get("/manifest.json");
    expect(r.ok()).toBe(true);
    const m = await r.json();
    expect(m).toMatchObject({ name: expect.any(String), short_name: "Keel", display: "standalone", start_url: "./" });
    expect(m.icons.length).toBeGreaterThan(0);
  });
});

test.describe("J12 import activity file", () => {
  test("import a tracker file; a wrong file is refused with directions", async ({ keel: { page } }) => {
    await nav(page, "apps");
    await expect(page.locator("#view")).toContainText("Connect the tracker on your Mac");
    await page.setInputFiles("#act-file", { name: "notes.json", mimeType: "application/json", buffer: Buffer.from('{"hello":1}') });
    await expect(page.locator("#toasts")).toContainText("isn't a Keel activity file");
    await page.setInputFiles("#act-file", "tests/js/fixtures/data/activity-2026-11-10.json");
    await expect(page.locator("#toasts")).toContainText("Imported 1 day");
    await expect(page.locator(".apps-tbl tbody tr")).toHaveCount(5);
  });
});

test.describe("J14 settings", () => {
  test("goal, theme, timer length and chronotype take effect", async ({ keel: { page, ev } }) => {
    await nav(page, "settings");
    await page.locator("#set-dailyGoalMin").fill("120");
    await page.locator("#set-dailyGoalMin").press("Tab");
    await page.locator("#set-focusMin").fill("50");
    await page.locator("#set-focusMin").press("Tab");
    await page.locator('select[data-change="setting"][data-f="theme"]').selectOption("light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.locator('select[data-change="chrono"]').selectOption("evening");
    expect(await ev(`() => mlState().chrono`)).toBe("evening");
    await nav(page, "today");
    await expect(page.locator(".rail")).toContainText("of 2h goal");
    await nav(page, "focus");
    await expect(page.locator('[data-act="focus-start"]')).toContainText("Start 50-min focus");
  });
});
