// html-ds.js (T-077, F9 9.1): design system of the file for figma_html (contract: planning/fable/F9_контракт.md, sections 0 and 1).
// A part of the plugin scope (no import/export), prefix htmlDs*. Two halves:
//  - map side (runs in htmlMap): htmlDsPlan(p, c) reads the CSS names of var(--token) from the walker's `declared` and writes them into the plan
//    (fills[i].var, strokes[i].var, bound.*). Only explicit var() marks count, nothing is guessed from values.
//  - build side (runs in htmlBuild): htmlDsIndex() indexes the local variables once per call, htmlDsPaints / htmlDsBindNode replace a name by the found variable.
// components and textStyles of the index are empty stubs with the final interface (filled by 9.2 and 9.3).
// html-map.js and html-build.js call into this file through `typeof htmlDsX === "function"` guards (tests may load them alone).

// ---------- names ----------
// One normalization for everything: lower case, separators / . _ - space become "-", no leading "--".
function htmlDsNorm(s) { return String(s || "").toLowerCase().replace(/[\/._\s-]+/g, "-").replace(/^-+|-+$/g, ""); }

// Warnings of one code and one name are merged: "var_not_found --accent-hover x6".
function htmlDsWarnAdd(bag, p, code, name, extra) {
  const k = code + "|" + name;
  const e = bag.get(k);
  if (e) e.n++; else bag.set(k, { n: 1, id: p && p.id !== undefined ? p.id : null, dom: p && p.dom !== undefined ? p.dom : null, code, name, extra: extra || "" });
}
function htmlDsWarnFlush(bag, out) {
  bag.forEach((e) => out.push({ id: e.id, dom: e.dom, code: e.code, msg: (e.name + (e.extra ? " " + e.extra : "") + (e.n > 1 ? " x" + e.n : "")).slice(0, 300) }));
  bag.clear();
}

