// Builds eval/coach/page/index.html: the claude.ai artifact that runs the Daily coach eval on the owner's Claude plan.
// It sends each case's prompt (built by the same buildPrompt the parity test pins to index.html) through `sample`
// with cache:false, 3 times per case, and stores the raw answers in the artifact's db. Grading happens offline
// (eval/coach/run.mjs), so nothing on the page decides pass or fail.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildPrompt, COACH_PROMPT_VERSION, INSTRUCTION, EVAL_SET_FOR } from "./prompt.mjs";

const sha = s => createHash("sha256").update(s).digest("hex").slice(0, 12);
const EVAL_SET = EVAL_SET_FOR[COACH_PROMPT_VERSION];
const setText = readFileSync(new URL(`../data/${EVAL_SET}.jsonl`, import.meta.url), "utf8");
const cases = setText.trim().split("\n").map(l => JSON.parse(l)).map(c => ({ id: c.id, category: c.category, prompt: buildPrompt(c.data) }));
const META = { evalSet: EVAL_SET, evalSetSha: sha(setText), promptVersion: COACH_PROMPT_VERSION, promptSha: sha(INSTRUCTION), reps: 3 };

const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Keel coach eval</title>
<style>
  :root { --bg:#f6f7fb; --ink:#1d2033; --muted:#646a85; --line:#dfe2ee; --accent:#5b4bdb; --ok:#1f8a5b; --bad:#c2410c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14151d; --ink:#e8e9f2; --muted:#9aa0bb; --line:#2b2e3d; --accent:#8f84ff; --ok:#4cc38a; --bad:#fb8b5a; } }
  * { box-sizing:border-box } body { margin:0; font:15px/1.5 system-ui, sans-serif; background:var(--bg); color:var(--ink); }
  main { max-width:760px; margin:0 auto; padding:28px 20px 60px; }
  h1 { font-size:22px; margin:0 0 4px } p { margin:6px 0 } .muted { color:var(--muted) }
  .row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin:18px 0 }
  button { font:inherit; padding:9px 16px; border-radius:8px; border:1px solid var(--line); background:transparent; color:var(--ink); cursor:pointer }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff } button:disabled { opacity:.5; cursor:default }
  button:focus-visible { outline:2px solid var(--accent); outline-offset:2px }
  .bar { height:8px; background:var(--line); border-radius:4px; overflow:hidden } .bar > i { display:block; height:100%; width:0; background:var(--accent); transition:width .3s }
  #log { margin-top:18px; border-top:1px solid var(--line) } #log div { padding:6px 0; border-bottom:1px solid var(--line); font-size:13px; white-space:pre-wrap }
  .ok { color:var(--ok) } .bad { color:var(--bad) }
</style></head>
<body><main>
  <h1>Keel Daily coach evaluation</h1>
  <p class="muted">Sends ${cases.length} invented days to Claude, ${META.reps} times each (${cases.length * META.reps} requests), using your Claude plan. No real data is sent. Answers are saved to this page's storage for grading; keep the page open until it finishes (about 15–25 minutes). You can stop and resume.</p>
  <p class="muted">Eval set ${META.evalSet} (${META.evalSetSha}) · prompt ${META.promptVersion} (${META.promptSha})</p>
  <div class="row"><button class="primary" id="go" disabled>Run evaluation</button><button id="stop" disabled>Stop</button><button id="fp" disabled>Save fingerprints</button><span id="status" class="muted" role="status">Connecting…</span></div>
  <div class="bar" aria-hidden="true"><i id="fill"></i></div>
  <div id="log" aria-live="polite"></div>
</main>
<script>
const CASES = ${JSON.stringify(cases)};
const META = ${JSON.stringify(META)};
const $ = s => document.querySelector(s);
const val = d => !d ? null : typeof d.data === "function" ? d.data() : (d.data && typeof d.data === "object" ? d.data : d);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let db = null, sample = null, stopping = false, runId = null;
const status = t => { $("#status").textContent = t; };
const log = (t, cls) => { const d = document.createElement("div"); d.textContent = t; if (cls) d.className = cls; $("#log").prepend(d); };

async function connect() {
  const t = setTimeout(() => status("Open this page in claude.ai to run it."), 10000);
  [db, sample] = await Promise.all([claude.use("db"), claude.use("sample")]);
  clearTimeout(t);
  if (!db || !sample) { status("This page needs Claude and storage. Open it in claude.ai while signed in."); return; }
  try {
    const m = await db.doc("meta/current").get();
    const cur = val(m);
    runId = cur && cur.runId && cur.evalSetSha === META.evalSetSha && cur.promptSha === META.promptSha && !cur.finished ? cur.runId : null;
  } catch { runId = null; }
  $("#go").disabled = false; $("#fp").disabled = false;
  $("#go").textContent = runId ? "Resume evaluation" : "Run evaluation";
  fingerprints();
  status(runId ? "An unfinished run was found. Resume picks up where it stopped." : "Ready.");
}

