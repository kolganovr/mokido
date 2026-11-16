// html-map.js (T-077, F8.2): translator "tree -> plan". Pure function: no figma, no DOM, no import/export.
// htmlMap(tree, opts) -> { root, count, warnings, stats }. Input: dom.json format (planning/tools/html/SPEC.md).
// Output: node tree in figma_dump.js format (contract planning/fable/F8_контракт.md).
// Does not read expect_sizing / significant: sizing and collapsing are derived from declared, flex, display, style, rects.
// Optional input extensions (a walker may add them): node.position ("absolute"|"fixed"), node.svg (markup), node.src (img).
// Without `position` an absolute child is inferred: its rect overlaps an earlier flow sibling in both axes.
// Padding in the plan is CSS padding as is; border width goes to build.strokeSides (the builder adds it to AL padding).

function htmlMapR2(v) { return Math.round(v * 100) / 100; }
function htmlMapPx(v) {
  if (typeof v === "number") return v;
  const m = /^(-?\d+(?:\.\d+)?)(?:px)?$/.exec(String(v == null ? "" : v).trim());
  return m ? parseFloat(m[1]) : null;
}
function htmlMapHex(h) {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(h || "");
  if (!m) return null;
  const a = m[2] ? parseInt(m[2], 16) / 255 : 1;
  if (a <= 0.004) return null;
  return { hex: "#" + m[1].toLowerCase(), opacity: htmlMapR2(a) };
}
function htmlMapRgb(s) {
  const m = /rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)(?:[ ,/]+([\d.]+))?\s*\)/.exec(s || "");
  if (!m) return null;
  const x = (i) => ("0" + (+m[i]).toString(16)).slice(-2);
  const a = m[4] === undefined ? 1 : parseFloat(m[4]);
  return { hex: "#" + x(1) + x(2) + x(3), a: a, hexa: "#" + x(1) + x(2) + x(3) + ("0" + Math.round(a * 255).toString(16)).slice(-2) };
}
function htmlMapWeightName(w) {
  const t = { 100: "Thin", 200: "Extra Light", 300: "Light", 400: "Regular", 500: "Medium", 600: "Semi Bold", 700: "Bold", 800: "Extra Bold", 900: "Black" };
  return t[Math.round((+w || 400) / 100) * 100] || "Regular";
}
// declared size: {k:"px",v}|{k:"fill"}|{k:"auto"}|{k:"other"}|null
function htmlMapDsz(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  if (s === "100%") return { k: "fill" };
  if (/^(auto|fit-content|max-content|min-content|normal)$/.test(s)) return { k: "auto" };
  const p = htmlMapPx(s);
  return p === null ? { k: "other" } : { k: "px", v: p };
}
function htmlMapGrow(d) {
  if (d["flex-grow"] != null) return parseFloat(d["flex-grow"]) || 0;
  if (d.flex != null) { const f = parseFloat(String(d.flex).trim().split(/\s+/)[0]); return isNaN(f) ? 0 : f; }
  return 0;
}
function htmlMapPaint(n) {
  const s = n.style || {};
  return !!(htmlMapHex(s.bg) || s.bgImage || (s.borderWidth || []).some((w) => w > 0) && htmlMapHex(s.borderColor) || s.boxShadow || (s.opacity != null && s.opacity < 1));
}
function htmlMapCtx(n) {
  if (n.flex) return { mode: n.flex.dir === "row" ? "row" : "col", align: n.flex.align || "normal" };
  if (n.grid) return { mode: "grid", align: "normal" };
  return { mode: "block", align: "normal" };
}
function htmlMapInline(n) { return /^inline/.test(n.display || ""); }

