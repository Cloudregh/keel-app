// Phase 7: data pipeline & data quality for the on-device planner.
//  A. the frozen eval datasets: schema, quality, balance, leakage between splits, determinism
//  B. feature extraction (featurize) on hand-checked examples and edge cases
//  C. no label or future information in features; train/serve consistency
//  D. the activity pipeline (tracker file → app): schema-preserving import, storage round trip, quality defences
//  E. personal data: what leaves the device
import { test, expect } from "../fixtures/keel.mjs";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { FILES, SEED, buildEffort } from "../../../eval/data/build.mjs";

const read = name => readFileSync(new URL(`../../../eval/data/${name}`, import.meta.url), "utf8");
const effort = read("effort-v1.jsonl").trim().split("\n").map(l => JSON.parse(l));
const duration = JSON.parse(read("duration-v1.json"));
const energy = JSON.parse(read("energy-v1.json"));
const STOP = new Set("the a an and or to for of on in at with my me i is be it this that from by up out about into over as".split(" "));
const words = s => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w && !STOP.has(w)));
const jaccard = (a, b) => { const A = words(a), B = words(b); const i = [...A].filter(x => B.has(x)).length; return i / (A.size + B.size - i || 1); };

test.describe("A. eval datasets", () => {
  test("effort: schema, types and ranges", () => {
    for (const r of effort) {
      expect(Object.keys(r).sort()).toEqual(["estimate", "group", "id", "label", "notes", "priority", "projectId", "split", "subtasks", "title"]);
      expect(r.id).toMatch(/^[lmh]\d\d-[12]$/);
      expect(["L", "M", "H"]).toContain(r.label);
      expect(["train", "val", "test"]).toContain(r.split);
      expect(typeof r.title === "string" && r.title.trim().length >= 5 && r.title.length <= 80).toBe(true);
      expect(Number.isInteger(r.estimate) && r.estimate >= 0 && r.estimate <= 240).toBe(true);
      expect([0, 1, 2, 3]).toContain(r.priority);
      expect(Array.isArray(r.subtasks) && r.subtasks.length <= 6).toBe(true);
    }
  });

  test("effort: no missing values, duplicates, impossible values or label/estimate contradictions", () => {
    expect(new Set(effort.map(r => r.id)).size).toBe(effort.length);
    const titles = effort.map(r => r.title.toLowerCase());
    expect(titles.filter((t, i) => titles.indexOf(t) !== i)).toEqual([]);                  // exact duplicates
    const contradictions = effort.filter(r => r.estimate && ((r.label === "L" && r.estimate > 30) || (r.label === "H" && r.estimate < 90) || (r.label === "M" && (r.estimate < 30 || r.estimate > 90))));
    expect(contradictions.map(r => r.id)).toEqual([]);
    expect(effort.filter(r => !r.estimate).length / effort.length).toBeGreaterThan(0.15);    // realistic share of tasks without an estimate
    expect(effort.filter(r => !r.estimate).length / effort.length).toBeLessThan(0.35);
  });

  test("effort: classes are balanced in every split; the test split has ≥ 150 tasks", () => {
    for (const split of ["train", "val", "test"]) {
      const n = c => effort.filter(r => r.split === split && r.label === c).length;
      expect(n("L")).toBe(n("M"));
      expect(n("M")).toBe(n("H"));
    }
    expect(effort.filter(r => r.split === "test").length).toBeGreaterThanOrEqual(150);
  });

  test("effort: zero overlap between train, validation and test (ids, groups, exact and near-duplicate titles)", () => {
    const by = s => effort.filter(r => r.split === s);
    const pairs = [["train", "val"], ["train", "test"], ["val", "test"]];
    const report = {};
    for (const [a, b] of pairs) {
      const A = by(a), B = by(b);
      report[`${a}/${b}`] = {
        ids: A.filter(x => B.some(y => y.id === x.id)).length,
        groups: A.filter(x => B.some(y => y.group === x.group)).length,
        exact: A.filter(x => B.some(y => y.title.toLowerCase() === x.title.toLowerCase())).length,
        near: A.flatMap(x => B.filter(y => jaccard(x.title, y.title) >= 0.6).map(y => `${x.id}~${y.id}`)),
      };
    }
    console.log("Split overlap check:", JSON.stringify(report));
    for (const k of Object.keys(report)) expect(report[k]).toEqual({ ids: 0, groups: 0, exact: 0, near: [] });
  });

  test("bug 42: no note or title sentence is tied to one class (flags effort-v1, passes effort-v2)", () => {
    const leaks = rows => {
      const by = {};
      for (const r of rows) for (const text of [r.notes, r.title]) if (text) (by[text.trim().toLowerCase()] ||= new Set()).add(r.label) && (by[text.trim().toLowerCase()].n = (by[text.trim().toLowerCase()].n || 0) + 1);
      return Object.entries(by).filter(([, s]) => s.n >= 3 && s.size === 1).map(([t]) => t);
    };
    const v2 = read("effort-v2.jsonl").trim().split("\n").map(l => JSON.parse(l));
    expect(leaks(effort).length, "the check must catch effort-v1's per-class notes").toBeGreaterThan(0);
    expect(leaks(v2)).toEqual([]);
    expect(v2.map(r => ({ ...r, notes: "" }))).toEqual(effort.map(r => ({ ...r, notes: "" })));   // only the notes differ
  });

  test("duration and energy: schema, chronological splits (no future in history), no effort-test titles", () => {
    for (const r of duration) {
      expect(Number.isInteger(r.estimate) && r.estimate > 0 && Number.isInteger(r.actualMin) && r.actualMin >= 3 && r.actualMin <= 1440).toBe(true);
      expect(["L", "M", "H"]).toContain(r.label);
    }
    const hist = duration.filter(r => r.split === "history"), fut = duration.filter(r => r.split === "test");
    expect(Math.max(...hist.map(r => r.doneAt))).toBeLessThan(Math.min(...fut.map(r => r.doneAt)));
    const testTitles = new Set(effort.filter(r => r.split === "test").map(r => r.title));
    expect(duration.filter(r => testTitles.has(r.title)).map(r => r.id)).toEqual([]);
    const ratio = duration.map(r => r.actualMin / r.estimate).sort((a, b) => a - b);
    expect(ratio[0]).toBeGreaterThan(0.2); expect(ratio.at(-1)).toBeLessThan(6);   // no impossible overruns
    const eh = energy.sessions.filter(s => s.split === "history"), et = energy.sessions.filter(s => s.split === "test");
    expect(Math.max(...eh.map(s => s.end))).toBeLessThan(Math.min(...et.map(s => s.start)));
    for (const s of energy.sessions) expect(s.end > s.start && s.dur === s.end - s.start).toBe(true);
    expect(energy.trueCurve).toHaveLength(24);
  });

  test("frozen: every dataset matches the hash recorded in eval/manifest.json", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../../eval/manifest.json", import.meta.url), "utf8"));
    const sha = s => createHash("sha256").update(s).digest("hex").slice(0, 12);
    for (const d of Object.values(manifest.datasets)) expect(sha(readFileSync(new URL(`../../../${d.file}`, import.meta.url))), d.file).toBe(d.sha256);
  });

  test("versioned: the planner code matches the hash recorded in eval/manifest.json", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../../eval/manifest.json", import.meta.url), "utf8"));
    const html = readFileSync(new URL("../../../index.html", import.meta.url), "utf8");
    const start = html.indexOf("/* ================= Planner:"), end = html.indexOf("/* ---- UI: plan panel");
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const sha = createHash("sha256").update(html.slice(start, end)).digest("hex").slice(0, 12);
    expect(sha, "update eval/manifest.json when the planner changes").toBe(manifest.models.planner.sha256);
    // bug 47: the running version must be the recorded one, and its recorded code hash must be this code,
    // so changing the planner without bumping PLANNER_VERSION (and recording the new version) fails here
    const version = (html.match(/const PLANNER_VERSION = "([^"]+)"/) || [])[1];
    expect(version).toBe(manifest.models.planner.version);
    expect(manifest.models.planner.versions[version], `bump PLANNER_VERSION and record it in eval/manifest.json versions`).toBe(sha);
  });

  test("determinism: rebuilding with the same seed gives byte-identical files", () => {
    for (const [name, make] of Object.entries(FILES)) expect(make()).toBe(read(name));
    expect(JSON.stringify(buildEffort(SEED))).toBe(JSON.stringify(buildEffort(SEED)));
    expect(JSON.stringify(buildEffort(SEED + 1))).not.toBe(JSON.stringify(buildEffort(SEED)));   // the seed really drives it
  });
});