async function done() {
  try {
    const snap = await db.collection("results").where("runId", "==", runId).get();
    const docs = snap.docs || snap;
    return new Set((Array.isArray(docs) ? docs : []).map(val).filter(r => r && r.ok).map(r => r.caseId + "#" + r.rep));
  } catch { return new Set(); }
}

async function one(c, rep) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const t0 = Date.now();
    try {
      const r = await sample(c.prompt, { cache: false });
      return { ok: true, text: r.text, truncated: !!r.truncated, modelApplied: r.modelApplied || null, ms: Date.now() - t0, attempts: attempt };
    } catch (e) {
      if (e && e.code === "not_granted") throw e;
      if (e && e.code === "rate_limited" && attempt < 3) { status("Claude asked us to slow down. Waiting a minute…"); await sleep(60000); continue; }
      return { ok: false, error: (e && e.code) || "error", message: String((e && e.message) || "").slice(0, 200), ms: Date.now() - t0, attempts: attempt };
    }
  }
}

async function go() {
  stopping = false; $("#go").disabled = true; $("#stop").disabled = false;
  if (!runId) { runId = "run-" + new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14); await db.doc("meta/current").set({ ...META, runId, startedAt: Date.now(), finished: false }); }
  const have = await done();
  const jobs = [];
  for (let rep = 1; rep <= META.reps; rep++) for (const c of CASES) if (!have.has(c.id + "#" + rep)) jobs.push([c, rep]);
  const total = CASES.length * META.reps; let n = total - jobs.length;
  const show = () => { $("#fill").style.width = (100 * n / total) + "%"; status(n + " of " + total + " answers saved"); };
  show();
  try {
    for (const [c, rep] of jobs) {
      if (stopping) break;
      const r = await one(c, rep);
      await db.doc("results/" + runId + "__" + c.id + "__" + rep).set({ runId, caseId: c.id, category: c.category, rep, at: Date.now(), ...r });
      if (r.ok) { n++; log(c.id + " · run " + rep + " · " + r.text.split(/\\s+/).length + " words", "ok"); } else log(c.id + " · run " + rep + " · failed (" + r.error + ")", "bad");
      show();
    }
    if (!stopping && n >= total) { await db.doc("meta/current").set({ ...META, runId, finished: true, finishedAt: Date.now() }); status("Finished: all " + total + " answers saved. Tell Claude in the chat that the run is done."); runId = null; await fingerprints(); }
    else if (stopping) status("Stopped at " + n + " of " + total + ". Press Resume to continue.");
    else status(n + " of " + total + " saved; some requests failed. Press Resume to retry them.");
  } catch (e) {
    status(e && e.code === "not_granted" ? "Claude access wasn't granted, so the run stopped. Press Run to be asked again." : "The run stopped: " + ((e && e.message) || "unknown error"));
  }
  $("#stop").disabled = true; $("#go").disabled = false; $("#go").textContent = runId ? "Resume evaluation" : "Run evaluation again";
}
// Export check: after a finished run, store a sha-256 fingerprint of every saved answer, so the copy Claude writes
// into the repo can be checked against what was actually saved here.
async function fingerprints() {
  try {
    const m = val(await db.doc("meta/current").get());
    if (!m || !m.finished || !crypto || !crypto.subtle) return;
    const snap = await db.collection("results").where("runId", "==", m.runId).get();
    const rows = (Array.isArray(snap.docs || snap) ? (snap.docs || snap) : []).map(val).filter(r => r && r.ok);
    const fp = {};
    for (const r of rows) {
      const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(r.text));
      fp[r.caseId + "_" + r.rep] = [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
    }
    await db.doc("meta/fingerprints").set({ runId: m.runId, count: rows.length, fp, at: Date.now() });
    log("Saved fingerprints of " + rows.length + " answers (" + m.runId + ") for the export check.", "ok");
    status("Saved fingerprints of " + rows.length + " answers for " + m.runId + ".");
  } catch (e) { log("Couldn't save fingerprints: " + ((e && e.message) || "error"), "bad"); }
}
$("#go").addEventListener("click", go);
$("#fp").addEventListener("click", async () => { $("#fp").disabled = true; await fingerprints(); $("#fp").disabled = false; });
$("#stop").addEventListener("click", () => { stopping = true; $("#stop").disabled = true; status("Stopping after the current request…"); });
connect();
</script></body></html>
`;
mkdirSync(new URL("./page/", import.meta.url), { recursive: true });
writeFileSync(new URL("./page/index.html", import.meta.url), html);
console.log(`wrote eval/coach/page/index.html  ${sha(html)}  (${cases.length} cases × ${META.reps})`);
