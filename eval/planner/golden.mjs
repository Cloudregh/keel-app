// Phase 9: records the evaluated model's outputs for a fixed set of inputs ("golden" predictions), in the same
// Chromium setup as the evaluation. tests/js/e2e/model-parity.spec.mjs checks every browser reproduces them.
//   node eval/planner/golden.mjs     writes tests/js/fixtures/data/golden-planner.json
import { chromium } from "@playwright/test";
import http from "node:http";
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { GOLDEN_SCRIPT } from "../../tests/js/fixtures/golden-inputs.mjs";

const ROOT = path.resolve(new URL("../../", import.meta.url).pathname);
const server = http.createServer((q, r) => { const f = path.join(ROOT, path.normalize(decodeURIComponent(new URL(q.url, "http://x").pathname))); if (!f.startsWith(ROOT) || !existsSync(f) || !statSync(f).isFile()) { r.writeHead(404).end(); return; } r.writeHead(200, { "content-type": f.endsWith(".html") ? "text/html" : "application/octet-stream" }).end(readFileSync(f)); });
await new Promise(res => server.listen(0, "127.0.0.1", res));
const browser = await chromium.launch(process.env.PW_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PW_CHROMIUM_EXECUTABLE } : {});
const ctx = await browser.newContext({ timezoneId: "Africa/Accra", locale: "en-GB", serviceWorkers: "block", bypassCSP: true });
await ctx.route(/fonts\.(googleapis|gstatic)\.com|:47821\//, r => r.abort());
const page = await ctx.newPage();
await page.clock.setFixedTime(new Date("2026-11-10T10:00:00Z"));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
await page.waitForFunction("typeof predictEffort === 'function'");
const effort = readFileSync(path.join(ROOT, "eval/data/effort-v1.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
const out = await page.evaluate(`(${GOLDEN_SCRIPT})(${JSON.stringify(effort)})`);
const html = readFileSync(path.join(ROOT, "index.html"), "utf8");
const golden = { app: createHash("sha256").update(html).digest("hex").slice(0, 12), plannerVersion: out.version, browser: browser.version(), ...out };
writeFileSync(path.join(ROOT, "tests/js/fixtures/data/golden-planner.json"), JSON.stringify(golden) + "\n");
console.log(`golden predictions: ${golden.effortCold.length} effort (cold) + ${golden.effortWarm.length} (after corrections), ${golden.durations.length} durations, ${golden.plans.length} plans · app ${golden.app}`);
await browser.close(); server.close();
