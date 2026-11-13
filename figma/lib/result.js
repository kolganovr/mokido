const vm = require("vm");
const { optimizeFigmaData } = require("../optimizer");
const { outputBudgetInfo, truncationNote, resultBudget } = require("./budget");
const { ECONOMY } = require("./config");
const { classifyServerCode, withServerHint, toJson } = require("./hints");
const { errorLocation } = require("./jobs");
const { shieldParams } = require("./script-prep");
const { byteLength, cutToBytes, shrinkToBudget } = require("./shrink");
const { compressValidationError, compressValidationDeep } = require("./validation");

// ------------------------------------------------------------------
// Images. Tokens are charged by pixel area (~w*h/750), so the useful facts to
// surface are the real dimensions and the price. The PNG size is read from
// the IHDR chunk — no decoding, no dependencies.
// ------------------------------------------------------------------
function stripDataUrl(b64) {
  return String(b64 || "").replace(/^data:image\/\w+;base64,/, "");
}

function pngSize(b64) {
  try {
    const head = Buffer.from(stripDataUrl(b64).slice(0, 32), "base64");
    if (head.length < 24 || head.toString("ascii", 12, 16) !== "IHDR") return null;
    return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
  } catch (e) {
    return null;
  }
}

function describeImage(b64, label) {
  const size = pngSize(b64);
  const dims = size ? `${size.w}x${size.h} ~${Math.ceil((size.w * size.h) / 750)}tok` : "?";
  return label ? `${label} ${dims}` : dims;
}

// Gathers every image a plugin response carries (before/after, single, list),
// caps how many go back to the model, and describes each one in text.
function collectImages(response, maxImages = ECONOMY.maxImages) {
  const found = [];
  if (!response) return { parts: [], meta: [], skipped: 0, errors: [] };
  if (response.beforeScreenshot) found.push({ b64: response.beforeScreenshot, label: "before" });
  if (response.screenshot) found.push({ b64: response.screenshot, label: response.targetName || null });
  const errors = [];
  if (Array.isArray(response.screenshots)) {
    for (const shot of response.screenshots) {
      if (shot && shot.base64) found.push({ b64: shot.base64, label: shot.name || shot.label || shot.id || null });
      else if (shot && shot.error) errors.push(`${shot.name || shot.id || "node"}: ${shot.error}`);
    }
  }
  const limit = Number.isFinite(maxImages) && maxImages > 0 ? maxImages : found.length;
  const kept = found.slice(0, limit);
  return {
    parts: kept.map(img => ({ type: "image", data: stripDataUrl(img.b64), mimeType: "image/png" })),
    meta: kept.map(img => describeImage(img.b64, img.label)),
    skipped: found.length - kept.length,
    errors
  };
}

// Every successful write/read tool renders through this so an agent gets the
// same envelope shape regardless of which tool it called: { ok, result,
// created, modified, warnings, checkpoint_id, duration_ms, ...extra }.
//
// The byte budget covers the WHOLE envelope, not just `result`: a client that
// spills oversized tool output to a file measures everything it was handed.
function buildStructuredResult(response, extra, options = {}) {
  const budget = Number.isFinite(options.maxOutputBytes) ? options.maxOutputBytes : ECONOMY.maxOutputBytes;
  // Side lists get a share of the budget so they can never crowd out result.
  const sideCap = budget > 0 ? Math.min(1500, Math.floor(budget / 4)) : 0;
  const rest = {};
  if (response) {
    if (Array.isArray(response.created) && response.created.length) rest.created = shrinkToBudget(response.created, sideCap).value;
    if (Array.isArray(response.modified) && response.modified.length) rest.modified = shrinkToBudget(response.modified, sideCap).value;
    if (Array.isArray(response.warnings) && response.warnings.length) rest.warnings = shrinkToBudget(response.warnings, sideCap).value;
    if (response.checkpointId) rest.checkpoint_id = response.checkpointId;
    if (typeof response.durationMs === "number") rest.duration_ms = response.durationMs;
    if (response.captureNote) rest.capture_note = response.captureNote;
  }
  if (options.images) {
    if (options.images.meta.length) rest.images = options.images.meta;
    if (options.images.skipped) rest.images_skipped = `${options.images.skipped} more image(s) not sent (max ${ECONOMY.maxImages} per call) — capture those nodes separately if you need them.`;
    if (options.images.errors.length) rest.image_errors = options.images.errors;
  }
  if (options.capNote) rest.note = options.capNote;
  if (extra) Object.assign(rest, extra);

  // `lead` fields (the read nudge) go BEFORE result: the first thing the model
  // reads, not one more key after a long payload.
  const lead = options.lead || null;
  const stashed = !!(response && response.resultStashed);
  const readNote = !!(lead && (lead.use_instead || lead.redirected));
  const noteBytes = byteLength(toJson(truncationNote({ from: 9999999, to: 9999999 }, stashed, readNote, options.kind))) + 16;
  const shrunk = shrinkToBudget(
    response && response.result !== undefined ? compressValidationDeep(response.result) : null,
    resultBudget(budget, lead ? Object.assign({}, lead, rest) : rest, noteBytes)
  );
  const envelope = Object.assign({ ok: true }, lead || {}, { result: shrunk.value });
  if (shrunk.truncated) envelope.truncated = truncationNote(shrunk.truncated, stashed, readNote, options.kind);
  return toJson(Object.assign(envelope, rest));
}

// Text envelope + image parts, the shape every capture-capable tool returns.
function renderPluginResponse(response, extra, options = {}) {
  const images = collectImages(response, options.maxImages);
  return {
    content: [
      { type: "text", text: buildStructuredResult(response, extra, { ...options, images }) },
      ...images.parts
    ]
  };
}

