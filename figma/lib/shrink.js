const { toJson } = require("./hints");

// ------------------------------------------------------------------
// Output budget. A tree walk that returns every node's properties can come
// back as 40k characters; one such result then rides along in every later
// turn. shrinkToBudget() keeps the SHAPE of an oversized result and cuts its
// bulk — least lossy level that fits wins — so the agent still sees what is
// there (and how much was cut) and can ask for exactly the part it needs.
// ------------------------------------------------------------------
const SHRINK_LEVELS = [
  { str: 400, arr: 50, keys: 60, depth: 8 },
  { str: 300, arr: 30, keys: 50, depth: 7 },
  { str: 200, arr: 20, keys: 40, depth: 6 },
  { str: 160, arr: 15, keys: 30, depth: 5 },
  { str: 120, arr: 10, keys: 25, depth: 4 },
  { str: 100, arr: 7, keys: 20, depth: 4 },
  { str: 80, arr: 5, keys: 15, depth: 3 },
  { str: 60, arr: 3, keys: 10, depth: 2 }
];

// A multi-line string (an outline, a log) is cut by whole LINES, never by a
// fixed character count: figma_inspect returns { outline: "<many lines>" } and
// a 400-char cut on the first shrink level used to throw away the whole child
// tree ("shrunk 8064→502 bytes"). While shrinkToBudget() is pruning the rest of
// the value, each multi-line string is parked in a MultiLine slot; once the
// rest is known, the slots share what is left of the byte budget.
class MultiLine {
  constructor(text) { this.text = text; this.set = null; this.fitted = ""; }
  toJSON() { return this.fitted; }
}

// `budget` (optional { left }) aborts the walk with PRUNE_OVER once more values
// were emitted than the byte budget could ever hold (each costs >= 1 byte).
const PRUNE_OVER = { over: true };
function pruneValue(value, lvl, depth, slots, budget) {
  if (budget && --budget.left < 0) throw PRUNE_OVER;
  if (typeof value === "string") {
    if (slots && value.indexOf("\n") !== -1) return new MultiLine(value);
    return value.length > lvl.str ? value.slice(0, lvl.str) + `…(+${value.length - lvl.str} chars)` : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    if (depth >= lvl.depth) return `[array of ${value.length}]`;
    const out = [];
    value.slice(0, lvl.arr).forEach((v, i) => {
      const r = pruneValue(v, lvl, depth + 1, slots, budget);
      out.push(r);
      if (r instanceof MultiLine) { r.set = (t) => { out[i] = t; }; slots.push(r); }
    });
    if (value.length > lvl.arr) out.push(`…+${value.length - lvl.arr} more (${value.length} total)`);
    return out;
  }
  const keys = Object.keys(value);
  if (depth >= lvl.depth) return `{object with ${keys.length} keys}`;
  const out = {};
  for (const k of keys.slice(0, lvl.keys)) {
    const r = pruneValue(value[k], lvl, depth + 1, slots, budget);
    out[k] = r;
    if (r instanceof MultiLine) { r.set = (t) => { out[k] = t; }; slots.push(r); }
  }
  if (keys.length > lvl.keys) out["…"] = `+${keys.length - lvl.keys} more keys`;
  return out;
}

// Bytes a string costs inside JSON (escapes included, the two quotes not).
function jsonStringCost(s) {
  return byteLength(JSON.stringify(String(s))) - 2;
}

// 2 spaces per outline level.
function indentLevel(line) {
  let n = 0;
  while (line.charCodeAt(n) === 32) n++;
  return Math.floor(n / 2);
}

function depthMarker(run, k) {
  const t = " ".repeat(2 * k) + `… +${run.n} deeper`;
  return { t, i: run.first, lv: k, cost: jsonStringCost(t) };
}

