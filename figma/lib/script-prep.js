const vm = require("vm");

// ------------------------------------------------------------------
// Writes that stall the plugin (bench H5, 15.10). Measured on the live bridge:
// after an exportAsync, or after a few loads in one call, a further
// figma.loadFontAsync of an already-loaded font does not resolve for 20-150 s
// (it seems to wait for a canvas frame, rare while Figma is in the
// background). Two agent paths hit it and turned a trivial write into a job
// plus a figma_job_status turn: (1) the per-character loop
// `for (i...) await figma.loadFontAsync(t.getRangeFontName(i, i + 1))`
// (T6: 16 loads), (2) diff:true, whose "before" export runs ahead of the
// plugin's own ensureFont calls (T7, T1, even with `return 1` as the code).
// (1): `figma` is a parameter of the script body, so a one-line prefix
// rebinds it to a view whose loadFontAsync loads each family|style once
// (Proxy over {}: figma's own properties are non-configurable). Same line as
// the script, so error line numbers stay. (2): diff is not forwarded.
// Bench Б-1 (#54, T12 failed at 278k tokens): the loaded set lives in
// bridge.state, so a font loaded by an earlier call is not loaded again, and a
// load that has not resolved after 5 s (st.__fontTimeoutMs) is taken as done:
// the stall is on fonts that are already there; a font that really is missing
// fails at the write with the unloaded-font hint.
// ------------------------------------------------------------------
const FONT_MEMO_PRELUDE = "(function (st) { const ms = st.__fontTimeoutMs || 5000; const done = st.__fontsLoaded || (st.__fontsLoaded = {}); const memo = (load, key) => { const m = new Map(); return function () { const k = key.apply(null, arguments); if (k === null) return load.apply(null, arguments); if (done[k]) return Promise.resolve(); if (!m.has(k)) { let tm; const late = typeof setTimeout === 'function' ? new Promise(r => { tm = setTimeout(r, ms); }) : new Promise(() => {}); m.set(k, Promise.race([Promise.resolve(load.apply(null, arguments)), late]).then(() => { if (tm) clearTimeout(tm); done[k] = 1; }, e => { if (tm) clearTimeout(tm); m.delete(k); throw e; })); } return m.get(k); }; }; ensureFont = memo(ensureFont, (f, s) => 'e|' + (f || 'Inter') + '|' + (s || 'Regular')); const lf = memo(figma.loadFontAsync.bind(figma), f => f && f.family ? f.family + '|' + f.style : null); figma = (function (real) { return new Proxy({}, { get(t, k) { if (k === 'loadFontAsync') return lf; const v = real[k]; return typeof v === 'function' ? v.bind(real) : v; }, set(t, k, v) { real[k] = v; return true; }, has(t, k) { return k in real; } }); })(figma); })(typeof bridge !== 'undefined' && bridge && bridge.state || {}); ";
const DIFF_OFF_NOTE = "diff:true was ignored: its \"before\" screenshot stalls the plugin for minutes (bench 15.10); the change ran without it.";

// #55 (T12): `const log = []` in a script is "Identifier 'log' has already been
// declared": log, notify, progress... are parameters of the function the code
// runs in. Such a body goes into a block (same first line, so line numbers stay),
// where the script's own declaration shadows the parameter.
const SCRIPT_PARAMS = ["figma", "ensureFont", "notify", "log", "getFreePosition", "getFreeCanvasPosition", "bridge", "progress"];
const compiles = body => { try { new vm.Script("(async function (" + SCRIPT_PARAMS.join(", ") + ") {\n" + body + "\n})"); return null; } catch (e) { return e; } };
function shieldParams(code) {
  if (typeof code !== "string") return code;
  const err = compiles(code);
  const m = err && err.name === "SyntaxError" && /Identifier '([\w$]+)' has already been declared/.exec(err.message);
  if (!m || SCRIPT_PARAMS.indexOf(m[1]) === -1) return code;
  const wrapped = "{ " + code + "\n}";
  return compiles(wrapped) ? code : wrapped;
}

function withFontMemo(code) {
  return typeof code === "string" && /\b(loadFontAsync|ensureFont)\b/.test(code) ? FONT_MEMO_PRELUDE + code : code;
}

function stripFontMemoCode(code) {
  return typeof code === "string" && code.indexOf(FONT_MEMO_PRELUDE) === 0 ? code.slice(FONT_MEMO_PRELUDE.length) : code;
}

// The prelude must never show up in an error the agent reads.
function stripFontMemo(response) {
  if (!response || typeof response !== "object") return response;
  for (const k of ["error", "errorLine", "at"]) {
    if (typeof response[k] === "string" && response[k].indexOf(FONT_MEMO_PRELUDE) !== -1) response[k] = response[k].split(FONT_MEMO_PRELUDE).join("");
  }
  return response;
}

module.exports = { FONT_MEMO_PRELUDE, DIFF_OFF_NOTE, shieldParams, withFontMemo, stripFontMemoCode, stripFontMemo };
