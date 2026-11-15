/* global COACH_TIMEOUT -- an app global, read inside page.evaluate */
// Phase 12: how the Daily coach behaves when the AI provider is slow, hangs or rate-limits.
// Recorded real latency (docs/performance.md): p50 2.3 s, p95 3.1 s, p99 7.6 s, worst 38 s over 1,266 requests.
// The provider is a scripted mock; no AI call is made.
import { test, expect } from "../fixtures/keel.mjs";

async function withProvider(page, mode, firstTokenMs = 0) {
  await page.addInitScript(([mode, firstTokenMs]) => {
    window.__coachCalls = 0;
    const sample = (prompt, opts = {}) => new Promise((resolve, reject) => {
      window.__coachCalls++;
      if (opts.signal) opts.signal.addEventListener("abort", () => reject({ code: "aborted", message: "stopped" }));
      if (mode === "rate_limited") return reject({ code: "rate_limited", message: "slow down" });
      if (mode === "hang") return;                                  // never answers, never fails
      const text = "You focused for 2h. Breaks were regular. Tomorrow, start with the proposal.";
      setTimeout(() => { if (opts.onText) opts.onText({ text, delta: text }); resolve({ text, truncated: false }); }, firstTokenMs);
    });
    window.claude = { use: async n => (n === "sample" ? sample : null) };
  }, [mode, firstTokenMs]);
  await page.clock.setFixedTime(new Date("2026-11-10T18:00:00Z"));
  await page.reload();
  await page.locator('#nav [data-view="today"]').click();
  await page.evaluate(() => {
    window.__long = [];
    new PerformanceObserver(l => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ type: "longtask" });
  });
}
const review = page => page.locator('#ai-panel [data-act="ai"]').click();

test("slow provider (8 s to answer): 'Thinking…' with Stop, the rest of the app keeps working, then the answer shows", async ({ keel: { page } }) => {
  test.setTimeout(30_000);
  await withProvider(page, "slow", 8000);
  await review(page);
  await expect(page.locator("#ai-out")).toHaveText("Thinking…");
  await expect(page.locator('#ai-panel [data-act="ai-stop"]')).toBeVisible();
  // While waiting the app stays usable: switch views and come back; the review is still in progress.
  await page.locator('#nav [data-view="tasks"]').click();
  await expect(page.locator("#view [data-act='toggle-task'], #view").first()).toBeVisible();
  await page.locator('#nav [data-view="today"]').click();
  await expect(page.locator("#ai-out")).toHaveText("Thinking…");
  await expect(page.locator("#ai-out")).toContainText("Tomorrow", { timeout: 12_000 });
  await expect(page.locator('#ai-panel [data-act="ai"]')).toBeEnabled();
  expect(Math.max(0, ...await page.evaluate(() => window.__long)), "longest main-thread task while waiting (ms)").toBeLessThan(200);
  expect(await page.evaluate(() => window.__coachCalls)).toBe(1);
});

test("rate-limited provider: every press gets a clear message, nothing retries on its own, the daily cap bounds attempts", async ({ keel: { page } }) => {
  await withProvider(page, "rate_limited");
  for (let i = 1; i <= 3; i++) {
    await review(page);
    await expect(page.locator("#ai-out")).toHaveText("The coach is busy right now. Try again in a minute.");
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__coachCalls)).toBe(i);           // no automatic retries (no retry storm)
  }
  for (let i = 4; i <= 20; i++) { await review(page); await expect.poll(() => page.evaluate(() => window.__coachCalls)).toBe(i); }
  await review(page);                                                           // the 21st press of the day
  await expect(page.locator("#ai-panel")).toContainText("daily limit");
  expect(await page.evaluate(() => window.__coachCalls)).toBe(20);
});

// Fix 63: the coach watches for silence. 20 s with no text adds a "taking longer than usual" note; 90 s with no text
// stops the request, says so, and doesn't count it toward the day. (Before the fix: "Thinking…" forever.)
test("fix 63: the shipped timings are 20 s for the note and 90 s to stop", async ({ keel: { page } }) => {
  expect(await page.evaluate(() => ({ ...COACH_TIMEOUT }))).toEqual({ slowMs: 20_000, stopMs: 90_000 });
});

test("fix 63: a hung provider gets the 'longer than usual' note, then is stopped with a retry message that doesn't use up the day", async ({ keel: { page } }) => {
  test.setTimeout(60_000);
  await withProvider(page, "hang");
  await page.evaluate(() => { COACH_TIMEOUT.slowMs = 2000; COACH_TIMEOUT.stopMs = 5000; });            // the same logic, faster
  await review(page);
  await expect(page.locator("#ai-out")).toHaveText("Thinking…");
  await expect(page.locator("#ai-panel")).not.toContainText("longer than usual");
  await expect(page.locator("#ai-panel")).toContainText("This is taking longer than usual. You can stop and try again.", { timeout: 4000 });
  await expect(page.locator('#ai-panel [data-act="ai-stop"]')).toBeVisible();
  await expect(page.locator("#ai-out")).toHaveText("The coach didn't answer in time, so the review was stopped. Press Review my day to try again.", { timeout: 6000 });
  await expect(page.locator('#ai-panel [data-act="ai"]')).toBeEnabled();
  await expect(page.locator('#ai-panel [data-act="ai-stop"]')).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("keel.ai.v1")).count)).toBe(0);    // a timed-out request isn't counted
  await review(page);                                                                                    // and the next review can start at once
  expect(await page.evaluate(() => window.__coachCalls)).toBe(2);
});

test("fix 63: text that keeps arriving is never cut off, and the note goes away once text arrives", async ({ keel: { page } }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    window.__coachCalls = 0;
    const sample = (prompt, opts = {}) => new Promise(resolve => {
      window.__coachCalls++;
      let n = 0, text = "";
      const tick = () => { n++; text += "Word " + n + ". "; opts.onText && opts.onText({ text, delta: "" }); if (n < 8) setTimeout(tick, 1000); else resolve({ text, truncated: false }); };
      setTimeout(tick, 2600);                                                                            // first text after the 2 s note
    });
    window.claude = { use: async n => (n === "sample" ? sample : null) };
  });
  await page.clock.setFixedTime(new Date("2026-11-10T18:00:00Z"));
  await page.reload();
  await page.locator('#nav [data-view="today"]').click();
  await page.evaluate(() => { COACH_TIMEOUT.slowMs = 2000; COACH_TIMEOUT.stopMs = 5000; });
  await review(page);
  await expect(page.locator("#ai-panel")).toContainText("longer than usual", { timeout: 4000 });
  await expect(page.locator("#ai-out")).toContainText("Word 1.", { timeout: 4000 });
  await expect(page.locator("#ai-panel")).not.toContainText("longer than usual");
  await expect(page.locator("#ai-out")).toContainText("Word 8.", { timeout: 12_000 });                 // 10.6 s in total, longer than stopMs
  await expect(page.locator("#ai-out")).not.toContainText("didn't answer in time");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("keel.ai.v1")).count)).toBe(1);
});