// Fits a multi-line string into `budget` JSON-string bytes. Returns
// { text, ok }; ok is false only when not even the first line (plus the
// marker) fits, in which case that first line is cut mid-way.
//  1. While it does not fit and there is more than one indent level, drop the
//     DEEPEST level: each consecutive run of dropped lines becomes one
//     "<indent>… +N deeper" line. (A single root line keeps its children's
//     level: collapsing 79 children into "+79 deeper" would show nothing.)
//  2. Still too big: keep whole leading lines and end with
//     "… +N more lines (T total) — pass offset=K".
// A leading "… lines 0–B skipped" header (figma_inspect's offset) is kept and
// shifts the K numbering so offset always counts ORIGINAL lines.
function fitLines(text, budget) {
  if (jsonStringCost(text) <= budget) return { text, ok: true };
  let head = "", base = 0, body = text;
  const skipped = /^… lines 0–(\d+) skipped\n/.exec(text);
  if (skipped) { head = skipped[0]; base = Number(skipped[1]) + 1; body = text.slice(head.length); }
  const rawLines = body.split("\n");
  const total = base + rawLines.length;
  const NL = 2; // "\n" costs two bytes once JSON-escaped
  const headCost = jsonStringCost(head);
  let prev = 0;
  const items = rawLines.map((t, i) => {
    const lv = t.trim() ? indentLevel(t) : prev;
    prev = lv;
    return { t, i, lv, cost: jsonStringCost(t) };
  });
  const costOf = (list) => headCost + list.reduce((sum, it) => sum + it.cost, 0) + NL * Math.max(0, list.length - 1);

  // 1. drop the deepest indent levels
  let list = items;
  const maxLv = items.reduce((m, it) => Math.max(m, it.lv), 0);
  const roots = items.filter(it => it.lv === 0).length;
  const minKeep = roots <= 1 ? 2 : 1; // never collapse below this level
  for (let k = maxLv; k >= minKeep; k--) {
    const collapsed = [];
    let run = null;
    for (const it of items) {
      if (it.lv >= k) {
        if (!run) run = { first: it.i, n: 0 };
        run.n++;
      } else {
        if (run) { collapsed.push(depthMarker(run, k)); run = null; }
        collapsed.push(it);
      }
    }
    if (run) collapsed.push(depthMarker(run, k));
    list = collapsed;
    if (costOf(list) <= budget) return { text: head + list.map(it => it.t).join("\n"), ok: true };
  }

  // 2. cut the tail on a line boundary
  const moreLine = (it) => {
    const first = base + it.i;
    return `… +${total - first} more lines (${total} total) — pass offset=${first}`;
  };
  let used = headCost;
  const prefix = []; // bytes of the first n lines, each followed by "\n"
  for (const it of list) { used += it.cost + NL; prefix.push(used); }
  for (let n = list.length - 1; n >= 1; n--) {
    if (prefix[n - 1] + jsonStringCost(moreLine(list[n])) <= budget) {
      return { text: head + list.slice(0, n).map(it => it.t).join("\n") + "\n" + moreLine(list[n]), ok: true };
    }
  }
  // Not even one whole line plus the marker: cut the first line by bytes.
  const marker = list.length > 1 ? moreLine(list[1]) : "";
  const room = Math.max(0, budget - headCost - NL - jsonStringCost(marker));
  let lo = 0, hi = list[0].t.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (jsonStringCost(list[0].t.slice(0, mid)) <= room) lo = mid; else hi = mid - 1;
  }
  if (lo > 0 && /[\uD800-\uDBFF]/.test(list[0].t[lo - 1])) lo -= 1;
  const first = list[0].t.slice(0, lo);
  return { text: head + first + (marker ? "\n" + marker : "…"), ok: false };
}

function byteLength(text) {
  return Buffer.byteLength(String(text), "utf8");
}

// Longest prefix of `text` that fits in maxBytes of UTF-8 without splitting a
// character.
function cutToBytes(text, maxBytes) {
  const s = String(text);
  if (byteLength(s) <= maxBytes) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (byteLength(s.slice(0, mid)) <= maxBytes) lo = mid; else hi = mid - 1;
  }
  if (lo > 0 && /[\uD800-\uDBFF]/.test(s[lo - 1])) lo -= 1; // don't end on half a surrogate pair
  return s.slice(0, lo);
}

