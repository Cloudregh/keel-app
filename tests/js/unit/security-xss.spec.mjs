// Phase 6: XSS through every way untrusted text reaches Keel's HTML.
//  1. A backup file someone sends you (Settings → Restore): ids, titles, notes, project names, app rules, activity.
//  2. Web page titles and app names recorded by the tracker (any website controls its own <title>).
//  3. AI output is covered in tests/js/e2e/ai-ui.spec.mjs ("HTML in the answer is shown as text").
// After every screen, dialog and tooltip, nothing injected may run, and no event-handler attribute, script or
// iframe may have appeared in the page.
import { test, expect } from "../fixtures/keel.mjs";
import { TRACKER, cors, preflight } from "../fixtures/tracker-guard.mjs";

const VIEWS = ["today", "focus", "tasks", "timeline", "apps", "reports", "projects", "settings"];
const tag = n => `<img src=x onerror=__x("${n}")>`;                    // element injection
const brk = n => `x" onfocus="__x('${n}')" autofocus data-z="`;        // breaks out of a double-quoted attribute
const brk1 = n => `x' onfocus='__x("${n}")' autofocus data-z='`;       // ...and a single-quoted one

async function scan(page) {
  return page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll("*")) for (const a of el.attributes) if (/^on/i.test(a.name)) bad.push(`${el.tagName.toLowerCase()}[${a.name}]`);
    for (const el of document.querySelectorAll("iframe, object, embed, img[src='x']")) bad.push(el.tagName.toLowerCase());
    if (document.querySelectorAll("script").length !== window.__scripts) bad.push("script added");
    for (const el of document.querySelectorAll("[href], [src]")) if (/^\s*javascript:/i.test(el.getAttribute("href") || el.getAttribute("src") || "")) bad.push("javascript: url");
    return { bad: [...new Set(bad)], fired: [...window.__xss] };
  });
}

async function everyScreen(page, label) {
  const found = [];
  for (const v of VIEWS) {
    await page.evaluate(`ui.view = ${JSON.stringify(v)}; render();`);
    const tips = page.locator("[data-tip]");
    for (let i = 0, n = Math.min(await tips.count(), 40); i < n; i++) await tips.nth(i).hover({ force: true, timeout: 2000 }).catch(() => {});
    for (const act of ["edit-entry", "expand", "edit-task", "tr-menu"]) {
      const el = page.locator(`[data-act="${act}"]`).first();
      if (await el.count()) { await el.click({ force: true, timeout: 2000 }).catch(() => {}); }
    }
    const r = await scan(page);
    if (r.bad.length || r.fired.length) found.push({ where: `${label} · ${v}`, ...r });
    await page.keyboard.press("Escape");
  }
  return found;
}

async function arm(page) {
  await page.evaluate(() => { window.__xss = []; window.__x = n => window.__xss.push(n); window.__scripts = document.querySelectorAll("script").length; });
}

test("baseline: the app itself uses no inline event handlers", async ({ keel: { page } }) => {
  await arm(page);
  expect(await everyScreen(page, "baseline")).toEqual([]);
});

test("a malicious backup can't run script anywhere in the app", async ({ keel: { page, ev } }) => {
  const day = await ev(`() => todayKey()`), t0 = await ev(`() => dayStart(todayKey())`);
  const backup = await ev(`() => JSON.parse(JSON.stringify({ ...state, activity: act }))`);
  const pid = brk("project.id");
  backup.projects = [{ id: pid, name: tag("project.name") + brk("pn"), slot: 2 }, ...backup.projects];
  backup.tasks = [
    { id: brk("task.id"), title: tag("task.title") + brk1("tt"), notes: tag("task.notes"), projectId: pid, priority: 3, due: day, estimate: 30, done: false, createdAt: 1,
      subtasks: [{ id: brk("sub.id"), title: tag("sub.title"), done: false }] },
    { id: brk1("task.id1"), title: "Plain " + brk("t2"), projectId: null, priority: 1, due: day, estimate: 15, done: true, doneAt: t0 + 3600e3, createdAt: 1 },
  ];
  backup.entries = [{ id: brk("entry.id"), type: "focus", start: t0 + 8 * 3600e3, end: t0 + 9 * 3600e3, dur: 3600e3, projectId: pid, taskId: brk("entry.taskId"), note: tag("entry.note"), switches: 1 }];
  backup.appRules = { [tag("rule.key")]: { cat: "deep", projectId: pid }, Code: { cat: tag("rule.cat") } };
  backup.activity = { [day]: [
    { s: t0 + 8 * 3600e3, e: t0 + 9 * 3600e3, app: tag("app"), title: tag("act.title") },
    { s: t0 + 9 * 3600e3, e: t0 + 9.5 * 3600e3, app: "Google Chrome", domain: brk("dom"), title: brk("title") },
  ] };
  backup.plan = null;

  await page.locator('#nav [data-view="settings"]').click();
  await page.locator('[data-act="import"]').click();
  await page.locator('.modal textarea[name="j"]').fill(JSON.stringify(backup));
  await page.locator(".modal button.primary").click();
  await expect(page.locator(".modal")).toHaveCount(0);
  await ev(`() => { state.plan = buildPlan(); state.plan.accepted = true; commit(); }`);

  await arm(page);
  const found = await everyScreen(page, "after restore");
  await page.reload();
  await arm(page);
  found.push(...await everyScreen(page, "after reload"));
  expect(found).toEqual([]);
});

