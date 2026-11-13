const { ECONOMY } = require("./config");
const { toJson } = require("./hints");
const { byteLength } = require("./shrink");

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

module.exports = { MCP_CLIENT, activeOutputCeiling, outputBudgetInfo, budgetOptions, similarHint, truncationNote, resultBudget };
