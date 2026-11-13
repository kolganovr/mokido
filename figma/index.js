#!/usr/bin/env node
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const vm = require("vm");
const { optimizeFigmaData } = require("./optimizer");
const { BRIDGE_PORT, BRIDGE_TOKEN, ALLOWED_ORIGINS, MAX_WS_MESSAGE_BYTES, MAX_HTTP_BODY_BYTES, TIMEOUTS, SERVER_VERSION, ECONOMY } = require("./lib/config");
const { parseFigmaUrlOrKey, figmaApiRequest } = require("./lib/rest");
const { TOOLS, getActiveTools } = require("./lib/tools");
const { SERVER_INSTRUCTIONS } = require("./lib/instructions");
const { normalizeNodeIds, classifyServerCode, withServerHint, toJson } = require("./lib/hints");
const { fitLines, byteLength, cutToBytes, shrinkToBudget } = require("./lib/shrink");
const { compressValidationError, compressValidationDeep } = require("./lib/validation");
const { FONT_MEMO_PRELUDE, DIFF_OFF_NOTE, shieldParams, withFontMemo, stripFontMemoCode, stripFontMemo } = require("./lib/script-prep");
const { isNewerVersion, updateNotice, checkForUpdates } = require("./lib/update");
const { state } = require("./lib/state");
const { jobs, errorLocation, readJobSnapshot } = require("./lib/jobs");
const { listTargets, pickTargetClient, sendCommandToPlugin, proxyToMaster } = require("./lib/dispatch");
const { startBridge } = require("./lib/server");

// Who is on the other end, from `initialize` clientInfo.name. Antigravity
// writes any tool output over ~4.1 KB to a file and makes the model spend a
// turn reading it; the clients below keep large outputs inline.
const MCP_CLIENT = { name: null };
const NO_SPILL_CLIENTS = /claude|cursor|windsurf|cline|roo-?code|codex|zed|continue/i;

function clientSpillsOutput() {
  return !(MCP_CLIENT.name && NO_SPILL_CLIENTS.test(MCP_CLIENT.name) && !/antigravity|gemini/i.test(MCP_CLIENT.name));
}

// The ceiling in force for this client (0 = none).
function activeOutputCeiling() {
  if (ECONOMY.outputCeilingFromEnv) return ECONOMY.outputCeiling;
  return clientSpillsOutput() ? ECONOMY.outputCeiling : 0;
}

// max_output_chars is the pre-4.2 name of max_output_bytes, still honoured.
// A REQUESTED value above the active ceiling — or 0, "no limit" — is clamped
// to it; the server default is left alone. -> { bytes, capNote }
function outputBudgetInfo(args) {
  for (const key of ["max_output_bytes", "max_output_chars"]) {
    const n = Number(args && args[key]);
    if (args && args[key] !== undefined && Number.isFinite(n) && n >= 0) {
      const ceiling = activeOutputCeiling();
      if (ceiling > 0 && (n === 0 || n > ceiling)) {
        return {
          bytes: ceiling,
          capNote: `max_output_bytes capped at ${ceiling}: a bigger reply is written to a file (an extra turn) — page with offset, or return a slice of bridge.state.lastResult`
        };
      }
      return { bytes: n, capNote: null };
    }
  }
  return { bytes: ECONOMY.maxOutputBytes, capNote: null };
}

function outputBudget(args) {
  return outputBudgetInfo(args).bytes;
}

// The options every text-rendering tool passes to renderPluginResponse.
function budgetOptions(args) {
  const info = outputBudgetInfo(args);
  return { maxOutputBytes: info.bytes, capNote: info.capNote };
}

// Copies of one element (a dropdown on three breakpoints) look alike in an
// outline but the model does not connect them: bench T1 (15.10) went
// outline -> depth 4 -> depth 5 -> props -> a dump script before writing,
// 8-13 turns. When an outline holds 3+ nodes of the same structure whose
// style differs, say so and name the one call that diffs them.
const SIMILAR_LINE_RE = /^(\s*)(FRAME|INSTANCE|COMPONENT|GROUP) "((?:[^"\\]|\\.)*)" #(\S+) [\d.]+x([\d.]+) @\S+(.*)$/;
const DEEPER_RE = /^\s*… \+(\d+) deeper/;

function outlineStyle(rest, h) {
  const s = { h: h };
  const br = /\[([^\]]*)\]/.exec(rest);
  const inner = br ? br[1] : "";
  s.layout = (/^[HVW]\b/.exec(inner) || [""])[0];
  s.gap = (/\bgap\S+/.exec(inner) || [""])[0];
  s.pad = (/\bpad\S+/.exec(inner) || [""])[0];
  s.align = (/\ba:\S+/.exec(inner) || [""])[0];
  const after = br ? rest.slice(br.index + br[0].length) : rest;
  s.fill = (/\bfill:\S+/.exec(after) || [""])[0];
  s.stroke = (/\bstroke:\S+/.exec(after) || [""])[0];
  s.r = (/(?:^|\s)(r[\d.,]+)(?=\s|$)/.exec(after) || ["", ""])[1];
  s.shadow = (/\bshadow:\S+(?: #\S+)?/.exec(after) || [""])[0];
  return s;
}

// Frames named like a finished example ("… (эталон)", "reference") are shown,
// not grouped with the targets (h7 T1 offered the reference as a 4th copy).
const REFERENCE_NAME_RE = /эталон|reference|\bref\b/i;

function similarHint(outline) {
  if (typeof outline !== "string") return null;
  const lines = outline.split(/\r?\n/);
  const nodes = [];
  const refs = [];
  const anc = []; // [{ indent, ref }] of the lines above the current one
  lines.forEach((line, i) => {
    const m = SIMILAR_LINE_RE.exec(line);
    const indentNow = line.length - line.trimStart().length;
    while (anc.length && anc[anc.length - 1].indent >= indentNow) anc.pop();
    if (!m) { anc.push({ indent: indentNow, ref: false }); return; }
    const inRef = anc.some(a => a.ref) || REFERENCE_NAME_RE.test(m[3]);
    anc.push({ indent: indentNow, ref: inRef });
    if (m[1].length === 0) return;
    // inside an instance (#I<id>;<id>) every layer belongs to the master: not a node to align
    if (m[4].charAt(0) === "I") return;
    const indent = m[1].length;
    // direct children: printed lines one level down, or the children:N marker when the depth cut them
    let kids = 0, childIndent = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const ind = lines[j].length - lines[j].trimStart().length;
      if (ind <= indent) break;
      if (DEEPER_RE.test(lines[j])) continue;
      if (childIndent === -1) childIndent = ind;
      if (ind === childIndent) kids++;
    }
    const cut = /\schildren:(\d+)$/.exec(m[6]);
    if (!kids && cut) kids = Number(cut[1]);
    if (kids < 2) return;
    const st = outlineStyle(m[6], m[5]);
    // a bare layout container (a row of fields) is not a styled copy of anything
    if (!st.fill && !st.stroke && !st.r && !st.shadow) return;
    if (inRef) { refs.push(m[4]); return; }
    // instances of different variants differ on purpose (Size=Desktop / Mobile): never one group
    const variant = m[2] === "INSTANCE" ? (/→.*?(?=\schildren:\d+$|$)/.exec(m[6]) || [""])[0] : "";
    nodes.push({ id: m[4], sig: m[2] + "|" + st.layout + "|" + kids + "|" + variant, st: st });
  });
  const groups = {};
  nodes.forEach(n => { (groups[n.sig] = groups[n.sig] || []).push(n); });
  const keys = ["stroke", "r", "shadow", "pad", "gap", "fill", "h", "align"];
  const out = [];
  Object.values(groups).sort((a, b) => b.length - a.length).forEach(g => {
    if (g.length < 3 || out.length >= 2) return;
    const differ = keys.filter(k => g.some(n => n.st[k] !== g[0].st[k]));
    if (!differ.length) return;
    const ids = g.slice(0, 8).map(n => "#" + n.id).join(" ") + (g.length > 8 ? " …" : "");
    out.push(g.length + " nodes of the same structure differ in " + differ.join(", ") + ": " + ids);
  });
  if (!out.length) return null;
  const refNote = refs.length ? " (frames named as a reference, not in the group: " + refs.slice(0, 3).map(x => "#" + x).join(" ") + ")" : "";
  return out.join("; ") + refNote + ". If they should match one of them: figma_inspect compare:\"<that id>\" node_ids:[the others] lists every difference in ONE call, then fix them all in ONE write.";
}

// Tells the model the cheapest next step. Raising max_output_bytes is only
// offered where it cannot push the reply past a client's spill limit.
function truncationNote(truncated, stashed, readNudged, kind) {
  // An outline cut by depth: re-reading it level by level (depth 4, then 5)
  // or slicing lastResult with a script is a turn per step (bench T1 15.10).
  // props / compare / like / flow / check replies are lists, not an outline: nothing
  // "deeper" was collapsed (bench p2 T1 cc37aea8 got the outline note on props).
  if (kind === "inspect-list") {
    return `result shrunk ${truncated.from}→${truncated.to} bytes (cuts marked with …). ` +
      "Don't re-read with scripts: pass fewer node_ids or props, or offset=K for the next lines.";
  }
  if (kind === "inspect") {
    return `outline shrunk ${truncated.from}→${truncated.to} bytes: deeper levels collapsed (… +N deeper). ` +
      "Don't re-read level by level or with scripts: pass only the ids you need deeper, compare:\"<ref id>\" or props for exact values; offset=K pages.";
  }
  // A cut hand-written read: slicing lastResult would cost a turn per slice
  // (15 such calls in session e6524905) — point at the paged outline instead.
  if (readNudged) {
    return `result shrunk ${truncated.from}→${truncated.to} bytes (cuts marked with …). ` +
      "Don't slice bridge.state.lastResult turn by turn: the use_instead call reads these nodes in one call and pages with offset (figma_inspect offset=K).";
  }
  return `result shrunk ${truncated.from}→${truncated.to} bytes (cuts marked with …). ` +
    (stashed
      ? "Full value is in bridge.state.lastResult — next call return just the part you need, e.g. " +
        "`return bridge.state.lastResult.slice(40, 80)` for an array, or only the keys you need; don't re-run. "
      : "") +
    (activeOutputCeiling() > 0 ? "Return less." : "Return less, or raise max_output_bytes.");
}