// Sizing along one axis ("h"|"v") by declared / flex / parent kind.
function htmlMapAxis(n, pc, axis) {
  const d = n.declared || {};
  const sz = htmlMapDsz(d[axis === "h" ? "width" : "height"]);
  const fixedish = sz && (sz.k === "px" || sz.k === "other");
  if (pc.mode === "row" || pc.mode === "col") {
    if ((pc.mode === "row") === (axis === "h")) {
      if (htmlMapGrow(d) > 0) return "FILL";
      const b = htmlMapDsz(d["flex-basis"]);
      if (fixedish || (b && b.k === "px")) return "FIXED";
      return sz && sz.k === "fill" ? "FILL" : "HUG";
    }
    if (fixedish) return "FIXED";
    if (sz && sz.k === "fill") return "FILL";
    const as = d["align-self"];
    const al = as && as !== "auto" ? as : pc.align;
    return al === "normal" || al === "stretch" ? "FILL" : "HUG";
  }
  if (fixedish) return "FIXED";
  if (sz && sz.k === "fill") return "FILL";
  if (axis === "v") return "HUG";
  if (htmlMapPx(d["max-width"]) !== null && n.rect && Math.abs(n.rect.w - htmlMapPx(d["max-width"])) < 1) return "FIXED";
  return htmlMapInline(n) ? "HUG" : "FILL";
}
function htmlMapSetSize(p, n, pc) {
  if (p.type === "TEXT") {
    let w = htmlMapAxis(n, pc, "h");
    if (w === "HUG" && p._m.multi) w = "FIXED";
    p.sizingH = w;
    p.sizingV = "HUG";
    p.text.autoResize = w === "HUG" ? "WIDTH_AND_HEIGHT" : "HEIGHT";
    return;
  }
  p.sizingH = htmlMapAxis(n, pc, "h");
  p.sizingV = htmlMapAxis(n, pc, "v");
}

function htmlMapName(n) {
  if (n.name) return n.name;
  if (n.component) return n.component;
  if (n.tag === "svg") return (n.classes && n.classes[0]) || "icon";
  if (n.classes && n.classes[0]) return n.classes[0];
  return n.tag === "#text" ? "text" : n.tag;
}
function htmlMapBase(c, n, type, rect) {
  const r = rect || n.rect;
  const s = n.style || {};
  return {
    id: "p" + n.id, dom: n.id, name: htmlMapName(n), type: type,
    x: htmlMapR2(r.x - c.ox), y: htmlMapR2(r.y - c.oy), w: r.w, h: r.h, visible: true,
    layoutMode: "NONE", layoutWrap: "NO_WRAP", itemSpacing: 0, counterAxisSpacing: 0, padding: [0, 0, 0, 0],
    primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN", sizingH: "FIXED", sizingV: "FIXED", positioning: "AUTO",
    opacity: s.opacity == null ? 1 : s.opacity, clips: false, fills: [], strokes: [], strokeWeight: 0, radius: [0, 0, 0, 0], effects: [],
    bound: {}, component: null, text: null,
    build: { tokens: n.tokens || {}, componentHint: n.component ? { component: n.component, variant: n.variant || null } : null },
    children: [], _n: n
  };
}