test("web page titles and app names from the tracker can't run script", async ({ keel: { page, ev } }) => {
  const t0 = await ev(`() => dayStart(todayKey())`), day = await ev(`() => todayKey()`);
  const STATUS = { app: "keel-tracker", version: 2, running: true, paused: false, pausedUntil: null, startedAt: 1, current: { app: tag("cur.app"), domain: brk("cur.dom"), title: tag("cur.title") }, idle: false, todayMs: 60000, device: tag("device"), now: 1, storage: { fileBytes: 1, logBytes: 1, keepDays: 30, maxFileMb: 20, days: 1, lastCleanup: null } };
  const ACTIVITY = { source: "keel-tracker", version: 2, device: "Mac", updatedAt: 1, days: { [day]: [
    { s: t0 + 8 * 3600e3, e: t0 + 9 * 3600e3, app: "Google Chrome", domain: "evil.example", title: tag("page.title") },
    { s: t0 + 9 * 3600e3, e: t0 + 9.5 * 3600e3, app: tag("tracked.app"), title: brk("win.title") },
    { s: t0 + 9.5 * 3600e3, e: t0 + 9.75 * 3600e3, app: "Safari", domain: brk1("tracked.dom"), title: brk1("t") },
  ] } };
  await page.route(TRACKER, async route => {
    if (await preflight(route)) return;
    return route.fulfill({ headers: cors(route.request()), contentType: "application/json", body: JSON.stringify(route.request().url().includes("/activity") ? ACTIVITY : STATUS) });
  });
  await ev(`() => trPoll(true)`);
  await expect(page.locator("#trk")).toContainText("Tracking apps");
  await arm(page);
  expect(await everyScreen(page, "tracker data")).toEqual([]);
});

test("a backup can't pollute JavaScript prototypes", async ({ keel: { page, ev } }) => {
  const b = await ev(`() => JSON.parse(JSON.stringify({ ...state, activity: act }))`);
  // Written as raw JSON text: JSON.parse turns "__proto__" into a real key, as it would for a crafted file.
  let s = JSON.stringify(b).slice(0, -1) + ',"__proto__":{"polluted":"top"},"constructor":{"prototype":{"polluted":"ctor"}}}';
  s = s.replace('"settings":{', '"settings":{"__proto__":{"polluted":"settings"},');
  s = s.replace('"appRules":{', '"appRules":{"__proto__":{"polluted":"rules","cat":"deep"},');
  await page.locator('#nav [data-view="settings"]').click();
  await page.locator('[data-act="import"]').click();
  await page.locator('.modal textarea[name="j"]').fill(s);
  await page.locator(".modal button.primary").click();
  for (const v of VIEWS) await page.evaluate(`ui.view = ${JSON.stringify(v)}; render();`);
  const check = `() => ({ obj: ({}).polluted ?? null, arr: [].polluted ?? null,
    rules: Object.getPrototypeOf(state.appRules) === Object.prototype, settings: Object.getPrototypeOf(state.settings) === Object.prototype })`;
  const clean = { obj: null, arr: null, rules: true, settings: true };
  expect(await ev(check)).toEqual(clean);
  await page.reload();
  expect(await ev(check)).toEqual(clean);
});

