const { ECONOMY } = require("./config");
const { state } = require("./state");

// ------------------------------------------------------------------
// Job Ledger — makes a figma_execute_code call that runs long survive its own
// synchronous wait window instead of the caller's promise just rejecting while
// the plugin keeps working. Every command gets an entry (cheap: a plain
// object). A record lives until its outcome is known AND told to the model
// (ADR-002): a result nobody waits for any more (escalated past
// TIMEOUTS.escalate, or abandoned by the hard timer) stays here as a "late"
// result. Fields beyond status: origin (which server process started it),
// detached ("escalated" | "timeout"), finishedAt, claimed (the outcome was
// already shown to the model), effects (what the run left on the canvas: first
// ids and counters only).
// ------------------------------------------------------------------
const jobs = new Map();
const JOBS_MAX = 200;
const EFFECT_IDS_MAX = 20;
const jobWaiters = new Map(); // job id -> Set<fn>, woken when the job leaves "running"

function newJob(id) {
  const now = Date.now();
  return {
    id, status: "running", progress: [], result: undefined, error: null, clientId: null,
    origin: null, detached: null, finishedAt: null, claimed: false, effects: null,
    createdAt: now, updatedAt: now
  };
}

// Cap: when full, drop the oldest record whose outcome was already told, then
// the oldest finished one, and a still running one only as the last resort.
function evictJobs(keepId) {
  while (jobs.size > JOBS_MAX) {
    let pick = null;
    let pickRank = 3;
    for (const job of jobs.values()) {
      if (job.id === keepId) continue;
      const rank = job.claimed ? 0 : job.status !== "running" ? 1 : 2;
      if (!pick || rank < pickRank || (rank === pickRank && job.createdAt < pick.createdAt)) { pick = job; pickRank = rank; }
    }
    if (!pick) return;
    wakeJobWaiters(pick.id);
    jobs.delete(pick.id);
  }
}

function touchJob(id, patch) {
  let job = jobs.get(id);
  if (!job) {
    sweepJobs();
    job = newJob(id);
    jobs.set(id, job);
    evictJobs(id);
  }
  Object.assign(job, patch, { updatedAt: Date.now() });
  if (job.status !== "running") wakeJobWaiters(id);
  return job;
}

function lastProgressTs(job) {
  return job.progress && job.progress.length ? (job.progress[job.progress.length - 1].ts || 0) : 0;
}
// Silence = no result and no progress() since the later of start and last progress.
function quietMs(job, now) {
  return (now === undefined ? Date.now() : now) - Math.max(job.createdAt, lastProgressTs(job));
}

function effectsOf(data) {
  const created = Array.isArray(data.created) ? data.created : [];
  const modified = Array.isArray(data.modified) ? data.modified.length : (Number.isFinite(data.modified) ? data.modified : 0);
  const checkpointId = data.checkpointId || data.checkpoint_id || null;
  if (!created.length && !modified && !checkpointId) return null;
  return { created: created.slice(0, EFFECT_IDS_MAX).map(String), createdCount: created.length, modified, checkpointId };
}
function hasTraces(effects) {
  return !!(effects && (effects.createdCount || (effects.created && effects.created.length) || effects.modified || effects.checkpointId));
}
// Worth telling the model: a script run (it may have written) or any trace on
// the canvas. An abandoned (hard timeout) read without traces is not.
function tells(job) {
  return hasTraces(job.effects) || (job.kind === "EXECUTE" && job.detached !== "timeout");
}
function isUnknownOutcome(job) {
  return job.status === "error" && (job.code === "PLUGIN_DISCONNECTED" || job.code === "JOB_EXPIRED");
}
function isLate(job, origin) {
  return job.status !== "running" && !job.claimed && !state.commandResolvers.has(job.id) &&
    tells(job) && (job.orphan === true || (!!origin && job.origin === origin));
}

