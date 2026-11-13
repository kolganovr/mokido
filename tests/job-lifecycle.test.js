// Job lifecycle contract (T-075, ADR-002): the journal keeps a result nobody waits
// for ("late"), expires silent jobs lazily, evicts in a sensible order, tells the
// right origin and never invents a result. Run: node tests/job-lifecycle.test.js
//
// Part 1: units through the figma/index.js facade (times are faked through record
// fields). Part 2: a real server process on :18830 with a fake plugin over a real
// WebSocket, driven by raw HTTP the way a proxy does (/execute, /job with origin).
// Part 1 also uses a fake master on :18831 for the proxy side. Needs Node >= 22.
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const { spawnSync } = require("child_process");

for (const k of Object.keys(process.env)) if (/^FIGMA_/i.test(k)) delete process.env[k];
process.env.FIGMA_BRIDGE_PORT = "18831";
const srv = require("../figma/index.js");
const H = require("./helpers/server-harness");
const { sleep, startServer, waitMaster, waitClients, startFakePlugin, HANG } = H;

let failures = 0;
let checks = 0;
function check(name, cond, extra) {
  checks++;
  if (cond) return;
  failures++;
  console.log("  FAIL " + name + (extra !== undefined ? "  -> " + (typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 700) : ""));
}

const { jobs, state, ECONOMY } = srv;
const DEFAULT_EXPIRE = ECONOMY.jobExpireMs;
const DEFAULT_STALLED = ECONOMY.stalledAfterMs;

function reset() {
  jobs.clear();
  state.commandResolvers.clear();
  state.lateInbox.length = 0;
  ECONOMY.jobExpireMs = DEFAULT_EXPIRE;
  ECONOMY.stalledAfterMs = DEFAULT_STALLED;
}
// A record the way dispatch creates it, then adjusted by the test.
function mk(id, fields) {
  const now = Date.now();
  const job = Object.assign({ id, status: "running", progress: [], result: undefined, error: null, clientId: "c1", origin: "o_a", detached: "escalated", finishedAt: null, claimed: false, effects: null, kind: "EXECUTE", createdAt: now, updatedAt: now }, fields || {});
  jobs.set(id, job);
  return job;
}
const ids = (n, p) => Array.from({ length: n }, (_, i) => (p || "1") + ":" + i);

