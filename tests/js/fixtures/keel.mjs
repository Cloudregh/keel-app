// Shared fixtures: an isolated, deterministic Keel page with no paid AI calls.
//  - Fresh browser context per test (separate localStorage/IndexedDB).
//  - window.claude is replaced by a mock: `sample` answers from recorded responses, `db`/`user` are absent
//    (so the app runs in "saved in this browser" mode). No request ever reaches a real model.
//  - Requests to the real tracker port are blocked unless a test passes its own fake tracker.
//  - Google Fonts are blocked so tests don't depend on the network.
import { test as base, expect } from "@playwright/test";
import { TRACKER, guardTracker } from "./tracker-guard.mjs";
import { appendFileSync, mkdirSync } from "node:fs";

// Fixed "now" for deterministic logic tests: Tue 10 Nov 2026, 10:00 in Africa/Accra (UTC+0).
export const NOW = new Date("2026-11-10T10:00:00Z");

export const RECORDED_COACH = [
  "You logged 2h 10m of focus across 3 sessions, close to your 3h goal. Breaks were short and regular.\n\nYour longest stretch was 55m, which is healthy.\n\nTomorrow, start with “Write proposal” in your first focus block."
];

export const test = base.extend({
  fixedTime: [NOW, { option: true }],          // Date to freeze, or null for the real clock
  aiMode: ["off", { option: true }],           // "off" (default: no AI at all) | "mock" (recorded responses)
  coachResponses: [RECORDED_COACH, { option: true }],
  keel: async ({ page, aiMode, coachResponses, fixedTime, browserName }, use, testInfo) => {
    const calls = [];
    const coverage = process.env.KEEL_COVERAGE === "1" && browserName === "chromium";
    if (fixedTime) await page.clock.setFixedTime(fixedTime);
    if (coverage) await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await page.exposeFunction("__keelRecordSample", prompt => { calls.push(prompt); });
    await page.addInitScript(({ aiMode, coachResponses }) => {
      if (aiMode !== "mock") return;
      let i = 0;
      const sample = async (prompt, opts = {}) => {
        window.__keelRecordSample(String(typeof prompt === "string" ? prompt : JSON.stringify(prompt)));
        const text = coachResponses[i++ % coachResponses.length];
        if (opts.onText) opts.onText({ text, delta: text });
        return { text, truncated: false };
      };
      window.claude = { use: async name => (name === "sample" ? sample : null) };
    }, { aiMode, coachResponses });
    const realTracker = [];                         // tripwire: no test may ever reach a real tracker
    page.on("request", r => { if (/:47821\//.test(r.url())) realTracker.push(r.url()); });
    await guardTracker(page);
    await page.route(TRACKER, route => route.abort("blockedbyclient"));
    await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
    await page.goto("/index.html");
    await page.waitForFunction(() => typeof window.render === "function" || document.querySelector("#nav button"));
    await use({ page, aiCalls: calls, ev: (src, arg) => page.evaluate(`(${src})(${JSON.stringify(arg ?? null)})`) });
    expect(realTracker, "requests sent to the real tracker address").toEqual([]);
    if (coverage) {
      const entries = (await page.coverage.stopJSCoverage()).filter(e => e.url.endsWith("/index.html") && !e.url.includes("/fixtures/"));   // only the current app, not the previous-release fixture
      mkdirSync("coverage", { recursive: true });
      appendFileSync("coverage/js-v8.jsonl", JSON.stringify({ test: testInfo.title, entries }) + "\n");
    }
  }
});
export { expect };