// Lazy expiry (no timers): a running job nobody waits for and silent longer than
// jobExpireMs will never be heard from. Called when a record is created and when
// late jobs are picked. A read without traces just disappears.
function sweepJobs(now) {
  const t = now === undefined ? Date.now() : now;
  const limit = ECONOMY.jobExpireMs;
  if (!(limit > 0)) return;
  for (const job of Array.from(jobs.values())) {
    if (job.status !== "running" || state.commandResolvers.has(job.id)) continue;
    const quiet = quietMs(job, t);
    if (quiet <= limit) continue;
    if (!tells(job)) { wakeJobWaiters(job.id); jobs.delete(job.id); continue; }
    job.status = "error";
    job.code = "JOB_EXPIRED";
    job.error = `No result or progress for ${Math.round(quiet / 60000)} min, so the outcome is unknown. ` +
      "It may or may not have finished: check the canvas with one cheap read before running it again.";
    job.finishedAt = t;
    job.claimed = false;
    job.updatedAt = t;
    wakeJobWaiters(job.id);
  }
}

// The one oldest late job of this origin (and how many more wait), marked
// claimed; the record stays so figma_job_status can still fetch the full result.
// A job from an old proxy (no origin) is never handed out here.
function takeLate(origin, exceptId) {
  sweepJobs();
  if (!origin) return null;
  let first = null;
  let count = 0;
  for (const job of jobs.values()) {
    if (job.id === exceptId || !isLate(job, origin)) continue;
    count++;
    const a = job.finishedAt || job.createdAt;
    const b = first ? (first.finishedAt || first.createdAt) : 0;
    if (!first || a < b || (a === b && job.createdAt < first.createdAt)) first = job;
  }
  if (!first) return null;
  first.claimed = true;
  return lateData(first, count - 1);
}