// Room the rest of an envelope leaves for its `result` inside `budget`.
// Never below a floor that still shows the shape of what came back.
function resultBudget(budget, envelopeWithoutResult, noteBytes) {
  if (!(budget > 0)) return budget;
  const overhead = byteLength(toJson({ ...envelopeWithoutResult, result: null })) + noteBytes;
  return Math.max(budget - overhead, 600);
}

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

// figma_inspect runs as ordinary plugin code over the bridge's cheap-read
// helpers (bridge.find / summarize / inspect / check), so it needs no plugin
// message type of its own and inherits the job ledger, target routing and
// bridge.state.lastResult. Arguments travel as a JSON literal, never spliced
// in as code.
const AUTO_DEPTH_RESERVE = 300;

function buildInspectCode(args = {}) {
  const ids = normalizeNodeIds(args.node_ids || args.node_id || args.ids);
  const depth = Number(args.depth);
  const limit = Number(args.limit);
  const spec = {
    ids: ids ? ids.split(",") : [],
    depth: Number.isFinite(depth) ? Math.max(0, Math.min(6, Math.floor(depth))) : null,
    props: Array.isArray(args.props) && args.props.length ? args.props.map(String) : null,
    view: args.view === "map" || args.view === "table" || args.view === "flow" ? args.view : null,
    context: args.context === true,
    find: typeof args.find === "string" && args.find ? args.find : null,
    findText: typeof args.find_text === "string" && args.find_text ? args.find_text : null,
    type: typeof args.find_type === "string" && args.find_type ? args.find_type.toUpperCase() : null,
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 30,
    check: args.check && typeof args.check === "object" ? args.check : null,
    compare: typeof args.compare === "string" && args.compare ? args.compare.replace(/-/g, ":") : null,
    like: normalizeNodeIds(args.like) ? normalizeNodeIds(args.like).split(",") : null,
    // No depth: the plugin picks the deepest outline that fits the reply. The
    // envelope around the outline ({"ok":true,"result":{"outline":…},"duration_ms":…}
    // plus the reserved truncation note) measured 295 B (bench/tools/autodepth_check.js),
    // so the outline may take the budget minus AUTO_DEPTH_RESERVE (was a guessed 500).
    autoBytes: Math.max(600, outputBudgetInfo(args).bytes - AUTO_DEPTH_RESERVE),
    screens: args.screens === true,
    notes: args.notes === true,
    findTreeMax: 8,
    notesMax: 30,
    findTreeBytes: Math.max(600, outputBudgetInfo(args).bytes - AUTO_DEPTH_RESERVE)
  };
  const literal = JSON.stringify(spec); // ES2019+: U+2028/2029 are legal in string literals
  return [
    `const a = ${literal};`,
    "const out = {};",
    "let targets = a.ids;",
    "const query = a.findText || a.find;", // find_text (names AND text content) wins over find
    "let hits = [];",
    "if (query) {",
    "  let more = [];",
    "  for (const root of (a.ids.length ? a.ids : [null])) {",
    "    const opts = { limit: a.limit };",
    "    if (root) opts.root = root;",
    "    if (a.type) opts.type = a.type;",
    "    if (a.findText) opts.text = true;",
    "    for (const f of bridge.find(query, opts)) (typeof f === 'string' ? more : hits).push(f);",
    "  }",
    "  targets = hits.map(f => f.id);",
    "  if (!targets.length) {",
    "    out.found = 'no matches';",
    // Searching the current page only is a trap in a multi-page file: name the page and count hits elsewhere
    // (loading at most 8 other pages; the rest are listed by name only).
    "    if (!a.ids.length) {",
    "      const cur = figma.currentPage;",
    "      out.found = 'no matches on page ' + JSON.stringify(cur.name);",
    "      const others = (figma.root && figma.root.children || []).filter(p => p.id !== cur.id);",
    "      if (others.length) {",
    "        const parts = [];",
    "        let loaded = 0;",
    "        for (const p of others) {",
    "          if (loaded >= 8) { parts.push(JSON.stringify(p.name) + ': not scanned'); continue; }",
    "          loaded++;",
    "          try {",
    "            if (typeof p.loadAsync === 'function') await p.loadAsync();",
    "            const opts = { limit: 1, root: p.id };",
    "            if (a.type) opts.type = a.type;",
    "            if (a.findText) opts.text = true;",
    "            const r = bridge.find(query, opts);",
    "            const more = r.find(x => typeof x === 'string');",
    "            const m = more && /\\((\\d+) total\\)/.exec(more);",
    "            parts.push(JSON.stringify(p.name) + ': ' + (m ? m[1] : r.filter(x => typeof x !== 'string').length));",
    "          } catch (e) { parts.push(JSON.stringify(p.name) + ': ?'); }",
    "        }",
    "        out.other_pages = parts.join(', ') + ' (matches; switch page to use them)';",
    "      }",
    "    }",
    "  }",
    "  if (more.length) out.found_more = more;",
    "}",
    // No ids: every top-level node of the page (a capped walk that says what it scanned),
    // not a refusal that costs a turn (h13: 3 empty flow calls). The selection goes first,
    // so the cap never cuts what the user pointed at (review 4.2.7 #52).
    "if (a.view === 'flow' && !targets.length && !query) {",
    "  const sel = (figma.currentPage.selection || []).map(n => n.id);",
    "  targets = sel.concat(figma.currentPage.children.map(n => n.id).filter(id => sel.indexOf(id) === -1));",
    "  if (!targets.length) out.flow = 'the page is empty';",
    "}",
    // flow of whole screens: each id -> the top-level frame it sits in (under the page or a section)
    "if (a.view === 'flow' && a.screens && targets.length) {",
    "  const tops = [];",
    "  for (const id of targets) {",
    "    let n = figma.getNodeById(id);",
    "    if (!n) continue;",
    "    while (n.parent && n.parent.type !== 'PAGE' && n.parent.type !== 'SECTION' && n.parent.type !== 'DOCUMENT') n = n.parent;",
    "    if (tops.indexOf(n.id) === -1) tops.push(n.id);",
    "  }",
    "  if (tops.length) targets = tops;",
    "}",
    "if (a.like) out.like = bridge.like(a.like, a.ids);",
    "const wantsRead = !a.like && (a.props || query || a.ids.length || a.view || a.context || !a.check);",
    "if (a.compare && targets.length) out.compare = bridge.compare(a.compare, targets);",
    "if (wantsRead && !out.flow && (targets.length || !query)) {",
    "  const refs = targets.length ? targets : [figma.currentPage];",
    "  if (a.compare) {}",
    "  else if (a.props) {",
    "    out.props = bridge.inspect(refs, a.props);",
    // props:["texts"]: lines "id characters" move to the top-level string out.texts, which pages with offset.
    "    if (a.props.indexOf('texts') !== -1) {",
    "      const lines = [];",
    "      const multi = Object.keys(out.props).length > 1;",
    "      for (const id of Object.keys(out.props)) {",
    "        const row = out.props[id];",
    "        if (!row || typeof row !== 'object' || !Array.isArray(row.texts)) continue;",
    "        if (multi) lines.push('@' + id);",
    "        for (const l of row.texts) lines.push(l);",
    "        delete row.texts;",
    "        if (!Object.keys(row).length) delete out.props[id];",
    "      }",
    "      out.texts = lines.length ? lines.join('\\n') : 'no TEXT nodes';",
    "      if (!Object.keys(out.props).length) delete out.props;",
    "    }",
    "  }",
    "  else if (a.findText && !a.view) out.found = hits.map(f => '#' + f.id + ' ' + JSON.stringify(f.name) + ' «' + f.text + '» in ' + (f.parent ? f.parent + ', screen ' + JSON.stringify(String(f.frame).replace(/ #\\S+$/, '')) : f.frame)).join('\\n');",
    "  else {",
    "    const so = { maxChildren: 200 };",
    // H6: a few hits come with their subtree (the next call was an outline of the same ids in 16 of 24 finds).
    "    const findTree = query && !a.view && a.depth === null && hits.length > 0 && hits.length <= a.findTreeMax;",
    "    if (a.depth !== null) so.depth = a.depth; else if (findTree) so.autoBytes = a.findTreeBytes; else if (query || a.view === 'map') so.depth = query ? 0 : 1; else so.autoBytes = a.autoBytes;",
    "    if (a.view === 'map') so.view = 'map';",
    "    if (a.view === 'table') so.view = 'table';",
    "    if (a.view === 'flow') so.view = 'flow';",
    // Hits nested in another hit are shown inside its tree, not counted as roots; one extra line only if the depth did not reach them.
    "    let s;",
    "    if (findTree) {",
    // Budget in JSON bytes, as the plugin counts it (review 4.2.7 #49: Cyrillic names are
    // 2 bytes a char, a chars check let ~5000 B through and the reply got shrunk).
    "      const jb = t => { let b = 2; for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); b += c === 34 || c === 92 || c === 10 ? 2 : c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xD800 && c <= 0xDBFF ? (i++, 4) : 3; } return b; };",
    "      const hitSet = new Set(targets);",
    "      const inHit = id => { let p = figma.getNodeById(id); p = p && p.parent; while (p) { if (hitSet.has(p.id)) return true; p = p.parent; } return false; };",
    "      const tops = targets.filter(id => !inHit(id));",
    "      const withLost = tree => { const lost = targets.filter(id => tops.indexOf(id) === -1 && tree.indexOf('#' + id + ' ') === -1); return lost.length ? tree + '\\n' + bridge.summarize(lost, { depth: 0 }) : tree; };",
    "      s = withLost(bridge.summarize(tops, so));",
    // the lost lines come out of the tree's budget, not on top of it
    "      if (jb(s) > a.findTreeBytes) { const room = so.autoBytes - (jb(s) - jb(bridge.summarize(tops, so))); if (room > 200) s = withLost(bridge.summarize(tops, Object.assign({}, so, { autoBytes: room }))); }",
    // depth 1 that does not fit comes back uncapped (up to 200 children): keep the one-line hits then
    "      if (jb(s) > a.findTreeBytes) s = bridge.summarize(refs, { maxChildren: 200, depth: 0 });",
    "    } else s = bridge.summarize(refs, so);",
    "    out[query ? 'found' : a.view === 'flow' ? 'flow' : 'outline'] = s;",
    "  }",
    "  if (a.context) {",
    "    out.context = {};",
    // One-line strings: nested {w,n} objects came back as \"{object with 2 keys}\" once shrunk.
    "    const ws = l => (l || []).map(x => x.w + '×' + x.n).join(', ');",
    "    for (const r of refs) {",
    "      const id = typeof r === 'string' ? r : r.id;",
    "      const c = bridge.context(id);",
    "      out.context[id] = { node: c.node.type + ' ' + JSON.stringify(c.node.name) + ' #' + c.node.id + ' ' + c.node.w + 'x' + c.node.h, ancestors: c.ancestors.join(' › '), siblings: ws(c.siblings), pageWidths: ws(c.pageWidths),",
    "        components: c.components.map(x => x.set + ' ×' + x.used + (x.props ? ' ' + Object.keys(x.props).map(k => k + '=' + (Array.isArray(x.props[k]) ? x.props[k].join('|') : x.props[k])).join('; ') : '')), conventions: c.conventions };",
    "    }",
    "  }",
    "}",
    // ids of layers inside an instance (I<inst>;<layer>): is the master, and every other instance of it, really untouched?
    // One getInstancesAsync per master and at most notesMax neighbours compared (review 4.2.7 #50:
    // a Button with 400 instances ran past the 15 s timeout and the whole after was lost).
    "if (a.notes) {",
    "  const notes = [];",
    "  const instancesOf = new Map();",
    "  for (const id of a.ids) {",
    "    if (id.charAt(0) !== 'I' || id.indexOf(';') === -1) continue;",
    "    const parts = id.slice(1).split(';');",
    "    const inst = figma.getNodeById(parts[0]);",
    "    const layer = figma.getNodeById(parts[parts.length - 1]);",
    "    if (!inst || inst.type !== 'INSTANCE' || !layer || !figma.getNodeById(id)) continue;",
    "    const main = inst.mainComponent;",
    "    if (!main) continue;",
    "    if (!instancesOf.has(main.id)) instancesOf.set(main.id, typeof main.getInstancesAsync === 'function' ? await main.getInstancesAsync() : (main.instances || []));",
    "    const others = instancesOf.get(main.id).filter(i => i.id !== inst.id);",
    "    const checked = others.slice(0, a.notesMax);",
    "    const differ = [];",
    "    for (const o of checked) {",
    "      const cid = 'I' + o.id + ';' + parts.slice(1).join(';');",
    "      if (!figma.getNodeById(cid)) continue;",
    "      if (!/: identical$/.test(bridge.compare(layer.id, [cid]).split('\\n')[0])) differ.push(o.id);",
    "    }",
    "    const same = checked.length - differ.length;",
    "    const scope = others.length > checked.length ? ', of ' + checked.length + ' checked (' + others.length + ' other instances in all)' : '';",
    "    notes.push('NOTE ' + id + ': an override inside instance #' + inst.id + '; main COMPONENT ' + JSON.stringify(main.name) + ' #' + main.id + ' and ' + same + ' other instance' + (same === 1 ? '' : 's') + ' untouched' + scope + (differ.length ? ' (' + differ.length + ' differ from the master: ' + differ.slice(0, 4).map(x => '#' + x).join(' ') + ')' : ''));",
    "  }",
    "  if (notes.length) out.notes = notes;",
    "}",
    "if (a.check) out.check = bridge.check(a.check);",
    "return out;"
  ].join("\n");
}

