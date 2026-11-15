// Phase 13: nothing private reaches the browser console. Keel itself has no console.* calls (searched in
// docs/resilience.md); this checks what the browser prints during a session that touches private data and fails:
// tasks, a focus session, live tracker activity, the tracker going down, and a coach review.
import { test, expect } from "../fixtures/keel.mjs";
import { TRACKER, cors, preflight } from "../fixtures/tracker-guard.mjs";

test.use({ aiMode: "mock" });
const PLANTED = ["Planted lawyer call", "Planted diagnosis for Jane Doe", "planted-bank.example", "PlantedSecretApp", "sk-planted-0000-token"];

test("the browser console and page errors contain none of the user's data", async ({ keel: { page, ev } }) => {
  const logs = [];
  page.on("console", m => logs.push(`${m.type()}: ${m.text()} ${JSON.stringify(m.location())}`));
  page.on("pageerror", e => logs.push(`pageerror: ${e.message}\n${e.stack}`));
  page.on("requestfailed", r => logs.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  let mode = "ok";
  const day = "2026-11-10";
  const activity = { source: "keel-tracker", version: 2, device: "Mac", updatedAt: 1, days: { [day]: [
    { s: Date.UTC(2026, 10, 10, 8), e: Date.UTC(2026, 10, 10, 8, 40), app: "PlantedSecretApp" },
    { s: Date.UTC(2026, 10, 10, 8, 40), e: Date.UTC(2026, 10, 10, 9), app: "Safari", domain: "planted-bank.example", title: "Planted diagnosis for Jane Doe sk-planted-0000-token" }] } };
  const status = { app: "keel-tracker", version: 2, running: true, paused: false, current: { app: "PlantedSecretApp", domain: "planted-bank.example" }, idle: false, todayMs: 1, device: "Mac", now: 1, storage: {} };
  await page.unroute(TRACKER);
  await page.route(TRACKER, async route => {
    if (await preflight(route)) return;
    if (mode === "down") return route.abort("connectionrefused");
    if (mode === "500") return route.fulfill({ status: 500, headers: cors(route.request()), contentType: "application/json", body: '{"error":"Planted diagnosis for Jane Doe"}' });
    return route.fulfill({ headers: cors(route.request()), contentType: "application/json", body: JSON.stringify(route.request().url().includes("/activity") ? activity : status) });
  });

  await page.locator('#nav [data-view="tasks"]').click();
  await page.locator("#qa-input").fill("Planted lawyer call #work today 30m");
  await page.locator("#qa-input").press("Enter");
  await expect(page.locator(".task")).toContainText("Planted lawyer call");
  await ev(`() => trPoll(true)`);
  await page.locator('#nav [data-view="apps"]').click();
  await expect(page.locator("#view")).toContainText("planted-bank.example");
  mode = "500"; await ev(`() => trPoll(true)`);
  mode = "down"; await ev(`() => trPoll(true)`);
  await expect(page.locator("#trk")).toContainText("Tracker not connected");
  await page.locator('#nav [data-view="today"]').click();
  await page.locator('[data-act="ai"]').first().click();
  await expect(page.locator("#ai-out")).not.toBeEmpty();

  const all = logs.join("\n");
  expect(logs.length, "the session did produce browser messages to search").toBeGreaterThan(0);
  for (const p of PLANTED) expect(all, `"${p}" appeared in the console:\n${all}`).not.toContain(p);
});