// Drawing: fills / strokes / radius / effects.
function htmlMapShadows(str) {
  const out = [];
  let depth = 0, cur = "";
  const parts = [];
  for (const ch of String(str || "")) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) parts.push(cur);
  for (const part of parts) {
    const col = htmlMapRgb(part);
    const nums = part.replace(/rgba?\([^)]*\)/, "").match(/-?\d+(?:\.\d+)?/g) || [];
    if (!col || nums.length < 2) continue;
    out.push({ type: /inset/.test(part) ? "INNER_SHADOW" : "DROP_SHADOW", radius: +(nums[2] || 0), offset: [+nums[0], +nums[1]], hex: col.hexa, spread: +(nums[3] || 0) });
  }
  return out;
}
function htmlMapPaintInto(p, n) {
  const s = n.style || {};
  const bg = htmlMapHex(s.bg);
  if (bg) p.fills.push({ type: "SOLID", hex: bg.hex, opacity: bg.opacity, var: null });
  const decl = (n.declared && (n.declared.background || n.declared["background-image"])) || "";
  if (s.bgImage === "gradient") {
    const g = /linear-gradient\((?:[^()]|\([^()]*\))*\)/.exec(decl);
    const col = htmlMapRgb(decl);
    p.fills.push({ type: "GRADIENT_LINEAR", hex: col ? col.hex : "#000000", opacity: 1, var: null });
    p.build.gradient = g ? g[0] : decl || null;
  } else if (s.bgImage === "url") {
    const u = /url\(["']?([^"')]*)["']?\)/.exec(decl);
    p.fills.push({ type: "IMAGE", hex: null, opacity: 1, var: null });
    p.build.img = u ? u[1] : null;
  }
  const bw = s.borderWidth || [0, 0, 0, 0];
  const bc = htmlMapHex(s.borderColor);
  if (bc && bw.some((w) => w > 0)) {
    p.strokes.push({ type: "SOLID", hex: bc.hex, opacity: bc.opacity, var: null });
    p.strokeWeight = bw.every((w) => w === bw[0]) ? bw[0] : "MIXED";
    p.build.strokeSides = bw.slice();
  }
  p.radius = (s.radius || [0, 0, 0, 0]).slice();
  if (s.boxShadow) p.effects = htmlMapShadows(s.boxShadow);
}

// Text. Pieces: [{n:#text node, style}] in document order; the base style is E's style.
function htmlMapTextual(c, n) {
  if (n.tag === "svg" || n.tag === "img" || n.tag === "#text") return false;
  const k = c.kids[n.id] || [];
  if (!k.length) return false;
  return k.every((x) => x.tag === "#text" || (x.display === "inline" && !htmlMapPaint(x) && htmlMapTextual(c, x)));
}
function htmlMapPieces(c, n, out) {
  for (const k of c.kids[n.id] || []) {
    if (k.tag === "#text") out.push(k); else htmlMapPieces(c, k, out);
  }
  return out;
}
function htmlMapTextNode(c, E, pieces, box, pc, folded) {
  const u = pieces.reduce((a, q) => {
    const r = q.rect;
    return { x1: Math.min(a.x1, r.x), y1: Math.min(a.y1, r.y), x2: Math.max(a.x2, r.x + r.w), y2: Math.max(a.y2, r.y + r.h) };
  }, { x1: 1e9, y1: 1e9, x2: -1e9, y2: -1e9 });
  const ur = { x: u.x1, y: u.y1, w: htmlMapR2(u.x2 - u.x1), h: htmlMapR2(u.y2 - u.y1) };
  const s = (folded ? E : pieces[0]).style;
  // T-103: truncated text (line-clamp N / nowrap + ellipsis): a range box spans the whole text, the visible box is the container's
  // width and at most N lines high
  const clamp = s.clamp || 0;
  if (clamp) {
    const cb = folded ? { x: E.rect.x, w: E.rect.w } : box;
    if (cb) { ur.x = cb.x; ur.w = htmlMapR2(cb.w); }
    ur.h = htmlMapR2(Math.min(ur.h, (s.lineHeight || s.fontSize * 1.2) * clamp));
  }
  const rect = folded ? E.rect : ur;
  const p = htmlMapBase(c, folded ? E : pieces[0], "TEXT", rect);
  if (!folded) p.name = "text";
  const col = htmlMapHex(s.color) || { hex: "#000000", opacity: 1 };
  p.fills = [{ type: "SOLID", hex: col.hex, opacity: col.opacity, var: null }];
  p.opacity = 1;
  // characters: join pieces; a space only where the rects have a gap or a line break between them
  let chars = "", ranges = [];
  pieces.forEach((q, i) => {
    if (i) {
      const a = pieces[i - 1].rect, b = q.rect;
      const sameLine = Math.abs(a.y - b.y) < a.h / 2;
      if (!sameLine || b.x - (a.x + a.w) > 1) chars += " ";
    }
    const st = q.style;
    if (st.fontWeight !== s.fontWeight || st.color !== s.color || st.fontSize !== s.fontSize) {
      const cc = htmlMapHex(st.color) || col;
      ranges.push({ start: chars.length, end: chars.length + q.text.length, fontStyle: htmlMapWeightName(st.fontWeight), hex: cc.hex, fontSize: st.fontSize, decoration: null });
    }
    chars += q.text;
  });
  const lh = s.lineHeight || s.fontSize * 1.2;
  const multi = ur.h > lh * 1.5;
  // alignment: where the text sits inside its box (own box when folded, parent's content box otherwise)
  let align = "LEFT";
  const bx = folded ? { x: E.rect.x, w: E.rect.w } : box;
  if (!multi && bx && ur.w < bx.w - 2) {
    const l = ur.x - bx.x, r = bx.x + bx.w - (ur.x + ur.w);
    if (l > 2 && Math.abs(l - r) <= 2) align = "CENTER"; else if (l > 2 && r <= 2) align = "RIGHT";
  }
  if (!(folded && E.name)) p.name = chars.slice(0, 40);
  p.text = { characters: chars, fontFamily: s.fontFamily, fontStyle: htmlMapWeightName(s.fontWeight), fontSize: s.fontSize, lineHeight: lh, styleName: null, align: align, autoResize: "HEIGHT", lines: multi ? Math.max(2, Math.round(ur.h / lh)) : 1, ranges: ranges };
  if (clamp) { p.text.maxLines = clamp; p.text.truncation = "ENDING"; }
  p._m = { multi: multi || !!clamp };
  htmlMapSetSize(p, folded ? E : pieces[0], pc);
  return p;
}