test.describe("B. featurize: hand-checked examples and edge cases", () => {
  test("words are lower-cased, stop words dropped, stemmed, with leading bigrams and metadata", async ({ keel: { ev } }) => {
    expect(await ev(`() => featurize({ title: "Writing the Q3 reports!", estimate: 0, priority: 0, subtasks: [] })`))
      .toEqual(["writ", "q3", "report", "writ_q3", "q3_report", "_est:none", "_prio:0", "_subs:0", "_v:writ", "_v:writ", "_v:writ"]);   // verb ×3: bug 38
    expect(await ev(`() => featurize({ title: "Pay bill", notes: "Rent and water", estimate: 10, priority: 2, projectId: "p_home", subtasks: [{}, {}] })`))
      .toEqual(["pay", "bill", "rent", "water", "pay_bill", "bill_rent", "rent_water", "_est:xs", "_prio:2", "_proj:p_home", "_subs:few", "_v:pay", "_v:pay", "_v:pay"]);
  });
  test("estimate and step buckets switch exactly at their boundaries", async ({ keel: { ev } }) => {
    const est = await ev(`() => [15, 16, 30, 31, 60, 61, 120, 121].map(e => featurize({ title: "x", estimate: e }).find(f => f.startsWith("_est")))`);
    expect(est).toEqual(["_est:xs", "_est:s", "_est:s", "_est:m", "_est:m", "_est:l", "_est:l", "_est:xl"]);
    const subs = await ev(`() => [0, 1, 3, 4].map(n => featurize({ title: "x", subtasks: Array(n).fill({}) }).find(f => f.startsWith("_subs")))`);
    expect(subs).toEqual(["_subs:0", "_subs:few", "_subs:few", "_subs:many"]);
  });
  test("limits: notes read up to 200 characters, at most 40 words and 8 bigrams", async ({ keel: { ev } }) => {
    const r = await ev(`() => {
      const long = Array.from({ length: 80 }, (_, i) => "word" + i).join(" ");
      const f = featurize({ title: long, notes: "x".repeat(300) + " zebra" });
      return { words: f.filter(t => !t.includes("_")).length, bigrams: f.filter(t => /^[^_]+_[^_]+$/.test(t) && !t.startsWith("_")).length, zebra: f.includes("zebra") };
    }`);
    expect(r).toEqual({ words: 40, bigrams: 8, zebra: false });
  });
  test("odd input never throws: empty, punctuation-only, missing fields, numbers as titles", async ({ keel: { ev } }) => {
    const r = await ev(`() => [{}, { title: "" }, { title: "!!! ??? ..." }, { title: null, notes: undefined }, { title: 12345 }, { title: "a b c d" }].map(t => featurize(t))`);
    expect(r[0]).toEqual(["_est:none", "_prio:0", "_subs:0"]);
    expect(r[2]).toEqual(["_est:none", "_prio:0", "_subs:0"]);
    expect(r[4][0]).toBe("12345");
    expect(r[5]).toEqual(["_est:none", "_prio:0", "_subs:0"]);   // single letters carry no meaning
  });
  test("words with accents or non-Latin letters are kept (French, Twi, Spanish)", async ({ keel: { ev } }) => {
    const r = await ev(`() => [featurize({ title: "Écrire le rapport" }), featurize({ title: "Kɔ dwam ɛnnɛ" }), featurize({ title: "Preparar presentación" })]
      .map(f => f.filter(t => !t.startsWith("_") && !t.includes("_")))`);
    expect(r).toEqual([["écrire", "le", "rapport"], ["kɔ", "dwam", "ɛnnɛ"], ["preparar", "presentación"]]);
  });
});

