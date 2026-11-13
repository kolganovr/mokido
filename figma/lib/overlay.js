const { suggestInspect } = require("./classify");
const { pickTargetClient } = require("./dispatch");
const { state } = require("./state");

const REACTION_MACRO_RE = /bridge\s*\.\s*(?:setReaction|openOverlay|closeOverlay)\s*\(/;

const MANUAL_DONE = "Done: the link is set. The overlay look is a MANUAL STEP no script can do (read-only in the Plugin API, no setter anywhere): stop here and tell the user exactly what the result says.";

const OVERLAY_LOOK_WRITE_RE =/\.overlay(?:PositionType|Background|BackgroundInteraction)\s*=(?!=)/;

const RAW_OVERLAY_RE = /(\.reactions\s*=(?!=)|setReactionsAsync\s*\()[\s\S]*["'`]OVERLAY["'`]|["'`]OVERLAY["'`][\s\S]*(\.reactions\s*=(?!=)|setReactionsAsync\s*\()/;

// Overlay frames bridge.openOverlay already linked in this server's life. A
// later script that tries to set the look on that frame is told the task is
// done (bench T3: 3 of 3 h7 runs re-read and tried). Keyed by file + overlay
// id (low ids like 12:3 repeat across files) and dropped when figma_rollback
// undoes the write that made the link (review 4.2.7 #47):
// "<file>\u0000<overlay id>" -> { trigger, overlay, file, checkpointId, manual }.
const OVERLAY_LINKED = new Map();

// fileName as `target` names it; null = unknown (a proxy call without target).
function overlayFileId(name) {
  return name ? String(name).toLowerCase() : null;
}

function linkOverlay(file, pair, checkpointId) {
  const f = overlayFileId(file);
  OVERLAY_LINKED.set((f || "") + "\u0000" + pair.overlay, { trigger: pair.trigger, overlay: pair.overlay, file: f, checkpointId: checkpointId || null, manual: pair.manual });
}

// The link of overlay `id` in `file`; an unknown file on either side matches any.
function linkedOverlay(file, id) {
  const f = overlayFileId(file);
  for (const v of OVERLAY_LINKED.values()) {
    if (v.overlay === id && (!f || !v.file || v.file === f)) return v;
  }
  return null;
}

function unlinkCheckpoint(checkpointId) {
  if (!checkpointId) return;
  for (const [k, v] of OVERLAY_LINKED) if (v.checkpointId === checkpointId) OVERLAY_LINKED.delete(k);
}

// The file a call without a resolved result goes to (macroGuard runs before
// sending): the target, else the client the router would pick; null if unknown.
function callFile(target) {
  if (target) return target;
  if (!state.isBridgeMaster) return null;
  try { const c = pickTargetClient(null); return c ? c.fileName || null : null; } catch (e) { return null; }
}

const OPEN_OVERLAY_IDS_RE = /bridge\s*\.\s*openOverlay\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*["'`]([^"'`]+)["'`]/;

const OVERLAY_HEADER_RE = /^OVERLAY SETTINGS \(frame properties of the overlay target, not part of the action\)$/m;

const OVERLAY_HEADER_DONE = "OVERLAY SETTINGS = the frame's CURRENT look, read-only for scripts: it stays like this until the user sets it by hand (the MANUAL STEP), not a failed write";

// Trigger first, overlay frame second: destinationId or the frame whose look the
// script sets is the overlay, never the trigger (Argon audit #18: p2 T3 043ebeed).
function overlayCall(code, file) {
  const ids = suggestInspect(code).node_ids || [];
  let ov = (code.match(/destinationId\s*:\s*["'`]([^"'`]+)["'`]/) || [])[1] || null;
  if (!ov && OVERLAY_LOOK_WRITE_RE.test(code) && ids.length === 1) ov = ids[0];
  let trig = ids.find(id => id !== ov) || null;
  if (!ov && ids.length >= 2) { trig = ids[0]; ov = ids[1]; }
  const known = ov && !trig ? linkedOverlay(file, ov) : null;
  if (known) trig = known.trigger;
  return `await bridge.openOverlay(${trig ? JSON.stringify(trig) : "triggerId"}, ${ov ? JSON.stringify(ov) : "overlayFrameId"}, { position: 'BOTTOM_CENTER', dim: 0.4, closeOnOutside: true })`;
}

// [{ trigger, overlay, manual }] of the bridge.openOverlay calls of a write.
// First the plugin's own list (4.2.8+: every call that ran, manual = the look
// stayed unset), else the literals in the code, else (ids kept in variables,
// h13 T3#3 08732f9d, an older plugin) modified[0..1], which is [trigger,
// overlay] only when the macro is the script's first edit: any node touched
// before it shifted the pair (review 4.2.7 #46). Without the plugin's flag,
// manual comes from the macro's text in the result (#45): "MANUAL STEP" = the
// look stayed unset, "(..., click outside closes)" = it was set; else
// undefined = unknown, which `done` treats as manual (read-only in practice).
function overlayManualFromText(response) {
  const text = response ? JSON.stringify(response.result === undefined ? "" : response.result) : "";
  if (/MANUAL STEP/.test(text)) return true;
  if (/click outside (?:closes|does nothing)\)/.test(text)) return false;
  return undefined;
}

function overlayPairs(code, response) {
  if (response && Array.isArray(response.overlays) && response.overlays.length) {
    return response.overlays.filter(x => x && x.trigger && x.overlay)
      .map(x => ({ trigger: String(x.trigger), overlay: String(x.overlay), manual: typeof x.manual === "boolean" ? x.manual : undefined }));
  }
  if (typeof code !== "string" || !/bridge\s*\.\s*openOverlay\s*\(/.test(code)) return [];
  const manual = overlayManualFromText(response);
  const re = new RegExp(OPEN_OVERLAY_IDS_RE.source, "g");
  const lit = [];
  let m;
  while ((m = re.exec(code))) lit.push({ trigger: m[1], overlay: m[2], manual });
  if (lit.length) return lit;
  if (response && Array.isArray(response.modified) && response.modified.length >= 2) {
    return [{ trigger: String(response.modified[0]), overlay: String(response.modified[1]), manual }];
  }
  return [];
}

// `done` for a successful bridge.openOverlay, self-contained: the model often
// returns its own string and drops the macro's MANUAL STEP text (h7 f7d2ca3a).
function overlayDone(code, pairs) {
  const list = Array.isArray(pairs) ? pairs : overlayPairs(code, null);
  if (!list.length) return MANUAL_DONE;
  const links = list.map(x => `#${x.trigger} opens overlay #${x.overlay}`).join(", ");
  // only the overlays whose look stayed unset are a manual step (review 4.2.7 #45)
  const frames = list.filter(x => x.manual !== false).map(x => "#" + x.overlay).join(", ");
  const pos = (code.match(/position\s*:\s*["'`](\w+)["'`]/) || [])[1];
  const dim = (code.match(/dim\s*:\s*([\d.]+)/) || [])[1];
  const outside = /closeOnOutside\s*:\s*true/.test(code);
  const want = [pos ? "position " + pos : null, dim ? "background #000000 at " + Math.round(Number(dim) * 100) + "%" : null, outside ? "close when clicking outside" : null].filter(Boolean).join(", ");
  if (!frames) return `Done: ${links}, and the overlay look is set (the macro wrote it; OVERLAY SETTINGS show it). Don't re-check or retry: answer now.`;
  return `Done: ${links}. The overlay look is a MANUAL STEP (read-only in the Plugin API, no setter anywhere; OVERLAY SETTINGS below show the current values, not a failed write). Don't re-check or retry: answer now and tell the user to select frame ${frames} > Prototype panel > Overlay and set ${want || "position, background and click-outside"}.`;
}

module.exports = { REACTION_MACRO_RE, OVERLAY_LOOK_WRITE_RE, RAW_OVERLAY_RE, OVERLAY_LINKED, linkOverlay, linkedOverlay, unlinkCheckpoint, callFile, OVERLAY_HEADER_RE, OVERLAY_HEADER_DONE, overlayCall, overlayPairs, overlayDone };