test("bug 26: unsafe ids are replaced and every link to them still works", async ({ keel: { ev } }) => {
  const out = await ev(`() => {
    const P = 'p" x="', T = "t<b>", E = "e'1", day = todayKey();
    const o = normalize({ ...state,
      projects: [{ id: P, name: "Work", slot: 1 }, { id: "p_ok", name: "Ok", slot: 2 }],
      tasks: [{ id: T, title: "A", projectId: P, subtasks: [{ id: "s 1", title: "step" }] }, { id: "t_ok", title: "B", projectId: "p_ok" }],
      entries: [{ id: E, type: "focus", start: 1, end: 2, dur: 1, projectId: P, taskId: T }],
      active: { type: "focus", start: 1, projectId: P, taskId: T },
      appRules: { Code: { cat: "deep", projectId: P }, Mail: "junk" },
      plan: { day, items: [{ kind: "task", taskId: T, start: 1, end: 2 }, { kind: "task", taskId: "gone<", start: 2, end: 3 }, { kind: "break", start: 3, end: 4 }], later: [T, "t_ok"] },
      planSkips: { day, ids: [T] } });
    const ok = id => /^[A-Za-z0-9_-]{1,64}$/.test(id);
    const p = o.projects[0], t = o.tasks[0], e = o.entries[0];
    return { allSafe: [...o.projects, ...o.tasks, ...o.entries, ...t.subtasks].every(x => ok(x.id)),
      kept: o.projects[1].id === "p_ok" && o.tasks[1].id === "t_ok" && o.tasks[1].projectId === "p_ok",
      taskToProject: t.projectId === p.id, entryLinks: e.projectId === p.id && e.taskId === t.id,
      active: o.active.projectId === p.id && o.active.taskId === t.id, rule: o.appRules.Code.projectId === p.id, junkRule: "Mail" in o.appRules,
      plan: o.plan.items.map(i => i.kind === "task" ? i.taskId === t.id : "break"), later: o.plan.later[0] === t.id && o.plan.later[1] === "t_ok",
      skips: o.planSkips.ids[0] === t.id };
  }`);
  expect(out).toEqual({ allSafe: true, kept: true, taskToProject: true, entryLinks: true, active: true, rule: true, junkRule: false,
    plan: [true, "break"], later: true, skips: true });
});

test.describe("bug 31: oversized files and backups are refused", () => {
  test("a 26 MB activity file dropped on the page", async ({ keel: { page, ev } }) => {
    const before = await ev(`() => JSON.stringify(act)`);
    await page.evaluate(() => {
      const f = new File([new Uint8Array(26 * 1024 * 1024).fill(32)], "keel-activity.json", { type: "application/json" });
      const dt = new DataTransfer(); dt.items.add(f);
      document.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect(page.locator("#toasts")).toContainText("too large to be a Keel activity file");
    expect(await ev(`() => JSON.stringify(act)`)).toBe(before);
  });
  // Restore takes pasted text. Chrome on macOS freezes once 26 MB of text is in the box, before the click-time check
  // can run (Phase 14, 2026-11-15), so an oversized paste or drop is refused before the text lands in the box.
  for (const how of ["paste", "drop"]) {
    test(`a 26 MB backup ${how === "paste" ? "pasted" : "dropped"} into Restore is refused before it lands in the box`, async ({ keel: { page, ev } }) => {
      const before = await ev(`() => JSON.stringify(state.tasks)`);
      await page.locator('#nav [data-view="settings"]').click();
      await page.locator('[data-act="import"]').click();
      const prevented = await page.evaluate(how => {
        const dt = new DataTransfer(); dt.setData("text/plain", '{"tasks":[],"entries":[],"pad":"' + "x".repeat(26 * 1024 * 1024) + '"}');
        const box = document.querySelector('.modal textarea[name="j"]');
        const e = how === "paste" ? new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })
          : new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
        box.dispatchEvent(e);
        return e.defaultPrevented;
      }, how);
      expect(prevented, "the browser must not insert the text").toBe(true);
      await expect(page.locator("#imp-err")).toContainText("too large");
      expect(await page.locator('.modal textarea[name="j"]').inputValue()).toBe("");
      expect(await ev(`() => JSON.stringify(state.tasks)`)).toBe(before);
    });
  }
  test("a small backup can still be pasted; the click-time size check stays as a backstop", async ({ keel: { page, ev } }) => {
    await page.locator('#nav [data-view="settings"]').click();
    await page.locator('[data-act="import"]').click();
    const prevented = await page.evaluate(() => {
      const dt = new DataTransfer(); dt.setData("text/plain", '{"tasks":[],"entries":[]}');
      const e = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      document.querySelector('.modal textarea[name="j"]').dispatchEvent(e);
      return e.defaultPrevented;
    });
    expect(prevented).toBe(false);                                                    // normal pastes are left to the browser
    const before = await ev(`() => JSON.stringify(state.tasks)`);
    // Backstop: text that got in some other way is still checked on Restore. The box is hidden so the browser
    // doesn't lay out 26 MB of text; this checks Keel's size check, not the browser's text rendering.
    await page.evaluate(() => { const b = document.querySelector('.modal textarea[name="j"]'); b.style.display = "none"; b.value = '{"tasks":[],"entries":[],"pad":"' + "x".repeat(26 * 1024 * 1024) + '"}'; });
    await page.locator(".modal button.primary").click();
    await expect(page.locator("#imp-err")).toContainText("too large");
    expect(await ev(`() => JSON.stringify(state.tasks)`)).toBe(before);
  });
});