test.describe("C. no leakage; train/serve consistency", () => {
  test("features never contain the label, completion state, actual time or anything from the future", async ({ keel: { ev } }) => {
    const r = await ev(`() => {
      const t = { id: "t1", title: "Write the grant proposal", notes: "", estimate: 120, priority: 2, subtasks: [] };
      const a = featurize(t);
      const b = featurize({ ...t, energy: "L", done: true, doneAt: Date.now() + 86400e3, actualMin: 5, createdAt: 0, updatedAt: 9e15 });
      return { same: JSON.stringify(a) === JSON.stringify(b), labelTokens: a.filter(x => /^(l|m|h|light|medium|heavy)$/.test(x)) };
    }`);
    expect(r).toEqual({ same: true, labelTokens: [] });
  });
  test("training and prediction see exactly the same features", async ({ keel: { ev } }) => {
    const r = await ev(`() => {
      const seen = { train: [], predict: [] }, real = featurize;
      const t = { id: "t1", title: "Draft the board presentation", notes: "slides and numbers", estimate: 90, priority: 3, projectId: "p_work", subtasks: [{}, {}] };
      try {
        featurize = x => { const f = real(x); (seen.mode === "train" ? seen.train : seen.predict).push(f); return f; };
        seen.mode = "train"; trainEffort(t, "H", 1);
        seen.mode = "predict"; predictEffort(t);
      } finally { featurize = real; }
      return JSON.stringify(seen.train[0]) === JSON.stringify(seen.predict[0]) && seen.train[0].length > 5;
    }`);
    expect(r).toBe(true);
  });
  test("changing a label after editing the task removes exactly what was trained (no stale counts)", async ({ keel: { ev } }) => {
    const r = await ev(`() => {
      const snapshot = () => JSON.stringify(mlState().nb);
      state.ml = null; mlState(); state.tasks = [];
      const t = { id: "t1", title: "Write the quarterly report", estimate: 180, priority: 3, subtasks: [] };
      state.tasks.push(t);
      setEffort(t, "H");                         // user labels it Heavy
      t.title = "Pay electricity bill"; t.estimate = 10; t.priority = 0;   // then edits the task
      setEffort(t, "L");                         // and relabels it Light
      const got = snapshot();
      state.ml = null; mlState();
      const fresh = { ...t }; delete fresh.energy;
      trainEffort(fresh, "L", 2);                // what the model should hold: only the current task as Light
      const want = snapshot();
      return { equal: got === want, heavyDocs: JSON.parse(got).docs.H, heavyLeft: Object.entries(JSON.parse(got).c.H).filter(([, v]) => v > 0).map(([k]) => k) };
    }`);
    expect(r).toEqual({ equal: true, heavyDocs: 0, heavyLeft: [] });
  });
  test("the same input always gives the same prediction, and training twice from scratch gives the same model", async ({ keel: { ev } }) => {
    const train = effort.filter(r => r.split === "train");
    const r = await ev(`rows => {
      const run = () => { state.ml = null; mlState(); for (const x of rows) trainEffort(x, x.label, 2); return JSON.stringify(mlState().nb) + JSON.stringify(rows.map(x => predictEffort(x).p)); };
      return run() === run();
    }`, train);
    expect(r).toBe(true);
  });
});

