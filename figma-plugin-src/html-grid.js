// html-grid.js (T-077, F9 9.4): CSS grid without native GRID (contract planning/fable/F9_контракт.md, section 4, rules 1-3).
// A part of the plugin scope (no import/export), prefix htmlGrid*. Called from htmlMapNode; works on the plan only (pure).
// htmlGridStrategy() is the ONE extension point: the native layoutMode GRID (when the live probe passes) is a new return value there.
function htmlGridTracks(cols) { // computed "468px 468px" -> [468, 468]; anything not px -> []
  const t = String(cols || "").trim().split(/\s+/).filter(Boolean);
  const v = t.map((x) => (/^-?[\d.]+px$/.test(x) ? parseFloat(x) : NaN));
  return t.length && v.every((x) => !isNaN(x)) ? v : [];
}
function htmlGridSpan(v) { // "span 2" | "1 / 3" | "1 / span 2" -> 2; anything else 1
  const s = String(v == null ? "" : v);
  let m = /span\s+(\d+)/.exec(s);
  if (m) return Math.max(1, +m[1]);
  m = /^\s*(-?\d+)\s*\/\s*(-?\d+)\s*$/.exec(s);
  return m && +m[2] > +m[1] ? +m[2] - +m[1] : 1;
}
// flexible (fr / % / minmax) tracks: from the authored template when the walker gave it, else "the tracks fill the container"
function htmlGridFlex(n, tr, inner) {
  const d = (n.declared || {})["grid-template-columns"];
  if (d) {
    const m = /^repeat\(\s*(\d+)\s*,(.*)\)$/.exec(String(d).trim());
    const one = m ? m[2].trim() : String(d).trim();
    const parts = one.split(/\s+(?![^(]*\))/).filter(Boolean);
    const list = m ? Array.from({ length: +m[1] }, () => parts).reduce((a, b) => a.concat(b), []) : parts;
    if (list.length === tr.length) return list.map((x) => !/^-?[\d.]+px$/.test(x));
    return tr.map(() => true);
  }
  const sum = tr.reduce((a, b) => a + b, 0) + (n.grid.colGap || 0) * (tr.length - 1);
  return tr.map(() => Math.abs(sum - inner) <= 3);
}
// rows by vertical overlap of the flow children (align-items does not matter), each row sorted by x
function htmlGridRows(flow) {
  const rows = [];
  flow.slice().sort((a, b) => a._n.rect.y - b._n.rect.y || a._n.rect.x - b._n.rect.x).forEach((k) => {
    const r = rows[rows.length - 1], y = k._n.rect.y;
    if (r && y < r.b - 1) { r.k.push(k); r.b = Math.max(r.b, y + k._n.rect.h); } else rows.push({ k: [k], b: y + k._n.rect.h });
  });
  return rows.map((r) => r.k.sort((a, b) => a._n.rect.x - b._n.rect.x));
}
function htmlGridInfo(n, flow, pad) {
  const tr = htmlGridTracks(n.grid.cols);
  if (!tr.length) return null;
  const gap = n.grid.colGap || 0, left = n.rect.x + pad[3], inner = n.rect.w - pad[1] - pad[3];
  const starts = [];
  tr.reduce((x, w) => { starts.push(x); return x + w + gap; }, left);
  const rows = htmlGridRows(flow);
  const col = (k) => { // start track and span of a child
    let best = 0;
    starts.forEach((s, i) => { if (Math.abs(s - k._n.rect.x) < Math.abs(starts[best] - k._n.rect.x)) best = i; });
    const sp = Math.min(htmlGridSpan((k._n.declared || {})["grid-column"]), tr.length - best);
    return { i: best, n: sp };
  };
  const span = flow.some((k) => col(k).n > 1 || htmlGridSpan((k._n.declared || {})["grid-row"]) > 1);
  const equal = Math.max.apply(null, tr) - Math.min.apply(null, tr) <= 1;
  return { tr: tr, gap: gap, rows: rows, span: span, equal: equal, col: col, flex: htmlGridFlex(n, tr, inner), left: left, count: flow.length };
}
function htmlGridStrategy(g) { // "single" | "wrap" | "rows"; the native GRID joins here later
  if (g.count <= g.tr.length && g.rows.length <= 1) {
    let end = 0;
    if (g.rows[0] && g.rows[0].every((k) => { const c = g.col(k); const ok = c.i === end; end = c.i + c.n; return ok; })) return "single";
  }
  return g.equal && !g.span ? "wrap" : "rows";
}
// width of a child over its tracks; FILL only when its tracks are flexible and the row fills the container
function htmlGridSize(k, g, c, full) {
  const w = g.tr.slice(c.i, c.i + c.n).reduce((a, b) => a + b, 0) + g.gap * (c.n - 1);
  if (k.sizingH === "FIXED" && k.type !== "TEXT") return; // an own declared width stays
  const fill = full && g.flex.slice(c.i, c.i + c.n).every(Boolean);
  k.sizingH = fill ? "FILL" : "FIXED";
  if (!fill) k.w = w;
  if (k.type === "TEXT") k.text.autoResize = "HEIGHT";
}
// CSS names of the gap tokens: row-gap / column-gap, or the shorthand "gap: row column" (needs html-ds.js; null without it)
function htmlGridGapTokens(c, n, P) {
  const d = n.declared || {};
  if (typeof htmlDsName !== "function" || typeof htmlDsSplit !== "function") return null;
  const gp = d.gap ? htmlDsSplit(d.gap).map((x) => htmlDsName(x, c, P)) : [];
  return { row: d["row-gap"] ? htmlDsName(d["row-gap"], c, P) : gp[0] || null, col: d["column-gap"] ? htmlDsName(d["column-gap"], c, P) : (gp.length > 1 ? gp[1] : gp[0]) || null };
}
function htmlGridApply(c, n, P, flow, pad) {
  P.padding = pad.slice();
  const g = htmlGridInfo(n, flow, pad);
  if (!g) { // no px tracks from the walker: the F8 behaviour
    P.layoutMode = "HORIZONTAL"; P.layoutWrap = "WRAP"; P.itemSpacing = n.grid.colGap; P.counterAxisSpacing = n.grid.rowGap;
    return;
  }
  const how = htmlGridStrategy(g);
  P.build.grid = n.grid.cols;
  if (how === "single" || how === "wrap") {
    P.layoutMode = "HORIZONTAL"; P.itemSpacing = g.gap;
    if (how === "wrap") { P.layoutWrap = "WRAP"; P.counterAxisSpacing = n.grid.rowGap; }
    const last = flow.length ? g.col(g.rows[0] ? g.rows[0][g.rows[0].length - 1] : flow[0]) : { i: 0, n: 0 };
    const full = how === "single" && last.i + last.n === g.tr.length; // empty tracks at the end: children must not stretch over them
    flow.forEach((k) => htmlGridSize(k, g, g.col(k), full));
    return;
  }
  // rows: VERTICAL of "row N" frames, every row is a one-row grid (rule 1)
  P.layoutMode = "VERTICAL"; P.itemSpacing = n.grid.rowGap; P.counterAxisSpacing = n.grid.rowGap;
  const gt = htmlGridGapTokens(c, n, P); // tokens by meaning: row-gap -> the stack, column-gap -> every row frame
  if (gt) { P.build.gapBound = true; if (gt.row) P.bound.itemSpacing = gt.row; }
  const out = P.children.filter((k) => flow.indexOf(k) < 0);
  g.rows.forEach((ks, i) => {
    const cols = ks.map((k) => g.col(k));
    let end = cols[0].i, full = cols[0].i === 0;
    cols.forEach((x) => { if (x.i !== end) full = false; end = x.i + x.n; });
    full = full && end === g.tr.length;
    ks.forEach((k, j) => htmlGridSize(k, g, cols[j], full));
    const top = Math.min.apply(null, ks.map((k) => k.y)), bot = Math.max.apply(null, ks.map((k) => k.y + k.h));
    const lead = Math.max(0, cols[0].i ? Math.round(ks[0]._n.rect.x - g.left) : 0);
    out.push({
      id: "p" + n.id + "r" + (i + 1), dom: null, name: "row " + (i + 1), type: "FRAME", x: ks[0].x - lead, y: top, w: htmlMapR2(n.rect.w - pad[1] - pad[3]), h: htmlMapR2(bot - top), visible: true,
      layoutMode: "HORIZONTAL", layoutWrap: "NO_WRAP", itemSpacing: g.gap, counterAxisSpacing: 0, padding: [0, 0, 0, lead],
      primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN", sizingH: "FILL", sizingV: "HUG", positioning: "AUTO",
      opacity: 1, clips: false, fills: [], strokes: [], strokeWeight: 0, radius: [0, 0, 0, 0], effects: [], bound: {}, component: null, text: null,
      build: { tokens: {}, componentHint: null }, children: ks
    });
    if (gt && gt.col) out[out.length - 1].bound.itemSpacing = gt.col;
    c.stats.frames++; c.stats.auto_layout++;
  });
  P.children = out;
  c.warn.push({ dom: n.id, code: "grid_rows", msg: "grid with spans or unequal tracks: " + g.rows.length + " row frames" });
}