async function units() {
  console.log("== defaults, origin, env ==");
  check("stalledAfterMs default 120000", DEFAULT_STALLED === 120000, DEFAULT_STALLED);
  check("jobExpireMs default 30 min", DEFAULT_EXPIRE === 30 * 60 * 1000, DEFAULT_EXPIRE);
  check("JOBS_MAX is 200", srv.JOBS_MAX === 200);
  const cfg = path.join(__dirname, "..", "figma", "lib", "config.js");
  const env = { ...process.env, FIGMA_MCP_STALLED_MS: "777", FIGMA_MCP_JOB_EXPIRE_MS: "4242" };
  const out = spawnSync(process.execPath, ["-e", `const c=require(${JSON.stringify(cfg)});console.log(JSON.stringify([c.ECONOMY.stalledAfterMs,c.ECONOMY.jobExpireMs,c.ORIGIN_ID]))`], { env, encoding: "utf-8" });
  const [s1, ex1, o1] = JSON.parse(out.stdout.trim());
  check("FIGMA_MCP_STALLED_MS and FIGMA_MCP_JOB_EXPIRE_MS are read", s1 === 777 && ex1 === 4242, out.stdout + out.stderr);
  const out2 = spawnSync(process.execPath, ["-e", `console.log(require(${JSON.stringify(cfg)}).ORIGIN_ID)`], { env: process.env, encoding: "utf-8" });
  check("ORIGIN_ID is random per process", /^o_[0-9a-f]{12}$/.test(o1) && o1 !== out2.stdout.trim() && o1 !== srv.ORIGIN_ID && /^o_[0-9a-f]{12}$/.test(srv.ORIGIN_ID), [o1, out2.stdout.trim(), srv.ORIGIN_ID]);

  console.log("== new record ==");
  reset();
  const j = srv.touchJob("cmd_new", { kind: "EXECUTE" });
  check("new record: running, origin null, detached null, finishedAt null, claimed false, effects null",
    j.status === "running" && j.origin === null && j.detached === null && j.finishedAt === null && j.claimed === false && j.effects === null && Array.isArray(j.progress), j);

  console.log("== waiting caller: result goes to the resolver, record deleted at once ==");
  reset();
  mk("w1", { detached: null });
  let got = null;
  state.commandResolvers.set("w1", (d) => { got = d; });
  srv.settleCommand({ id: "w1", success: true, created: ids(3), checkpointId: "cp" });
  check("resolver called with the data, record gone, resolver gone", got && got.id === "w1" && !jobs.has("w1") && !state.commandResolvers.has("w1"));
  mk("w2", { detached: null });
  state.commandResolvers.set("w2", () => {});
  srv.settleCommand({ id: "w2", success: false, error: "boom" });
  check("error with a waiting caller also deletes the record", !jobs.has("w2"));

  console.log("== settle without resolver: keep or drop ==");
  reset();
  mk("e1", { detached: "escalated", kind: "EXECUTE" });
  const before = Date.now();
  srv.settleCommand({ id: "e1", success: true, result: "r", created: ids(25), modified: ["9:1", "9:2"], checkpointId: "cp_7" });
  const e1 = jobs.get("e1");
  check("escalated EXECUTE is kept as done", e1 && e1.status === "done" && e1.result && e1.result.result === "r", e1 && e1.status);
  check("finishedAt is set, claimed false", e1.finishedAt >= before && e1.finishedAt <= Date.now() && e1.claimed === false, e1.finishedAt);
  check("effects: first 20 ids, createdCount 25, modified count 2, checkpointId", e1.effects && e1.effects.created.length === 20 && e1.effects.created[0] === "1:0" && e1.effects.created[19] === "1:19" && e1.effects.createdCount === 25 && e1.effects.modified === 2 && e1.effects.checkpointId === "cp_7", e1.effects);
  check("exactly 20 created ids are all kept", (() => { srv.touchJob("e1b", { kind: "EXECUTE", detached: "escalated" }); srv.settleCommand({ id: "e1b", success: true, created: ids(20) }); const f = jobs.get("e1b").effects; return f.created.length === 20 && f.createdCount === 20; })());
  check("checkpoint_id (snake case) is understood too", (() => { srv.touchJob("e1c", { kind: "EXECUTE", detached: "escalated" }); srv.settleCommand({ id: "e1c", success: true, checkpoint_id: "cp_s" }); return jobs.get("e1c").effects.checkpointId === "cp_s"; })());
  check("no traces: effects stay null", (() => { srv.touchJob("e1d", { kind: "EXECUTE", detached: "escalated" }); srv.settleCommand({ id: "e1d", success: true, created: [], modified: [] }); return jobs.get("e1d").effects === null; })());

  srv.touchJob("e2", { kind: "EXECUTE", detached: "escalated" });
  srv.settleCommand({ id: "e2", success: false, error: "script threw", code: "SCRIPT_ERROR", line: 3 });
  check("escalated EXECUTE that failed is kept as error with code and line", jobs.get("e2") && jobs.get("e2").status === "error" && jobs.get("e2").code === "SCRIPT_ERROR" && jobs.get("e2").line === 3 && jobs.get("e2").error === "script threw");

  srv.touchJob("r1", { kind: "SCREENSHOT", detached: "timeout" });
  srv.settleCommand({ id: "r1", success: true, result: "img" });
  check("abandoned read without traces is dropped", !jobs.has("r1"));
  srv.touchJob("r2", { kind: "READ_CANVAS", detached: "timeout" });
  srv.settleCommand({ id: "r2", success: false, error: "nope" });
  check("abandoned read that failed is dropped too", !jobs.has("r2"));
  srv.touchJob("r3", { kind: "EXECUTE", detached: "timeout", description: "Inspect" });
  srv.settleCommand({ id: "r3", success: true, result: "outline" });
  check("hard-timeout EXECUTE without traces (an inspect) is dropped", !jobs.has("r3"));
  for (const [name, extra] of [["created", { created: ["4:1"] }], ["modified", { modified: ["4:2"] }], ["checkpointId", { checkpointId: "cp_x" }]]) {
    srv.touchJob("t_" + name, { kind: "INSERT_SVG", detached: "timeout" });
    srv.settleCommand({ id: "t_" + name, success: true, ...extra });
    check("abandoned insert with only " + name + " is kept", jobs.has("t_" + name) && jobs.get("t_" + name).status === "done");
  }
  srv.touchJob("t_exec", { kind: "EXECUTE", detached: "timeout" });
  srv.settleCommand({ id: "t_exec", success: true, created: ["4:9"] });
  check("hard-timeout EXECUTE with traces is kept", jobs.has("t_exec"));
  srv.touchJob("r4", { kind: "INSERT_SVG", detached: "escalated" });
  srv.settleCommand({ id: "r4", success: true });
  check("non-EXECUTE without traces is dropped even when escalated", !jobs.has("r4"));

  console.log("== second answer to a settled job is ignored ==");
  reset();
  mk("d1", { status: "done", result: { id: "d1", result: "first" }, finishedAt: 1000, claimed: true, effects: { created: ["1:1"], createdCount: 1, modified: 0, checkpointId: null } });
  srv.settleCommand({ id: "d1", success: true, result: "second", created: ["5:5"] });
  check("done stays as it was (result, claimed, finishedAt)", jobs.get("d1").result.result === "first" && jobs.get("d1").claimed === true && jobs.get("d1").finishedAt === 1000);
  mk("d2", { status: "error", code: "SCRIPT_ERROR", error: "x", finishedAt: 1000 });
  srv.settleCommand({ id: "d2", success: true, created: ["5:5"] });
  check("a real error is not overwritten", jobs.get("d2").status === "error" && jobs.get("d2").code === "SCRIPT_ERROR");

  console.log("== orphan: a result for an id the journal never had ==");
  reset();
  srv.settleCommand({ id: "ghost0", success: true, result: "x" });
  check("no traces: nothing is created", !jobs.has("ghost0"));
  srv.settleCommand({ id: "ghost0b", success: false, error: "x" });
  check("no traces, error: nothing is created", !jobs.has("ghost0b"));
  for (const [name, extra] of [["created", { created: ["7:1"] }], ["modified", { modified: ["7:2"] }], ["checkpointId", { checkpointId: "cp_o" }]]) {
    srv.settleCommand({ id: "ghost_" + name, success: true, ...extra }, { id: "ws_9", fileName: "Design.fig" });
    const o = jobs.get("ghost_" + name);
    check("orphan with " + name, o && o.orphan === true && o.status === "done" && o.target === "Design.fig" && o.claimed === false && o.origin === null && o.finishedAt > 0, o);
  }
  srv.settleCommand({ id: "ghost_nofile", success: true, created: ["7:1"] });
  check("orphan from /result (no socket) has no file", jobs.get("ghost_nofile").target === null);
  srv.settleCommand({ id: "ghost_err", success: false, error: "late fail", checkpointId: "cp_e" });
  check("failed orphan with a checkpoint is kept as error", jobs.get("ghost_err") && jobs.get("ghost_err").status === "error");

  console.log("== PROGRESS-style touch of unknown ids is the caller's business; known record keeps progress ==");
  reset();
  check("touchJob on an unknown id creates a running record (dispatch relies on it)", srv.touchJob("p1", {}).status === "running");

  console.log("== plugin lost ==");
  reset();
  mk("l1", { clientId: "cA", detached: "escalated" });
  mk("l2", { clientId: "cA", detached: "timeout", kind: "EXECUTE" });
  mk("l3", { clientId: "cA", detached: "timeout", kind: "SCREENSHOT" });
  mk("l4", { clientId: "cA", detached: "escalated", kind: "INSERT_SVG" });
  mk("l5", { clientId: "cB", detached: "escalated" });
  mk("l6", { clientId: "cA", status: "done", detached: "escalated", result: { id: "l6" } });
  mk("l7", { clientId: "cA", detached: null });
  let rejected = null;
  state.commandResolvers.set("l7", (d) => { rejected = d; });
  srv.failCommandsOfClient("cA");
  check("escalated EXECUTE becomes error PLUGIN_DISCONNECTED and stays", jobs.get("l1") && jobs.get("l1").status === "error" && jobs.get("l1").code === "PLUGIN_DISCONNECTED" && jobs.get("l1").claimed === false && jobs.get("l1").finishedAt > 0, jobs.get("l1"));
  check("lost error text asks for a cheap read", /cheap read/.test(jobs.get("l1").error));
  check("hard-timeout EXECUTE without traces is dropped on loss", !jobs.has("l2"));
  check("abandoned read is dropped on loss", !jobs.has("l3"));
  check("escalated non-EXECUTE without traces is dropped on loss", !jobs.has("l4"));
  check("another client's job is untouched", jobs.get("l5").status === "running" && jobs.get("l5").code === undefined);
  check("a finished job is untouched", jobs.get("l6").status === "done");
  check("a waiting caller gets the PLUGIN_DISCONNECTED answer and its record is deleted", rejected && rejected.code === "PLUGIN_DISCONNECTED" && rejected.success === false && !jobs.has("l7") && !state.commandResolvers.has("l7"));

  console.log("== truth wins over lost / expired ==");
  reset();
  mk("t1", { clientId: "cA" });
  srv.failCommandsOfClient("cA");
  jobs.get("t1").claimed = true; // the model was already told "lost"
  srv.settleCommand({ id: "t1", success: true, result: "really done", created: ["8:1"] });
  const t1 = jobs.get("t1");
  check("lost -> done: status, code, claimed reset, effects", t1.status === "done" && t1.code === null && t1.claimed === false && t1.effects.createdCount === 1 && t1.error === null, t1);
  mk("t2", { status: "error", code: "JOB_EXPIRED", error: "expired", claimed: true, finishedAt: 5 });
  srv.settleCommand({ id: "t2", success: false, error: "script failed", code: "SCRIPT_ERROR" });
  check("expired -> error: the real error replaces the guess, claimed reset", jobs.get("t2").code === "SCRIPT_ERROR" && jobs.get("t2").error === "script failed" && jobs.get("t2").claimed === false && jobs.get("t2").finishedAt > 5);
  mk("t3", { status: "error", code: "JOB_EXPIRED", error: "expired", claimed: true });
  srv.settleCommand({ id: "t3", success: true, result: "ok" });
  check("expired -> done with no traces: EXECUTE record stays done", jobs.get("t3").status === "done" && jobs.get("t3").code === null && jobs.get("t3").claimed === false);

  console.log("== lazy expiry (sweepJobs) ==");
  reset();
  ECONOMY.jobExpireMs = 1000;
  const T = Date.now();
  mk("x_edge", { createdAt: T - 1000 });
  mk("x_over", { createdAt: T - 1001 });
  mk("x_prog", { createdAt: T - 5000, progress: [{ step: 1, ts: T - 500 }] });
  mk("x_prog_old", { createdAt: T - 5000, progress: [{ step: 1, ts: T - 1001 }] });
  mk("x_wait", { createdAt: T - 9000, detached: null });
  state.commandResolvers.set("x_wait", () => {});
  mk("x_read", { createdAt: T - 9000, kind: "SCREENSHOT", detached: "timeout" });
  mk("x_done", { createdAt: T - 9000, status: "done" });
  srv.sweepJobs(T);
  check("silent exactly jobExpireMs is not expired", jobs.get("x_edge").status === "running");
  const xo = jobs.get("x_over");
  check("silent jobExpireMs+1 -> error JOB_EXPIRED, finishedAt = now, claimed false, text", xo.status === "error" && xo.code === "JOB_EXPIRED" && xo.finishedAt === T && xo.claimed === false && /outcome is unknown/.test(xo.error), xo);
  check("recent progress() keeps it alive", jobs.get("x_prog").status === "running");
  check("old progress() does not", jobs.get("x_prog_old").code === "JOB_EXPIRED");
  check("a job with a waiting caller never expires", jobs.get("x_wait").status === "running");
  check("a silent abandoned read without traces just disappears", !jobs.has("x_read"));
  check("a finished job is not touched by sweep", jobs.get("x_done").status === "done" && jobs.get("x_done").code === undefined);
  ECONOMY.jobExpireMs = 0;
  mk("x_off", { createdAt: T - 1e9 });
  srv.sweepJobs(T);
  check("jobExpireMs 0 turns expiry off", jobs.get("x_off").status === "running");
  ECONOMY.jobExpireMs = 1000;
  jobs.clear();
  mk("x_old2", { createdAt: Date.now() - 5000 });
  srv.touchJob("x_new", {});
  check("creating a record sweeps (no timers)", jobs.get("x_old2").code === "JOB_EXPIRED");
  jobs.clear();
  mk("x_old3", { createdAt: Date.now() - 5000 });
  srv.takeLate("o_a");
  check("picking late jobs sweeps", jobs.get("x_old3").code === "JOB_EXPIRED");
  jobs.clear();
  mk("x_old4", { createdAt: Date.now() - 5000 });
  const snap = await srv.readJobSnapshot("x_old4", 0);
  check("job_status sweeps and returns the expired error, record stays claimed", snap.ok === false && snap.code === "JOB_EXPIRED" && jobs.get("x_old4").claimed === true, snap);
  const snap2 = await srv.readJobSnapshot("x_old4", 0);
  check("a second read of an expired job still answers (not JOB_NOT_FOUND)", snap2.code === "JOB_EXPIRED");

  console.log("== eviction at 200 ==");
  reset();
  ECONOMY.jobExpireMs = 0;
  mk("r_oldest", { createdAt: 100 });
  mk("f_a", { status: "done", createdAt: 1000 });
  mk("f_b", { status: "error", createdAt: 2000 });
  mk("c_new", { status: "done", claimed: true, createdAt: 5000 });
  mk("c_old", { status: "done", claimed: true, createdAt: 3000 });
  for (let i = 0; jobs.size < 199; i++) mk("fill" + i, { createdAt: 10000 + i });
  srv.touchJob("n0", {});
  check("exactly 200 records: nothing evicted", jobs.size === 200 && jobs.has("c_old") && jobs.has("r_oldest"), jobs.size);
  const order = [];
  for (const expected of ["c_old", "c_new", "f_a", "f_b", "r_oldest", "fill0"]) {
    const had = new Set(jobs.keys());
    srv.touchJob("n_" + expected, {});
    const gone = [...had].filter((k) => !jobs.has(k));
    order.push(gone.join(","));
    check("201st record evicts exactly " + expected, gone.length === 1 && gone[0] === expected && jobs.size === 200 && jobs.has("n_" + expected), gone);
  }
  reset();
  ECONOMY.jobExpireMs = 0;
  for (let i = 0; i < 200; i++) mk("same" + i, { createdAt: 50 });
  srv.touchJob("keepme", {});
  check("the new record is never the one evicted", jobs.has("keepme") && jobs.size === 200);
  reset();
  ECONOMY.jobExpireMs = 0;
  mk("cl_waiting", { status: "done", claimed: true, createdAt: 1 });
  mk("cl_running_claimed_newer", { createdAt: 2 });
  for (let i = 0; jobs.size < 200; i++) mk("z" + i, { status: "done", createdAt: 100 + i });
  srv.touchJob("n1", {});
  check("claimed beats an older unclaimed finished one", !jobs.has("cl_waiting") && jobs.has("z0"));
  reset();

  console.log("== findBusyJob ==");
  mk("b_timeout", { createdAt: 1000, detached: "timeout" });
  mk("b_esc", { createdAt: 2000, detached: "escalated" });
  mk("b_wait", { createdAt: 1500, detached: null });
  mk("b_done", { createdAt: 500, status: "done" });
  mk("b_other", { createdAt: 400, clientId: "cX" });
  mk("b_noclient", { createdAt: 450, clientId: null });
  check("oldest busy: abandoned, finished and other-client jobs skipped; no-client job counts", srv.findBusyJob("c1", "none", 0).id === "b_noclient", srv.findBusyJob("c1", "none", 0));
  jobs.delete("b_noclient");
  check("abandoned (timeout) jobs are not counted", srv.findBusyJob("c1", "none", 0).id === "b_wait");
  check("exceptId is skipped", srv.findBusyJob("c1", "b_wait", 0).id === "b_esc");
  check("startedBefore: equal counts, later does not", srv.findBusyJob("c1", "none", 1500).id === "b_wait" && srv.findBusyJob("c1", "none", 1499) === null);
  check("clientId null matches any client", srv.findBusyJob(null, "none", 0).id === "b_other");
  jobs.delete("b_wait"); jobs.delete("b_esc");
  check("only abandoned jobs left -> no busy job", srv.findBusyJob("c1", "none", 0) === null);
  reset();

  console.log("== takeLate ==");
  const NOW = Date.now();
  const fx = (n) => ({ created: ids(n), createdCount: n, modified: 0, checkpointId: null });
  mk("L_new", { status: "done", finishedAt: NOW - 1000, effects: fx(2) });
  mk("L_old", { status: "done", finishedAt: NOW - 42000, effects: fx(14), description: "Build cards" });
  mk("L_mid", { status: "done", finishedAt: NOW - 5000, effects: fx(1) });
  const first = srv.takeLate("o_a");
  check("oldest first, more counts the rest", first && first.job_id === "L_old" && first.more === 2, first);
  check("block data: status done, description, ids, counts", first.status === "done" && first.description === "Build cards" && first.created.length === 14 && first.created_count === 14 && first.modified_count === 0 && first.checkpoint_id === null && first.orphan === false && first.error === null, first);
  check("finished_s_ago", Math.abs(first.finished_s_ago - 42) <= 1, first.finished_s_ago);
  mk("L_hour", { status: "done", finishedAt: NOW - 7200000, effects: fx(1) });
  check("finished_s_ago is seconds (2 h = 7200)", Math.abs(srv.takeLate("o_a").finished_s_ago - 7200) <= 1);
  check("claimed set, record stays", jobs.get("L_old").claimed === true && jobs.has("L_old"));
  check("next call gives the next oldest, more 1", (() => { const b = srv.takeLate("o_a"); return b.job_id === "L_mid" && b.more === 1; })());
  check("then the last, more 0", (() => { const b = srv.takeLate("o_a"); return b.job_id === "L_new" && b.more === 0; })());
  check("then nothing", srv.takeLate("o_a") === null);
  reset();
  mk("O1", { status: "done", finishedAt: NOW, effects: fx(1), origin: "o_b" });
  check("another origin gets nothing", srv.takeLate("o_a") === null && jobs.get("O1").claimed === false);
  check("origin null (old proxy) gets nothing", srv.takeLate(null) === null && srv.takeLate(undefined) === null && srv.takeLate("") === null);
  mk("O2", { status: "done", finishedAt: NOW, effects: fx(1), origin: null });
  check("a job without origin (old proxy) is never handed out", srv.takeLate("o_a") === null && srv.takeLate(null) === null && jobs.get("O2").claimed === false);
  mk("O3", { status: "done", finishedAt: NOW, effects: fx(1), origin: "o_a", orphan: true, target: "Design.fig" });
  const orp = srv.takeLate("o_zzz");
  check("an orphan goes to whoever asks first, with the file name", orp && orp.job_id === "O3" && orp.orphan === true && orp.file === "Design.fig", orp);
  check("an orphan is still withheld from an origin-less caller", (() => { mk("O4", { status: "done", finishedAt: NOW, effects: fx(1), orphan: true, origin: null }); const r = srv.takeLate(null); jobs.get("O4").claimed = true; return r === null; })());
  reset();
  mk("S_run", { effects: fx(1) });
  mk("S_claimed", { status: "done", claimed: true, finishedAt: NOW, effects: fx(1) });
  mk("S_wait", { status: "done", finishedAt: NOW, effects: fx(1), detached: null });
  state.commandResolvers.set("S_wait", () => {});
  mk("S_read", { status: "done", kind: "SCREENSHOT", finishedAt: NOW });
  mk("S_nothing", { status: "done", kind: "EXECUTE", detached: "timeout", finishedAt: NOW });
  mk("S_self", { status: "done", finishedAt: NOW, effects: fx(1) });
  check("running, claimed, waited, no-news reads, hard-timeout without traces and exceptId are all skipped", srv.takeLate("o_a", "S_self") === null);
  check("without exceptId the same record is handed out", srv.takeLate("o_a").job_id === "S_self");
  reset();
  mk("K_exec", { status: "done", kind: "EXECUTE", detached: "escalated", finishedAt: NOW });
  check("EXECUTE without traces is told", srv.takeLate("o_a").job_id === "K_exec");
  mk("K_read", { status: "done", kind: "INSERT_SVG", detached: "timeout", finishedAt: NOW, effects: { created: [], createdCount: 0, modified: 3, checkpointId: null } });
  const kr = srv.takeLate("o_a");
  check("a read with only modified traces is told, modified_count 3, was timeout", kr.job_id === "K_read" && kr.modified_count === 3 && kr.was === "timeout", kr);
  reset();
  mk("M_lost", { status: "error", code: "PLUGIN_DISCONNECTED", error: "gone", finishedAt: NOW });
  mk("M_exp", { status: "error", code: "JOB_EXPIRED", error: "old", finishedAt: NOW + 1 });
  mk("M_err", { status: "error", code: "SCRIPT_ERROR", error: "bad thing", finishedAt: NOW + 2 });
  const m1 = srv.takeLate("o_a"), m2 = srv.takeLate("o_a"), m3 = srv.takeLate("o_a");
  check("status mapping: lost, expired, error (+ error text), none of lost/expired carries error", m1.status === "lost" && m1.error === null && m2.status === "expired" && m2.error === null && m3.status === "error" && m3.error === "bad thing", [m1, m2, m3]);
  reset();
  mk("W_stalled_r", { status: "done", createdAt: NOW - 1000, finishedAt: NOW, stalledReports: 1, effects: fx(1) });
  mk("W_quiet", { status: "done", createdAt: NOW - 200000, finishedAt: NOW + 1, effects: fx(1) });
  mk("W_quick", { status: "done", createdAt: NOW - 60000, finishedAt: NOW + 2, effects: fx(1) });
  mk("W_prog", { status: "done", createdAt: NOW - 600000, progress: [{ ts: NOW - 30000 }], finishedAt: NOW + 3, effects: fx(1) });
  const ws = [1, 2, 3, 4].map(() => srv.takeLate("o_a").was);
  check("was: stalledReports -> stalled, quiet > 120s -> stalled, quick -> running, recent progress -> running", ws.join() === "stalled,stalled,running,running", ws);
  reset();
  ECONOMY.stalledAfterMs = 1000;
  mk("W_edge", { status: "done", createdAt: NOW - 1000, finishedAt: NOW, effects: fx(1) });
  mk("W_edge2", { status: "done", createdAt: NOW - 1001, finishedAt: NOW + 1, effects: fx(1) });
  check("was: stalled only past stalledAfterMs", srv.takeLate("o_a").was === "running" && srv.takeLate("o_a").was === "stalled");
  reset();
  mk("tie_b", { status: "done", createdAt: NOW - 10, finishedAt: NOW, effects: fx(1) });
  mk("tie_a", { status: "done", createdAt: NOW - 20, finishedAt: NOW, effects: fx(1) });
  check("same finishedAt: the earlier started goes first", srv.takeLate("o_a").job_id === "tie_a");
  reset();

  console.log("== readJobSnapshot ==");
  mk("s_done", { status: "done", result: { id: "s_done", result: 1 } });
  const sd = await srv.readJobSnapshot("s_done", 0);
  check("done is returned and then forgotten", sd.ok && sd.status === "done" && !jobs.has("s_done"));
  mk("s_err", { status: "error", code: "SCRIPT_ERROR", error: "x" });
  const se = await srv.readJobSnapshot("s_err", 0);
  check("script error is returned and forgotten", se.ok === false && se.code === "SCRIPT_ERROR" && !jobs.has("s_err"));
  mk("s_lost", { status: "error", code: "PLUGIN_DISCONNECTED", error: "gone" });
  const sl = await srv.readJobSnapshot("s_lost", 0);
  check("lost is returned, stays, claimed", sl.ok === false && sl.code === "PLUGIN_DISCONNECTED" && jobs.has("s_lost") && jobs.get("s_lost").claimed === true, sl);
  check("a lost job already read is not handed out as late", srv.takeLate("o_a") === null);
  reset();
  ECONOMY.stalledAfterMs = 1000;
  mk("s_run", { createdAt: Date.now() - 5000 });
  const sr = await srv.readJobSnapshot("s_run", 0);
  check("running and quiet past stalledAfterMs -> stalled", sr.stalled === true && sr.stop === true, sr);
  mk("s_run2", { createdAt: Date.now() - 100 });
  const sr2 = await srv.readJobSnapshot("s_run2", 0);
  check("running and recent -> plain running", sr2.ok === true && sr2.status === "running" && sr2.job_id === "s_run2" && sr2.stalled === undefined, sr2);
  reset();
  mk("s_full", { status: "done", result: { id: "s_full" }, script: "return 1", target: "Design.fig" });
  const sf = await srv.readJobSnapshot("s_full", 0);
  check("done snapshot carries script and target", sf.script === "return 1" && sf.target === "Design.fig" && sf.response.id === "s_full", sf);
  mk("s_bare", { status: "done", result: { id: "s_bare" } });
  const sb = await srv.readJobSnapshot("s_bare", 0);
  check("done snapshot without script/target gives nulls", sb.script === null && sb.target === null);

  console.log("== long-poll wake-up ==");
  mk("p_wait", { createdAt: Date.now() });
  let t0 = Date.now();
  const waiting = srv.readJobSnapshot("p_wait", 5000);
  await sleep(80);
  srv.touchJob("p_wait", { status: "done", result: { id: "p_wait" } });
  const woke = await waiting;
  check("a long poll returns as soon as the job finishes", woke.status === "done" && Date.now() - t0 < 2000, Date.now() - t0);
  t0 = Date.now();
  const unknown = await srv.readJobSnapshot("no_such_job", 3000);
  check("an unknown id does not block", unknown.code === "JOB_NOT_FOUND" && Date.now() - t0 < 500);
  mk("p_done", { status: "done", result: { id: "p_done" } });
  t0 = Date.now();
  await srv.readJobSnapshot("p_done", 3000);
  check("a finished job does not block", Date.now() - t0 < 500);
  mk("p_zero", { createdAt: Date.now() });
  t0 = Date.now();
  await srv.readJobSnapshot("p_zero", 0);
  check("wait_ms 0 does not block", Date.now() - t0 < 500);
  reset();
}

