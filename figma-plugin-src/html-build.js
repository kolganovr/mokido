// html-build.js (T-077, F8.3): builds Figma nodes from a plan made by htmlMap (contract: planning/fable/F8_контракт.md).
// A part of the plugin scope (no import/export). Entry: async htmlBuild(plan, opts) -> report.
// opts: { parent (default figma.currentPage), x, y, name }.
// Figma order rules: create the frame, set layoutMode BEFORE children, layoutSizing FILL/HUG only AFTER appendChild into an
// auto layout parent, fonts loaded in one batch before any text write, text: characters -> setRange* -> textAutoResize last.
// One node failing never stops the build: it becomes a warning and the build goes on.

const HTML_BUILD_FALLBACK_FONT = { family: "Inter", style: "Regular" };
const HTML_BUILD_WEIGHTS = { 100: "Thin", 200: "Extra Light", 300: "Light", 400: "Regular", 500: "Medium", 600: "Semi Bold", 700: "Bold", 800: "Extra Bold", 900: "Black" };

function htmlBuildWarn(ctx, p, code, msg) {
  ctx.warnings.push({ id: p && p.id !== undefined ? p.id : null, dom: p && p.dom !== undefined ? p.dom : null, code, msg: String(msg).slice(0, 300) });
}
function htmlBuildErr(e) { return e && e.message ? e.message : String(e); }
// Runs fn; a throw becomes a warning (code) and returns false.
function htmlBuildTry(ctx, p, code, fn) {
  try { fn(); return true; } catch (e) { htmlBuildWarn(ctx, p, code, htmlBuildErr(e)); return false; }
}

