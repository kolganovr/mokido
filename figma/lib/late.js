const { ORIGIN_ID } = require("./config");
const { state } = require("./state");
const { byteLength } = require("./shrink");

// Late results and figma_job_status edge cases (ADR-002, T-075, T-008).
// A job that finished after nobody was waiting any more is handed to the model as a
// first text block `late_result` in the next reply of the process that started it.
// The router wrapper calls attachLate(); everything else lives here so router.js
// stays small. Leaf module: config, state and shrink only.

const FULL_MAX = 300;      // bytes, the full block
const SHORT_MAX = 120;     // bytes, the short block
const LATE_CEILING = 3900; // main text + full block must stay under this, else the short block
const ISSUED_MAX = 50;

// Tools that talk to the plugin (and so to the master's journal). REST tools and
// figma_list_targets never carry a block.
const LATE_TOOLS = new Set([
  "figma_execute_code", "figma_inspect", "figma_job_status", "figma_read_canvas", "figma_rollback",
  "figma_screenshot", "figma_get_selection", "figma_create_ui_card", "figma_find_components",
  "figma_insert_component_instance", "figma_get_variables", "figma_set_variables_mode",
  "figma_insert_svg", "figma_get_canvas_layout", "figma_html"
]);

const oneLine = (s, max) => {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "~" : t;
};

function noteFor(d, hasIds) {
  if (d.status === "lost" || d.status === "expired") return "Outcome unknown: one cheap read of the canvas, do not rerun blind.";
  if (d.status === "error") return "Failed late. Check the canvas before any rerun. Details: figma_job_status.";
  return hasIds ? "Finished late. Do not rerun, inspect these ids. Full: figma_job_status."
    : "Finished late. Do not rerun it. Full: figma_job_status.";
}

function pack(d, descLen, errLen, fileLen, ids) {
  const o = { job_id: d.job_id, status: d.status, was: d.was };
  const desc = descLen ? oneLine(d.description, descLen) : "";
  if (desc) o.description = desc;
  o.finished_s_ago = d.finished_s_ago;
  if (ids.length) o.created = ids;
  if (d.created_count > 0) o.created_count = d.created_count;
  if (d.modified_count > 0) o.modified_count = d.modified_count;
  if (d.checkpoint_id) o.checkpoint_id = d.checkpoint_id;
  if (d.status === "error" && errLen) o.error = oneLine(d.error, errLen);
  if (d.orphan) { o.orphan = true; if (d.file && fileLen) o.file = oneLine(d.file, fileLen); }
  if (d.more > 0) o.more = d.more;
  o.note = noteFor(d, ids.length > 0);
  return o;
}
const size = (o) => byteLength(JSON.stringify({ late_result: o }));

// Full form, at most FULL_MAX bytes: ids first (as many as fit), then description and
// error text shrink before an id is given up. null when even the bare frame does not fit.
function fullBlock(d) {
  const all = d.status === "error" ? [] : (d.created || []).slice(0, 20).map(String);
  const want = Math.min(all.length, 3);
  const variants = [[30, 120, 30], [14, 80, 20], [0, 50, 14], [0, 20, 8], [0, 0, 0]];
  for (let i = 0; i < variants.length; i++) {
    const [dl, el, fl] = variants[i];
    let n = all.length;
    while (n > 0 && size(pack(d, dl, el, fl, all.slice(0, n))) > FULL_MAX) n--;
    const o = pack(d, dl, el, fl, all.slice(0, n));
    if (size(o) <= FULL_MAX && (n >= want || i === variants.length - 1)) return { late_result: o };
  }
  return null;
}

function shortBlock(d) {
  const o = { job_id: d.job_id, status: d.status, created_count: d.created_count || 0 };
  const withNote = { ...o, note: "details: figma_job_status" };
  return { late_result: size(withNote) <= SHORT_MAX ? withNote : o };
}

// What the model reads, as the text of one content item. `mainBytes` is the size of
// the reply's own text: when both would cross the ceiling the short form is used.
function lateBlock(d, mainBytes) {
  const full = fullBlock(d);
  if (full) {
    const text = JSON.stringify(full);
    if ((mainBytes || 0) + byteLength(text) <= LATE_CEILING) return text;
  }
  return JSON.stringify(shortBlock(d));
}

function textBytes(result) {
  let n = 0;
  for (const part of result.content) if (part && part.type === "text") n += byteLength(part.text);
  return n;
}

// Next late record for this call: first what a proxy got from the master, then (master
// only) straight from the journal. A job being read by this very call is skipped.
function nextLate(exceptId, takeLate) {
  while (state.lateInbox.length) {
    const q = state.lateInbox.shift();
    if (q && typeof q === "object" && q.job_id && q.job_id !== exceptId) return q;
  }
  return state.isBridgeMaster ? takeLate(ORIGIN_ID, exceptId) : null;
}

// The router wrapper: puts the block FIRST in content (errors too). Never throws:
// a broken block must not cost the model its real answer.
function attachLate(result, name, args, takeLate) {
  try {
    if (!LATE_TOOLS.has(name) || !result || !Array.isArray(result.content)) return result;
    const exceptId = name === "figma_job_status" && args ? args.job_id : undefined;
    const d = nextLate(exceptId, takeLate);
    if (!d) return result;
    return { ...result, content: [{ type: "text", text: lateBlock(d, textBytes(result)) }, ...result.content] };
  } catch (e) {
    return result;
  }
}

// ---- figma_job_status ------------------------------------------------------
// Ids this process handed to the model as running: if the journal later does not
// know one, the journal was lost (master restarted), not "already read".
const issued = [];
function noteIssued(id) {
  if (!id) return;
  const at = issued.indexOf(id);
  if (at !== -1) issued.splice(at, 1);
  issued.push(id);
  while (issued.length > ISSUED_MAX) issued.shift();
}
function forgetIssued(id) {
  const at = issued.indexOf(id);
  if (at !== -1) issued.splice(at, 1);
}

function unknownJob(id) {
  return {
    ok: false, status: "unknown", code: "JOB_STATE_UNKNOWN", job_id: id || null,
    hint: "The bridge that ran this job restarted, so its outcome is unknown. If the script still finishes, the result comes as late_result on a later Mokido call. Until then do not rerun it blind: make one cheap read of the canvas (figma_inspect)."
  };
}

// A thrown BRIDGE_OFFLINE (the master is gone) becomes the structured answer.
function jobStatusError(err, id) {
  return err && err.code === "BRIDGE_OFFLINE" ? unknownJob(id) : null;
}

// A snapshot (from the journal or a proxy hop) made safe for the model.
function jobStatusSnap(snap, id) {
  if (snap && snap.code === "JOB_NOT_FOUND" && issued.indexOf(id) !== -1) return unknownJob(id);
  if (snap && (snap.status === "done" || snap.status === "error")) forgetIssued(id);
  return snap;
}

module.exports = { LATE_TOOLS, FULL_MAX, SHORT_MAX, LATE_CEILING, fullBlock, shortBlock, lateBlock, attachLate, noteIssued, forgetIssued, unknownJob, jobStatusError, jobStatusSnap };