test.describe("D. activity pipeline", () => {
  test("a valid tracker file is imported without losing or changing any segment", async ({ keel: { ev } }) => {
    const file = JSON.parse(readFileSync(new URL("../fixtures/data/activity-2026-11-10.json", import.meta.url), "utf8"));
    const r = await ev(`f => { const out = cleanActDays(f.days); return Object.keys(f.days).every(k => JSON.stringify(out[k]) === JSON.stringify(f.days[k].map(s => ({ s: s.s, e: s.e, app: s.app, ...(s.domain ? { domain: s.domain } : {}), ...(s.title ? { title: s.title } : {}) })))); }`, file);
    expect(r).toBe(true);
  });
  test("storage round trip: decode(encode(activity)) gives back exactly the same data (200 random days)", async ({ keel: { ev } }) => {
    const r = await ev(`() => {
      let a = 12345; const rnd = () => { a = (a * 1103515245 + 12345) % 2147483648; return a / 2147483648; };
      const apps = ["Code", "Safari", "Google Chrome", "Slack", "Notes"], doms = ["github.com", "youtube.com", "mail.google.com"];
      const src = {};
      for (let d = 0; d < 200; d++) {
        const k = addDays(todayKey(), -(d % 6)) + "", t0 = dayStart(k) + d * 1000;
        const segs = []; let t = t0;
        for (let i = 0; i < 1 + Math.floor(rnd() * 30); i++) { const len = 1000 + Math.floor(rnd() * 3600e3 / 4); const app = apps[Math.floor(rnd() * apps.length)];
          const s = { s: t, e: t + len, app }; if (app !== "Code" && rnd() < 0.7) { s.domain = doms[Math.floor(rnd() * doms.length)]; s.title = "Page " + Math.floor(rnd() * 99); } segs.push(s); t += len + Math.floor(rnd() * 60e3); }
        src[k] = segs;
      }
      const back = decodeAct(JSON.parse(JSON.stringify(encodeAct(src))));
      return Object.keys(src).every(k => JSON.stringify(back[k]) === JSON.stringify(src[k]));
    }`);
    expect(r).toBe(true);
  });
  test("bad segments in a file (overlaps, a 3-day segment, future time) can't make a day longer than 24 h", async ({ keel: { ev } }) => {
    const r = await ev(`() => {
      const k = todayKey(), t0 = dayStart(k), H = 3600e3;
      const days = { [k]: [
        { s: t0 + 8 * H, e: t0 + 10 * H, app: "Code" },
        { s: t0 + 9 * H, e: t0 + 11 * H, app: "Slack" },            // overlaps the first by an hour
        { s: t0 + 9.5 * H, e: t0 + 9.75 * H, app: "Notes" },        // inside both
        { s: t0 + 12 * H, e: t0 + 84 * H, app: "Safari" },          // runs three days
      ] };
      importActivity({ source: "keel-tracker", version: 2, days }, true, "file");
      actCache[k] = null;
      const st = actStats(k), dayEnd = Math.min(t0 + 24 * H, Date.now());
      return { totalH: +(st.total / H).toFixed(2), maxH: +((dayEnd - t0) / H).toFixed(2), segsInDay: st.segs.every(s => s.s >= t0 && s.e <= t0 + 24 * H), sorted: st.segs.every((s, i, a) => !i || a[i - 1].e <= s.s) };
    }`);
    expect(r.totalH).toBeLessThanOrEqual(r.maxH);
    expect(r).toMatchObject({ segsInDay: true, sorted: true });
  });
});

test.describe("E. personal data", () => {
  test.use({ aiMode: "mock" });
  test("window titles, app names and websites never go into the AI coach's prompt", async ({ keel: { page, ev, aiCalls } }) => {
    await ev(`() => { const k = todayKey(), t0 = dayStart(k); act[k] = [{ s: t0 + 8 * 3600e3, e: t0 + 9 * 3600e3, app: "SecretApp", domain: "private-bank.example", title: "Account 12345 balance" }]; actCache[k] = null; render(); }`);
    await page.locator('#nav [data-view="today"]').click();
    await page.locator('#ai-panel [data-act="ai"]').click();
    await expect.poll(() => aiCalls.length).toBeGreaterThan(0);
    const prompt = JSON.stringify(aiCalls);
    for (const secret of ["SecretApp", "private-bank", "Account 12345"]) expect(prompt).not.toContain(secret);
  });
});