// Spacing mode of a gap list (most frequent rounded value), negative clamped to 0.
function htmlMapMode(g) {
  if (!g.length) return 0;
  const cnt = {};
  g.forEach((v) => { const k = Math.round(v); (cnt[k] = cnt[k] || []).push(v); });
  let best = null;
  Object.keys(cnt).forEach((k) => { if (!best || cnt[k].length > cnt[best].length) best = k; });
  const arr = cnt[best];
  return Math.max(0, htmlMapR2(arr.reduce((a, b) => a + b, 0) / arr.length));
}
function htmlMapAlign(v) {
  if (v === "center") return "CENTER";
  if (v === "flex-end" || v === "end" || v === "right") return "MAX";
  if (v === "baseline") return "BASELINE";
  return "MIN";
}

// Block flow (no flex) -> AL: vertical with FILL width, or a horizontal run of inline-blocks. Margins from rects.
function htmlMapFlow(c, n, P, flow) {
  const bw = n.style.borderWidth || [0, 0, 0, 0], pad = n.padding;
  const cx = P.x + bw[3] + pad[3], cy = P.y + bw[0] + pad[0];
  const cw = P.w - bw[1] - bw[3] - pad[1] - pad[3], ch = P.h - bw[0] - bw[2] - pad[0] - pad[2];
  const warn = (code, msg) => c.warn.push({ dom: n.id, code: code, msg: msg });
  const horiz = flow.length >= 2 && flow.every((k, i) => i === 0 || (k.x >= flow[i - 1].x + flow[i - 1].w - 1 && k.y < flow[i - 1].y + flow[i - 1].h - 1 && k.y + k.h > flow[i - 1].y + 1));
  const pd = pad.slice();
  if (horiz) {
    P.layoutMode = "HORIZONTAL";
    const gaps = flow.slice(1).map((k, i) => k.x - (flow[i].x + flow[i].w));
    P.itemSpacing = htmlMapMode(gaps);
    pd[3] += Math.max(0, flow[0].x - cx);
    const t = flow[0].y - cy, b = cy + ch - (flow[0].y + flow[0].h);
    P.counterAxisAlignItems = t > 1 && Math.abs(t - b) <= 1 ? "CENTER" : t > 1 && b <= 1 ? "MAX" : "MIN";
    if (P.counterAxisAlignItems === "MIN") pd[0] += Math.max(0, t);
  } else {
    P.layoutMode = "VERTICAL";
    const gaps = flow.slice(1).map((k, i) => k.y - (flow[i].y + flow[i].h));
    P.itemSpacing = htmlMapMode(gaps);
    if (gaps.length && Math.max.apply(null, gaps) - Math.min.apply(null, gaps) > 1.5) warn("uneven-margin", "block children have different margins " + gaps.map(Math.round).join(","));
    pd[0] += Math.max(0, flow[0].y - cy);
    const last = flow[flow.length - 1];
    if (!htmlMapDsz(n.declared && n.declared.height) || htmlMapDsz(n.declared.height).k !== "px") pd[2] += Math.max(0, cy + ch - (last.y + last.h));
    const fills = flow.filter((k) => k.sizingH === "FILL");
    let el = 0, er = 0;
    if (fills.length) {
      el = Math.max(0, fills[0].x - cx);
      er = Math.max(0, cx + cw - (fills[0].x + fills[0].w));
      if (fills.some((k) => Math.abs(k.x - cx - el) > 1 || Math.abs(cx + cw - k.x - k.w - er) > 1)) warn("uneven-margin", "FILL children have different side margins");
      pd[3] += el; pd[1] += er;
    }
    const votes = { MIN: 0, CENTER: 0, MAX: 0 };
    flow.filter((k) => k.sizingH !== "FILL").forEach((k) => {
      const l = k.x - cx - el, r = cx + cw - er - (k.x + k.w);
      votes[l > 1 && Math.abs(l - r) <= 1 ? "CENTER" : l > 1 && r <= 1 ? "MAX" : "MIN"]++;
    });
    const top = Object.keys(votes).sort((a, b) => votes[b] - votes[a])[0];
    if (votes[top]) P.counterAxisAlignItems = top;
  }
  P.padding = pd.map(htmlMapR2);
}