// ---------------------------------------------------------------------------
// proxy side: origin on the wire, __late folded into state.lateInbox
// ---------------------------------------------------------------------------
async function proxyUnits() {
  console.log("== proxy: origin sent, __late folded into lateInbox ==");
  reset();
  const seen = [];
  let mode = "ok";
  const fake = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, method: req.method, body: body ? JSON.parse(body) : null });
      const late = { job_id: "cmd_late", status: "done", more: 0 };
      if (mode === "err") { res.writeHead(500, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ success: false, error: "no plugin", code: "NO_CONNECTED_CLIENTS", __late: late })); }
      res.writeHead(200, { "Content-Type": "application/json" });
      if (mode === "plain") return res.end(JSON.stringify({ success: true, result: 1 }));
      res.end(JSON.stringify(req.url.indexOf("/job") === 0 ? { ok: true, status: "done", __late: late } : { success: true, result: 1, __late: late }));
    });
  });
  await new Promise((r) => fake.listen(18831, "127.0.0.1", r));
  state.isBridgeMaster = false;
  try {
    const r = await srv.sendCommandToPlugin({ code: "x", description: "d" }, 2000, { escalateMs: 300 });
    check("proxy /execute body carries origin = ORIGIN_ID and escalateMs", seen[0].url === "/execute" && seen[0].body.origin === srv.ORIGIN_ID && seen[0].body.escalateMs === 300 && seen[0].body.timeoutMs === 2000, seen[0]);
    check("origin is also sent without escalateMs", (await srv.sendCommandToPlugin({ code: "x" }, 2000), seen[1].body.origin === srv.ORIGIN_ID && seen[1].body.escalateMs === undefined));
    check("__late moved to state.lateInbox and removed from the reply", r.__late === undefined && r.result === 1 && state.lateInbox.length === 2 && state.lateInbox[0].job_id === "cmd_late", [r, state.lateInbox]);
    state.lateInbox.length = 0;
    const j = await srv.proxyToMaster("/job?id=cmd_1&wait_ms=0");
    check("/job gets origin appended, __late folded", /^\/job\?id=cmd_1&wait_ms=0&origin=o_[0-9a-f]{12}$/.test(seen[2].url) && seen[2].url.endsWith("origin=" + srv.ORIGIN_ID) && j.__late === undefined && j.status === "done" && state.lateInbox.length === 1, [seen[2], j]);
    state.lateInbox.length = 0;
    await srv.proxyToMaster("/status");
    check("other paths do not get origin", seen[3].url === "/status" && state.lateInbox.length === 1);
    state.lateInbox.length = 0;
    mode = "plain";
    await srv.sendCommandToPlugin({ code: "x" }, 2000);
    check("a reply without __late leaves the inbox empty", state.lateInbox.length === 0);
    mode = "err";
    let err = null;
    try { await srv.sendCommandToPlugin({ code: "x" }, 2000); } catch (e) { err = e; }
    check("an error reply still delivers __late, error code kept", err && err.code === "NO_CONNECTED_CLIENTS" && state.lateInbox.length === 1 && state.lateInbox[0].job_id === "cmd_late", [err && err.code, state.lateInbox]);
  } finally {
    state.isBridgeMaster = false;
    await new Promise((r) => fake.close(r));
    reset();
  }
}