// ---------- colors, paints ----------
function htmlBuildColor(str) {
  let s = String(str || "").trim().toLowerCase();
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (s === "white") return { r: 1, g: 1, b: 1, a: 1 };
  if (s === "black") return { r: 0, g: 0, b: 0, a: 1 };
  let m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+)(%?))?\s*\)$/.exec(s);
  if (m) return { r: +m[1] / 255, g: +m[2] / 255, b: +m[3] / 255, a: m[4] === undefined ? 1 : (m[5] ? +m[4] / 100 : +m[4]) };
  s = s.replace("#", "");
  if (s.length === 3 || s.length === 4) s = s.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(s)) return null;
  const h = (i) => parseInt(s.slice(i, i + 2), 16) / 255;
  return { r: h(0), g: h(2), b: h(4), a: s.length === 8 ? h(6) : 1 };
}
function htmlBuildSolid(hex, opacity) {
  const c = htmlBuildColor(hex) || { r: 0, g: 0, b: 0, a: 1 };
  return { type: "SOLID", color: { r: c.r, g: c.g, b: c.b }, opacity: (opacity === undefined || opacity === null ? 1 : opacity) * c.a, visible: true };
}
function htmlBuildSplit(s) {
  const out = []; let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++; else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
// css linear-gradient(...) -> GRADIENT_LINEAR paint. The gradient line (CSS angle, 0deg = up, clockwise) runs through the box
// center with length |w sin|+|h cos|; gradientTransform is the inverse of the matrix that maps the unit gradient space onto the node space
// (x axis = along the line, y axis = perpendicular, measured in pixels and then normalized by w, h so that isolines stay perpendicular).
function htmlBuildGradient(css, w, h, opacity) {
  const m = /linear-gradient\((.*)\)\s*$/i.exec(String(css || "").trim());
  if (!m || !(w > 0) || !(h > 0)) return null;
  const parts = htmlBuildSplit(m[1]);
  let dx = 0, dy = 1; // default: to bottom (180deg)
  const first = parts[0] || "";
  const ang = /^(-?[\d.]+)(deg|turn|rad|grad)$/.exec(first);
  if (ang) {
    const k = { deg: 1, turn: 360, rad: 180 / Math.PI, grad: 0.9 }[ang[2]];
    const t = (+ang[1] * k * Math.PI) / 180;
    dx = Math.sin(t); dy = -Math.cos(t); parts.shift();
  } else if (/^to\s/.test(first)) {
    const sx = /right/.test(first) ? 1 : /left/.test(first) ? -1 : 0, sy = /bottom/.test(first) ? 1 : /top/.test(first) ? -1 : 0;
    if (sx && sy) { dx = sx * h; dy = sy * w; const n = Math.hypot(dx, dy); dx /= n; dy /= n; } else { dx = sx; dy = sy; }
    parts.shift();
  }
  const stops = [];
  for (const part of parts) {
    const sm = /^(.*?)(?:\s+(-?[\d.]+)%)?$/.exec(part);
    const c = htmlBuildColor(sm[1]);
    if (!c) return null;
    stops.push({ position: sm[2] === undefined ? null : Math.max(0, Math.min(1, +sm[2] / 100)), color: c });
  }
  if (stops.length < 2) return null;
  if (stops[0].position === null) stops[0].position = 0;
  if (stops[stops.length - 1].position === null) stops[stops.length - 1].position = 1;
  for (let i = 1; i < stops.length - 1; i++) {
    if (stops[i].position !== null) continue;
    let j = i; while (stops[j].position === null) j++;
    const a = stops[i - 1].position, b = stops[j].position;
    for (let k = i; k < j; k++) stops[k].position = a + ((b - a) * (k - i + 1)) / (j - i + 1);
  }
  const L = Math.abs(w * dx) + Math.abs(h * dy);
  const p0 = [(w / 2 - (dx * L) / 2) / w, (h / 2 - (dy * L) / 2) / h];
  const p1 = [(w / 2 + (dx * L) / 2) / w, (h / 2 + (dy * L) / 2) / h];
  const p2 = [p0[0] + (-dy * L) / w, p0[1] + (dx * L) / h];
  const ax = p1[0] - p0[0], ay = p1[1] - p0[1], bx = p2[0] - p0[0], by = p2[1] - p0[1];
  const det = ax * by - bx * ay;
  if (!det) return null;
  const i00 = by / det, i01 = -bx / det, i10 = -ay / det, i11 = ax / det;
  return {
    type: "GRADIENT_LINEAR", opacity: opacity === undefined || opacity === null ? 1 : opacity, visible: true,
    gradientTransform: [[i00, i01, -(i00 * p0[0] + i01 * p0[1])], [i10, i11, -(i10 * p0[0] + i11 * p0[1])]],
    gradientStops: stops.map((s) => ({ position: s.position, color: s.color }))
  };
}
function htmlBuildPaints(list, p, ctx) {
  const out = [];
  const grads = [].concat((p.build && p.build.gradient) || []);
  let gi = 0;
  for (const f of list || []) {
    if (f.type === "SOLID") out.push(htmlBuildSolid(f.hex, f.opacity));
    else if (f.type === "IMAGE") out.push(htmlBuildImagePaint(p, ctx));
    else if (f.type === "GRADIENT_LINEAR") {
      const g = htmlBuildGradient(grads[gi++], p.w, p.h, f.opacity);
      if (g) out.push(g);
      else { htmlBuildWarn(ctx, p, "gradient_parse", "cannot parse gradient, first stop color used"); out.push(htmlBuildSolid(f.hex, f.opacity)); }
    }
  }
  return typeof htmlDsPaints === "function" ? htmlDsPaints(list || [], out, p, ctx) : out;
}

// ---------- fonts ----------
function htmlBuildStyleName(s) { return typeof s === "number" || /^\d+$/.test(String(s)) ? HTML_BUILD_WEIGHTS[s] || "Regular" : s || "Regular"; }
function htmlBuildCollectFonts(p, keys) {
  if (p.type === "TEXT" && p.text) {
    const fam = p.text.fontFamily || "Inter";
    keys.set(fam + "|" + htmlBuildStyleName(p.text.fontStyle), { family: fam, style: htmlBuildStyleName(p.text.fontStyle), dom: p });
    for (const r of p.text.ranges || []) if (r.fontStyle) keys.set(fam + "|" + htmlBuildStyleName(r.fontStyle), { family: fam, style: htmlBuildStyleName(r.fontStyle), dom: p });
  }
  for (const c of p.children || []) htmlBuildCollectFonts(c, keys);
}
function htmlBuildLoadOne(font) {
  return typeof loadFontOnce === "function" ? loadFontOnce(font) : figma.loadFontAsync(font);
}
// One batch; a font that fails to load maps to Inter Regular (warning font_fallback).
async function htmlBuildLoadFonts(root, ctx) {
  const keys = new Map();
  htmlBuildCollectFonts(root, keys);
  ctx.fonts = new Map();
  const fb = HTML_BUILD_FALLBACK_FONT;
  if (!keys.has(fb.family + "|" + fb.style)) keys.set(fb.family + "|" + fb.style, { family: fb.family, style: fb.style, dom: null });
  await Promise.all([...keys.entries()].map(async ([key, f]) => {
    try { await htmlBuildLoadOne({ family: f.family, style: f.style }); ctx.fonts.set(key, { family: f.family, style: f.style }); }
    catch (e) {
      ctx.fonts.set(key, HTML_BUILD_FALLBACK_FONT);
      htmlBuildWarn(ctx, f.dom, "font_fallback", f.family + " " + f.style + " not available, Inter Regular used");
    }
  }));
}
function htmlBuildFont(ctx, family, style) {
  return ctx.fonts.get((family || "Inter") + "|" + htmlBuildStyleName(style)) || HTML_BUILD_FALLBACK_FONT;
}

// ---------- node properties ----------
function htmlBuildEffects(list) {
  return (list || []).map((e) => {
    const c = htmlBuildColor(e.hex) || { r: 0, g: 0, b: 0, a: 0.25 };
    const off = Array.isArray(e.offset) ? { x: e.offset[0], y: e.offset[1] } : e.offset || { x: 0, y: 0 };
    return { type: e.type, color: { r: c.r, g: c.g, b: c.b, a: c.a * (e.opacity === undefined || e.opacity === null ? 1 : e.opacity) }, offset: { x: off.x || 0, y: off.y || 0 }, radius: e.radius || 0, spread: e.spread || 0, visible: true, blendMode: "NORMAL" };
  });
}
function htmlBuildStyle(n, p, ctx) {
  const t = p.type;
  if (p.name) n.name = String(p.name);
  if (p.visible === false) n.visible = false;
  if (typeof p.opacity === "number" && p.opacity !== 1) n.opacity = p.opacity;
  if (t !== "SVG" && t !== "IMAGE") htmlBuildTry(ctx, p, "fills_error", () => { n.fills = htmlBuildPaints(p.fills, p, ctx); });
  if (t === "SVG" || t === "TEXT") {
    // svg keeps its own vector paints; text strokes are not modeled
  } else if (p.strokes && p.strokes.length) {
    htmlBuildTry(ctx, p, "stroke_error", () => {
      n.strokes = htmlBuildPaints(p.strokes, p, ctx);
      n.strokeAlign = "INSIDE";
      const s = p.build && p.build.strokeSides;
      if (s && s.length === 4 && !(s[0] === s[1] && s[1] === s[2] && s[2] === s[3])) {
        n.strokeTopWeight = s[0]; n.strokeRightWeight = s[1]; n.strokeBottomWeight = s[2]; n.strokeLeftWeight = s[3];
      } else n.strokeWeight = p.strokeWeight || (s && s[0]) || 1;
      // css padding sits inside the border, so the stroke has to count in the layout
      if (t === "FRAME" && p.layoutMode && p.layoutMode !== "NONE") n.strokesIncludedInLayout = true;
    });
  }
  if ((t === "FRAME" || t === "RECTANGLE" || t === "IMAGE") && p.radius) {
    const r = p.radius;
    htmlBuildTry(ctx, p, "radius_error", () => {
      if (r.every((v) => v === r[0])) { if (r[0]) n.cornerRadius = r[0]; }
      else { n.topLeftRadius = r[0]; n.topRightRadius = r[1]; n.bottomRightRadius = r[2]; n.bottomLeftRadius = r[3]; }
    });
  }
  if (p.effects && p.effects.length) htmlBuildTry(ctx, p, "effects_error", () => { n.effects = htmlBuildEffects(p.effects); });
  if (t === "FRAME") n.clipsContent = !!p.clips;
}
function htmlBuildFrameLayout(n, p, ctx) {
  const m = p.layoutMode;
  if (m !== "HORIZONTAL" && m !== "VERTICAL") { n.layoutMode = "NONE"; return; }
  n.layoutMode = m;
  htmlBuildTry(ctx, p, "layout_error", () => {
    if (p.layoutWrap === "WRAP") {
      if (m === "HORIZONTAL") { n.layoutWrap = "WRAP"; n.counterAxisSpacing = p.counterAxisSpacing || 0; }
      else htmlBuildWarn(ctx, p, "wrap_unsupported", "wrap is horizontal only, ignored for a vertical container");
    }
    n.itemSpacing = p.itemSpacing || 0;
    const pd = p.padding || [0, 0, 0, 0];
    n.paddingTop = pd[0]; n.paddingRight = pd[1]; n.paddingBottom = pd[2]; n.paddingLeft = pd[3];
    n.primaryAxisAlignItems = p.primaryAxisAlignItems || "MIN";
    let ca = p.counterAxisAlignItems || "MIN";
    if (ca === "BASELINE" && m !== "HORIZONTAL") ca = "MIN";
    n.counterAxisAlignItems = ca;
  });
}
function htmlBuildSizeModes(n, p, ctx) {
  if (p.layoutMode !== "HORIZONTAL" && p.layoutMode !== "VERTICAL") return;
  const hugH = p.sizingH === "HUG", hugV = p.sizingV === "HUG";
  const horiz = p.layoutMode === "HORIZONTAL";
  htmlBuildTry(ctx, p, "layout_error", () => {
    n.primaryAxisSizingMode = (horiz ? hugH : hugV) ? "AUTO" : "FIXED";
    n.counterAxisSizingMode = (horiz ? hugV : hugH) ? "AUTO" : "FIXED";
  });
}

async function htmlBuildText(n, p, ctx) {
  const t = p.text || {};
  const base = htmlBuildFont(ctx, t.fontFamily, t.fontStyle);
  n.fontName = base;
  n.characters = String(t.characters === undefined ? "" : t.characters);
  const len = n.characters.length;
  if (t.fontSize) n.fontSize = t.fontSize;
  htmlBuildTry(ctx, p, "text_error", () => {
    n.lineHeight = typeof t.lineHeight === "number" ? { unit: "PIXELS", value: t.lineHeight } : { unit: "AUTO" };
    if (t.align) n.textAlignHorizontal = t.align;
  });
  if (typeof htmlDsTextStyle === "function") await htmlDsTextStyle(n, p, ctx);
  for (const r of t.ranges || []) {
    const s = Math.max(0, r.start | 0), e = Math.min(len, r.end | 0);
    if (!(e > s)) continue;
    htmlBuildTry(ctx, p, "range_error", () => {
      if (r.fontStyle) n.setRangeFontName(s, e, htmlBuildFont(ctx, t.fontFamily, r.fontStyle));
      if (r.fontSize) n.setRangeFontSize(s, e, r.fontSize);
      if (r.hex) n.setRangeFills(s, e, htmlBuildPaints([{ type: "SOLID", hex: r.hex, opacity: r.opacity, var: r.var }], p, ctx));
      if (r.decoration && r.decoration !== "NONE") n.setRangeTextDecoration(s, e, r.decoration);
    });
  }
}
function htmlBuildDecodeSvg(m) {
  if (m[2]) { const bin = String(figma.base64Decode ? Array.from(figma.base64Decode(m[3]), (c) => String.fromCharCode(c)).join("") : ""); return decodeURIComponent(escape(bin)); }
  return decodeURIComponent(m[3]);
}
// IMAGE paint from p.build.img. Whatever cannot become one (not a data: URI, createImage fails) is a grey solid plus a warning:
// a container that took the image as its fill must never end up empty (T-103).
function htmlBuildImagePaint(p, ctx) {
  const src = String((p.build && p.build.img) || "");
  const m = /^data:([^,]*?)(;base64)?,([\s\S]*)$/i.exec(src);
  if (m && m[2]) {
    try {
      const img = figma.createImage(figma.base64Decode(m[3]));
      return { type: "IMAGE", imageHash: img.hash, scaleMode: "FILL", visible: true };
    } catch (e) { htmlBuildWarn(ctx, p, "img_failed", "createImage: " + htmlBuildErr(e)); }
  } else htmlBuildWarn(ctx, p, "img_placeholder", "image is not a data: URI, placeholder used: " + src.slice(0, 80));
  return htmlBuildSolid("#d9d9d9", 1);
}
// img leaf: svg data URI -> vector; anything else -> rectangle with the image paint (or the grey placeholder).
function htmlBuildImage(p, ctx) {
  const src = String((p.build && p.build.img) || "");
  const m = /^data:([^,]*?)(;base64)?,([\s\S]*)$/i.exec(src);
  if (m && /svg/i.test(m[1])) {
    try { return figma.createNodeFromSvg(htmlBuildDecodeSvg(m)); } catch (e) { htmlBuildWarn(ctx, p, "img_failed", "svg data uri: " + htmlBuildErr(e)); }
  }
  const r = figma.createRectangle();
  r.fills = [htmlBuildImagePaint(p, ctx)];
  return r;
}

function htmlBuildCreate(p, ctx) {
  let n;
  if (p.type === "TEXT") { n = figma.createText(); }
  else if (p.type === "SVG") {
    try { n = figma.createNodeFromSvg(String((p.build && p.build.svg) || "")); }
    catch (e) { htmlBuildWarn(ctx, p, "svg_failed", htmlBuildErr(e)); n = figma.createRectangle(); n.fills = [htmlBuildSolid("#d9d9d9", 1)]; }
  } else if (p.type === "IMAGE") n = htmlBuildImage(p, ctx);
  else if (p.type === "RECTANGLE") n = figma.createRectangle();
  else n = figma.createFrame();
  return n;
}

function htmlBuildResize(n, p) { n.resize(Math.max(p.w || 0, 0.01), Math.max(p.h || 0, 0.01)); }

// Parent-dependent part: runs AFTER appendChild (FILL / HUG need the auto layout parent), before the children exist.
function htmlBuildPlace(e, par, ctx) {
  const p = e.p, n = e.n;
  const parAL = par && par.p.layoutMode && par.p.layoutMode !== "NONE";
  if (!par) return;
  if (parAL && p.positioning !== "ABSOLUTE") {
    let h = p.sizingH, v = p.sizingV;
    const canHug = p.type === "TEXT" || (p.type === "FRAME" && p.layoutMode && p.layoutMode !== "NONE") || (e.inst && n.layoutMode && n.layoutMode !== "NONE");
    if (!canHug) {
      if (h === "HUG" || v === "HUG") htmlBuildWarn(ctx, p, "sizing_coerced", "HUG not possible for " + p.type + ", FIXED used");
      if (h === "HUG") h = "FIXED"; if (v === "HUG") v = "FIXED";
    }
    htmlBuildTry(ctx, p, "sizing_error", () => { if (h && h !== "FIXED") n.layoutSizingHorizontal = h; });
    htmlBuildTry(ctx, p, "sizing_error", () => { if (v && v !== "FIXED") n.layoutSizingVertical = v; });
  } else {
    if (parAL) htmlBuildTry(ctx, p, "absolute_error", () => { n.layoutPositioning = "ABSOLUTE"; });
    if (parAL && p.constraints) htmlBuildTry(ctx, p, "constraints_error", () => { n.constraints = { horizontal: p.constraints.h, vertical: p.constraints.v }; });
    htmlBuildTry(ctx, p, "position_error", () => { n.x = p.x - par.p.x; n.y = p.y - par.p.y; });
  }
}

// 9.2: an element with data-component becomes an instance, its children are not built; no component found: plain frames (warning).
async function htmlBuildInstance(p, par, ctx, parentFigma, isRoot) {
  let n = null;
  try { n = await htmlInstBuild(p, ctx); } catch (err) { htmlBuildWarn(ctx, p, "instance_failed", htmlBuildErr(err)); }
  if (!n) return null;
  try { parentFigma.appendChild(n); } catch (err) { htmlBuildWarn(ctx, p, "node_error", htmlBuildErr(err)); try { n.remove(); } catch (e2) { /* nothing to clean */ } return null; }
  const e = { p: Object.assign({}, p, { type: "INSTANCE", children: [] }), n, par, kids: [], inst: true };
  ctx.entries.push(e);
  ctx.created++; ctx.instances++;
  if (!isRoot) htmlBuildPlace(e, par, ctx);
  return e;
}
async function htmlBuildNode(p, par, ctx, parentFigma, isRoot) {
  let n;
  if (p.component && typeof htmlInstBuild === "function") { const ie = await htmlBuildInstance(p, par, ctx, parentFigma, isRoot); if (ie) return ie; }
  try {
    n = htmlBuildCreate(p, ctx);
    if (p.type === "TEXT") await htmlBuildText(n, p, ctx);
    if (p.type === "FRAME") htmlBuildFrameLayout(n, p, ctx);
    htmlBuildStyle(n, p, ctx);
    htmlBuildTry(ctx, p, "resize_error", () => htmlBuildResize(n, p));
    if (p.type === "FRAME") htmlBuildSizeModes(n, p, ctx);
    if (typeof htmlDsBindNode === "function") htmlDsBindNode(n, p, ctx);
    if (p.type === "TEXT") htmlBuildTry(ctx, p, "text_error", () => { n.textAutoResize = (p.text && p.text.autoResize) || "WIDTH_AND_HEIGHT"; });
    // T-103: truncation (Plugin API: textTruncation "DISABLED" | "ENDING", maxLines >= 1 | null; set after the auto-resize mode)
    if (p.type === "TEXT" && p.text && p.text.maxLines) htmlBuildTry(ctx, p, "text_error", () => { n.textTruncation = "ENDING"; n.maxLines = p.text.maxLines; });
    parentFigma.appendChild(n);
  } catch (err) {
    htmlBuildWarn(ctx, p, "node_error", htmlBuildErr(err));
    try { if (n && !n.parent) n.remove(); } catch (e2) { /* nothing to clean */ }
    return null;
  }
  const e = { p, n, par, kids: [] };
  ctx.entries.push(e);
  ctx.created++;
  if (p.layoutMode === "HORIZONTAL" || p.layoutMode === "VERTICAL") ctx.al++;
  if (!isRoot) htmlBuildPlace(e, par, ctx);
  for (const c of p.children || []) {
    const ce = await htmlBuildNode(c, e, ctx, n, false);
    if (ce) e.kids.push(ce);
  }
  return e;
}

// ---------- self check ----------
function htmlBuildDelta(e, org) {
  let b = null;
  try { b = e.n.absoluteBoundingBox; } catch (x) { b = null; }
  if (!b) return null;
  const p = e.p;
  return Math.max(Math.abs(b.x - org.x - p.x), Math.abs(b.y - org.y - p.y), Math.abs(b.width - p.w), Math.abs(b.height - p.h));
}
function htmlBuildBox(e) { try { return e.n.absoluteBoundingBox || null; } catch (x) { return null; } }
// T-104: size and position are judged apart, and the position against the node's ACTUAL parent, so one shifted node
// does not drag its ancestors with it. delta/ok (absolute, 1 px) only feed the report.
const HTML_BUILD_TOL = 2;
function htmlBuildMeasure(ctx, org) {
  for (const e of ctx.entries) {
    e.delta = htmlBuildDelta(e, org); e.ok = e.delta === null || e.delta <= 1;
    const b = htmlBuildBox(e), p = e.p, pb = e.par ? htmlBuildBox(e.par) : org;
    e.dSize = b ? Math.max(Math.abs(b.width - p.w), Math.abs(b.height - p.h)) : 0;
    const ex = e.par ? p.x - e.par.p.x : p.x, ey = e.par ? p.y - e.par.p.y : p.y;
    e.dPos = b && pb ? Math.max(Math.abs(b.x - pb.x - ex), Math.abs(b.y - pb.y - ey)) : 0;
  }
}
// A container's own size is wrong: HUG becomes FIXED at the plan size (the root is always fixed).
function htmlBuildFixSelf(e, ctx) {
  const p = e.p;
  e.fixed = true;
  if (e.par && p.sizingH !== "HUG" && p.sizingV !== "HUG") return false;
  htmlBuildTry(ctx, p, "fallback_error", () => {
    if (e.par) {
      if (p.sizingH === "HUG") e.n.layoutSizingHorizontal = "FIXED";
      if (p.sizingV === "HUG") e.n.layoutSizingVertical = "FIXED";
    } else { e.n.primaryAxisSizingMode = "FIXED"; e.n.counterAxisSizingMode = "FIXED"; }
    htmlBuildResize(e.n, p);
  });
  return true;
}
// A leaf with a wrong size is fixed in place: text gets the DOM width (height follows its lines), anything else the DOM box.
// One-line text is left alone: its width is the font's, a fixed browser width would only wrap it.
function htmlBuildFixLeaf(e, ctx) {
  const p = e.p, n = e.n;
  e.fixed = true;
  if (p.type === "TEXT" && htmlBuildLines(p) === 1) return false;
  let fh = false, fv = false;
  try { fh = n.layoutSizingHorizontal === "FILL"; fv = n.layoutSizingVertical === "FILL"; } catch (x) { /* not in a flow */ }
  if (fh && fv) return false;
  htmlBuildTry(ctx, p, "fallback_error", () => {
    if (!fh && n.layoutSizingHorizontal === "HUG") n.layoutSizingHorizontal = "FIXED";
    if (p.type === "TEXT") {
      n.textAutoResize = "HEIGHT";
      n.resize(Math.max(fh ? n.width : p.w, 0.01), Math.max(n.height, 0.01));
      n.textAutoResize = "HEIGHT";
    } else {
      if (!fv && n.layoutSizingVertical === "HUG") n.layoutSizingVertical = "FIXED";
      n.resize(Math.max(fh ? n.width : p.w, 0.01), Math.max(fv ? n.height : p.h, 0.01));
    }
  });
  return true;
}
function htmlBuildApplyFallback(e, ctx) {
  const p = e.p;
  htmlBuildFixSelf(e, ctx);
  for (const k of e.kids) {
    htmlBuildTry(ctx, k.p, "fallback_error", () => {
      k.n.layoutPositioning = "ABSOLUTE";
      // one-line text keeps hugging: a fixed browser width wraps it in Figma, whose Inter runs a bit wider (T-105)
      if (k.p.type === "TEXT" && htmlBuildLines(k.p) === 1 && !(k.p.text && k.p.text.maxLines)) htmlBuildHugText(k);
      else if (!k.inst) htmlBuildResize(k.n, k.p);
      k.n.x = k.p.x - p.x + htmlBuildAlignShift(k); k.n.y = k.p.y - p.y;
    });
  }
  e.fb = true;
}

// ---------- text wrap guard (T-105) ----------
// Lines the text had in the browser: plan text.lines (mapper), else box height / line height.
function htmlBuildLines(p) {
  const t = p.text || {};
  if (t.lines) return t.lines;
  const lh = typeof t.lineHeight === "number" ? t.lineHeight : (t.fontSize || 12) * 1.2;
  return Math.max(1, Math.round((p.h || lh) / lh));
}
function htmlBuildFigmaLines(e) {
  const t = e.p.text || {};
  const lh = typeof t.lineHeight === "number" ? t.lineHeight : (t.fontSize || 12) * 1.2;
  let h = 0;
  try { h = e.n.height; } catch (x) { return null; }
  return Math.max(1, Math.round(h / lh));
}
function htmlBuildHugText(e) {
  e.n.textAutoResize = "WIDTH_AND_HEIGHT";
}
// A hugging text grows from its left edge; keep the right edge (RIGHT) or the middle (CENTER) where the browser had it.
function htmlBuildAlignShift(e) {
  if (e.p.type !== "TEXT") return 0;
  const a = e.p.text && e.p.text.align;
  if (a !== "RIGHT" && a !== "CENTER") return 0;
  let w = e.p.w;
  try { w = e.n.width; } catch (x) { /* plan width */ }
  return (e.p.w - w) * (a === "RIGHT" ? 1 : 0.5);
}
// Every text must keep the browser's line count. One-line text that wrapped goes back to hug; multi-line text that got an
// extra line is widened by up to 4%. What still wraps is counted (report.text_wrapped) and warned, never silent.
function htmlBuildTextGuard(ctx, report) {
  for (const e of ctx.entries) {
    if (e.p.type !== "TEXT") continue;
    const want = htmlBuildLines(e.p);
    let got = htmlBuildFigmaLines(e);
    if (got === null || got <= want) continue;
    htmlBuildTry(ctx, e.p, "text_error", () => {
      const inFlow = e.par && e.par.p.layoutMode && e.par.p.layoutMode !== "NONE" && e.n.layoutPositioning !== "ABSOLUTE";
      const align = (e.p.text && e.p.text.align) || "LEFT";
      if (want === 1 && inFlow && e.n.layoutSizingHorizontal === "FILL" && align !== "LEFT") return; // hug would lose the alignment: counted below
      if (want === 1) {
        if (inFlow) e.n.layoutSizingHorizontal = "HUG";
        htmlBuildHugText(e);
        if (!inFlow && e.par) e.n.x = e.p.x - e.par.p.x + htmlBuildAlignShift(e);
      } else {
        if (inFlow && e.n.layoutSizingHorizontal === "FILL") e.n.layoutSizingHorizontal = "FIXED";
        e.n.textAutoResize = "HEIGHT";
        for (const k of [1.01, 1.02, 1.04]) {
          e.n.resize(e.p.w * k, Math.max(e.n.height, 0.01));
          e.n.textAutoResize = "HEIGHT";
          if (htmlBuildFigmaLines(e) <= want) break;
        }
      }
    });
    got = htmlBuildFigmaLines(e);
    if (got !== null && got <= want) report.text_fixed++;
    else {
      report.text_wrapped++;
      htmlBuildWarn(ctx, e.p, "text_wrapped", "text wraps into " + got + " lines, browser had " + want + ": \"" + String((e.p.text && e.p.text.characters) || "").slice(0, 30) + "\"");
    }
  }
}
// Size is fine when within 2 px, or when a fix was already tried (it must not loop).
const htmlBuildSizeOk = (e) => e.dSize <= HTML_BUILD_TOL || !!e.fixed || !!e.inst;
function htmlBuildSelfCheck(root, ctx, report) {
  let org = { x: 0, y: 0 };
  try { const b = root.n.absoluteBoundingBox; if (b) org = { x: b.x, y: b.y }; } catch (e) { /* keep 0,0 */ }
  const rev = ctx.entries.slice().reverse(); // children before parents
  for (let round = 0; round < 8; round++) {
    htmlBuildMeasure(ctx, org);
    let changed = false;
    // 1) leaves with a wrong size are fixed in place; 2) containers whose children are right but whose own size is not;
    // 3) only then a container whose children have the right sizes but the wrong positions: its in-flow children go ABSOLUTE.
    for (const e of rev) if (!e.kids.length && !e.fixed && !e.inst && e.dSize > HTML_BUILD_TOL && htmlBuildFixLeaf(e, ctx)) changed = true;
    if (changed) continue;
    for (const e of rev) if (e.kids.length && !e.fixed && e.dSize > HTML_BUILD_TOL && e.kids.every(htmlBuildSizeOk) && htmlBuildFixSelf(e, ctx)) changed = true;
    if (changed) continue;
    for (const e of rev) {
      if (e.p.type !== "FRAME" || !e.kids.length || e.fb || e.p.layoutMode === "NONE") continue;
      const flow = e.kids.filter((k) => k.p.positioning !== "ABSOLUTE");
      if (!flow.length || !flow.every(htmlBuildSizeOk) || !flow.some((k) => k.dPos > HTML_BUILD_TOL)) continue;
      htmlBuildWarn(ctx, e.p, "absolute_fallback", "children positions off (max " + Math.round(Math.max(...flow.map((k) => k.dPos)) * 100) / 100 + " px), placed ABSOLUTE by plan boxes");
      htmlBuildApplyFallback(e, ctx);
      report.absolute_fallback++;
      changed = true;
    }
    if (!changed) break;
  }
  htmlBuildTextGuard(ctx, report);
  htmlBuildMeasure(ctx, org);
  for (const e of ctx.entries) {
    if (e.delta === null) continue;
    report.box_ok.den++;
    if (e.inst) { // rule 7: an instance is never stretched to the DOM box, a difference is only reported
      if (e.ok) report.box_ok.num++;
      else if (e.dSize > HTML_BUILD_TOL) { const b = htmlBuildBox(e); htmlDsWarnAdd(ctx.dsw, e.p, "instance_size_differs", e.p.component.name, "css " + e.p.w + "x" + e.p.h + " figma " + (b ? Math.round(b.width * 10) / 10 + "x" + Math.round(b.height * 10) / 10 : "?")); }
    } else if (e.ok) report.box_ok.num++;
    else htmlBuildWarn(ctx, e.p, "box_mismatch", "box differs from plan by " + Math.round(e.delta * 100) / 100 + " px");
  }
}

async function htmlBuild(plan, opts) {
  opts = opts || {};
  const ctx = { warnings: [], created: 0, al: 0, entries: [], fonts: new Map(), ds: null, dsw: new Map(), bound: 0, instances: 0, textStyles: 0 };
  const report = { root_id: null, created: 0, auto_layout: 0, absolute_fallback: 0, text_fixed: 0, text_wrapped: 0, box_ok: { num: 0, den: 0 }, warnings: ctx.warnings };
  if (!plan || !plan.root) { htmlBuildWarn(ctx, null, "no_plan", "plan.root is missing"); return report; }
  await htmlBuildLoadFonts(plan.root, ctx);
  if (typeof htmlDsIndex === "function") ctx.ds = await htmlDsIndex();
  const parent = opts.parent || figma.currentPage;
  const root = await htmlBuildNode(plan.root, null, ctx, parent, true);
  if (!root) return report;
  htmlBuildTry(ctx, plan.root, "position_error", () => {
    root.n.x = typeof opts.x === "number" ? opts.x : 0;
    root.n.y = typeof opts.y === "number" ? opts.y : 0;
    if (opts.name) root.n.name = String(opts.name);
  });
  report.root_id = root.n.id;
  htmlBuildSelfCheck(root, ctx, report);
  report.created = ctx.created;
  report.auto_layout = ctx.al;
  report.bound = ctx.bound;
  report.instances = ctx.instances;
  report.text_styles = ctx.textStyles;
  if (typeof htmlDsWarnFlush === "function") htmlDsWarnFlush(ctx.dsw, ctx.warnings);
  return report;
}