// One child laid over an empty container: alignment on both axes + padding from the nearest edge.
function htmlMapOverlay(n, P, k) {
  const bw = n.style.borderWidth || [0, 0, 0, 0], pad = n.padding.slice();
  const cx = P.x + bw[3] + pad[3], cy = P.y + bw[0] + pad[0];
  const cw = P.w - bw[1] - bw[3] - pad[1] - pad[3], ch = P.h - bw[0] - bw[2] - pad[0] - pad[2];
  const ax = (a, b, ia, ib) => (a > 1 && Math.abs(a - b) <= 1 ? "CENTER" : a <= b ? "MIN" : "MAX");
  const l = k.x - cx, r = cx + cw - (k.x + k.w), t = k.y - cy, b = cy + ch - (k.y + k.h);
  const ah = ax(l, r), av = ax(t, b);
  if (ah === "MIN") pad[3] += Math.max(0, l); else if (ah === "MAX") pad[1] += Math.max(0, r);
  if (av === "MIN") pad[0] += Math.max(0, t); else if (av === "MAX") pad[2] += Math.max(0, b);
  P.layoutMode = "VERTICAL"; P.primaryAxisAlignItems = av; P.counterAxisAlignItems = ah; P.padding = pad.map(htmlMapR2);
  k.positioning = "AUTO"; k.sizingH = "HUG"; k.sizingV = "HUG";
  if (k.type === "TEXT") k.text.autoResize = "WIDTH_AND_HEIGHT";
}

function htmlMapOverlaps(a, b) {
  return Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1;
}
function htmlMapClose(a, b) {
  return Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.w - b.w) <= 1 && Math.abs(a.h - b.h) <= 1;
}