const SLOW_CALL_HINT = "Slow call: if it searched the whole page (findAll / find without root), scope it to a section next time.";

// ------------------------------------------------------------------
// Read nudge. Antigravity/Gemini Flash never sees server instructions and
// rarely opens figma_inspect's schema, but it always reads a tool response.
// 4.2.1 showed a generic one-time tip; in session e6524905 the model got it on
// the very first read, ignored it, and wrote ~69 more read scripts (+15 calls
// slicing bridge.state.lastResult, because the truncation note told it to).
// What a model does act on is a concrete next call. So every hand-written read
// of figma_execute_code gets, as the FIRST field of the reply, the
// figma_inspect call that reads the same nodes — ids, find query and props
// lifted from the script itself — plus a running count of wasted turns.
// ------------------------------------------------------------------
const TREE_WALK_RE = /\.(findAll|findAllWithCriteria|findOne|findChildren)\s*\(|\.children\b|function\s+walk\b|const\s+walk\s*=/;
const NODE_READ_RE = /getNodeById(Async)?\s*\(|currentPage\b|\.(findAll|findAllWithCriteria|findOne|findChildren)\s*\(|\.children\b|\.parent\b/;
const STASH_RE = /bridge\s*\.\s*state\s*\.\s*lastResult/;
// Reads through the bridge's own helpers are already cheap — not nagged.
const CHEAP_READ_RE = /bridge\s*\.\s*(summarize|inspect|find|check|context)\s*\(/;
const WRITE_PROPS = [
  "x", "y", "characters", "fills", "strokes", "strokeWeight", "strokeAlign", "visible", "opacity", "name",
  "layoutMode", "layoutWrap", "itemSpacing", "counterAxisSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "horizontalPadding", "verticalPadding", "layoutSizingHorizontal", "layoutSizingVertical", "layoutGrow", "layoutAlign",
  "layoutPositioning", "primaryAxisAlignItems", "counterAxisAlignItems", "primaryAxisSizingMode", "counterAxisSizingMode",
  "cornerRadius", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius", "fontName", "fontSize",
  "lineHeight", "letterSpacing", "textAutoResize", "textAlignHorizontal", "textAlignVertical", "textCase", "textDecoration",
  "constraints", "rotation", "effects", "clipsContent", "locked", "selection", "mainComponent", "reactions", "itemReverseZIndex",
  "minWidth", "maxWidth", "minHeight", "maxHeight", "fillStyleId", "strokeStyleId", "textStyleId", "effectStyleId", "isMask",
  "blendMode", "currentPage", "expanded", "description", "relativeTransform"
];
const CANVAS_WRITE_RE = new RegExp(
  "figma\\s*\\.\\s*(create|group|ungroup|flatten|union|subtract|intersect|exclude|combineAsVariants|setCurrentPageAsync)|" +
  "\\.(remove|appendChild|insertChild|resize|resizeWithoutConstraints|rescale|swapComponent|createInstance|clone|detachInstance|" +
  "resetOverrides|insertCharacters|deleteCharacters|scrollAndZoomIntoView)\\s*\\(|\\.set[A-Z]\\w*\\s*\\(|" +
  "bridge\\s*\\.\\s*(replaceWithInstance|setProps|setText|shift|moveInto|fitSection|componentize|setReaction|openOverlay|closeOverlay|setPosition|define|snapshot|checkpoint)\\s*\\(|" +
  "\\.(" + WRITE_PROPS.join("|") + ")\\s*(=(?!=)|\\+=|-=)"
);
const WHAT_YOU_GET = {
  outline: 'one line per node: TYPE "name" #id WxH @x,y [layout] fill font "text" →component variant',
  table: "per table: header, each column's title, width, sizing, cell texts and component variant counts, row/cell ids",
  map: "canvas map: sections, frames, breakpoints",
  props: "{ id: { prop: value } } for each node",
  like: "like:'<ref id>' finds the copies of a correct node under node_ids and lists how each differs, then REF lines with the reference's exact values",
  compare: "compare:'<ref id>' lists how each node_id differs from the reference, then REF lines with its exact values to copy into the write"
};
const CAPS_NOTE = 'figma_inspect also does: find / find_text (search names / text under node_ids), props:[...] (exact values: ' +
  '"font", "text", "layout", "padding", "props" = componentProperties, "variant", "main", "reactions", or any raw property), ' +
  'context:true (parent sections, breakpoints, component variants), view:"map" (canvas map), view:"table" (per table: headers, widths, ' +
  'cell contents and variant counts per column, row/cell ids), check (pass/fail), ' + WHAT_YOU_GET.like + ', ' + WHAT_YOU_GET.compare + '.';
// Script property -> figma_inspect props name. Geometry, names, types, text,
// fonts, layout, fills and instance variants are already on every outline
// line, so only these make a props read worth suggesting.
const PROP_HINTS = [
  [/\bcomponentProperties\b/, "props"], [/\bvariantProperties\b/, "variant"], [/\bmainComponent\b/, "main"],
  [/\b(fontName|fontSize|getStyledTextSegments|getRange\w+)\b/, "font"], [/\bcharacters\b/, "text"],
  [/\b(layoutMode|itemSpacing|primaryAxis\w*|counterAxis\w*)\b/, "layout"], [/\bpadding(Top|Right|Bottom|Left)\b/, "padding"],
  [/\breactions\b/, "reactions"], [/\babsolute(BoundingBox|Transform|RenderBounds)\b/, "absolute"],
  [/\blayoutSizingHorizontal\b/, "layoutSizingHorizontal"], [/\blayoutSizingVertical\b/, "layoutSizingVertical"],
  [/\blayoutGrow\b/, "layoutGrow"], [/\blayoutAlign\b/, "layoutAlign"], [/\bconstraints\b/, "constraints"],
  [/\bfills\b/, "fill"], [/\bstrokes\b/, "stroke"], [/\bcornerRadius\b/, "cornerRadius"], [/\bvisible\b/, "visible"]
];
// "header" / "заголов" alone is a page header, not a table one (T7 `const header = ...` got view:"table"):
// only row / cell / column words, which a table walk cannot do without, count.
const TABLE_HINT_RE = /\b(table|tables|row|rows|cell|cells|column|columns)\b|таблиц|строк|ячейк|колонк|столб/i;
const OUTLINE_COVERS =["font", "text", "layout", "fill", "stroke", "cornerRadius", "visible", "variant", "main"];
const READ_STATE = { streak: 0, redirects: 0, total: 0, lastIds: [], lastArgs: null, capsShown: false };

// -> "write" | "read" | "stash" | "cheap" | null
function classifyScript(code, response) {
  if (typeof code !== "string") return null;
  if (response && ((Array.isArray(response.created) && response.created.length) ||
                   (Array.isArray(response.modified) && response.modified.length))) return "write";
  if (CANVAS_WRITE_RE.test(code)) return "write";
  const touchesNodes = NODE_READ_RE.test(code);
  // lastResult is plain data: `.children` on it is not a node read.
  if (STASH_RE.test(code) && !/getNodeById(Async)?\s*\(|currentPage\b/.test(code)) return "stash";
  if (CHEAP_READ_RE.test(code) && !TREE_WALK_RE.test(code)) return "cheap";
  return touchesNodes ? "read" : null;
}

// After a write the agent spends a turn re-reading what it changed (every T1
// run in bench 15.10 ended with an inspect props/compare of the same ids).
// Answer that read in the write's own reply: one outline line per node the
// code named by id, as they are now. Best-effort: any failure = no `after`.
const AFTER_WRITE_MAX_IDS = 12;
const AFTER_WRITE_BYTES = 1400;
const AFTER_WRITE_DEEP_IDS = 8; // up to this many nodes the after-write outline goes one level down

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

// Node ids in a write's result, in order, up to AFTER_WRITE_MAX_IDS.
function resultIds(result) {
  const text = typeof result === "string" ? result : JSON.stringify(result);
  const ids = [];
  const idRe = /["'`#](I?\d+:\d+(?:;\d+:\d+)*)\b/g;
  let m;
  while (text && (m = idRe.exec(text)) && ids.length < AFTER_WRITE_MAX_IDS * 2) {
    if (ids.indexOf(m[1]) === -1) ids.push(m[1]);
  }
  return ids;
}

// figma_inspect arguments that read what the script read.
function suggestInspect(code, fallbackIds) {
  const ids = [];
  const idRe = /["'`](I?\d+[:-]\d+(?:;\d+[:-]\d+)*)["'`]/g;
  let m;
  while ((m = idRe.exec(code)) && ids.length < 8) {
    const id = m[1].indexOf(";") === -1 ? m[1].replace("-", ":") : m[1];
    if (ids.indexOf(id) === -1) ids.push(id);
  }
  const args = {};
  if (ids.length) args.node_ids = ids;
  else if (fallbackIds && fallbackIds.length) args.node_ids = fallbackIds.slice(0, 8);

  const nameRes = [
    /\.name\s*===?\s*["'`]([^"'`\n]{2,60})["'`]/,
    /["'`]([^"'`\n]{2,60})["'`]\s*===?\s*[\w$.]*\.name\b/,
    /\.name\s*(?:\.\s*toLowerCase\s*\(\s*\))?\s*\.\s*(?:includes|startsWith|endsWith|indexOf)\s*\(\s*["'`]([^"'`\n]{2,60})["'`]/
  ];
  let nameAt = -1;
  for (const re of nameRes) {
    const hit = re.exec(code);
    if (hit) { args.find = hit[1]; nameAt = hit.index; break; }
  }
  // The type filter only counts when it sits in the SAME predicate as the
  // name (`n => n.name === 'checkbox' && n.type === 'INSTANCE'`); a TEXT test
  // elsewhere in the script would make find return nothing.
  if (args.find) {
    const near = code.slice(Math.max(0, nameAt - 60), nameAt + 90).split(/=>|;|\n/).filter(s => s.indexOf(args.find) !== -1).join(" ");
    const typeHit = /\.type\s*===?\s*["'`]([A-Z_]+)["'`]|["'`]([A-Z_]+)["'`]\s*===?\s*[\w$.]*\.type\b/.exec(near);
    if (typeHit) args.find_type = typeHit[1] || typeHit[2];
  }

  // Only props an outline line does NOT carry earn a props read: every line
  // already has geometry, layout, fill, stroke, radius, font, text, visibility
  // and an instance's component + variant.
  const props = [];
  for (const [re, prop] of PROP_HINTS) {
    if (re.test(code) && OUTLINE_COVERS.indexOf(prop) === -1 && props.indexOf(prop) === -1) props.push(prop);
  }
  // props are read off the listed / found nodes themselves, so they fit a
  // script that read them there — not one that walked further down.
  const walks = (code.match(/\.(findAll|findAllWithCriteria|findOne|findChildren)\s*\(|\.children\b/g) || []).length;
  if (props.length && (args.find ? walks <= 1 : walks === 0)) {
    args.props = props.slice(0, 6);
    return args;
  }
  if (!args.node_ids) return args.find ? args : { view: "map" };
  // A walk into rows / headers / cells: view:"table" gives headers, widths and
  // per-column contents (variant counts) for every listed screen at once —
  // in session e6524905 that was ~45 read scripts.
  if (walks && TABLE_HINT_RE.test(code)) return { node_ids: args.node_ids, view: "table" };
  let depth = walks >= 4 ? 3 : walks >= 2 ? 2 : 1;
  if (/\.(findAll|findAllWithCriteria|findOne)\s*\(/.test(code) && !args.find) depth = 3;
  if (args.find) depth = Math.max(1, Math.min(depth, 2));
  if (args.node_ids.length > 2) depth = Math.min(depth, 2);
  if (props.length === 0 && walks === 0 && !args.find) {
    // A flat read of the ids' own facts (font, text, layout...): their lines.
    args.depth = 0;
    return args;
  }
  args.depth = depth;
  return args;
}

// ------------------------------------------------------------------
// Read guard (4.2.5). Session packs from Antigravity/Gemini Flash showed the
// nudge above is read and ignored: the script still ran, returned its result,
// and the model went on to read #54 in a row (60-64% of the input tokens of
// two prototype sessions). So the NUDGE stays for the first read, but from the
// next consecutive hand-written read on the script is NOT run: the 2nd read
// gets the result of the figma_inspect call it should have made, the 3rd and
// later get a refusal without a result. A figma_inspect call or any write
// resets the streak. A page-wide findAll over a big file froze the plugin for
// 2-12 minutes (747 s once), so a READ that scans the whole page is refused
// up front, and the refusal names the scoped call.
// `/* run-anyway */` in the script lifts both guards (misread script, or a
// scan the user really wants).
// ------------------------------------------------------------------
const RUN_ANYWAY_RE = /\/[*/]\s*run-anyway\b/;
const PAGE_ALIAS_RE = /(?:const|let|var)\s+([\w$]+)\s*=\s*(?:await\s+)?figma\s*\.\s*(?:currentPage|root)\s*(?:;|,|\n|$)/g;

// "findAll" | "reactions" | null — does the script walk the whole page / file?
function pageWideScan(code) {
  if (typeof code !== "string") return null;
  const names = ["figma\\s*\\.\\s*(?:currentPage|root)"];
  PAGE_ALIAS_RE.lastIndex = 0;
  let m;
  while ((m = PAGE_ALIAS_RE.exec(code))) names.push(m[1].replace(/\$/g, "\\$"));
  const base = "(?:" + names.join("|") + ")";
  if (new RegExp(base + "\\s*\\.\\s*(?:findAll|findOne)\\s*\\(").test(code)) return "findAll";
  if (/\breactions\b/.test(code) && (
    new RegExp(base + "\\s*\\.\\s*findAllWithCriteria\\s*\\(").test(code) ||
    new RegExp("\\b(?:walk|visit|scan|traverse|recurse|collect)\\w*\\s*\\(\\s*" + base + "\\b").test(code) ||
    new RegExp("\\bof\\s+" + base + "\\s*\\.\\s*children\\b").test(code)
  )) return "reactions";
  return null;
}

const PAGE_SCAN_NOTE = "figma.currentPage.findAll / a walk of the whole page freezes the plugin for minutes on a big file (747 s seen). Scope it to a section: figma_inspect with node_ids, find / find_type (name search), or view:\"flow\" for prototype links; or findAll on a section node in a write script.";

// figma.createComponentFromNode forces every AutoLayout frame of the subtree to
// FIXED sizing; bridge.componentize restores it. Same call shape, so rewrite.
function rewriteComponentize(code) {
  if (typeof code !== "string" || !/figma\s*\.\s*createComponentFromNode\s*\(/.test(code)) return { code, lint: null };
  const n = (code.match(/figma\s*\.\s*createComponentFromNode\s*\(/g) || []).length;
  return {
    code: code.replace(/figma\s*\.\s*createComponentFromNode\s*\(/g, "bridge.componentize("),
    lint: `figma.createComponentFromNode was replaced by bridge.componentize (${n}×): the raw call turns AutoLayout frames in the subtree FIXED and breaks resizing. Write bridge.componentize(node) yourself next time.`
  };
}

// ------------------------------------------------------------------
// Macro guard (bench H3, 15.10). In bench T3 every run spent 3-4 model turns
// learning how to call bridge.openOverlay (bridge.info(), typeof, .toString()
// of the macro = 3 KB of source), and a failed run set the read-only
// overlayPositionType by hand five times. The server answers a look at a
// macro with its call shape, and refuses a hand-written overlay before it runs.
// ------------------------------------------------------------------
const MACRO_SIGNATURES = {
  openOverlay: "await bridge.openOverlay(triggerId, overlayFrameId, { position: 'BOTTOM_CENTER', dim: 0.4, closeOnOutside: true }) - prototype link that opens the overlay frame (transition slides in from the edge). position: CENTER | TOP_LEFT | TOP_CENTER | TOP_RIGHT | BOTTOM_LEFT | BOTTOM_CENTER | BOTTOM_RIGHT; dim: alpha 0..1 or '#000000@0.4'. The overlay look is read-only in the Plugin API: the reply says which part is a MANUAL STEP for the user - report it, don't look for a setter.",
  closeOverlay: "await bridge.closeOverlay(nodeId) - CLOSE action on a node inside an overlay.",
  setReaction: "await bridge.setReaction(nodeId, { trigger: 'ON_CLICK', to: frameId, nav: 'NAVIGATE', transition: 'MOVE_IN/LEFT' }) - one prototype link (replaces the one with the same trigger); action: 'BACK' | 'CLOSE' | { type: 'URL', url } instead of to/nav.",
  // bench H4: T4 read typeof + .toString() of componentize before using it.
  componentize: "bridge.componentize(node) -> the new COMPONENT (sync; pass the node object, e.g. await figma.getNodeByIdAsync(id)). Same name, size, position, look and AutoLayout sizing; the id CHANGES. Many at once: const out = []; for (const id of ids) out.push(bridge.componentize(await figma.getNodeByIdAsync(id)).id); return out;",
  setProps: "bridge.setProps(instance, { Name: value }) - component properties by readable name ('Label' matches 'Label#12:3'); INSTANCE_SWAP takes a component node or id; returns the instance.",
  setText: "await bridge.setText(root, { layerNameOrId: 'text' }) or bridge.setText(textNodeOrId, 'text') - loads all fonts and sets TEXT layers found by id or exact name under root, KEEPING font styles by words - font, size, colour, decoration, letter spacing (first word keeps its style, the tail from the first space keeps its own; more styles: word by word, extra words take the last). Replace text with it, never with `characters =` (that flattens mixed fonts) or a per-character getRangeFontName loop. Returns { set: [ids] }.",
  replaceWithInstance: "await bridge.replaceWithInstance(target, component, { props, text, keepSize: false, remove: true }) - instance of a COMPONENT / COMPONENT_SET / id in target's slot; returns the instance.",
  shift: "bridge.shift(nodesOrIds, { dx: 0, dy: 0 }) - moves nodes by an offset; returns the count.",
  moveInto: "bridge.moveInto(nodesOrIds, container, { layout: 'none' | 'row' | 'column', gap: 100, padding: 0 }) - reparents nodes; returns ids.",
  fitSection: "bridge.fitSection(section, { padding: 100 }) - resizes a SECTION/FRAME to its children + padding; returns the section.",
  setPosition: "bridge.setPosition(node, x, y) - sets x/y, or explains why not (inside an INSTANCE: use AutoLayout)."
};
const MACRO_PEEK_RE = /bridge\s*\.\s*(\w+)\s*\.\s*toString\s*\(|String\s*\(\s*bridge\s*\.\s*(\w+)\s*\)|typeof\s+bridge\s*\.\s*(\w+)|Object\s*\.\s*(?:keys|getOwnPropertyNames)\s*\(\s*bridge\s*\)/g;
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

// -> null (run the script) | { type: "peek" | "overlay", body }
// file: the document the script would run in (callFile), null = unknown.
function macroGuard(code, file) {
  if (typeof code !== "string" || RUN_ANYWAY_RE.test(code)) return null;
  if (!/bridge\s*\.\s*openOverlay\s*\(/.test(code) && (OVERLAY_LOOK_WRITE_RE.test(code) || RAW_OVERLAY_RE.test(code))) {
    const look = OVERLAY_LOOK_WRITE_RE.test(code);
    const linked = look ? (suggestInspect(code).node_ids || []).map(id => linkedOverlay(file, id)).find(Boolean) : null;
    if (linked) {
      return {
        type: "overlay",
        body: {
          ok: false, code: "OVERLAY_ALREADY_LINKED", not_run: true,
          done: linked.manual === false
            ? `Already done: bridge.openOverlay linked #${linked.trigger} → overlay #${linked.overlay} and set its look. Nothing left to do: answer now.`
            : `Already done: bridge.openOverlay linked #${linked.trigger} → overlay #${linked.overlay}. Its look is read-only for scripts (no setter anywhere): this is the MANUAL STEP. Answer now: tell the user to select frame #${linked.overlay} > Prototype panel > Overlay and set position, background and click-outside there.`
        }
      };
    }
    return {
      type: "overlay",
      body: {
        ok: false, code: "USE_OPEN_OVERLAY",
        error: "Not run. " + (look
          ? "overlayPositionType / overlayBackground / overlayBackgroundInteraction are READ-ONLY in the Plugin API (no setter), there is no other way to set them."
          : "A hand-built OVERLAY reaction misses the overlay look and is easy to get wrong (`actions` array, `transition` key).") +
          " If bridge.openOverlay already ran and said MANUAL STEP, the task is done: tell the user that step and stop. Otherwise one call makes the link and tries the look; its reply names what the user must set by hand (MANUAL STEP). Swap the ids if the order is wrong. A script that is not this: add /* run-anyway */.",
        use_instead: overlayCall(code, file)
      }
    };
  }
  // A look at a macro (its source, its type, the key list): nothing on the
  // canvas is read, so answer here with how to call it.
  if (classifyScript(code, null) === "write" || NODE_READ_RE.test(code)) return null;
  const names = [];
  let all = false, m;
  MACRO_PEEK_RE.lastIndex = 0;
  while ((m = MACRO_PEEK_RE.exec(code))) {
    const name = m[1] || m[2] || m[3];
    if (name) { if (names.indexOf(name) === -1) names.push(name); } else all = true;
  }
  const known = names.filter(n => MACRO_SIGNATURES[n]);
  if (!known.length && !(all && names.length === 0)) return null;
  const pick = known.length ? known : Object.keys(MACRO_SIGNATURES);
  const signatures = {};
  for (const n of pick) signatures[n] = MACRO_SIGNATURES[n];
  return {
    type: "peek",
    body: {
      ok: true, not_run: true,
      note: "Answered by the server without running the script: how to call " + pick.map(n => "bridge." + n).join(", ") + ". Call it directly in the write; don't read its source." + (all ? " `return bridge.info()` lists every helper." : ""),
      signatures
    }
  };
}

// -> null (run the script) | { type: "heavy" | "redirect" | "refuse", args, call, n }
function readGuard(code) {
  if (typeof code !== "string" || RUN_ANYWAY_RE.test(code)) return null;
  const kind = classifyScript(code, null);
  if (kind !== "read" && kind !== "stash") return null;
  const heavy = pageWideScan(code);
  if (heavy) {
    const ids = suggestInspect(code, READ_STATE.lastIds);
    const args = heavy === "reactions"
      ? (ids.node_ids ? { node_ids: ids.node_ids, view: "flow" } : { view: "flow" })
      : (ids.find || ids.node_ids ? ids : { view: "map" });
    return { type: "heavy", args, call: "figma_inspect " + JSON.stringify(args), reason: heavy, n: READ_STATE.streak };
  }
  if (!(READ_STATE.streak >= 1)) return null;
  const args = kind === "stash" ? READ_STATE.lastArgs : suggestInspect(code, READ_STATE.lastIds);
  if (!args) return null;
  READ_STATE.streak += 1;
  READ_STATE.total += 1;
  const first = !(READ_STATE.redirects > 0);
  READ_STATE.redirects = (READ_STATE.redirects || 0) + 1;
  return { type: first ? "redirect" : "refuse", args, call: "figma_inspect " + JSON.stringify(args), n: READ_STATE.streak };
}

function guardRefusal(guard) {
  const body = guard.type === "heavy"
    ? { ok: false, code: "PAGE_SCAN_BLOCKED", error: "Not run. " + PAGE_SCAN_NOTE, use_instead: guard.call + (guard.reason === "reactions" ? " — pick the section id from a view:\"map\" call if you don't have it" : "") }
    : {
        ok: false, code: "READ_REFUSED",
        error: `Not run: hand-written read #${guard.n} in a row, and no result comes back for those. Call ${guard.call} (long replies page with offset=K), or make the whole change in ONE figma_execute_code. A script that is not a read: add the comment /* run-anyway */.`,
        use_instead: guard.call
      };
  return { isError: true, content: [{ type: "text", text: toJson(body) }] };
}

// The `use_instead` field for a hand-written read, or null.
function readNudge(code, response) {
  const kind = classifyScript(code, response);
  if (kind !== "read" && kind !== "stash") {
    if (kind === "write") resetReadStreak();
    return null;
  }
  READ_STATE.streak += 1;
  READ_STATE.total += 1;
  // Slicing lastResult re-reads what the previous walk returned: suggest the
  // call that replaces THAT walk.
  const args = kind === "stash" && READ_STATE.lastArgs
    ? READ_STATE.lastArgs
    : suggestInspect(code, READ_STATE.lastIds);
  if (kind === "read" && args.node_ids) { READ_STATE.lastIds = args.node_ids; READ_STATE.lastArgs = args; }
  const call = "figma_inspect " + JSON.stringify(args);
  const n = READ_STATE.streak;
  let text = kind === "stash"
    ? `${call} — slicing bridge.state.lastResult costs a model turn per slice; this returns the tree as an outline, paged with offset=K.`
    : `${call} — reads the same nodes in ONE call (${WHAT_YOU_GET[args.view || (args.props ? "props" : "outline")]}), every id at once; a long reply pages with offset=K.`;
  text += ` Hand-written read #${n} in a row: each is a full model turn that re-sends the whole conversation.`;
  if (n >= 3) text += " Next: one figma_inspect for everything still unknown, then ONE figma_execute_code that makes the whole change and returns only ids/flags.";
  if (!READ_STATE.capsShown) {
    READ_STATE.capsShown = true;
    text += " " + CAPS_NOTE;
  }
  return text;
}

function resetReadStreak() {
  READ_STATE.streak = 0;
  READ_STATE.redirects = 0;
}

async function handleCallTool(name, args = {}) {
  try {
    switch (name) {
      case "figma_execute_code": {
        const desc = args.description || "Execute JS Code";
        const capture = args.capture === true;
        const wantsAsync = args.async === true;
        const normalizedCaptureIds = normalizeNodeIds(args.capture_node_ids);

        // A syntax error costs a plugin round trip and comes back without a
        // line number: catch it here (throws SCRIPT_SYNTAX_ERROR + line/at).
        checkAgentSyntax(args.code);

        const rewrite = rewriteComponentize(args.code);
        const code = rewrite.code;
        const macro = macroGuard(code, callFile(args.target));
        if (macro) return { isError: macro.type === "overlay", content: [{ type: "text", text: toJson(macro.body) }] };
        const guard = readGuard(code);
        if (guard && guard.type === "heavy") return guardRefusal(guard);
        if (guard && guard.type === "refuse") return guardRefusal(guard);
        if (guard) {
          // 2nd read in a row: answer with what figma_inspect returns for it.
          const inspected = await sendCommandToPlugin({
            code: buildInspectCode({ ...guard.args, target: args.target }),
            description: "Inspect",
            target: args.target
          }, TIMEOUTS.normal);
          return renderPluginResponse(
            { result: applyLineOffset(inspected.result, guard.args.offset), resultStashed: inspected.resultStashed },
            null,
            {
              ...budgetOptions(args),
              lead: { redirected: `Hand-written read #${guard.n} in a row: your script was NOT run; below is ${guard.call}, which reads the same nodes. Read with figma_inspect (offset=K pages); use figma_execute_code only to change things.` }
            }
          );
        }

        const response = await sendCommandToPlugin({
          code: withFontMemo(shieldParams(code)),
          description: desc,
          capture: capture,
          capture_node_ids: normalizedCaptureIds ? normalizedCaptureIds.split(",") : null,
          diff: false, // H5: see DIFF_OFF_NOTE
          ...captureOptions(args),
          target: args.target
        }, TIMEOUTS.heavy, { escalateMs: wantsAsync ? 50 : TIMEOUTS.escalate });
        stripFontMemo(response);

        if (response.__escalated) {
          return {
            content: [{
              type: "text",
              text: toJson({
                ok: true,
                status: "running",
                job_id: response.job_id,
                note: `Still running in Figma after ${Math.round(response.elapsed_ms / 1000)}s. Call figma_job_status({ job_id: "${response.job_id}" }) once — it waits for the result.`,
                hint: SLOW_CALL_HINT
              })
            }]
          };
        }

        const lead = await postWrite(code, response, {
          target: args.target,
          lint: [rewrite.lint, args.diff === true ? DIFF_OFF_NOTE : null]
        });
        return renderPluginResponse(response, null, { ...budgetOptions(args), lead });
      }

      case "figma_inspect": {
        resetReadStreak();
        const response = await sendCommandToPlugin({
          code: buildInspectCode(args),
          description: "Inspect",
          target: args.target
        }, TIMEOUTS.normal);
        // A read has nothing to roll back or lint — keep only what was read.
        const plain = !args.compare && !args.like && !args.props && !args.check && (!args.view || args.view === "outline");
        const similar = plain && response.result ? similarHint(response.result.outline) : null;
        // a flow re-read after bridge.openOverlay: say the look is the manual step, not a miss
        if (response.result && typeof response.result.flow === "string" && OVERLAY_LINKED.size &&
            [...OVERLAY_LINKED.values()].some(v => linkedOverlay(response.__file || args.target, v.overlay) === v && response.result.flow.indexOf("#" + v.overlay + ":") !== -1)) {
          response.result.flow = response.result.flow.replace(OVERLAY_HEADER_RE, OVERLAY_HEADER_DONE);
        }
        return renderPluginResponse(
          { result: applyLineOffset(response.result, args.offset), resultStashed: response.resultStashed },
          null,
          { ...budgetOptions(args), kind: plain ? "inspect" : "inspect-list", lead: similar ? { similar: similar } : null }
        );
      }

      case "figma_job_status": {
        const waitMs = args.wait_ms != null && Number.isFinite(Number(args.wait_ms)) ? Number(args.wait_ms) : ECONOMY.jobWaitMs;
        const snap = state.isBridgeMaster
          ? await readJobSnapshot(args.job_id, waitMs)
          : await proxyToMaster(`/job?id=${encodeURIComponent(args.job_id || "")}&wait_ms=${Math.round(waitMs)}`, {
              timeoutMs: Math.min(waitMs, ECONOMY.jobWaitMaxMs) + 10000
            });

        if (snap.status === "done") {
          // a write that ran long gets the same reply as one that did not (h13 T6: job_status, then a verify turn)
          let lead = null;
          try {
            if (snap.script) lead = await postWrite(snap.script, snap.response, { target: snap.target || undefined, file: snap.target || null });
          } catch (e) { lead = null; }
          return renderPluginResponse(snap.response, { status: "done", job_id: snap.job_id }, { ...budgetOptions(args), lead });
        }
        if (snap.ok === false) {
          return {
            isError: true,
            content: [{ type: "text", text: toJson(snap.code === "JOB_NOT_FOUND" ? snap : { ...buildErrorEnvelope({ message: snap.error, code: snap.code, ...errorLocation(snap) }), job_id: snap.job_id }) }]
          };
        }
        return { content: [{ type: "text", text: toJson(snap) }] };
      }

      case "figma_read_canvas": {
        const nodeIds = normalizeNodeIds(args.node_ids || args.node_id || args.nodeIds || args.nodeId || args.ids);
        const format = args.format || "jsx";
        const requestedDepth = Number.isFinite(args.depth) ? args.depth : 6;
        const includeHidden = args.include_hidden === true;
        const budgetBytes = budgetBytesFromTokens(args.budget_tokens);

        const response = await sendCommandToPlugin({
          type: "READ_CANVAS",
          node_ids: nodeIds,
          depth: requestedDepth,
          include_hidden: includeHidden,
          target: args.target
        }, TIMEOUTS.normal);

        const rawData = response.result;
        let output = applyTokenBudget(rawData, { format, includeHidden, maxDepth: requestedDepth, budgetBytes });
        if (rawData && rawData.truncatedTop) {
          output += `\n\n<!-- canvas traversal capped at 4000 nodes; some siblings were not sent. Narrow with node_ids. -->`;
        }

        return { content: [{ type: "text", text: output }] };
      }

      case "figma_rollback": {
        const response = await sendCommandToPlugin({
          type: "ROLLBACK",
          checkpoint_id: args.checkpoint_id || "last",
          target: args.target
        }, TIMEOUTS.normal);
        // the links that write made are gone from the canvas: forget them (review 4.2.7 #47)
        unlinkCheckpoint(response && response.result && response.result.checkpoint_id);
        return { content: [{ type: "text", text: toJson({ ok: true, ...response.result }) }] };
      }

      case "figma_list_targets": {
        // A proxy has no plugin sockets of its own — the master does.
        let targets = listTargets();
        if (!state.isBridgeMaster) {
          try {
            const status = await proxyToMaster("/status", { timeoutMs: 5000 });
            if (status && Array.isArray(status.targets)) targets = status.targets;
          } catch (e) {}
        }
        // Session 9672b93e: an empty list sent the model grepping the server
        // source for 8 turns. Nothing is broken — the plugin just isn't running.
        const body = { ok: true, targets };
        if (!targets.length) body.hint = "No Figma file is connected. Ask the user to open the file in Figma DESKTOP and run the Mokido plugin (Ctrl+Alt+P / Cmd+Option+P) until it shows CONNECTED, then call figma_list_targets again. Nothing to debug in the server.";
        return { content: [{ type: "text", text: toJson(body) }] };
      }

      case "figma_screenshot": {
        const desc = args.description || "Figma Screenshot";
        // Models reach for node_id / nodeId often enough; ignoring the alias
        // silently captured the SELECTION instead — a wasted image and turn.
        const nodeIds = normalizeNodeIds(args.node_ids || args.node_id || args.nodeIds || args.nodeId || args.ids);
        const response = await sendCommandToPlugin({
          type: "SCREENSHOT",
          nodeIds,
          ...captureOptions(args),
          description: desc,
          target: args.target
        }, TIMEOUTS.normal);

        const images = collectImages(response);
        const body = { ok: true, result: response.result || "Captured", images: images.meta };
        if (images.skipped) body.images_skipped = `${images.skipped} more image(s) not sent (max ${ECONOMY.maxImages} per call).`;
        if (images.errors.length) body.image_errors = images.errors;
        return { content: [{ type: "text", text: toJson(body) }, ...images.parts] };
      }


      case "figma_get_selection": {
        // Runs as plugin-sandbox JS (not Node), so it inlines its own compact
        // fill formatter rather than reaching for figma/optimizer/styles.js —
        // that module only exists on the server side of the WebSocket.
        // Compact by design: a solid fill becomes one hex string instead of
        // the full paint object (gradient stops, boundVariables, matrices),
        // and text is previewed rather than dumped in full. Parent/page and
        // AutoLayout context are included since "what is this inside of" is
        // usually the actual question behind checking a selection.
        const code = `
          function hex(c) {
            const b = (n) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0').toUpperCase();
            return '#' + b(c.r) + b(c.g) + b(c.b);
          }
          function fillsSummary(fills) {
            if (!fills || fills === figma.mixed || !Array.isArray(fills) || fills.length === 0) return null;
            return fills.filter(f => f.visible !== false).map(f => f.type === 'SOLID' ? hex(f.color) : f.type).join('; ') || null;
          }
          const selection = figma.currentPage.selection;
          return selection.map(node => ({
            id: node.id,
            name: node.name,
            type: node.type,
            width: Math.round(node.width || 0),
            height: Math.round(node.height || 0),
            x: Math.round(node.x || 0),
            y: Math.round(node.y || 0),
            page: figma.currentPage.name,
            parentId: node.parent ? node.parent.id : null,
            parentName: node.parent ? node.parent.name : null,
            layoutMode: ('layoutMode' in node && node.layoutMode !== 'NONE') ? node.layoutMode : undefined,
            fills: fillsSummary(node.fills),
            characters: node.type === 'TEXT' ? String(node.characters || '').slice(0, 200) : undefined
          }));
        `;
        const response = await sendCommandToPlugin({ code, description: "Get Selected Nodes", target: args.target }, TIMEOUTS.normal);
        return jsonResult(response.result, args);
      }

      case "figma_create_ui_card": {
        // Every user-supplied string below is spliced into generated JS source.
        // Escaping only double quotes let a backslash ("C:\Users\x") or a newline
        // produce a SyntaxError — and a trailing backslash escape the closing
        // quote. JSON.stringify emits a complete, correctly escaped JS literal.
        const jsStr = (value) => JSON.stringify(String(value == null ? "" : value));

        const hexToRgb = (hex) => {
          let c = String(hex || "").trim().replace("#", "");
          if (c.length === 3) c = c.split("").map(x => x + x).join("");
          if (!/^[0-9a-fA-F]{6}$/.test(c)) {
            throw new Error(`Invalid hex color "${hex}". Use a 3- or 6-digit hex value such as "#F5F0FF".`);
          }
          const num = parseInt(c, 16);
          return { r: ((num >> 16) & 255) / 255, g: ((num >> 8) & 255) / 255, b: (num & 255) / 255 };
        };

        const title = args.title || "Figma AI Bridge";
        const subtitle = args.subtitle || "Real-time two-way bridge between AI assistants and Figma canvas.";
        const badgeText = args.badge_text || "✨ Live Bridge";
        const buttonText = args.button_text || "Explore Features →";
        const bgColor = args.bg_color || "#F5F0FF";
        // Numbers are interpolated bare into the generated source, so coerce
        // rather than trusting the client to have honoured the schema.
        const width = Number.isFinite(Number(args.width)) && Number(args.width) > 0
          ? Math.round(Number(args.width))
          : 400;

        const rgb = hexToRgb(bgColor);

        const code = `
          const card = figma.createFrame();
          card.name = "UI Card - " + ${jsStr(title)};
          card.layoutMode = "VERTICAL";
          card.primaryAxisSizingMode = "AUTO";
          card.counterAxisSizingMode = "FIXED";
          card.resize(${width}, 100);
          card.paddingTop = 28;
          card.paddingBottom = 28;
          card.paddingLeft = 28;
          card.paddingRight = 28;
          card.itemSpacing = 16;
          card.cornerRadius = 20;
          card.clipsContent = true;
          card.fills = [{ type: 'SOLID', color: { r: ${rgb.r}, g: ${rgb.g}, b: ${rgb.b} } }];
          card.effects = [{
            type: 'DROP_SHADOW',
            color: { r: 0.1, g: 0.05, b: 0.2, a: 0.08 },
            offset: { x: 0, y: 10 },
            radius: 24,
            spread: 0,
            visible: true,
            blendMode: 'NORMAL'
          }];

          ${badgeText ? `
          const badge = figma.createFrame();
          badge.name = "Badge";
          badge.layoutMode = "HORIZONTAL";
          badge.primaryAxisSizingMode = "AUTO";
          badge.counterAxisSizingMode = "AUTO";
          badge.paddingTop = 4;
          badge.paddingBottom = 4;
          badge.paddingLeft = 10;
          badge.paddingRight = 10;
          badge.cornerRadius = 100;
          badge.clipsContent = true;
          badge.fills = [{ type: 'SOLID', color: { r: 0.90, g: 0.84, b: 0.98 } }];

          const badgeTextNode = figma.createText();
          badgeTextNode.characters = ${jsStr(badgeText)};
          badgeTextNode.fontSize = 11;
          badgeTextNode.fontName = { family: "Inter", style: "Medium" };
          badgeTextNode.fills = [{ type: 'SOLID', color: { r: 0.45, g: 0.25, b: 0.75 } }];
          badge.appendChild(badgeTextNode);
          card.appendChild(badge);
          ` : ""}

          const titleText = figma.createText();
          titleText.characters = ${jsStr(title)};
          titleText.fontSize = 22;
          titleText.fontName = { family: "Inter", style: "Bold" };
          titleText.fills = [{ type: 'SOLID', color: { r: 0.15, g: 0.12, b: 0.25 } }];
          card.appendChild(titleText);

          ${subtitle ? `
          const subText = figma.createText();
          subText.characters = ${jsStr(subtitle)};
          subText.fontSize = 14;
          subText.fontName = { family: "Inter", style: "Regular" };
          subText.fills = [{ type: 'SOLID', color: { r: 0.45, g: 0.42, b: 0.55 } }];
          subText.layoutAlign = "STRETCH";
          card.appendChild(subText);
          ` : ""}

          ${buttonText ? `
          const btn = figma.createFrame();
          btn.name = "Action Button";
          btn.layoutMode = "HORIZONTAL";
          btn.primaryAxisSizingMode = "FIXED";
          btn.counterAxisSizingMode = "AUTO";
          btn.primaryAxisAlignItems = "CENTER";
          btn.counterAxisAlignItems = "CENTER";
          btn.layoutAlign = "STRETCH";
          btn.paddingTop = 12;
          btn.paddingBottom = 12;
          btn.paddingLeft = 0;
          btn.paddingRight = 0;
          btn.cornerRadius = 12;
          btn.clipsContent = true;
          btn.fills = [{ type: 'SOLID', color: { r: 0.55, g: 0.40, b: 0.95 } }];

          const btnText = figma.createText();
          btnText.characters = ${jsStr(buttonText)};
          btnText.fontSize = 14;
          btnText.fontName = { family: "Inter", style: "Medium" };
          btnText.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
          btn.appendChild(btnText);
          card.appendChild(btn);
          ` : ""}

          figma.currentPage.appendChild(card);
          const freePos = getFreePosition(${width}, 200, { gap: 80 });
          card.x = freePos.x;
          card.y = freePos.y;
          figma.currentPage.selection = [card];
          figma.viewport.scrollAndZoomIntoView([card]);
          return "Created UI Card with ID: " + card.id;
        `;

        const response = await sendCommandToPlugin({
          code,
          description: `Create card "${title}"`,
          capture: true,
          ...captureOptions(args)
        });

        const content = [];
        content.push({ type: "text", text: String(response.result) });
        if (response.screenshot) {
          const cleanB64 = response.screenshot.replace(/^data:image\/\w+;base64,/, "");
          content.push({
            type: "image",
            data: cleanB64,
            mimeType: "image/png"
          });
        }

        return { content };
      }

      // Design System Tools
      case "figma_find_components": {
        const response = await sendCommandToPlugin({
          type: "FIND_COMPONENTS",
          query: args.query || "",
          page_name: args.page_name,
          include_variants: args.include_variants !== false,
          limit: args.limit || 30,
          refresh_index: args.refresh_index === true,
          target: args.target
        }, TIMEOUTS.fast);

        return jsonResult(response.result, args);
      }

      case "figma_insert_component_instance": {
        // Capture is opt-in: the auto-lint `warnings` catch the mechanical
        // defects, and an image per inserted instance adds up fast.
        const capture = args.capture === true;
        const response = await sendCommandToPlugin({
          type: "INSERT_COMPONENT_INSTANCE",
          component_name: args.component_name,
          component_id: args.component_id,
          properties: args.properties || {},
          text_overrides: args.text_overrides || {},
          target_parent_id: args.target_parent_id,
          position: args.position,
          capture: capture,
          ...captureOptions(args),
          target: args.target
        }, TIMEOUTS.normal);

        return renderPluginResponse(response);
      }

      case "figma_get_variables": {
        const response = await sendCommandToPlugin({
          type: "GET_VARIABLES",
          collection_name: args.collection_name,
          limit: args.limit || 300,
          target: args.target
        }, TIMEOUTS.fast);

        return jsonResult(response.result, args);
      }

      case "figma_set_variables_mode": {
        const capture = args.capture === true;
        const response = await sendCommandToPlugin({
          type: "SET_VARIABLES_MODE",
          collection_name: args.collection_name,
          mode_name: args.mode_name,
          target_id: args.target_id,
          capture: capture,
          ...captureOptions(args),
          target: args.target
        }, TIMEOUTS.normal);

        return renderPluginResponse(response);
      }

      case "figma_insert_svg": {
        const capture = args.capture === true;
        const response = await sendCommandToPlugin({
          type: "INSERT_SVG",
          svg_code: args.svg_code,
          name: args.name,
          width: args.width,
          height: args.height,
          fill_override: args.fill_override,
          stroke_override: args.stroke_override,
          color_override: args.color_override,
          target_parent_id: args.target_parent_id,
          position: args.position,
          as_component: args.as_component === true,
          capture: capture,
          // Icons are tiny, so they keep a 2x default; max_px still bounds it.
          ...captureOptions(args, 2),
          target: args.target
        }, TIMEOUTS.normal);

        return renderPluginResponse(response);
      }

      case "figma_get_canvas_layout": {
        const response = await sendCommandToPlugin({
          type: "GET_CANVAS_LAYOUT",
          direction: args.direction || "RIGHT",
          gap: args.gap || 80,
          limit: args.limit || 200,
          layout: args.layout,
          columns: args.columns,
          target: args.target
        }, TIMEOUTS.fast);

        return jsonResult(response.result, args);
      }

      // REST API
      case "get_me": {
        const data = await figmaApiRequest("/me");
        return { content: [{ type: "text", text: toJson(data) }] };
      }
      case "get_file": {
        const { fileKey } = parseFigmaUrlOrKey(args.file_key);
        const depth = args.depth || 2;
        const data = await figmaApiRequest(`/files/${encodeURIComponent(fileKey)}?depth=${depth}`);
        const format = args.format || "jsx";
        const simplify = args.simplify !== false;
        const maxDepth = args.max_depth || 25;
        const includeHidden = args.include_hidden === true;
        const output = (simplify && format !== "raw" && Number.isFinite(args.budget_tokens))
          ? applyTokenBudget(data, { format, includeHidden, maxDepth, budgetBytes: budgetBytesFromTokens(args.budget_tokens) })
          : optimizeFigmaData(data, { format, simplify, maxDepth, includeHidden });
        return { content: [{ type: "text", text: output }] };
      }
      case "get_node": {
        const parsed = parseFigmaUrlOrKey(args.file_key);
        const fileKey = parsed.fileKey;
        const nodeIds = normalizeNodeIds(args.node_ids) || normalizeNodeIds(parsed.nodeId);
        if (!nodeIds) throw new Error("No node_ids provided.");
        const depth = args.depth || 3;
        const data = await figmaApiRequest(`/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeIds)}&depth=${depth}`);
        const format = args.format || "jsx";
        const simplify = args.simplify !== false;
        const maxDepth = args.max_depth || 25;
        const includeHidden = args.include_hidden === true;
        const output = (simplify && format !== "raw" && Number.isFinite(args.budget_tokens))
          ? applyTokenBudget(data, { format, includeHidden, maxDepth, budgetBytes: budgetBytesFromTokens(args.budget_tokens) })
          : optimizeFigmaData(data, { format, simplify, maxDepth, includeHidden });
        return { content: [{ type: "text", text: output }] };
      }
      case "get_image": {
        const parsed = parseFigmaUrlOrKey(args.file_key);
        const fileKey = parsed.fileKey;
        const nodeIds = normalizeNodeIds(args.node_ids) || normalizeNodeIds(parsed.nodeId);
        if (!nodeIds) throw new Error("No node_ids provided.");
        const format = args.format || "png";
        const scale = args.scale || 2;
        const data = await figmaApiRequest(`/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(nodeIds)}&format=${format}&scale=${scale}`);
        return { content: [{ type: "text", text: toJson(data) }] };
      }
      case "get_image_fills": {
        const { fileKey } = parseFigmaUrlOrKey(args.file_key);
        const data = await figmaApiRequest(`/files/${encodeURIComponent(fileKey)}/images`);
        return { content: [{ type: "text", text: toJson(data) }] };
      }
      case "get_styles": {
        const { fileKey } = parseFigmaUrlOrKey(args.file_key);
        const data = await figmaApiRequest(`/files/${encodeURIComponent(fileKey)}/styles`);
        return { content: [{ type: "text", text: toJson(data) }] };
      }
      case "get_components": {
        const { fileKey } = parseFigmaUrlOrKey(args.file_key);
        const data = await figmaApiRequest(`/files/${encodeURIComponent(fileKey)}/components`);
        return { content: [{ type: "text", text: toJson(data) }] };
      }
      case "get_comments": {
        const { fileKey } = parseFigmaUrlOrKey(args.file_key);
        const data = await figmaApiRequest(`/files/${encodeURIComponent(fileKey)}/comments`);
        return { content: [{ type: "text", text: toJson(data) }] };
      }
      case "post_comment": {
        const parsed = parseFigmaUrlOrKey(args.file_key);
        const fileKey = parsed.fileKey;
        const body = { message: args.message };
        if (args.node_id) body.client_meta = { node_id: args.node_id.replace(/-/g, ":") };
        const data = await figmaApiRequest(`/files/${encodeURIComponent(fileKey)}/comments`, {
          method: "POST",
          body: JSON.stringify(body)
        });
        return { content: [{ type: "text", text: toJson(data) }] };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: toJson(buildErrorEnvelope(error)) }]
    };
  }
}

// ==========================================
// MCP SDK Loader & Universal Stdio Loop
// ==========================================
function startOfficialSdkServer() {
  // Only locations that belong to THIS package. The list previously reached into
  // a sibling "google-tasks" project from the author's machine, which on any
  // other install could load an unrelated (and possibly incompatible) SDK build.
  const sdkLocations = [
    "@modelcontextprotocol/sdk",
    path.resolve(__dirname, "node_modules/@modelcontextprotocol/sdk/dist/cjs")
  ];

  for (const loc of sdkLocations) {
    try {
      const serverModule = require(path.join(loc, "server/index.js"));
      const Server = serverModule.Server;
      const StdioServerTransport = require(path.join(loc, "server/stdio.js")).StdioServerTransport;
      const types = require(path.join(loc, "types.js"));

      const server = new Server({
        name: "mokido",
        version: SERVER_VERSION
      }, {
        capabilities: { tools: {} },
        instructions: SERVER_INSTRUCTIONS
      });

      server.setRequestHandler(types.ListToolsRequestSchema, async () => {
        return { tools: getActiveTools() };
      });

      server.setRequestHandler(types.CallToolRequestSchema, async (request) => {
        return await handleCallTool(request.params.name, request.params.arguments);
      });

      const transport = new StdioServerTransport();
      server.connect(transport).catch(err => {
        console.error("MCP connection error:", err);
        process.exit(1);
      });
      return true;
    } catch (e) {}
  }
  return false;
}

function startUniversalStdioServer() {
  let buffer = Buffer.alloc(0);

  const sendResponse = (response) => {
    process.stdout.write(JSON.stringify(response) + "\n");
  };

  const processMessage = async (msg) => {
    if (!msg || typeof msg !== "object") return;
    const { id, method, params } = msg;

    if (method === "initialize") {
      const info = params && params.clientInfo;
      MCP_CLIENT.name = info && typeof info.name === "string" ? info.name : null;
      console.error(`[figma-mcp] client: ${MCP_CLIENT.name || "unknown"} — output ceiling ${activeOutputCeiling() || "off"}`);
      sendResponse({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "mokido", version: SERVER_VERSION },
          instructions: SERVER_INSTRUCTIONS
        }
      });
      return;
    }

    if (method === "notifications/initialized") {
      return; // No response needed
    }

    if (method === "ping") {
      sendResponse({ jsonrpc: "2.0", id, result: {} });
      return;
    }

    if (method === "tools/list") {
      sendResponse({ jsonrpc: "2.0", id, result: { tools: getActiveTools() } });
      return;
    }

    if (method === "tools/call") {
      const toolName = params ? params.name : "";
      const toolArgs = params ? params.arguments : {};
      const result = await handleCallTool(toolName, toolArgs);
      sendResponse({ jsonrpc: "2.0", id, result });
      return;
    }

    if (id !== undefined) {
      sendResponse({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
      });
    }
  };

  // Framing is done on a Buffer, never a string. Content-Length counts BYTES,
  // but the previous implementation sliced a decoded JS string by CHARACTER
  // index: one Cyrillic description made the two disagree, the body was
  // over-sliced, JSON.parse threw, and the read cursor was left mid-message —
  // so every subsequent request was corrupt too and the server went silent.
  // processMessage is async; an unhandled rejection here would take the whole
  // server down instead of failing one request.
  const dispatch = (msg) => {
    Promise.resolve()
      .then(() => processMessage(msg))
      .catch((err) => {
        if (msg && msg.id !== undefined) {
          sendResponse({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32603, message: `Internal error: ${err && err.message ? err.message : String(err)}` }
          });
        }
      });
  };

  process.stdin.on("data", (chunk) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");

      // Content-Length framing (LSP style)
      if (headerEnd !== -1) {
        const header = buffer.slice(0, headerEnd).toString("ascii");
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (match) {
          const contentLength = parseInt(match[1], 10);
          const bodyStart = headerEnd + 4;
          if (buffer.length - bodyStart < contentLength) break; // wait for the rest
          const body = buffer.slice(bodyStart, bodyStart + contentLength).toString("utf8");
          buffer = buffer.slice(bodyStart + contentLength);
          try {
            dispatch(JSON.parse(body));
          } catch (e) {}
          continue;
        }
      }

      // Newline-delimited JSON (what MCP stdio actually uses).
      const lineEnd = buffer.indexOf(0x0a);
      if (lineEnd === -1) break;

      // A \r\n\r\n further ahead in the stream belongs to a LATER framed
      // message; only skip line parsing when the header is at the very start,
      // otherwise a stray blank line stalled the loop forever.
      if (headerEnd !== -1 && headerEnd < lineEnd) break;

      const line = buffer.slice(0, lineEnd).toString("utf8").trim();
      buffer = buffer.slice(lineEnd + 1);
      if (line.length > 0) {
        try {
          dispatch(JSON.parse(line));
        } catch (e) {}
      }
    }
  });
}

if (require.main === module) {
  startBridge();
  checkForUpdates();

  // Start either official SDK server or universal stdio engine
  if (!startOfficialSdkServer()) {
    startUniversalStdioServer();
  }
} else {
  // Pure helpers for tests (tests/token-economy.test.js); nothing is bound.
  module.exports = {
    TOOLS, SERVER_INSTRUCTIONS, ECONOMY, TIMEOUTS, CAPS_NOTE, WHAT_YOU_GET,
    shrinkToBudget, pngSize, collectImages, buildStructuredResult, captureOptions, getActiveTools,
    buildInspectCode, applyTokenBudget, byteLength, outputBudgetInfo, truncationNote, similarHint, afterWriteOutline, readNudge, classifyScript, suggestInspect, READ_STATE, postWrite, resetReadStreak, readGuard, guardRefusal, pageWideScan, macroGuard, overlayCall, overlayDone, OVERLAY_LINKED, linkOverlay, linkedOverlay, unlinkCheckpoint, resultIds, overlayPairs, withFontMemo, stripFontMemo, FONT_MEMO_PRELUDE, shieldParams, rewriteComponentize, compressValidationError, readJobSnapshot, jobs, MCP_CLIENT, activeOutputCeiling, applyLineOffset, checkAgentSyntax, buildErrorEnvelope, isNewerVersion, updateNotice
  };
}
