const { classifyScript, AFTER_WRITE_MAX_IDS, AFTER_WRITE_BYTES, AFTER_WRITE_DEEP_IDS, resultIds, suggestInspect, pageWideScan, PAGE_SCAN_NOTE } = require("./classify");
const { TIMEOUTS } = require("./config");
const { sendCommandToPlugin } = require("./dispatch");
const { readNudge } = require("./guards");
const { buildInspectCode } = require("./inspect-code");
const { REACTION_MACRO_RE, linkOverlay, OVERLAY_HEADER_RE, OVERLAY_HEADER_DONE, overlayPairs, overlayDone } = require("./overlay");
const { fitLines } = require("./shrink");

async function afterWriteOutline(code, response, target) {
  if (classifyScript(code, response) !== "write") return null;
  const codeIds = suggestInspect(code).node_ids || [];
  // A prototype link is checked with view:"flow" (bench H3: every T3 run
  // re-read it that way after the write), so show that instead of outlines.
  const flow = REACTION_MACRO_RE.test(code);
  // componentize / flatten / clone return NEW ids the code never named (bench
  // H4: T4 re-read the six new components after the write): those first.
  let fresh = [];
  try { fresh = (resultIds(response && response.result)).filter(id => codeIds.indexOf(id) === -1); } catch (e) {}
  let ids = fresh.concat(codeIds).slice(0, AFTER_WRITE_MAX_IDS);
  if (flow) {
    // ids kept in variables never reach the code text: the macro's own result has them
    const pairs = overlayPairs(code, response);
    const ov = pairs.length ? [...new Set([].concat(...pairs.map(x => [x.trigger, x.overlay])))] : null;
    const modified = response && Array.isArray(response.modified) ? response.modified.map(String) : [];
    ids = (ov || (codeIds.length ? codeIds : modified)).slice(0, AFTER_WRITE_MAX_IDS);
  }
  if (!ids.length) return null;
  try {
    // flow: the whole screen of the trigger (and of the overlay), not the two nodes: every link on it
    const r = await sendCommandToPlugin({
      code: buildInspectCode(flow ? { node_ids: ids, view: "flow", screens: true } : { node_ids: ids, depth: ids.length <= AFTER_WRITE_DEEP_IDS ? 1 : 0, notes: true }),
      description: "Inspect (after write)",
      target: target
    }, TIMEOUTS.fast);
    let outline = r && r.result && (flow ? r.result.flow : r.result.outline);
    if (typeof outline !== "string") return null;
    // a layer inside an instance: say the master and the other instances are intact (compared for real in the plugin)
    if (!flow && Array.isArray(r.result.notes) && r.result.notes.length) outline = r.result.notes.join("\n") + "\n" + outline;
    // Ids the write replaced (componentize) read as MISSING: noise, not news.
    outline = outline.split("\n").filter(l => !/^\s*MISSING\b/.test(l)).join("\n");
    if (!outline) return null;
    return fitLines(outline, AFTER_WRITE_BYTES).text;
  } catch (e) {
    return null;
  }
}

// Everything a finished write gets on top of the plugin's reply: overlay
// `done`, the read nudge, lint, the after-write re-read, captureNote clean-up.
// One place for the synchronous reply and figma_job_status (an escalated write
// used to get only `after`: no `done`, no OVERLAY_LINKED, the "Nothing was
// created" note next to a filled after; review 4.2.7 #53). Mutates
// response.captureNote. ctx: target, file (where it ran, default the result's
// __file or target), lint (extra lint strings). -> lead | null
async function postWrite(code, response, ctx = {}) {
  const ok = !!response && response.success !== false;
  const opened = ok ? overlayPairs(code, response) : [];
  opened.forEach(x => linkOverlay(ctx.file !== undefined ? ctx.file : (response && response.__file) || ctx.target || null, x, response && response.checkpointId));
  const nudge = ok ? readNudge(code, response) : null;
  const lint = [].concat(ctx.lint || [], pageWideScan(code) ? "Whole-page scan: " + PAGE_SCAN_NOTE : null).filter(Boolean).join(" ");
  const lead = {};
  // done goes first: models act on the first thing they read (Argon audit #23)
  if (ok && (opened.length || (REACTION_MACRO_RE.test(code) && /MANUAL STEP/.test(JSON.stringify(response.result || ""))))) lead.done = overlayDone(code, opened);
  if (nudge) lead.use_instead = nudge;
  if (lint) lead.lint = lint;
  let after = ok && !nudge ? await afterWriteOutline(code, response, ctx.target) : null;
  // "read-only, set it by hand" only when some look stayed unset (review 4.2.7 #45)
  if (after && lead.done && (!opened.length || opened.some(x => x.manual !== false))) after = after.replace(OVERLAY_HEADER_RE, OVERLAY_HEADER_DONE);
  if (after) {
    lead.after = "Already re-read for you, as they are now (no verify call needed):\n" + after;
    // "Nothing was created, modified ... no screenshot" next to a filled `after` reads as "nothing happened"
    if (typeof response.captureNote === "string" && /Nothing was created, modified/.test(response.captureNote)) response.captureNote = null;
  }
  return Object.keys(lead).length ? lead : null;
}

module.exports = { afterWriteOutline, postWrite };