// T-105: margins of flex children (ADR-004 p. 3). The gap between neighbours = css gap + margins. The smallest gap is the container's
// itemSpacing (equal margins end up there); a bigger one is a margin on that child: padding of the child if it is an unpainted
// Auto Layout frame, otherwise a wrapper frame with a warning. Main axis only; wrap and space-between are left alone.
function htmlMapFlexMargins(c, n, P, flow, kids) {
  const row = n.flex.dir === "row", side = row ? 3 : 0;
  const pos = (k) => (row ? k.x : k.y), len = (k) => (row ? k.w : k.h);
  const gaps = flow.slice(1).map((k, i) => pos(k) - (pos(flow[i]) + len(flow[i])));
  if (gaps.some((g) => g < -0.5)) return;
  let lo = Math.min.apply(null, gaps);
  if (Math.max.apply(null, gaps) - lo > 1 && n.flex.gap <= lo + 0.5) lo = n.flex.gap; // unequal: the css gap stays the spacing, margins go to the children
  P.itemSpacing = htmlMapR2(lo);
  flow.slice(1).forEach((k, i) => {
    const extra = htmlMapR2(gaps[i] - lo);
    if (extra <= 1) return;
    const bare = k.type === "FRAME" && k.layoutMode !== "NONE" && !k.fills.length && !k.strokes.length && !k.effects.length;
    if (bare) {
      k.padding[side] = htmlMapR2(k.padding[side] + extra);
      if (row) { k.x = htmlMapR2(k.x - extra); k.w = htmlMapR2(k.w + extra); } else { k.y = htmlMapR2(k.y - extra); k.h = htmlMapR2(k.h + extra); }
      return;
    }
    const w = htmlMapBase(c, k._n, "FRAME");
    w.dom = null; w.id = k.id + "m"; w.name = k.name + " margin";
    w.x = row ? htmlMapR2(k.x - extra) : k.x; w.y = row ? k.y : htmlMapR2(k.y - extra);
    w.w = row ? htmlMapR2(k.w + extra) : k.w; w.h = row ? k.h : htmlMapR2(k.h + extra);
    w.layoutMode = row ? "HORIZONTAL" : "VERTICAL"; w.padding[side] = extra;
    w.sizingH = k.sizingH; w.sizingV = k.sizingV; w.children = [k];
    kids[kids.indexOf(k)] = w;
    c.stats.frames++; c.stats.auto_layout++;
    c.warn.push({ dom: k.dom, code: "margin-wrapper", msg: "margin " + extra + " px before this node needs a wrapper layer" });
  });
}

// T-105 follow-up (ADR-004 p. 3): size and constraints of an ABSOLUTE child. Declared px: FIXED; 100% or both opposite sides: FIXED +
// STRETCH (FILL does not exist for an ABSOLUTE child); undeclared: HUG for an Auto Layout frame or a one-line text, FIXED for a leaf.
function htmlMapAbsSize(k) {
  const d = (k._n && k._n.declared) || {};
  const set = (a) => d[a] !== undefined || d.inset !== undefined;
  const axis = (dim, lo, hi) => {
    const sz = htmlMapDsz(d[dim]);
    const px = sz && (sz.k === "px" || sz.k === "other");
    const l = set(lo), r = set(hi);
    if (px) return { s: "FIXED", c: r && !l ? "MAX" : "MIN" };
    if ((sz && sz.k === "fill") || (l && r)) return { s: "FIXED", c: "STRETCH" };
    const hug = (k.type === "FRAME" && k.layoutMode !== "NONE") || (k.type === "TEXT" && !(k._m && k._m.multi));
    return { s: hug ? "HUG" : "FIXED", c: r && !l ? "MAX" : "MIN" };
  };
  const h = axis("width", "left", "right"), v = axis("height", "top", "bottom");
  k.sizingH = h.s; k.sizingV = v.s; k.constraints = { h: h.c, v: v.c };
  if (k.type === "TEXT") k.text.autoResize = h.s === "HUG" ? "WIDTH_AND_HEIGHT" : "HEIGHT";
}

