const { ECONOMY } = require("./config");
const { state } = require("./state");

// ------------------------------------------------------------------
// Job Ledger — makes a figma_execute_code call that runs long survive its own
// synchronous wait window instead of the caller's promise just rejecting while
// the plugin keeps working. Every command gets an entry (cheap: a plain
// object); most are read once and evicted quickly by the LRU cap below. Only
// commands that actually run past TIMEOUTS.escalate are ever surfaced to the
// agent as a job_id via figma_job_status — see sendCommandToPlugin().
// ------------------------------------------------------------------
const jobs = new Map();
const JOBS_MAX = 200;
const jobWaiters = new Map(); // job id -> Set<fn>, woken when the job leaves "running"

function touchJob(id, patch) {
  let job = jobs.get(id);
  if (!job) {
    job = { id, status: "running", progress: [], result: undefined, error: null, clientId: null, createdAt: Date.now(), updatedAt: Date.now() };
    jobs.set(id, job);
    if (jobs.size > JOBS_MAX) {
      const oldestKey = jobs.keys().next().value;
      if (oldestKey !== id) jobs.delete(oldestKey);
    }
  }
  Object.assign(job, patch, { updatedAt: Date.now() });
  if (job.status !== "running") wakeJobWaiters(id);
  return job;
}

function wakeJobWaiters(id) {
  const set = jobWaiters.get(id);
  if (!set) return;
  jobWaiters.delete(id);
  for (const fn of set) { try { fn(); } catch (e) {} }
}

// Resolves when the job finishes or `ms` elapses, whichever comes first — the
// long-poll behind figma_job_status. One blocking call replaces the 5-10
// "still running" polls an agent otherwise burns, each re-reading its whole
// context.
function waitForJob(id, ms) {
  const job = jobs.get(id);
  if (!job || job.status !== "running" || !(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    let set = jobWaiters.get(id);
    if (!set) { set = new Set(); jobWaiters.set(id, set); }
    const done = () => { clearTimeout(timer); set.delete(done); resolve(); };
    const timer = setTimeout(done, ms);
    set.add(done);
  });
}

// Result of a command whose caller is still blocked on it is handed straight
// to that caller and NOT kept: the ledger used to retain every result
// (screenshots included) for the last 200 commands. Only escalated commands —
// the ones nobody is waiting on synchronously any more — keep theirs for
// figma_job_status.
// Where in the agent's code a failure happened (the plugin sends line/column/at
// for runtime errors, this server for syntax errors); {} when unknown.
function errorLocation(src) {
  const loc = {};
  if (!src) return loc;
  if (Number.isFinite(Number(src.line)) && src.line !== null && src.line !== "") loc.line = Number(src.line);
  if (Number.isFinite(Number(src.column)) && src.column !== null && src.column !== "") loc.column = Number(src.column);
  if (typeof src.at === "string" && src.at) loc.at = src.at;
  return loc;
}

function settleCommand(data) {
  const resolver = state.commandResolvers.get(data.id);
  const patch = {
    status: data.success === false ? "error" : "done",
    result: data.success === false ? undefined : data,
    error: data.success === false ? (data.error || "Execution failed in Figma sandbox") : null,
    code: data.code || null,
    ...(data.success === false ? errorLocation(data) : {})
  };
  if (resolver) {
    state.commandResolvers.delete(data.id);
    touchJob(data.id, { ...patch, result: undefined });
    jobs.delete(data.id);
    resolver(data);
  } else {
    touchJob(data.id, patch);
  }
}

// The Figma sandbox runs plugin code on one thread: a heavy call blocks every
// later one. Knowing what is still running on a client turns a bare timeout
// into "wait for job X" instead of a retry loop. Only commands that started
// BEFORE the timed-out one can be what blocked it.
function findBusyJob(clientId, exceptId, startedBefore) {
  let busiest = null;
  for (const job of jobs.values()) {
    if (job.status !== "running" || job.id === exceptId) continue;
    if (clientId && job.clientId && job.clientId !== clientId) continue;
    if (startedBefore && job.createdAt > startedBefore) continue;
    if (!busiest || job.createdAt < busiest.createdAt) busiest = job;
  }
  return busiest;
}

// A plugin that disconnects (reload, Figma closed) will never answer what it
// was running. Fail those now instead of letting callers and pollers wait out
// their full timeouts.
function failCommandsOfClient(clientId) {
  for (const job of jobs.values()) {
    if (job.status !== "running" || job.clientId !== clientId) continue;
    const data = {
      id: job.id,
      success: false,
      code: "PLUGIN_DISCONNECTED",
      error: "The Figma plugin disconnected while this command was running, so its result is lost. " +
             "It may or may not have finished: check the canvas with one cheap read before running it again."
    };
    settleCommand(data);
  }
}

// Shared by figma_job_status (master) and GET /job (what proxies call).
// Blocks up to waitMs for the job to finish; a finished job is read once and
// forgotten so the ledger does not keep screenshots alive.
async function readJobSnapshot(id, waitMs) {
  const waitStart = Date.now();
  // A job already reported as stalled is not waited on again: the model polled
  // 4-5 more times after "ask the user" (pack 15.10), a blocking wait each time.
  const earlier = jobs.get(id);
  const repeat = !!(earlier && earlier.status === "running" && earlier.stalledReports > 0);
  await waitForJob(id, repeat ? 0 : Math.min(Math.max(0, waitMs || 0), ECONOMY.jobWaitMaxMs));
  const job = jobs.get(id);
  if (!job) {
    return {
      ok: false, code: "JOB_NOT_FOUND",
      error: `No job "${id}". A job is forgotten once read after finishing, or after ~${JOBS_MAX} newer jobs have been created.`
    };
  }
  if (job.status === "running") {
    const lastProgress = job.progress.length ? job.progress[job.progress.length - 1].ts : 0;
    const quietMs = Date.now() - Math.max(job.createdAt, lastProgress || 0);
    const snap = {
      ok: true, status: "running", job_id: job.id,
      elapsed_ms: Date.now() - job.createdAt,
      waited_ms: Date.now() - waitStart
    };
    if (job.progress.length) snap.progress = job.progress.slice(-3);
    if (quietMs > ECONOMY.stalledAfterMs) {
      job.stalledReports = (job.stalledReports || 0) + 1;
      snap.stalled = true;
      snap.stop = true;
      snap.hint = job.stalledReports === 1
        ? `STOP. No result or progress for ${Math.round(quietMs / 1000)}s: the Figma plugin is frozen on a heavy operation (usually a page-wide scan). Do not call figma_job_status again and do not rerun the script. Reply to the user now: ask them to look at Figma (close or reload the plugin, Ctrl+Alt+P) and tell you when it is back; then continue with a smaller, section-scoped step.`
        : "Already reported as stalled. Do not poll again: write your reply to the user (check Figma, reload the plugin) and wait for their answer.";
    }
    return snap;
  }
  jobs.delete(job.id);
  if (job.status === "error") return { ok: false, status: "error", job_id: job.id, code: job.code, error: job.error, ...errorLocation(job) };
  return { ok: true, status: "done", job_id: job.id, response: job.result, script: job.script || null, target: job.target || null };
}

module.exports = { jobs, jobWaiters, touchJob, waitForJob, errorLocation, settleCommand, findBusyJob, failCommandsOfClient, readJobSnapshot };