// T-134 (decision 25.11): a flex row whose children ALL grow with unequal flex-grow (flex: 2 / flex: 1) is a native Figma GRID with FLEX columns:
// Auto Layout FILL splits the space equally, a grid keeps 2:1. Plan: layoutMode stays HORIZONTAL (older Figma gets the plain row), build.grid = { cols, gap }
// tells the builder. Only when the row really fills its container in those proportions with the css gap between children (no margins, no free space);
// equal grows, fixed widths mixed with grow, wrap, absolute children and hugging rows stay as they were.
function htmlGridNative(n, P, flow, kids, pc, abs) {
  if (n.flex.dir !== "row" || n.flex.wrap || flow.length < 2 || abs.length || P.layoutMode !== "HORIZONTAL" || P.primaryAxisAlignItems === "SPACE_BETWEEN") return;
  if (!flow.every((k) => kids.indexOf(k) >= 0 && k._n && htmlMapGrow(k._n.declared || {}) > 0)) return;
  const g = flow.map((k) => htmlMapGrow(k._n.declared || {}));
  if (Math.max.apply(null, g) - Math.min.apply(null, g) < 0.001) return;
  if (htmlMapAxis(n, pc, "h") === "HUG") return;
  const bw = (n.style && n.style.borderWidth) || [0, 0, 0, 0];
  const inner = P.w - bw[1] - bw[3] - P.padding[1] - P.padding[3];
  const sw = flow.reduce((a, k) => a + k.w, 0), sg = g.reduce((a, b) => a + b, 0);
  if (Math.abs(sw + n.flex.gap * (flow.length - 1) - inner) > 2) return;
  if (!flow.slice(1).every((k, i) => Math.abs(k.x - (flow[i].x + flow[i].w) - n.flex.gap) <= 1)) return;
  // css shares the free space by grow on top of each child's padding + border (basis 0): outer_i = pb_i + g_i / sum(g) * (inner - gaps - sum(pb))
  const pb = flow.map((k) => { const b = (k._n.style && k._n.style.borderWidth) || [0, 0, 0, 0]; return k.padding[1] + k.padding[3] + b[1] + b[3]; });
  const free = inner - n.flex.gap * (flow.length - 1) - pb.reduce((a, b) => a + b, 0);
  if (!flow.every((k, i) => Math.abs(k.w - (pb[i] + (g[i] / sg) * free)) <= 1.5)) return;
  // a Figma FLEX track shares the whole width by its value, padding included: equal to the grow ratio without padding, else the measured widths
  const exact = flow.every((k, i) => Math.abs(k.w / sw - g[i] / sg) <= 0.002);
  P.build.grid = { cols: exact ? g : flow.map((k) => htmlMapR2(k.w)), gap: n.flex.gap };
}