// Element -> list of plan nodes (empty: nothing; one: node; collapsed wrappers give their child instead).
function htmlMapNode(c, n, pc, isRoot) {
  if (n.tag === "#text") return [htmlMapTextNode(c, n, [n], null, pc, false)];
  if (n.tag === "svg" || n.tag === "img") {
    const p = htmlMapBase(c, n, n.tag === "svg" ? "SVG" : "IMAGE");
    if (n.tag === "svg") p.build.svg = n.svg || null; else { p.build.img = n.src || null; p.fills = [{ type: "IMAGE", hex: null, opacity: 1, var: null }]; }
    htmlMapPaintInto(p, n);
    if (n.tag === "svg") p.fills = [];
    htmlMapSetSize(p, n, pc);
    c.stats.leaf++;
    return [p];
  }
  const own = htmlMapCtx(n);
  const paint = htmlMapPaint(n);
  const pad = n.padding || [0, 0, 0, 0];
  const hasPad = pad.some((v) => v > 0);
  const contentBox = { x: n.rect.x + ((n.style.borderWidth || [0, 0, 0, 0])[3] || 0) + pad[3], w: n.rect.w - pad[1] - pad[3] };
  let kids;
  if (htmlMapTextual(c, n)) {
    const pieces = htmlMapPieces(c, n, []);
    if (!paint && !hasPad && !isRoot) {
      c.stats.collapsed++;
      return [htmlMapTextNode(c, n, pieces, null, pc, true)];
    }
    kids = [htmlMapTextNode(c, n, pieces, contentBox, own, false)];
  } else {
    kids = [];
    for (const k of c.kids[n.id] || []) {
      if (k.display === "inline" && k.tag !== "svg" && k.tag !== "img" && (c.kids[k.id] || []).length === 0) continue;
      kids.push.apply(kids, htmlMapNode(c, k, own, false));
    }
  }
  const dst = (n.declared && n.declared.height) || null;
  if (!isRoot && !paint && !hasPad) {
    if (kids.length === 1 && kids[0].positioning !== "ABSOLUTE" && htmlMapClose(kids[0], htmlMapBase(c, n, "FRAME"))) {
      c.stats.collapsed++;
      htmlMapSetSize(kids[0], n, pc);
      if (n.name && kids[0].type !== "TEXT") kids[0].name = n.name;
      return [kids[0]];
    }
    if (kids.length === 0 && !(n.rect.w > 0 && n.rect.h > 0)) { c.stats.collapsed++; return []; }
  }
  const P = htmlMapBase(c, n, "FRAME");
  htmlMapPaintInto(P, n);
  P.children = kids;
  // absolute: explicit position or overlap with an earlier flow sibling in both axes
  let flow = [];
  let abs = [];
  kids.forEach((k) => {
    const kn = k._n;
    if (kn.position === "absolute" || kn.position === "fixed" || flow.some((f) => htmlMapOverlaps(f, k))) abs.push(k); else flow.push(k);
  });
  // an image covering the whole container under overlays: the container takes the image as its fill
  if (abs.length && flow.length === 1 && flow[0].type === "IMAGE" && htmlMapClose(flow[0], P) && !P.fills.some((f) => f.type === "IMAGE")) {
    P.fills.push(flow[0].fills[0]);
    P.build.img = flow[0].build.img;
    P.children = kids = abs;
    flow = [];
  }
  // a single overlay in an otherwise empty container: Auto Layout with padding/alignment instead of ABSOLUTE
  let overlay = null;
  if (!flow.length && abs.length === 1 && !n.grid && !n.flex) {
    overlay = abs[0];
    abs = [];
    flow = [overlay];
    c.stats.overlay++;
  }
  abs.forEach((k) => {
    k.positioning = "ABSOLUTE"; htmlMapAbsSize(k);
    c.warn.push({ dom: k.dom, code: "absolute", msg: k._n.position ? "position " + k._n.position : "inferred from overlap with a sibling" });
  });
  if (n.grid) {
    P.layoutMode = "HORIZONTAL"; P.layoutWrap = "WRAP";
    P.itemSpacing = n.grid.colGap; P.counterAxisSpacing = n.grid.rowGap; P.padding = pad.slice();
    P.build.grid = n.grid.cols;
  } else if (n.flex) {
    P.layoutMode = n.flex.dir === "row" ? "HORIZONTAL" : "VERTICAL";
    P.itemSpacing = n.flex.gap; P.padding = pad.slice();
    P.primaryAxisAlignItems = n.flex.justify === "space-between" || n.flex.justify === "space-around" || n.flex.justify === "space-evenly" ? "SPACE_BETWEEN" : htmlMapAlign(n.flex.justify);
    P.counterAxisAlignItems = htmlMapAlign(n.flex.align);
    if (!n.flex.wrap && flow.length >= 2 && P.primaryAxisAlignItems !== "SPACE_BETWEEN") htmlMapFlexMargins(c, n, P, flow, kids);
    if (n.flex.wrap) {
      P.layoutWrap = "WRAP";
      const rows = [];
      flow.forEach((k) => { const r = rows[rows.length - 1]; if (r && Math.abs(r.y - k.y) < 2) r.b = Math.max(r.b, k.y + k.h); else rows.push({ y: k.y, b: k.y + k.h }); });
      const rg = rows.slice(1).map((r, i) => r.y - rows[i].b);
      P.counterAxisSpacing = rg.length ? htmlMapMode(rg) : n.flex.gap;
    }
  } else if (overlay) {
    htmlMapOverlay(n, P, overlay);
  } else if (flow.length) {
    htmlMapFlow(c, n, P, flow);
  } else P.padding = pad.slice();
  P.clips = !!n.overflow && /hidden|clip|auto|scroll/.test(n.overflow);
  if (P.layoutMode !== "NONE") c.stats.auto_layout++;
  c.stats.frames++;
  if (!isRoot) htmlMapSetSize(P, n, pc);
  // truncated text takes the container's width (it can only truncate against a width), unless the container hugs it
  kids.forEach((k) => {
    if (k.type === "TEXT" && k.text.maxLines && k.positioning !== "ABSOLUTE" && P.layoutMode !== "NONE") {
      k.sizingH = P.sizingH === "HUG" ? "FIXED" : "FILL"; k.text.autoResize = "HEIGHT";
    }
  });
  if (P.sizingH === "HUG") {
    kids.forEach((k) => {
      if (k.type === "TEXT" && k.sizingH === "FILL" && k.positioning !== "ABSOLUTE" && !k.text.maxLines) {
        k.sizingH = k._m.multi ? "FIXED" : "HUG";
        k.text.autoResize = k.sizingH === "HUG" ? "WIDTH_AND_HEIGHT" : "HEIGHT";
      }
    });
  }
  return [P];
}

