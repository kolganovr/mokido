// A small Auto Layout model for tests (T-134): computes the boxes real Figma would give the nodes of the strict stub
// (tests/helpers/html-build-stub.js), so the builder's self-check sees positions that follow Auto Layout rules instead of the plan's own.
// It is MY MODEL of Figma, not Figma: FIXED / HUG / FILL (FILL children share the free main-axis space equally), padding, itemSpacing,
// primary / counter alignment, SPACE_BETWEEN, ABSOLUTE children, stroke counted in layout, native GRID (FLEX / FIXED columns, one cell per child).
// Text and svg keep the size they were built with (no font metrics). Wrapping containers (layoutWrap WRAP) keep the plan positions.
// Use: stub.hooks.box = alSim.hook(stub, { wrapBox }) ; the origin of the topmost frame is its own x, y.
function createAlSim() {
  const isFrame = (d) => d.type === "FRAME" || d.type === "COMPONENT" || d.type === "INSTANCE";
  const isAL = (d) => isFrame(d) && d.layoutMode && d.layoutMode !== "NONE";
  const inFlow = (c) => c.visible !== false && c.layoutPositioning !== "ABSOLUTE";
  const dd = (n) => n.__d;
  function sizing(d, axis) { // "FIXED" | "HUG" | "FILL" along h | v
    const par = d.parent;
    if (par && isAL(par) && d.layoutPositioning !== "ABSOLUTE") return d[axis === "h" ? "layoutSizingHorizontal" : "layoutSizingVertical"] || "FIXED";
    if (isAL(d)) {
      const prim = d.layoutMode === "HORIZONTAL" ? "h" : "v";
      const m = axis === prim ? d.primaryAxisSizingMode : d.counterAxisSizingMode;
      return m === "AUTO" ? "HUG" : "FIXED";
    }
    return "FIXED";
  }
  function border(d) {
    if (!d.strokes || !d.strokes.length || !d.strokesIncludedInLayout) return [0, 0, 0, 0];
    const w = (k) => (typeof d[k] === "number" ? d[k] : d.strokeWeight || 0);
    return [w("strokeTopWeight"), w("strokeRightWeight"), w("strokeBottomWeight"), w("strokeLeftWeight")];
  }
  function pads(d) { const b = border(d); return [d.paddingTop + b[0], d.paddingRight + b[1], d.paddingBottom + b[2], d.paddingLeft + b[3]]; }
  const memo = new Map();
  // intrinsic size (what HUG gives): children measured by their own sizing, FILL children count by content
  function measure(d) {
    if (memo.has(d)) return memo.get(d);
    let out = { w: d.width, h: d.height };
    if (isAL(d) && d.layoutMode !== "GRID" && d.layoutWrap !== "WRAP") {
      const horiz = d.layoutMode === "HORIZONTAL", p = pads(d);
      const kids = (d.children || []).map(dd).filter(inFlow);
      let main = 0, cross = 0;
      for (const c of kids) { const s = childSize(c); main += horiz ? s.w : s.h; cross = Math.max(cross, horiz ? s.h : s.w); }
      main += Math.max(0, kids.length - 1) * (d.itemSpacing || 0);
      const w = (horiz ? main : cross) + p[1] + p[3], h = (horiz ? cross : main) + p[0] + p[2];
      out = { w: sizing(d, "h") === "HUG" ? w : d.width, h: sizing(d, "v") === "HUG" ? h : d.height };
    } else if (d.layoutMode === "GRID") {
      const p = pads(d), kids = (d.children || []).map(dd).filter(inFlow);
      const cs = kids.map(childSize);
      const cols = d.gridColumnCount || 1;
      const w = cs.reduce((a, s) => a + s.w, 0) + (cols - 1) * (d.gridColumnGap || 0) + p[1] + p[3];
      const h = Math.max(0, ...cs.map((s) => s.h)) + p[0] + p[2];
      out = { w: sizing(d, "h") === "HUG" ? w : d.width, h: sizing(d, "v") === "HUG" ? h : d.height };
    }
    memo.set(d, out);
    return out;
  }
  function childSize(c) { // the size a child asks for before the parent shares free space
    if (sizing(c, "h") === "FIXED" && sizing(c, "v") === "FIXED") return { w: c.width, h: c.height };
    const m = measure(c);
    return { w: sizing(c, "h") === "FIXED" ? c.width : m.w, h: sizing(c, "v") === "FIXED" ? c.height : m.h };
  }
  function place(d, ox, oy, W, H, res, wrapBox) {
    res.set(d, { x: ox, y: oy, width: W, height: H });
    const kids = (d.children || []).map(dd).filter((c) => c.visible !== false);
    if (!isAL(d)) { for (const c of kids) place(c, ox + c.x, oy + c.y, c.width, c.height, res, wrapBox); return; }
    const p = pads(d), horiz = d.layoutMode === "HORIZONTAL";
    const flow = kids.filter(inFlow);
    for (const c of kids.filter((k) => !inFlow(k))) place(c, ox + c.x, oy + c.y, c.width, c.height, res, wrapBox);
    if (d.layoutMode === "GRID") {
      const cols = d.gridColumnCount || 1, gap = d.gridColumnGap || 0, avail = W - p[1] - p[3] - gap * (cols - 1);
      const sizes = d.gridColumnSizes || [];
      let fixedSum = 0, flexSum = 0;
      for (let i = 0; i < cols; i++) { const s = sizes[i] || { type: "FLEX", value: 1 }; if (s.type === "FIXED") fixedSum += s.value; else flexSum += s.value || 1; }
      const widths = []; for (let i = 0; i < cols; i++) { const s = sizes[i] || { type: "FLEX", value: 1 }; widths.push(s.type === "FIXED" ? s.value : ((avail - fixedSum) * (s.value || 1)) / flexSum); }
      const rowH = Math.max(0, ...flow.map((c) => childSize(c).h));
      const innerH = H - p[0] - p[2];
      let x0 = p[3]; const starts = []; for (let i = 0; i < cols; i++) { starts.push(x0); x0 += widths[i] + gap; }
      for (const c of flow) {
        const pos = c.gridPos || { row: 0, col: 0 }, cw = widths[pos.col] * 1;
        const ch = sizing(c, "v") === "FILL" ? Math.max(innerH, rowH) : childSize(c).h;
        place(c, ox + starts[pos.col], oy + p[0], sizing(c, "h") === "FILL" ? cw : Math.min(childSize(c).w, cw), ch, res, wrapBox);
      }
      return;
    }
    if (d.layoutWrap === "WRAP") { for (const c of flow) { const b = wrapBox ? wrapBox(c) : null; place(c, ox + (b ? b.x : c.x), oy + (b ? b.y : c.y), c.width, c.height, res, wrapBox); } return; }
    const mainAvail = (horiz ? W : H) - (horiz ? p[1] + p[3] : p[0] + p[2]), crossAvail = (horiz ? H : W) - (horiz ? p[0] + p[2] : p[1] + p[3]);
    const gap = d.itemSpacing || 0;
    const ask = flow.map(childSize);
    const fills = flow.map((c) => sizing(c, horiz ? "h" : "v") === "FILL");
    const used = ask.reduce((a, s, i) => a + (fills[i] ? 0 : horiz ? s.w : s.h), 0) + gap * Math.max(0, flow.length - 1);
    const nFill = fills.filter(Boolean).length;
    const share = nFill ? Math.max(0, (mainAvail - used) / nFill) : 0;
    const dims = flow.map((c, i) => {
      const s = ask[i];
      let mainLen = fills[i] ? share : horiz ? s.w : s.h;
      let crossLen = sizing(c, horiz ? "v" : "h") === "FILL" ? crossAvail : horiz ? s.h : s.w;
      return { main: mainLen, cross: crossLen };
    });
    const total = dims.reduce((a, s) => a + s.main, 0) + gap * Math.max(0, flow.length - 1);
    let start = horiz ? p[3] : p[0], g = gap;
    const pa = d.primaryAxisAlignItems;
    if (!nFill) {
      if (pa === "CENTER") start += (mainAvail - total) / 2;
      else if (pa === "MAX") start += mainAvail - total;
      else if (pa === "SPACE_BETWEEN" && flow.length > 1) g = (mainAvail - dims.reduce((a, s) => a + s.main, 0)) / (flow.length - 1);
    }
    flow.forEach((c, i) => {
      const s = dims[i];
      const crossStart = horiz ? p[0] : p[3];
      const ca = d.counterAxisAlignItems;
      const off = ca === "CENTER" ? (crossAvail - s.cross) / 2 : ca === "MAX" ? crossAvail - s.cross : 0;
      const cx = horiz ? start : crossStart + off, cy = horiz ? crossStart + off : start;
      place(c, ox + cx, oy + cy, horiz ? s.main : s.cross, horiz ? s.cross : s.main, res, wrapBox);
      start += s.main + g;
    });
  }
  // absolute boxes of every node under the topmost frame of node
  function hook(stub, opts) {
    return (node, naive) => {
      let top = dd(node);
      while (top.parent && top.parent.type !== "PAGE" && top.parent.id !== (opts && opts.hostId)) top = top.parent;
      memo.clear();
      const res = new Map();
      const W = sizing(top, "h") === "HUG" ? measure(top).w : top.width, H = sizing(top, "v") === "HUG" ? measure(top).h : top.height;
      place(top, top.x, top.y, W, H, res, opts && opts.wrapBox);
      const r = res.get(dd(node));
      return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : naive;
    };
  }
  return { hook, measure, place };
}
module.exports = { createAlSim };