// ---------------------------------------------------------------------------
// live master + fake plugin, raw HTTP the way a proxy talks
// ---------------------------------------------------------------------------
const PORT = 18830;
async function live() {
  console.log("== live server: late results over /execute and /job ==");
  const server = startServer({ port: PORT, env: {
    FIGMA_MCP_STALLED_MS: "600", FIGMA_MCP_JOB_EXPIRE_MS: "2500", FIGMA_MCP_ESCALATE_MS: "300",
    FIGMA_MCP_TIMEOUT_MS: "1500", FIGMA_MCP_TIMEOUT_FAST_MS: "1500", FIGMA_MCP_TIMEOUT_HEAVY_MS: "2500"
  } });
  const plugins = [];
  try {
    await server.initialize();
    await waitMaster(server);
    const base = `http://127.0.0.1:${PORT}`;
    const hdr = { "Content-Type": "application/json", "X-Bridge-Token": server.token };
    const post = async (body) => { const r = await fetch(base + "/execute", { method: "POST", headers: hdr, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
    const getJob = async (id, origin) => {
      const r = await fetch(`${base}/job?id=${encodeURIComponent(id)}&wait_ms=0${origin ? "&origin=" + origin : ""}`, { headers: hdr });
      return r.json();
    };
    const quick = (origin) => post({ code: "return 1", description: "quick", ...(origin ? { origin } : {}) });

    const plans = {};
    const connect = async (n) => {
      const p = startFakePlugin({ port: PORT, token: server.token, handler: (cmd) => (plans[cmd.description] ? plans[cmd.description](cmd) : { result: "ok" }) });
      plugins.push(p);
      await p.opened;
      await waitClients(server, n);
      return p;
    };
    const delayed = (ms, out) => () => sleep(ms).then(() => out);
    let plugin = await connect(1);
    const idOf = (desc) => plugins.flatMap((p) => p.received).find((c) => c.description === desc).id;

    // S1: escalated, finishes after it was reported stalled
    plans.build = delayed(900, { result: { built: true }, created: ["1:1", "1:2", "1:3"], modified: ["1:9"], checkpointId: "cp_1" });
    const esc = await post({ code: "x", description: "build", origin: "o_A", timeoutMs: 5000, escalateMs: 300 });
    check("S1: escalated reply", esc.status === 200 && esc.body.__escalated === true && /^cmd_/.test(esc.body.job_id) && esc.body.__late === undefined, esc);
    const jid = esc.body.job_id;
    const running = await getJob(jid, "o_A");
    check("S1: while running /job says running, no __late", running.status === "running" && running.__late === undefined, running);
    await sleep(1100);
    const other = await quick("o_B");
    check("S1: another origin gets no __late", other.status === 200 && other.body.__late === undefined, other);
    check("S1: ordinary reply has exactly the plugin's keys (byte-for-byte no extras)", !("__late" in other.body) && other.body.success === true && other.body.result === "ok", other.body);
    const lateA = await quick("o_A");
    const lt = lateA.body.__late;
    check("S1: the owner gets __late: done, ids, counts, checkpoint, was stalled", lt && lt.job_id === jid && lt.status === "done" && lt.was === "stalled" && lt.created.join() === "1:1,1:2,1:3" && lt.created_count === 3 && lt.modified_count === 1 && lt.checkpoint_id === "cp_1" && lt.more === 0 && lt.description === "build" && lt.orphan === false, lateA.body);
    check("S1: the same call still carries its own result", lateA.body.success === true && lateA.body.result === "ok");
    const again = await quick("o_A");
    check("S1: told once", again.body.__late === undefined);
    const full = await getJob(jid, "o_A");
    check("S1: the full result is still there via job_status, once", full.ok && full.status === "done" && full.response && full.response.result.built === true && full.__late === undefined, full);
    const gone = await getJob(jid);
    check("S1: then forgotten", gone.code === "JOB_NOT_FOUND");

    // S1b: finishes soon after escalation (not stalled)
    plans.fastbuild = delayed(450, { result: 1, created: ["2:1"] });
    const esc2 = await post({ code: "x", description: "fastbuild", origin: "o_A2", timeoutMs: 5000, escalateMs: 300 });
    await sleep(700);
    const l2 = (await quick("o_A2")).body.__late;
    check("S1b: finished within stalledAfterMs -> was running", l2 && l2.job_id === esc2.body.job_id && l2.was === "running" && l2.created_count === 1, l2);

    // S1c: a late job is also delivered with an /job reply for another job (and not for itself)
    plans.c1 = delayed(500, { result: 1, created: ["3:1"] });
    const esc3 = await post({ code: "x", description: "c1", origin: "o_C", timeoutMs: 5000, escalateMs: 300 });
    await sleep(700);
    const self = await getJob(esc3.body.job_id, "o_C");
    check("S1c: polling the job itself does not make it a late block", self.status === "done" && self.__late === undefined, self);
    plans.c2 = delayed(500, { result: 1, created: ["3:2"] });
    const esc4 = await post({ code: "x", description: "c2", origin: "o_C", timeoutMs: 5000, escalateMs: 300 });
    await sleep(700);
    const viaJob = await getJob("cmd_nonexistent", "o_C");
    check("S1c: /job for an unknown id (JOB_NOT_FOUND) still carries __late", viaJob.code === "JOB_NOT_FOUND" && viaJob.__late && viaJob.__late.job_id === esc4.body.job_id, viaJob);

    // S2: hard timeout of an insert; the plugin answers later
    plans.ins = delayed(900, { result: { inserted: true }, created: ["4:1"], checkpointId: "cp_2" });
    const t0 = Date.now();
    const ins = await post({ type: "INSERT_COMPONENT_INSTANCE", description: "ins", origin: "o_D", timeoutMs: 500 });
    check("S2: caller gets the timeout error, no __late", ins.status === 500 && ins.body.code === "BRIDGE_OFFLINE" && ins.body.__late === undefined && Date.now() - t0 < 2000, ins);
    const insId = idOf("ins");
    const insRun = await getJob(insId);
    check("S2: the abandoned insert stays in the journal as running", insRun.status === "running" && insRun.job_id === insId, insRun);
    await sleep(700);
    const insLate = (await quick("o_D")).body.__late;
    check("S2: result after the hard timeout arrives as late, was timeout, ids kept", insLate && insLate.job_id === insId && insLate.status === "done" && insLate.was === "timeout" && insLate.created.join() === "4:1" && insLate.checkpoint_id === "cp_2", insLate);

    // S2b: abandoned reads leave nothing
    plans.shot = delayed(700, { result: "img" });
    plans.Inspect = delayed(700, { result: "outline" });
    plans.svg = delayed(700, { result: 1, modified: ["5:1"] });
    const sh = await post({ type: "SCREENSHOT", description: "shot", origin: "o_E", timeoutMs: 300 });
    const ip = await post({ code: "x", description: "Inspect", origin: "o_E", timeoutMs: 300 });
    const sv = await post({ type: "INSERT_SVG", description: "svg", origin: "o_E", timeoutMs: 300 });
    check("S2b: all three timed out", sh.status === 500 && ip.status === 500 && sv.status === 500);
    await sleep(900);
    const lE = (await quick("o_E")).body.__late;
    const shGet = await getJob(idOf("shot"));
    const ipGet = await getJob(idOf("Inspect"));
    check("S2b: abandoned screenshot and inspect without traces are gone", shGet.code === "JOB_NOT_FOUND" && ipGet.code === "JOB_NOT_FOUND", [shGet, ipGet]);
    check("S2b: only the insert with a trace is told", lE && lE.job_id === idOf("svg") && lE.modified_count === 1 && lE.more === 0, lE);

    // S3: findBusyJob does not count abandoned jobs
    plans.hang1 = () => HANG;
    plans.hang2 = () => HANG;
    await post({ type: "SCREENSHOT", description: "hang1", origin: "o_F", timeoutMs: 400 });
    const b = await post({ type: "SCREENSHOT", description: "hang2", origin: "o_F", timeoutMs: 400 });
    check("S3: a command abandoned by its timeout is not 'busy' for the next one (BRIDGE_OFFLINE, not PLUGIN_BUSY)", b.status === 500 && b.body.code === "BRIDGE_OFFLINE", b.body);
    plans.hang3 = () => HANG;
    plans.hang4 = () => HANG;
    const hang3 = await post({ code: "x", description: "hang3", origin: "o_G", timeoutMs: 5000, escalateMs: 300 });
    const b2 = await post({ type: "SCREENSHOT", description: "hang4", origin: "o_G", timeoutMs: 400 });
    check("S3: an escalated running job still makes the next call PLUGIN_BUSY", b2.status === 500 && b2.body.code === "PLUGIN_BUSY" && b2.body.error.indexOf(hang3.body.job_id) !== -1, b2.body);

    // S4: plugin lost while escalated / abandoned (the busy and hang jobs above die with this plugin too)
    plans.lost = () => HANG;
    const lostEsc = await post({ code: "x", description: "lost", origin: "o_L", timeoutMs: 5000, escalateMs: 300 });
    plugin.close();
    await waitClients(server, 0);
    plugin = await connect(1);
    const lostLate = (await quick("o_L")).body.__late;
    check("S4: lost job told as lost, no error text", lostLate && lostLate.job_id === lostEsc.body.job_id && lostLate.status === "lost" && lostLate.error === null, lostLate);
    const lostGet = await getJob(lostEsc.body.job_id);
    check("S4: /job still answers PLUGIN_DISCONNECTED (not forgotten)", lostGet.ok === false && lostGet.code === "PLUGIN_DISCONNECTED", lostGet);
    const hangLost = (await quick("o_G")).body.__late;
    check("S4: the other origin's escalated job was lost as well", hangLost && hangLost.job_id === hang3.body.job_id && hangLost.status === "lost", hangLost);
    const hang1Get = await getJob(idOf("hang1"));
    check("S4: the abandoned screenshot did not become a lost job", hang1Get.code === "JOB_NOT_FOUND", hang1Get);

    // S5: expiry, then the plugin answers after all
    let release;
    plans.slow = () => new Promise((r) => { release = r; });
    const slow = await post({ code: "x", description: "slow", origin: "o_X", timeoutMs: 20000, escalateMs: 300 });
    await sleep(2900);
    const expLate = (await quick("o_X")).body.__late;
    check("S5: silent past FIGMA_MCP_JOB_EXPIRE_MS -> told as expired", expLate && expLate.job_id === slow.body.job_id && expLate.status === "expired" && expLate.error === null, expLate);
    check("S5: told once", (await quick("o_X")).body.__late === undefined);
    release({ result: "finally", created: ["6:1"], checkpointId: "cp_6" });
    await sleep(300);
    const truth = (await quick("o_X")).body.__late;
    check("S5: the plugin answered after expiry: the truth is told again (done, ids)", truth && truth.job_id === slow.body.job_id && truth.status === "done" && truth.created.join() === "6:1" && truth.checkpoint_id === "cp_6", truth);
    const truthGet = await getJob(slow.body.job_id);
    check("S5: job_status now shows done", truthGet.ok && truthGet.status === "done", truthGet);

    // S5b: JOB_EXPIRED via job_status for a silent job nobody polled
    plans.slow2 = () => HANG;
    const slow2 = await post({ code: "x", description: "slow2", origin: "o_X2", timeoutMs: 20000, escalateMs: 300 });
    await sleep(2900);
    const ex2 = await getJob(slow2.body.job_id);
    check("S5b: job_status of a silent job -> JOB_EXPIRED error", ex2.ok === false && ex2.code === "JOB_EXPIRED", ex2);
    check("S5b: and it is not told a second time as late", (await quick("o_X2")).body.__late === undefined);

    // S6: old proxy (no origin)
    plans.old = delayed(600, { result: 1, created: ["7:1"] });
    const old = await post({ code: "x", description: "old", timeoutMs: 5000, escalateMs: 300 });
    check("S6: old proxy escalation works", old.body.__escalated === true);
    await sleep(800);
    const q1 = await quick(null);
    const q2 = await quick("o_Y");
    check("S6: no origin -> never told to anyone", q1.body.__late === undefined && q2.body.__late === undefined);
    const oldGet = await getJob(old.body.job_id);
    check("S6: but job_status still returns it", oldGet.ok && oldGet.status === "done", oldGet);

    // S8: several late jobs, one per call, oldest first, more counts down
    plans.m1 = delayed(450, { result: 1, created: ["8:1"] });
    plans.m2 = delayed(500, { result: 1, created: ["8:2"] });
    plans.m3 = delayed(550, { result: 1, created: ["8:3"] });
    const m = (await Promise.all(["m1", "m2", "m3"].map((d) => post({ code: "x", description: d, origin: "o_M", timeoutMs: 5000, escalateMs: 300 })))).map((r) => r.body.job_id);
    await sleep(900);
    const g1 = (await quick("o_M")).body.__late, g2 = (await quick("o_M")).body.__late, g3 = (await quick("o_M")).body.__late, g4 = (await quick("o_M")).body.__late;
    check("S8: three late jobs come one per call, oldest first, more 2,1,0", g1 && g2 && g3 && g1.job_id === m[0] && g1.more === 2 && g2.job_id === m[1] && g2.more === 1 && g3.job_id === m[2] && g3.more === 0 && g4 === undefined, [g1, g2, g3, g4]);

    // S7: orphan
    plugin.ws.send(JSON.stringify({ type: "PROGRESS", id: "ghost_progress", step: 1, of: 2 }));
    plugin.ws.send(JSON.stringify({ type: "RESULT", success: true, id: "ghost_plain", result: "x" }));
    await sleep(300);
    check("S7: PROGRESS for an unknown id is ignored (no record)", (await getJob("ghost_progress")).code === "JOB_NOT_FOUND");
    check("S7: a result without traces for an unknown id is ignored", (await getJob("ghost_plain")).code === "JOB_NOT_FOUND");
    check("S7: PROGRESS did not make the busy check see a phantom job", (await post({ type: "SCREENSHOT", description: "hang1", origin: "o_Q", timeoutMs: 400 })).body.code === "BRIDGE_OFFLINE");
    plugin.ws.send(JSON.stringify({ type: "RESULT", success: true, id: "ghost_traces", result: "x", created: ["9:9"], checkpointId: "cp_9" }));
    await sleep(300);
    const noOrigin = await quick(null);
    check("S7: an orphan is not handed to an origin-less (old) proxy", noOrigin.body.__late === undefined);
    const orphan = (await quick("o_Z")).body.__late;
    check("S7: an orphan with traces goes to the first origin, with the file name", orphan && orphan.job_id === "ghost_traces" && orphan.orphan === true && orphan.file === "Golden File" && orphan.created.join() === "9:9" && orphan.checkpoint_id === "cp_9", orphan);
    check("S7: and only once", (await quick("o_W")).body.__late === undefined);
  } finally {
    for (const p of plugins) p.close();
    await server.stop();
  }
}


// ---------------------------------------------------------------------------
// T-075 delivery: late_result block (late.js), figma_job_status, process journal
// ---------------------------------------------------------------------------
const late = require("../figma/lib/late");
const router = require("../figma/lib/router");
const bl = (s) => Buffer.byteLength(s, "utf8");
const J = (res, i) => JSON.parse(res.content[i || 0].text);
const hasLate = (res) => /"late_result"/.test(res.content[0].text);

function blockUnits() {
  console.log("== late_result block: size and shape ==");
  const base = { job_id: "cmd_ab12cd3", status: "done", was: "stalled", description: "Build cards", kind: "EXECUTE", finished_s_ago: 42, created: ids(14, "12"), created_count: 14, modified_count: 2, checkpoint_id: "cp_m1x_7", error: null, orphan: false, file: null, more: 0 };
  const f = JSON.parse(late.lateBlock(base, 100));
  check("full block: the ADR shape", f.late_result && f.late_result.job_id === "cmd_ab12cd3" && f.late_result.status === "done" && f.late_result.was === "stalled" && f.late_result.description === "Build cards" && f.late_result.finished_s_ago === 42 && f.late_result.created_count === 14 && f.late_result.modified_count === 2 && f.late_result.checkpoint_id === "cp_m1x_7" && /rerun/i.test(f.late_result.note), f);
  check("full block lists ids in creation order", f.late_result.created[0] === "12:0" && f.late_result.created.every((x, i) => x === "12:" + i), f.late_result.created);
  const worst = { ...base, description: "Очень длинное описание сборки карточек ".repeat(5), created: ids(20, "1234"), created_count: 999, modified_count: 999, checkpoint_id: "cp_m1x_7abcdef", orphan: true, file: "A very long Figma file name.fig that goes on", more: 12, finished_s_ago: 123456 };
  const w = late.lateBlock(worst, 0);
  const wj = JSON.parse(w);
  check("worst case (long description, 20 ids, orphan, more): at most 300 bytes", bl(w) <= 300, bl(w));
  check("worst case (every field maxed) still names job, status, the first id, counts, orphan, more", wj.late_result.job_id === base.job_id && wj.late_result.created.length >= 1 && wj.late_result.created[0] === "1234:0" && wj.late_result.created_count === 999 && wj.late_result.orphan === true && wj.late_result.more === 12, wj);
  const w2 = late.lateBlock({ ...base, created: ids(20, "9"), description: "x".repeat(500) }, 0);
  check("20 ids and a 500-char description: at most 300 bytes", bl(w2) <= 300 && JSON.parse(w2).late_result.created.length >= 3, bl(w2));
  const er = JSON.parse(late.lateBlock({ ...base, status: "error", error: "ReferenceError: " + "boom ".repeat(100), created: [], created_count: 0 }, 0));
  check("error: error text (at most 120 chars) instead of ids", typeof er.late_result.error === "string" && er.late_result.error.length <= 120 && er.late_result.error.indexOf("ReferenceError") === 0 && er.late_result.created === undefined && bl(JSON.stringify(er)) <= 300, er);
  for (const st of ["lost", "expired"]) {
    const o = JSON.parse(late.lateBlock({ ...base, status: st, created: [], created_count: 0, modified_count: 0, checkpoint_id: null }, 0));
    check(st + ": note says outcome unknown and one cheap canvas read", /unknown/i.test(o.late_result.note) && /cheap read/i.test(o.late_result.note) && o.late_result.created === undefined, o);
  }
  // boundary: some padding makes the full block exactly 300 bytes and it is still the full form
  let exact = null;
  for (let pad = 0; pad < 80 && !exact; pad++) {
    const d = { ...base, description: null, created: ["1:1"], created_count: 1, modified_count: 0, checkpoint_id: "c".repeat(pad + 3) };
    const t = JSON.stringify(late.fullBlock(d));
    if (bl(t) === 300 && JSON.parse(t).late_result.created) exact = d;
  }
  check("a full block of exactly 300 bytes exists and keeps its id", !!exact);
  if (exact) {
    const over = late.fullBlock({ ...exact, checkpoint_id: exact.checkpoint_id + "c" });
    check("one byte more: the block shrinks, never exceeds 300", over && bl(JSON.stringify(over)) <= 300, over && bl(JSON.stringify(over)));
  }
  // short form
  const sh = late.lateBlock(base, 3900);
  const shj = JSON.parse(sh);
  check("main text over the ceiling: short form, at most 120 bytes, job_id + status + created_count", bl(sh) <= 120 && shj.late_result.job_id === base.job_id && shj.late_result.status === "done" && shj.late_result.created_count === 14 && shj.late_result.created === undefined, sh);
  const shw = late.lateBlock({ ...worst, status: "expired", job_id: "cmd_" + "x".repeat(40) }, 3900);
  check("short form with a long job id stays at most 120 bytes", bl(shw) <= 120, bl(shw));
  // ceiling boundary: exactly at 3900 total is full, one byte more is short
  const fullLen = bl(JSON.stringify(late.fullBlock(base)));
  check("main + full block exactly 3900: full form", late.lateBlock(base, 3900 - fullLen) === JSON.stringify(late.fullBlock(base)));
  check("main + full block 3901: short form", bl(late.lateBlock(base, 3901 - fullLen)) <= 120);

  console.log("== attachLate: first content item, ceiling, which tools ==");
  const prevMaster = state.isBridgeMaster;
  state.isBridgeMaster = false;
  const mainText = (n) => ({ content: [{ type: "text", text: "x".repeat(n) }, { type: "image", data: "AAAA", mimeType: "image/png" }] });
  state.lateInbox.push({ ...base });
  const a1 = late.attachLate(mainText(100), "figma_inspect", {}, () => null);
  check("block is the FIRST content item, type text, original items follow", a1.content.length === 3 && a1.content[0].type === "text" && JSON.parse(a1.content[0].text).late_result.job_id === base.job_id && a1.content[1].text.length === 100 && a1.content[2].type === "image", a1.content.map((c) => c.type));
  state.lateInbox.push({ ...base });
  const e1 = late.attachLate({ isError: true, content: [{ type: "text", text: "{}" }] }, "figma_execute_code", {}, () => null);
  check("an error reply carries the block too, isError kept", e1.isError === true && hasLate(e1) && e1.content.length === 2);
  for (const t of ["get_file", "get_me", "post_comment", "figma_list_targets", "no_such_tool"]) {
    state.lateInbox.push({ ...base });
    const r = late.attachLate(mainText(10), t, {}, () => null);
    check(t + ": no block (REST / no journal)", r.content.length === 2 && state.lateInbox.length === 1, r.content.length);
    state.lateInbox.length = 0;
  }
  state.lateInbox.push({ ...base });
  const edge = late.attachLate(mainText(3900), "figma_inspect", {}, () => null);
  const edgeText = edge.content.filter((c) => c.type === "text").reduce((n, c) => n + bl(c.text), 0);
  check("reply at the 3900-byte ceiling plus the block: at most 4020 bytes of text, short form", edgeText <= 4020 && bl(edge.content[0].text) <= 120, edgeText);
  state.lateInbox.push({ ...base });
  const roomy = late.attachLate(mainText(3000), "figma_inspect", {}, () => null);
  check("room below the ceiling: full form (more than 120 bytes), total under 3900", bl(roomy.content[0].text) > 120 && bl(roomy.content[0].text) <= 300 && bl(roomy.content[0].text) + 3000 <= 3900);
  state.lateInbox.push({ ...base, job_id: "cmd_self" });
  const skip = late.attachLate(mainText(10), "figma_job_status", { job_id: "cmd_self" }, () => null);
  check("a block about the job this very call reads is skipped", skip.content.length === 2 && state.lateInbox.length === 0);
  state.lateInbox.push({ job_id: "cmd_broken" });
  let threw = false;
  let br;
  try { br = late.attachLate(mainText(10), "figma_inspect", {}, () => null); } catch (e) { threw = true; }
  check("a malformed block never throws", !threw && br && br.content.length >= 2);
  state.lateInbox.length = 0;
  state.isBridgeMaster = true;
  let asked = null;
  const m = late.attachLate(mainText(10), "figma_job_status", { job_id: "cmd_q" }, (origin, except) => { asked = [origin, except]; return { ...base, job_id: "cmd_m" }; });
  check("master: takes the block from the journal with its own origin, except the job read", asked && asked[0] === srv.ORIGIN_ID && asked[1] === "cmd_q" && JSON.parse(m.content[0].text).late_result.job_id === "cmd_m", asked);
  state.isBridgeMaster = prevMaster;
  reset();

  console.log("== figma_job_status helpers ==");
  const u = late.unknownJob("cmd_z");
  check("JOB_STATE_UNKNOWN: ok false, status unknown, job_id, hint without connection jargon", u.ok === false && u.status === "unknown" && u.code === "JOB_STATE_UNKNOWN" && u.job_id === "cmd_z" && /late_result/.test(u.hint) && !/fetch failed|ECONNREFUSED|establish/i.test(JSON.stringify(u)), u);
  check("BRIDGE_OFFLINE becomes the structured answer, other errors stay errors", late.jobStatusError({ code: "BRIDGE_OFFLINE" }, "cmd_z").code === "JOB_STATE_UNKNOWN" && late.jobStatusError({ code: "X" }, "cmd_z") === null && late.jobStatusError(new Error("x"), "c") === null);
  check("JOB_NOT_FOUND for an id never issued stays JOB_NOT_FOUND", late.jobStatusSnap({ ok: false, code: "JOB_NOT_FOUND" }, "cmd_never").code === "JOB_NOT_FOUND");
  late.noteIssued("cmd_i1");
  check("JOB_NOT_FOUND for an issued id becomes JOB_STATE_UNKNOWN", late.jobStatusSnap({ ok: false, code: "JOB_NOT_FOUND" }, "cmd_i1").code === "JOB_STATE_UNKNOWN");
  late.jobStatusSnap({ ok: true, status: "done" }, "cmd_i1");
  check("after a successful read the id is forgotten: JOB_NOT_FOUND is real again", late.jobStatusSnap({ ok: false, code: "JOB_NOT_FOUND" }, "cmd_i1").code === "JOB_NOT_FOUND");
  late.noteIssued("cmd_i2");
  late.jobStatusSnap({ ok: false, status: "error", code: "SCRIPT_RUNTIME_ERROR" }, "cmd_i2");
  check("a read error result forgets the id as well", late.jobStatusSnap({ ok: false, code: "JOB_NOT_FOUND" }, "cmd_i2").code === "JOB_NOT_FOUND");
  late.noteIssued("cmd_i3");
  late.jobStatusSnap({ ok: true, status: "running" }, "cmd_i3");
  check("a running answer keeps the id", late.jobStatusSnap({ ok: false, code: "JOB_NOT_FOUND" }, "cmd_i3").code === "JOB_STATE_UNKNOWN");
  for (let i = 0; i < 60; i++) late.noteIssued("cmd_bulk" + i);
  check("only the last 50 ids are remembered", late.jobStatusSnap({ ok: false, code: "JOB_NOT_FOUND" }, "cmd_bulk5").code === "JOB_NOT_FOUND" && late.jobStatusSnap({ ok: false, code: "JOB_NOT_FOUND" }, "cmd_bulk59").code === "JOB_STATE_UNKNOWN");
}

// New proxy against a master that knows nothing of __late
async function compatUnits() {
  console.log("== compat: new proxy with a master that sends no __late ==");
  reset();
  const fake = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url.indexOf("/job") === 0 ? { ok: false, code: "JOB_NOT_FOUND", error: "No job" } : { success: true, result: [] }));
  });
  await new Promise((r) => fake.listen(18831, "127.0.0.1", r));
  const prev = state.isBridgeMaster;
  state.isBridgeMaster = false;
  try {
    const r = await router.handleCallTool("figma_get_selection", {});
    check("proxy + master without __late: plain reply, no block, no error", !r.isError && r.content.length === 1 && !hasLate(r), r);
    const nf = await router.handleCallTool("figma_job_status", { job_id: "cmd_old", wait_ms: 0 });
    check("job_status for a never-issued id through such a master: JOB_NOT_FOUND as before", nf.isError === true && J(nf).code === "JOB_NOT_FOUND", nf);
    late.noteIssued("cmd_iss");
    const un = await router.handleCallTool("figma_job_status", { job_id: "cmd_iss", wait_ms: 0 });
    check("an issued id the master no longer knows: JOB_STATE_UNKNOWN, not an error", !un.isError && J(un).code === "JOB_STATE_UNKNOWN" && J(un).job_id === "cmd_iss", un);
  } finally {
    state.isBridgeMaster = prev;
    await new Promise((r) => fake.close(r));
    reset();
  }
}