function htmlMapClean(p, c) {
  delete p._n; delete p._m;
  c.count++;
  if (p.positioning === "ABSOLUTE") c.stats.absolute++;
  if (p.type === "TEXT") c.stats.text++;
  p.children.forEach((k) => htmlMapClean(k, c));
}

function htmlMap(tree, opts) {
  const c = { kids: {}, warn: [], count: 0, stats: { frames: 0, auto_layout: 0, absolute: 0, collapsed: 0, text: 0, leaf: 0, overlay: 0 } };
  const nodes = tree.nodes || [];
  let root = null;
  nodes.forEach((n) => { c.kids[n.id] = c.kids[n.id] || []; if (n.parent == null) root = n; else (c.kids[n.parent] = c.kids[n.parent] || []).push(n); });
  if (!root) throw new Error("htmlMap: tree has no root node");
  c.ox = root.rect.x; c.oy = root.rect.y;
  const out = htmlMapNode(c, root, { mode: "none", align: "normal" }, true);
  const r = out[0];
  r.x = 0; r.y = 0;
  r.w = (tree.viewport && tree.viewport.w) || root.rect.w;
  r.h = (tree.page && tree.page.h) || root.rect.h;
  r.sizingH = "FIXED"; r.sizingV = "FIXED"; r.positioning = "AUTO";
  htmlMapClean(r, c);
  return { root: r, count: c.count, warnings: c.warn, stats: c.stats };
}