// ---------- map side: CSS names into the plan ----------
// Top-level whitespace split of a CSS value (parentheses stay whole).
function htmlDsSplit(s) {
  const out = [];
  let cur = "", depth = 0;
  for (const ch of String(s || "")) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) { if (cur) out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
function htmlDsBox4(parts) {
  const q = parts;
  if (!q.length) return [null, null, null, null];
  if (q.length === 1) return [q[0], q[0], q[0], q[0]];
  if (q.length === 2) return [q[0], q[1], q[0], q[1]];
  if (q.length === 3) return [q[0], q[1], q[2], q[1]];
  return q.slice(0, 4);
}
// One value part: var(--x) / var(--x, fallback) gives the name (rule 5); a calc/min/max/clamp around a var is reported and not bound.
function htmlDsName(part, c, p) {
  if (!part) return null;
  const m = /^var\(\s*(--[\w-]+)\s*(?:,[\s\S]*)?\)$/.exec(part);
  if (m) return m[1];
  if (/\b(calc|min|max|clamp)\(/.test(part) && /var\(\s*--/.test(part) && c && c.dsw) htmlDsWarnAdd(c.dsw, p, "var_expr", /var\(\s*(--[\w-]+)/.exec(part)[1], "calc");
  return null;
}
const HTML_DS_BORDER_STYLE = /^(solid|dashed|dotted|double|groove|ridge|inset|outset|hidden|none)$/;
const HTML_DS_RADIUS = ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"];

function htmlDsPlan(p, c) {
  if (typeof htmlInstPlan === "function") htmlInstPlan(p, c);
  const n = p._n;
  if (!n || p.dom == null || !n.declared) return; // wrappers made by the mapper have no DOM node of their own
  const d = n.declared;
  const isFrame = p.type === "FRAME";
  // fills: the background of a frame, only a plain solid (gradient: silent, calc: var_expr)
  if (isFrame && p.fills.length && p.fills[0].type === "SOLID") {
    const bg = d["background-color"] || d.background;
    if (bg && !/gradient\(|url\(/.test(bg)) p.fills[0].var = htmlDsName(htmlDsSplit(bg).length === 1 ? bg.trim() : null, c, p);
  }
  // strokes: the color part of border / border-color, the width part of border / border-width
  let wName = null, cName = null;
  const bc = d["border-color"];
  if (bc) cName = htmlDsName(htmlDsSplit(bc)[0], c, p);
  for (const k of ["border", "border-top", "border-right", "border-bottom", "border-left"]) {
    if (!d[k] || (cName && wName)) continue;
    const parts = htmlDsSplit(d[k]);
    const si = parts.findIndex((x) => HTML_DS_BORDER_STYLE.test(x));
    parts.forEach((x, i) => {
      const nm = htmlDsName(x, c, p);
      if (!nm) return;
      if (si >= 0 && i < si) wName = wName || nm; else cName = cName || nm;
    });
  }
  if (d["border-width"]) { const b = htmlDsBox4(htmlDsSplit(d["border-width"]).map((x) => htmlDsName(x, c, p))); if (b.every((x) => x && x === b[0])) wName = b[0]; }
  if (p.strokes.length && p.strokes[0].type === "SOLID") p.strokes[0].var = cName;
  if (p.strokes.length && typeof p.strokeWeight === "number" && wName) p.bound.strokeWeight = wName;
  // radius: shorthand (before "/"), then the longhands
  if (isFrame || p.type === "IMAGE") {
    const sh = d["border-radius"] ? htmlDsBox4(htmlDsSplit(d["border-radius"].split("/")[0]).map((x) => htmlDsName(x, c, p))) : [null, null, null, null];
    ["border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius"].forEach((k, i) => {
      const nm = d[k] ? htmlDsName(htmlDsSplit(d[k])[0], c, p) : sh[i];
      if (nm && p.radius[i] > 0) p.bound[HTML_DS_RADIUS[i]] = nm;
    });
  }
  if (!isFrame || p.layoutMode === "NONE") return;
  // padding: only a side that is still what CSS says (a margin moved into the padding is not a token)
  let sides = d.padding ? htmlDsBox4(htmlDsSplit(d.padding).map((x) => htmlDsName(x, c, p))) : [null, null, null, null];
  ["padding-top", "padding-right", "padding-bottom", "padding-left"].forEach((k, i) => { if (d[k]) sides[i] = htmlDsName(d[k], c, p); });
  ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].forEach((k, i) => {
    if (sides[i] && Math.abs((n.padding || [0, 0, 0, 0])[i] - p.padding[i]) <= 0.5) p.bound[k] = sides[i];
  });
  // gap: row-gap / column-gap, "gap: row column"
  if (n.flex || n.grid) {
    const gp = d.gap ? htmlDsSplit(d.gap).map((x) => htmlDsName(x, c, p)) : [];
    const row = d["row-gap"] ? htmlDsName(d["row-gap"], c, p) : gp[0] || null;
    const col = d["column-gap"] ? htmlDsName(d["column-gap"], c, p) : (gp.length > 1 ? gp[1] : gp[0]) || null;
    const column = n.flex && n.flex.dir === "column";
    const main = column ? row : col, cross = column ? col : row;
    if (main) p.bound.itemSpacing = main;
    if (cross && p.layoutWrap === "WRAP") p.bound.counterAxisSpacing = cross;
  }
}

// Text color: the token of the first text piece (the walker hands inherited tokens to every #text node).
function htmlDsTextVar(piece) {
  const t = piece && piece.tokens && piece.tokens.color;
  return typeof t === "string" ? t : null;
}

// ---------- build side: the index ----------
function htmlDsHexOf(v) { return v && typeof v === "object" && "r" in v ? v : null; }
async function htmlDsIndex() {
  const idx = { vars: [], components: [], textStyles: [] };
  try {
    const cols = await figma.variables.getLocalVariableCollectionsAsync();
    const vars = await figma.variables.getLocalVariablesAsync();
    const col = new Map(cols.map((x) => [x.id, x]));
    const byId = new Map(vars.map((v) => [v.id, v]));
    for (const v of vars) {
      const cl = col.get(v.variableCollectionId);
      idx.vars.push({ v, kind: v.resolvedType === "COLOR" ? "color" : v.resolvedType === "FLOAT" ? "size" : "other", remote: !!v.remote,
        norm: htmlDsNorm(v.name), full: htmlDsNorm((cl ? cl.name + "/" : "") + v.name), cl, byId });
    }
  } catch (e) { idx.error = e && e.message ? e.message : String(e); }
  return idx;
}
// 9.2: local component sets and single components, from the plugin's own component index (components.js, the one figma_find_components uses).
// Called lazily, only when a plan has data-component: a cold index walks every page.
async function htmlDsComponents() {
  const out = [];
  try { if (typeof figma.loadAllPagesAsync === "function") await figma.loadAllPagesAsync(); } catch (e) { /* the index still sees the loaded pages */ }
  if (typeof ensureComponentIndex !== "function") return out;
  for (const e of ensureComponentIndex(false).values()) out.push({ id: e.id, name: e.name, norm: htmlDsNorm(e.name), type: e.type, remote: false, node: null });
  return out;
}
// Rules 1-3: { v } found, or { code } not_found | ambiguous | type_mismatch.
function htmlDsFindVar(idx, cssName, kind) {
  const q = htmlDsNorm(cssName);
  const all = idx.vars.filter((e) => e.norm === q || e.full === q);
  if (!all.length) return { code: "var_not_found" };
  let c = all.filter((e) => e.kind === kind);
  if (!c.length) return { code: "var_type_mismatch", have: all[0].v.resolvedType };
  if (c.length > 1) { const loc = c.filter((e) => !e.remote); if (loc.length) c = loc; }
  if (c.length > 1) { const ex = c.filter((e) => e.full === q); if (ex.length) c = ex; }
  if (c.length > 1) return { code: "var_ambiguous" };
  return { e: c[0] };
}
// Value of a variable in the default mode of its collection (aliases followed), or undefined.
function htmlDsValue(e) {
  let v = e.v, cl = e.cl;
  for (let i = 0; i < 6 && v; i++) {
    const modes = v.valuesByMode || {};
    const val = modes[cl && cl.defaultModeId] !== undefined ? modes[cl.defaultModeId] : modes[Object.keys(modes)[0]];
    if (val && typeof val === "object" && val.type === "VARIABLE_ALIAS") { v = e.byId.get(val.id); continue; }
    return val;
  }
  return undefined;
}
// Rules 2-4, 6: finds the variable for a CSS name; returns it or null with the warning already recorded.
function htmlDsResolve(ctx, p, name, kind, want, cap) {
  const r = htmlDsFindVar(ctx.ds, name, kind);
  if (!r.e) { htmlDsWarnAdd(ctx.dsw, p, r.code, name, r.have ? "(" + r.have + ")" : ""); return null; }
  let val = htmlDsValue(r.e);
  if (typeof val === "number" && cap !== undefined) val = Math.min(val, cap); // a radius is clamped to half the shorter side, like in CSS
  if (kind === "color") {
    const c = htmlDsHexOf(val);
    if (c && want && want.rgb && [c.r, c.g, c.b].some((x, i) => Math.abs(x * 255 - want.rgb[i]) > 2)) htmlDsWarnAdd(ctx.dsw, p, "var_value_differs", name, "css " + want.hex + " var " + r.e.v.name);
  } else if (typeof val === "number" && typeof want === "number" && Math.abs(val - want) > 0.5) htmlDsWarnAdd(ctx.dsw, p, "var_value_differs", name, "css " + want + " var " + val);
  return r.e.v;
}
function htmlDsRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null;
}
// Rule 9, paints: setBoundVariableForPaint returns a copy bound to the variable; the opacity of the paint stays (rule 7).
function htmlDsBindPaint(ctx, p, paint, name, hex) {
  if (!name || !ctx.ds || paint.type !== "SOLID") return paint;
  const v = htmlDsResolve(ctx, p, name, "color", { hex: hex, rgb: htmlDsRgb(hex) });
  if (!v) return paint;
  try { const out = figma.variables.setBoundVariableForPaint(paint, "color", v); ctx.bound++; return out; }
  catch (e) { htmlDsWarnAdd(ctx.dsw, p, "var_bind_failed", name, String(e && e.message || e).slice(0, 80)); return paint; }
}
// list: plan paints (with .var), out: built paints (same order).
function htmlDsPaints(list, out, p, ctx) {
  if (!ctx.ds) return out;
  return out.map((x, i) => (list[i] && list[i].var ? htmlDsBindPaint(ctx, p, x, list[i].var, list[i].hex) : x));
}
const HTML_DS_NUM_SLOTS = ["itemSpacing", "counterAxisSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius", "strokeWeight"];
// Rule 9, numbers: node.setBoundVariable(field, variable). The value to compare is the one the plan gave to that field.
function htmlDsBindNode(n, p, ctx) {
  if (!ctx.ds || !p.bound) return;
  for (const f of HTML_DS_NUM_SLOTS) {
    const name = p.bound[f];
    if (!name) continue;
    let want, cap;
    const pi = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].indexOf(f), ri = HTML_DS_RADIUS.indexOf(f);
    if (pi >= 0) want = (p.padding || [])[pi];
    else if (ri >= 0) { want = (p.radius || [])[ri]; cap = Math.min(p.w, p.h) / 2; }
    else if (f === "strokeWeight") want = p.strokeWeight;
    else want = p[f];
    const v = htmlDsResolve(ctx, p, name, "size", want, cap);
    if (!v) continue;
    try { n.setBoundVariable(f, v); ctx.bound++; }
    catch (e) { htmlDsWarnAdd(ctx.dsw, p, "var_bind_failed", name, String(e && e.message || e).slice(0, 80)); }
  }
}