// Raw material for the block the model sees (formatted by the router layer).
function lateData(job, more) {
  const fx = job.effects || {};
  const finished = job.finishedAt || Date.now();
  const status = job.code === "PLUGIN_DISCONNECTED" ? "lost" : job.code === "JOB_EXPIRED" ? "expired" : job.status;
  const was = job.detached === "timeout" ? "timeout"
    : (job.stalledReports > 0 || finished - Math.max(job.createdAt, lastProgressTs(job)) > ECONOMY.stalledAfterMs) ? "stalled" : "running";
  return {
    job_id: job.id, status, was,
    description: job.description || null,
    kind: job.kind || null,
    finished_s_ago: Math.max(0, Math.round((Date.now() - finished) / 1000)),
    created: fx.created || [],
    created_count: fx.createdCount || 0,
    modified_count: fx.modified || 0,
    checkpoint_id: fx.checkpointId || null,
    error: status === "error" ? String(job.error || "") : null,
    orphan: job.orphan === true,
    file: job.target || null,
    more
  };
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
// (screenshots included) for the last 200 commands. A command nobody waits for
// any more keeps its result for figma_job_status when it has something to tell.
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

// `client` (the plugin socket that sent it) is only used to name the file of an orphan.
function settleCommand(data, client) {
  const resolver = state.commandResolvers.get(data.id);
  const failed = data.success === false;
  const patch = {
    status: failed ? "error" : "done",
    result: failed ? undefined : data,
    error: failed ? (data.error || "Execution failed in Figma sandbox") : null,
    code: data.code || null,
    finishedAt: Date.now(),
    ...(failed ? errorLocation(data) : {})
  };
  if (resolver) {
    state.commandResolvers.delete(data.id);
    touchJob(data.id, { ...patch, result: undefined });
    jobs.delete(data.id);
    resolver(data);
    return;
  }
  const prior = jobs.get(data.id);
  const effects = effectsOf(data);
  if (!prior) {
    // A result for a record the master never had (journal lost on restart): keep it
    // as an orphan only when it left traces, so the model can be told.
    if (!effects) return;
    touchJob(data.id, { ...patch, orphan: true, kind: "EXECUTE", effects, claimed: false,
      clientId: client ? client.id : null, target: (client && client.fileName) || null });
    return;
  }
  // A second answer to a job already settled for real changes nothing; a lost or
  // expired one is settled by the plugin's own answer (truth wins).
  if (prior.status !== "running" && !isUnknownOutcome(prior)) return;
  if (!tells({ ...prior, effects })) {
    wakeJobWaiters(data.id);
    jobs.delete(data.id);
    return;
  }
  touchJob(data.id, { ...patch, effects, claimed: false });
}

// The Figma sandbox runs plugin code on one thread: a heavy call blocks every
// later one. Knowing what is still running on a client turns a bare timeout
// into "wait for job X" instead of a retry loop. Only commands that started
// BEFORE the timed-out one can be what blocked it. A command abandoned by its
// own hard timeout is not counted: the caller is gone, and it is not a reason
// to make the next caller wait.
function findBusyJob(clientId, exceptId, startedBefore) {
  let busiest = null;
  for (const job of jobs.values()) {
    if (job.status !== "running" || job.id === exceptId || job.detached === "timeout") continue;
    if (clientId && job.clientId && job.clientId !== clientId) continue;
    if (startedBefore && job.createdAt > startedBefore) continue;
    if (!busiest || job.createdAt < busiest.createdAt) busiest = job;
  }
  return busiest;
}

// A plugin that disconnects (reload, Figma closed) will never answer what it
// was running. Fail those now instead of letting callers and pollers wait out
// their full timeouts. Detached jobs stay in the ledger as PLUGIN_DISCONNECTED
// (they are told to the model as lost) unless they are reads with no traces.
function failCommandsOfClient(clientId) {
  for (const job of Array.from(jobs.values())) {
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
  sweepJobs();
  // A job already reported as stalled is not waited on again: the model polled
  // 4-5 more times after "ask the user" (pack 15.10), a blocking wait each time.
  const earlier = jobs.get(id);
  const repeat = !!(earlier && earlier.status === "running" && earlier.stalledReports > 0);
  await waitForJob(id, repeat ? 0 : Math.min(Math.max(0, waitMs || 0), ECONOMY.jobWaitMaxMs));
  sweepJobs();
  const job = jobs.get(id);
  if (!job) {
    return {
      ok: false, code: "JOB_NOT_FOUND",
      error: `No job "${id}". A job is forgotten once read after finishing, or after ~${JOBS_MAX} newer jobs have been created.`
    };
  }
  if (job.status === "running") {
    const quiet = quietMs(job);
    const snap = {
      ok: true, status: "running", job_id: job.id,
      elapsed_ms: Date.now() - job.createdAt,
      waited_ms: Date.now() - waitStart
    };
    if (job.progress.length) snap.progress = job.progress.slice(-3);
    if (quiet > ECONOMY.stalledAfterMs) {
      job.stalledReports = (job.stalledReports || 0) + 1;
      snap.stalled = true;
      snap.stop = true;
      snap.hint = job.stalledReports === 1
        ? `STOP. No result or progress for ${Math.round(quiet / 1000)}s: the Figma plugin is frozen on a heavy operation (usually a page-wide scan). Do not call figma_job_status again and do not rerun the script (if it still finishes, the next Mokido call reports it in late_result). Reply to the user now: ask them to look at Figma (close or reload the plugin, Ctrl+Alt+P) and tell you when it is back; then continue with a smaller, section-scoped step.`
        : "Already reported as stalled. Do not poll again: write your reply to the user (check Figma, reload the plugin) and wait for their answer.";
    }
    return snap;
  }
  // Lost or expired jobs stay (marked told): the plugin may still answer, and its
  // answer then replaces the guess. Everything else is read once and forgotten.
  if (isUnknownOutcome(job)) job.claimed = true; else jobs.delete(job.id);
  // late: it was shown as stalled and then answered after all.
  const late = job.stalledReports > 0 && !isUnknownOutcome(job) ? { late: true } : {};
  if (job.status === "error") return { ok: false, status: "error", job_id: job.id, code: job.code, error: job.error, ...errorLocation(job), ...late };
  return { ok: true, status: "done", job_id: job.id, response: job.result, script: job.script || null, target: job.target || null, ...late };
}

module.exports = { jobs, jobWaiters, JOBS_MAX, touchJob, sweepJobs, takeLate, quietMs, waitForJob, errorLocation, settleCommand, findBusyJob, failCommandsOfClient, readJobSnapshot };
