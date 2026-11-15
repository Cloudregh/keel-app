/* global taskById, LS_KEY -- app globals, read inside page.evaluate */
// Fix 62: ticking a task in the Tasks view updates only that row and the filter counts at once; the full re-render
// (group moves, plan) follows 1.5 s after the last tick. Completed tasks show 50 at a time.
// Measured before the fix (docs/performance.md): 498–808 ms from tap to next frame at 4× CPU with 600 tasks.
import { test, expect } from "../fixtures/keel.mjs";

const seed = n => `() => {
  localStorage.clear(); state = normalize(null); state.updatedAt = 0;
  for (let i = 0; i < ${n}; i++) state.tasks.push({ id: "t" + i, title: "Task " + i, projectId: "p_work", priority: i % 4,
    due: addDays(todayKey(), (i % 20) - 10), estimate: 30, notes: "", subtasks: [], done: i % 3 === 0,
    doneAt: i % 3 === 0 ? Date.now() - (1 + (i % 30)) * DAY : null, createdAt: Date.now() - 40 * DAY + i });
  save(); ui.view = "tasks"; ui.taskFilter = "today"; render();
}`;
const count = (page, f) => page.locator(`[data-act="task-filter"][data-f="${f}"] .num`).innerText();

test("a tick updates that row and the counts without re-rendering the view; the full update follows", async ({ keel: { page, ev } }) => {
  await ev(seed(600));
  await page.evaluate(() => { document.querySelector(".tasks").dataset.sentinel = "1"; window.__views = 0; const v = window.viewTasks; window.viewTasks = (...a) => (window.__views++, v(...a)); });
  const box = page.locator(".group-h:has-text('Overdue') ~ .task [data-act='toggle-task']").first();
  const id = await box.getAttribute("data-id");
  const [open0, done0] = [await count(page, "open"), await count(page, "done")];
  await box.click();
  const row = page.locator(`.task[data-task="${id}"]`);
  await expect(row).toHaveClass(/\bdone\b/);
  await expect(row.locator("[data-act='toggle-task']")).toHaveAttribute("aria-checked", "true");
  await expect(row.locator("[data-act='toggle-task']")).toBeFocused();                                   // focus stays on the checkbox
  expect(await count(page, "open")).toBe(String(+open0 - 1));
  expect(await count(page, "done")).toBe(String(+done0 + 1));
  expect(await page.evaluate(() => [document.querySelector(".tasks").dataset.sentinel, window.__views])).toEqual(["1", 0]);
  expect(await page.evaluate(i => taskById(i).done, id)).toBe(true);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem(LS_KEY)).tasks.find(t => t.done && t.doneAt > Date.now() - 60000) != null)).toBe(true);
  // ...then, after the pause, the whole view catches up: the task sits under "Completed today".
  await expect(page.locator(".group-h:has-text('Completed today') ~ .task[data-task='" + id + "']")).toHaveCount(1, { timeout: 4000 });
  expect(await page.evaluate(() => window.__views)).toBe(1);
});

test("ticking several tasks quickly re-renders once, after the last tick; unticking works the same way", async ({ keel: { page, ev } }) => {
  await ev(seed(60));
  await page.evaluate(() => { window.__views = 0; const v = window.viewTasks; window.viewTasks = (...a) => (window.__views++, v(...a)); });
  const ids = await page.locator(".group-h:has-text('Overdue') ~ .task [data-act='toggle-task']").evaluateAll(els => els.slice(0, 3).map(e => e.dataset.id));
  for (const id of ids) await page.locator(`.task[data-task="${id}"] [data-act='toggle-task']`).click();
  await page.locator(`.task[data-task="${ids[0]}"] [data-act='toggle-task']`).click();                   // untick the first again
  expect(await page.evaluate(i => i.map(x => taskById(x).done), ids)).toEqual([false, true, true]);
  await expect.poll(() => page.evaluate(() => window.__views), { timeout: 4000 }).toBe(1);
  await page.waitForTimeout(2000);
  expect(await page.evaluate(() => window.__views)).toBe(1);
});

test("the Completed list shows 50 tasks, then 50 more on request", async ({ keel: { page, ev } }) => {
  await ev(seed(300));                                                                                     // 100 done
  await page.locator('[data-act="task-filter"][data-f="done"]').click();
  await expect(page.locator(".tasks .task")).toHaveCount(50);
  await page.getByRole("button", { name: "Show 50 more" }).click();
  await expect(page.locator(".tasks .task")).toHaveCount(100);
  await expect(page.getByRole("button", { name: /Show \d+ more/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Delete completed tasks" })).toBeVisible();
});