const baseEnv = { FIGMA_MCP_STALLED_MS: "600", FIGMA_MCP_ESCALATE_MS: "300" };
async function liveTools() {
  console.log("== live, through MCP tools: master, proxies, killed master ==");
  const plans = {};
  const plugins = [];
  const servers = [];
  const spawn = (port, env) => { const s = startServer({ port, env: { ...baseEnv, ...(env || {}) } }); servers.push(s); return s; };
  const plugin = async (server, n) => {
    const p = startFakePlugin({ port: server.port, token: server.token, handler: (cmd) => (plans[cmd.description] ? plans[cmd.description](cmd) : { result: "ok" }) });
    plugins.push(p);
    await p.opened;
    await waitClients(server, n);
    return p;
  };
  const delayed = (ms, out) => () => sleep(ms).then(() => out);
  try {
    // ---- master: running -> stalled -> plugin answers
    const M = spawn(18840, { FIGMA_MCP_TIMEOUT_MS: "1200" });
    await M.initialize();
    await waitMaster(M);
    await plugin(M, 1);
    plans.build = delayed(1700, { result: { built: true }, created: ["1:1", "1:2", "1:3"], modified: ["1:9"], checkpointId: "cp_1" });
    const esc = await M.tool("figma_execute_code", { code: "await 1; return 1;", description: "build" });
    const jid = J(esc).job_id;
    check("M1: long script returns running + job_id", J(esc).status === "running" && /^cmd_/.test(jid) && !hasLate(esc), esc);
    const run1 = await M.tool("figma_job_status", { job_id: jid, wait_ms: 0 });
    check("M1: job_status while quiet is short: running, not stalled", J(run1).status === "running" && !J(run1).stalled, run1);
    await sleep(800);
    const st = await M.tool("figma_job_status", { job_id: jid, wait_ms: 0 });
    check("M1: silent past the threshold: stalled true + stop true (master)", J(st).stalled === true && J(st).stop === true && /late_result/.test(J(st).hint) && /do not rerun/i.test(J(st).hint), st);
    const st2 = await M.tool("figma_job_status", { job_id: jid, wait_ms: 0 });
    check("M1: the second stalled report is the short one", J(st2).stalled === true && /Already reported/.test(J(st2).hint) && !/late_result/.test(J(st2).hint), st2);
    await sleep(1200); // the plugin answers at ~1700 ms
    const next = await M.tool("figma_get_selection", {});
    const blk = J(next);
    check("M1: the next call to the plugin carries late_result FIRST, with the created id", blk.late_result && blk.late_result.job_id === jid && blk.late_result.status === "done" && blk.late_result.was === "stalled" && blk.late_result.created[0] === "1:1" && blk.late_result.created_count === 3 && blk.late_result.checkpoint_id === "cp_1" && blk.late_result.description === "build" && bl(next.content[0].text) <= 300, next.content[0].text);
    check("M1: the call's own answer follows the block", next.content.length >= 2 && !/late_result/.test(next.content[1].text), next.content.map((c) => c.text));
    const next2 = await M.tool("figma_get_selection", {});
    check("M1: the call after that carries no block", !hasLate(next2), next2);
    const full = await M.tool("figma_job_status", { job_id: jid, wait_ms: 0 });
    check("M1: job_status gives the full result once, with late: true", J(full).status === "done" && J(full).late === true && J(full).result && J(full).result.built === true && !hasLate(full), full.content[0].text.slice(0, 300));
    const gone = await M.tool("figma_job_status", { job_id: jid, wait_ms: 0 });
    check("M1: read again: JOB_NOT_FOUND (really read), not JOB_STATE_UNKNOWN", gone.isError === true && J(gone).code === "JOB_NOT_FOUND", gone);

    // a job that was never stalled: no late flag
    plans.fine = delayed(500, { result: { ok: 1 }, created: ["2:1"] });
    const e2 = await M.tool("figma_execute_code", { code: "await 1; return 2;", description: "fine" });
    const f2 = await M.tool("figma_job_status", { job_id: J(e2).job_id, wait_ms: 3000 });
    check("M2: finished in time: done without the late flag, and no block", J(f2).status === "done" && J(f2).late === undefined && !hasLate(f2), f2.content[0].text.slice(0, 200));

    // ---- PLUGIN_BUSY text on a frozen plugin
    plans.freeze = () => HANG;
    plans["Get Selected Nodes"] = () => HANG;
    const fz = await M.tool("figma_execute_code", { code: "await 1; return 3;", description: "freeze" });
    await sleep(800);
    const busy = await M.tool("figma_get_selection", {});
    const bj = J(busy);
    check("M3: a call behind a frozen job: PLUGIN_BUSY says not responding, stop and ask the user, no 'wait via job_status'", busy.isError === true && bj.code === "PLUGIN_BUSY" && /not responding/.test(bj.error) && /ask the user/i.test(bj.error) && bj.error.indexOf(J(fz).job_id) !== -1 && !/wait for it with figma_job_status/.test(bj.error), bj);
    delete plans["Get Selected Nodes"];

    // ---- proxies: block goes to the agent that ran the job
    const A = spawn(18841);
    await A.initialize();
    await waitMaster(A);
    await plugin(A, 1);
    const B = spawn(18841);
    const C = spawn(18841);
    await B.initialize();
    await C.initialize();
    plans.pbuild = delayed(1700, { result: { built: true }, created: ["5:1", "5:2"], checkpointId: "cp_p" });
    const pesc = await B.tool("figma_execute_code", { code: "await 1; return 1;", description: "pbuild" });
    const pjid = J(pesc).job_id;
    check("P1: proxy B gets running + job_id from the master", J(pesc).status === "running" && /^cmd_/.test(pjid), pesc);
    await sleep(1000);
    const pst = await B.tool("figma_job_status", { job_id: pjid, wait_ms: 0 });
    check("P1: job_status through the proxy: stalled true + late_result phrase", J(pst).stalled === true && J(pst).stop === true && /late_result/.test(J(pst).hint), pst);
    await sleep(1100);
    const cNext = await C.tool("figma_get_selection", {});
    check("P1: the second agent (proxy C) gets no block", !hasLate(cNext), cNext.content[0].text.slice(0, 200));
    const bNext = await B.tool("figma_get_selection", {});
    const bb = J(bNext);
    check("P1: the agent that ran it (proxy B) gets late_result first", bb.late_result && bb.late_result.job_id === pjid && bb.late_result.created.join() === "5:1,5:2" && bb.late_result.was === "stalled" && bb.late_result.checkpoint_id === "cp_p", bNext.content[0].text);
    check("P1: told once", !hasLate(await B.tool("figma_get_selection", {})));
    const pfull = await B.tool("figma_job_status", { job_id: pjid, wait_ms: 0 });
    check("P1: full result once via the proxy, with late: true, no block about itself", J(pfull).status === "done" && J(pfull).late === true && !hasLate(pfull), pfull.content[0].text.slice(0, 200));

    // ---- master killed mid-job
    const K = spawn(18842);
    await K.initialize();
    await waitMaster(K);
    const kp = await plugin(K, 1);
    const L = spawn(18842);
    await L.initialize();
    plans.kjob = () => HANG;
    const kesc = await L.tool("figma_execute_code", { code: "await 1; return 1;", description: "kjob" });
    const kjid = J(kesc).job_id;
    check("K1: proxy L started a job on master K", J(kesc).status === "running", kesc);
    K.child.kill("SIGKILL");
    await new Promise((r) => (K.child.exitCode !== null || K.child.signalCode ? r() : K.child.once("exit", r)));
    kp.close();
    const ku = await L.tool("figma_job_status", { job_id: kjid, wait_ms: 0 });
    const kt = ku.content[0].text;
    check("K1: master gone: job_status answers JOB_STATE_UNKNOWN with job_id, not an error", !ku.isError && J(ku).code === "JOB_STATE_UNKNOWN" && J(ku).status === "unknown" && J(ku).job_id === kjid, kt);
    check("K1: no connection jargon in the text", !/fetch failed|ECONNREFUSED|establish|retry the call/i.test(kt), kt);
    await waitMaster(L, 8000); // L took the port over
    const ku2 = await L.tool("figma_job_status", { job_id: kjid, wait_ms: 0 });
    check("K2: former proxy is the master now with an empty journal: still JOB_STATE_UNKNOWN (issued id)", !ku2.isError && J(ku2).code === "JOB_STATE_UNKNOWN", ku2.content[0].text);
    const kp2 = await plugin(L, 1);
    kp2.ws.send(JSON.stringify({ type: "RESULT", success: true, id: kjid, result: "done anyway", created: ["8:1", "8:2"], checkpointId: "cp_k" }));
    await sleep(300);
    const orph = await L.tool("figma_get_selection", {});
    const ob = J(orph);
    check("K3: the plugin answered the old id: it arrives as an orphan late_result with ids and file", ob.late_result && ob.late_result.job_id === kjid && ob.late_result.orphan === true && ob.late_result.created.join() === "8:1,8:2" && ob.late_result.checkpoint_id === "cp_k" && ob.late_result.file === "Golden File", orph.content[0].text);
    check("K3: not told twice", !hasLate(await L.tool("figma_get_selection", {})));
  } finally {
    for (const p of plugins) p.close();
    for (const s of servers) await s.stop();
  }
}

