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
    c.stats.frames++; c.stats.auto_layout++;
  });
  P.children = out;
  c.warn.push({ dom: n.id, code: "grid_rows", msg: "grid with spans or unequal tracks: " + g.rows.length + " row frames" });
}