// The pruning (depth × array length × string length) whose JSON is the
// largest that still fits; ties go to the deeper one. -> { value, bytes } | null
const GRID_DEPTHS = [8, 7, 6, 5, 4, 3, 2];
const GRID_ARRS = [50, 30, 20, 15, 10, 7, 5, 3, 2];
const GRID_STRS = [400, 200, 120, 80, 60];
function bestStructuralFit(value, maxBytes) {
  let best = null;
  for (const depth of GRID_DEPTHS) {
    for (const arr of GRID_ARRS) {
      for (const str of GRID_STRS) {
        let pruned;
        try {
          pruned = pruneValue(value, { depth, arr, str, keys: Math.max(10, arr + 10) }, 0, null, { left: maxBytes });
        } catch (e) {
          if (e === PRUNE_OVER) continue;
          throw e;
        }
        const bytes = byteLength(toJson(pruned));
        if (bytes <= maxBytes && (!best || bytes > best.bytes)) best = { value: pruned, bytes };
      }
    }
  }
  return best;
}

// -> { value, truncated: null | { from, to } } in UTF-8 bytes; maxBytes <= 0 disables.
function shrinkToBudget(value, maxBytes) {
  let full;
  try { full = toJson(value); } catch (e) { full = String(value); }
  if (!(maxBytes > 0) || full === undefined) return { value, truncated: null };
  const fullBytes = byteLength(full);
  if (fullBytes <= maxBytes) return { value, truncated: null };
  if (typeof value === "string") {
    if (value.indexOf("\n") !== -1) {
      const fit = fitLines(value, Math.max(0, maxBytes - 2));
      return { value: fit.text, truncated: { from: fullBytes, to: byteLength(toJson(fit.text)) } };
    }
    const cut = cutToBytes(value, Math.max(0, maxBytes - 24));
    return { value: cut + `…(+${value.length - cut.length} chars)`, truncated: { from: fullBytes, to: maxBytes } };
  }
  // Plain data (no multi-line text): the fixed levels cut depth, arrays and
  // strings together, so one step too far collapses everything — session
  // e6524905 saw 4444→651 and 5840→998 bytes under a 3500 budget, then 15
  // calls slicing lastResult. Search the grid for the fit that keeps the most.
  const probe = [];
  let probed = true;
  try { pruneValue(value, SHRINK_LEVELS[0], 0, probe, { left: 200000 }); } catch (e) { if (e !== PRUNE_OVER) throw e; probed = false; }
  if (probed && probe.length === 0) {
    const best = bestStructuralFit(value, maxBytes);
    if (best) return { value: best.value, truncated: { from: fullBytes, to: best.bytes } };
  }
  let fallback = null;
  for (const lvl of SHRINK_LEVELS) {
    const slots = [];
    const pruned = pruneValue(value, lvl, 0, slots);
    let allFit = true;
    if (slots.length) {
      // Whatever the rest of the value leaves is shared between the multi-line
      // strings, smallest first, so a short one is never cut for a long one.
      let avail = maxBytes - byteLength(toJson(pruned));
      const order = slots.slice().sort((a, b) => a.text.length - b.text.length);
      order.forEach((slot, idx) => {
        const fit = fitLines(slot.text, Math.max(0, Math.floor(avail / (order.length - idx))));
        slot.fitted = fit.text;
        if (!fit.ok) allFit = false;
        avail -= jsonStringCost(fit.text);
      });
      for (const slot of slots) slot.set(slot.fitted);
    }
    const bytes = byteLength(toJson(pruned));
    if (bytes <= maxBytes) {
      const res = { value: pruned, truncated: { from: fullBytes, to: bytes } };
      if (allFit) return res;
      fallback = fallback || res; // a first line had to be cut: try a level that shrinks the rest more
    }
  }
  if (fallback) return fallback;
  // Nothing structural fits (thousands of top-level keys, say): plain cut.
  return { value: cutToBytes(full, maxBytes) + "…", truncated: { from: fullBytes, to: maxBytes } };
}

module.exports = { fitLines, byteLength, cutToBytes, shrinkToBudget };