// Screenshot knobs shared by every capture-capable tool.
function captureOptions(args, defaultScale = ECONOMY.scale) {
  const scale = Number(args && args.scale);
  const maxPx = Number(args && args.max_px);
  return {
    scale: Number.isFinite(scale) && scale > 0 ? scale : defaultScale,
    max_px: Number.isFinite(maxPx) && maxPx > 0 ? maxPx : ECONOMY.maxPx
  };
}

// Mirrors buildStructuredResult for the failure path, used by handleCallTool's
// outer catch — every tool failure comes back with the same { ok:false, code,
// error } shape instead of a single opaque line of text.
function buildErrorEnvelope(error) {
  const rawMessage = compressValidationError(error && error.message ? error.message : String(error));
  const code = (error && error.code) || classifyServerCode(rawMessage) || null;
  return { ok: false, code, error: withServerHint(rawMessage), ...errorLocation(error) };
}

// Catches a SyntaxError in the agent's code BEFORE it is queued for the plugin:
// the round trip costs a turn and the plugin's own message has no line number.
// The wrapper mirrors the plugin's AsyncFunction (same parameter names), one line
// above the code, so lineOffset -1 makes the reported line the agent's own.
// Throws an Error carrying code/line/at, or returns when the code compiles.
const SYNTAX_HINT = "Your code is compiled as an async function body: top-level await and return are allowed, " +
  "import/export are not. Check for unbalanced braces or quotes in the code string.";

function checkAgentSyntax(code) {
  if (typeof code !== "string") return;
  try {
    new vm.Script(
      "(async function (figma, ensureFont, notify, log, getFreePosition, getFreeCanvasPosition, bridge, progress) {\n" + shieldParams(code) + "\n})",
      { filename: "code.js", lineOffset: -1 }
    );
  } catch (e) {
    if (!e || e.name !== "SyntaxError") return; // not ours to judge: let the plugin run it
    const err = new Error(`${e.message}\n\nHINT: ${SYNTAX_HINT}`);
    err.code = "SCRIPT_SYNTAX_ERROR";
    const m = /^code\.js:(\d+)/m.exec(String(e.stack || ""));
    if (m) {
      const line = Number(m[1]);
      err.line = line;
      const src = code.split("\n")[line - 1];
      if (typeof src === "string" && src.trim()) err.at = src.trim().slice(0, 160);
    }
    throw err;
  }
}

// figma_inspect's `offset`: drop the first `offset` lines of the string
// results (outline / found) and say so on the first line. Runs before the
// budget shrink; shrinkToBudget numbers its own "pass offset=K" from ORIGINAL lines.
function applyLineOffset(result, offset) {
  const off = Math.floor(Number(offset));
  if (!result || typeof result !== "object" || !Number.isFinite(off) || off <= 0) return result;
  const out = { ...result };
  for (const key of ["outline", "found", "compare", "like", "flow", "texts"]) {
    if (typeof out[key] !== "string" || out[key].indexOf("\n") === -1) continue;
    out[key] = `… lines 0–${off - 1} skipped\n` + out[key].split("\n").slice(off).join("\n");
  }
  return out;
}

// Plain data results (list/find/variables/layout...) under the same budget.
const NARROW_HINT = " Narrow the query (query/limit/collection_name/node_ids) to see the rest.";

function jsonResult(value, args) {
  const noteBytes = byteLength(truncationNote({ from: 9999999, to: 9999999 }, false) + NARROW_HINT) + 16;
  const info = outputBudgetInfo(args);
  const shrunk = shrinkToBudget(value, resultBudget(info.bytes, info.capNote ? { note: info.capNote } : {}, noteBytes));
  const body = { ok: true, result: shrunk.value };
  if (info.capNote) body.note = info.capNote;
  if (shrunk.truncated) body.truncated = truncationNote(shrunk.truncated, false) + NARROW_HINT;
  return { content: [{ type: "text", text: toJson(body) }] };
}

// Shared by figma_read_canvas AND get_file/get_node: serialize at the
// requested depth, and if that overshoots the byte budget, re-serialize the
// SAME already-fetched tree at a shallower maxDepth (cheap — pure JS, no
// extra network/plugin round trip) until it fits or depth bottoms out at 0.
// Still too big at depth 0 (hundreds of top-level frames): cut, and say so.
function applyTokenBudget(rawData, { format, includeHidden, maxDepth, budgetBytes }) {
  let depthTry = maxDepth;
  let output = optimizeFigmaData(rawData, { format, simplify: true, maxDepth: depthTry, includeHidden });

  while (budgetBytes > 0 && byteLength(output) > budgetBytes && depthTry > 0) {
    depthTry -= 1;
    output = optimizeFigmaData(rawData, { format, simplify: true, maxDepth: depthTry, includeHidden });
  }

  let cut = false;
  if (budgetBytes > 0 && byteLength(output) > budgetBytes) {
    output = cutToBytes(output, budgetBytes - 200);
    cut = true;
  }
  if (depthTry < maxDepth || cut) {
    output += `\n\n<!-- ${cut ? "cut" : "truncated"} at depth=${depthTry} to fit ${budgetBytes} bytes. Read a specific node_id for more depth, or raise budget_tokens. -->`;
  }
  return output;
}

// budget_tokens (the public knob) -> bytes at ~4 bytes/token; absent -> the
// server-wide byte budget.
function budgetBytesFromTokens(budgetTokens) {
  return Number.isFinite(budgetTokens) ? budgetTokens * 4 : ECONOMY.maxOutputBytes;
}

module.exports = { pngSize, collectImages, buildStructuredResult, renderPluginResponse, captureOptions, buildErrorEnvelope, checkAgentSyntax, applyLineOffset, jsonResult, applyTokenBudget, budgetBytesFromTokens };