async function journalTests() {
  console.log("== process journal ==");
  const readLog = (p) => { try { return fs.readFileSync(p, "utf8"); } catch (e) { return ""; } };
  const exited = (s) => new Promise((r) => (s.child.exitCode !== null || s.child.signalCode ? r() : s.child.once("exit", r)));
  const tmpDirs = [];
  const mkdir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "mokido-j-")); tmpDirs.push(d); return d; };
  try {
    // (a) stdin closed -> reason line; and no script code, file name or token in the file
    const dir = mkdir();
    const f1 = path.join(dir, "a.log");
    const S = startServer({ port: 18850, env: { FIGMA_MCP_LOG_FILE: f1 } });
    await S.initialize();
    await waitMaster(S);
    const p = startFakePlugin({ port: 18850, token: S.token, fileName: "Secret Brand File", handler: () => ({ result: "ok" }) });
    await p.opened;
    await waitClients(S, 1);
    await S.tool("figma_execute_code", { code: "return 'SCRIPT_MARKER_7731';", description: "marker job" });
    p.close();
    await sleep(150);
    const midLog = readLog(f1);
    check("journal: a start line (pid, version) and a role line", /start v\d+\.\d+\.\d+/.test(midLog) && midLog.indexOf("pid=" + S.child.pid) !== -1 && /role master/.test(midLog), midLog);
    await S.stop();
    await exited(S);
    const log1 = readLog(f1);
    check("journal: closing stdin leaves 'exit ... reason=stdin closed' and the exit code", /exit role=master reason=stdin closed/.test(log1) && /process exit code=0/.test(log1), log1);
    check("journal: no script code, no file name, no bridge token", log1.indexOf("SCRIPT_MARKER_7731") === -1 && log1.indexOf("Secret Brand File") === -1 && log1.indexOf("marker job") === -1 && log1.indexOf(S.token) === -1, log1);

    // (b) uncaught exception and unhandled rejection: stack in the file, process still dies
    for (const [mode, kind, msg] of [["1", "uncaughtException", "test crash"], ["reject", "unhandledRejection", "test rejection"]]) {
      const f = path.join(mkdir(), mode + ".log");
      const C = startServer({ port: 18851, env: { FIGMA_MCP_LOG_FILE: f, FIGMA_MCP_TEST_CRASH: mode } });
      await C.initialize();
      await exited(C);
      const lg = readLog(f);
      check("journal " + kind + ": the line, the message and a stack", lg.indexOf(kind) !== -1 && lg.indexOf(msg) !== -1 && /\n\s+at /.test(lg), lg);
      check("journal " + kind + ": behaviour unchanged: exit code 1 and the error still on stderr", C.child.exitCode === 1 && C.stderr().indexOf(msg) !== -1, [C.child.exitCode, C.stderr().slice(0, 200)]);
    }

    // (c) default path is os.tmpdir()/mokido-server.log; =0 writes nothing
    const tdir = mkdir();
    const D = startServer({ port: 18852, env: { TEMP: tdir, TMP: tdir, TMPDIR: tdir, FIGMA_MCP_LOG_FILE: "" } });
    await D.initialize();
    await waitMaster(D);
    await D.stop();
    await exited(D);
    check("journal: on by default, in the temp dir as mokido-server.log", /start v/.test(readLog(path.join(tdir, "mokido-server.log"))), fs.readdirSync(tdir));
    const tdir2 = mkdir();
    const Z = startServer({ port: 18853, env: { TEMP: tdir2, TMP: tdir2, TMPDIR: tdir2, FIGMA_MCP_LOG_FILE: "0" } });
    await Z.initialize();
    await waitMaster(Z);
    await Z.stop();
    await exited(Z);
    check("journal: FIGMA_MCP_LOG_FILE=0 creates no file", fs.readdirSync(tdir2).length === 0, fs.readdirSync(tdir2));

    // (d) an oversized file is cut to its tail at start
    const f4 = path.join(mkdir(), "big.log");
    fs.writeFileSync(f4, "old line of the journal that is long enough to fill space\n".repeat(6000));
    const big0 = fs.statSync(f4).size;
    const G = startServer({ port: 18854, env: { FIGMA_MCP_LOG_FILE: f4 } });
    await G.initialize();
    await waitMaster(G);
    await G.stop();
    await exited(G);
    const big1 = fs.statSync(f4).size;
    const lg4 = readLog(f4);
    check("journal: a file over 256 KB is cut to its tail on start, the new lines are at the end", big0 > 256 * 1024 && big1 <= 256 * 1024 && /start v/.test(lg4) && /exit role=master/.test(lg4) && lg4.indexOf("old line") === 0, [big0, big1]);
  } finally {
    for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
  }
}

(async () => {
  await units();
  await proxyUnits();
  await live();
  blockUnits();
  await compatUnits();
  await liveTools();
  await journalTests();
  console.log(failures === 0 ? `\nALL PASS (${checks} checks passed)` : `\n${failures} FAILURES (of ${checks} checks)`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log("  FAIL crashed -> " + (e && e.stack || e)); process.exit(1); });
