
// ==========================================================================
// Cheap reads — bridge.summarize / inspect / find / check
// --------------------------------------------------------------------------
// The most expensive thing an agent does through this bridge is a hand-written
// tree walk that returns every property of every node: tens of kilobytes that
// then ride along in every later turn of the conversation. These helpers
// return the same facts as short text or flat maps, and `check` turns
// "dump it and eyeball it" into a pass/fail list that is empty when all is well.
// ==========================================================================
function readRound(v) {
  return typeof v === "number" ? Math.round(v * 100) / 100 : v;
}

function readNode(ref) {
  if (!ref) return null;
  if (typeof ref === "string") return figma.getNodeById(ref.replace(/-/g, ":"));
  return ref;
}

function readHex(color, opacity) {
  if (!color) return null;
  const b = (n) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, "0").toUpperCase();
  const base = "#" + b(color.r) + b(color.g) + b(color.b);
  return typeof opacity === "number" && opacity < 1 ? base + "@" + readRound(opacity) : base;
}

// Paint list -> "#FFFFFF" | "#000000@0.5, IMAGE" | null; figma.mixed -> "mixed".
function readPaints(paints) {
  if (paints === figma.mixed) return "mixed";
  if (!Array.isArray(paints) || paints.length === 0) return null;
  const visible = paints.filter(p => p && p.visible !== false);
  if (visible.length === 0) return null;
  return visible.map(p => p.type === "SOLID" ? readHex(p.color, p.opacity) : p.type).join(", ");
}

function readLayout(n) {
  if (!("layoutMode" in n) || !n.layoutMode || n.layoutMode === "NONE") return null;
  const pads = [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft].map(readRound);
  const sizing = [n.layoutSizingHorizontal, n.layoutSizingVertical].filter(Boolean).map(x => String(x).toLowerCase()).join("/");
  return (n.layoutMode === "VERTICAL" ? "V" : n.layoutMode === "HORIZONTAL" ? "H" : n.layoutMode) +
    " gap" + readRound(n.itemSpacing) +
    (pads.every(p => p === pads[0]) ? " pad" + pads[0] : " pad" + pads.join(",")) +
    (sizing ? " " + sizing : "");
}

function readFont(n) {
  if (n.type !== "TEXT") return null;
  const f = n.fontName !== figma.mixed ? n.fontName : null;
  const size = n.fontSize !== figma.mixed ? readRound(n.fontSize) : "mixed";
  if (f) return f.family + "/" + f.style + " " + size;
  // mixed(Oswald/Medium+Oswald/Light) 16: which fonts, so a text edit does not have to read the ranges first
  let names = "";
  try {
    if (typeof n.getRangeAllFontNames === "function") {
      const all = n.getRangeAllFontNames(0, String(n.characters || "").length);
      names = all.slice(0, 3).map(x => x.family + "/" + x.style).join("+") + (all.length > 3 ? "+…" : "");
    }
  } catch (e) {}
  return "mixed" + (names ? "(" + names + ")" : "") + " " + size;
}

// The facts session 9672b93e had to fetch with ~20 extra props calls are put
// on the outline line itself, each only when it is not the default.

// AutoLayout alignment "a:start/center" (primary/counter); null for start/start.
const ALIGN_WORDS = { MIN: "start", MAX: "end", CENTER: "center", SPACE_BETWEEN: "between", BASELINE: "baseline" };
function readAlign(n) {
  if (!("layoutMode" in n) || !n.layoutMode || n.layoutMode === "NONE") return null;
  const p = n.primaryAxisAlignItems || "MIN", c = n.counterAxisAlignItems || "MIN";
  const wrap = n.layoutWrap === "WRAP" ? " wrap" : "";
  if (p === "MIN" && c === "MIN") return wrap ? wrap.trim() : null;
  return "a:" + (ALIGN_WORDS[p] || String(p).toLowerCase()) + "/" + (ALIGN_WORDS[c] || String(c).toLowerCase()) + wrap;
}

// "/1" or per side "/0,1,1,1" (top,right,bottom,left) when the weight is mixed.
function readStrokeWeight(n) {
  if (typeof n.strokeWeight === "number") return "/" + readRound(n.strokeWeight);
  if (n.strokeWeight === figma.mixed && typeof n.strokeTopWeight === "number") {
    return "/" + [n.strokeTopWeight, n.strokeRightWeight, n.strokeBottomWeight, n.strokeLeftWeight].map(readRound).join(",");
  }
  return "";
}

// "r8", or per corner "r0,0,3,3" (top-left, top-right, bottom-right, bottom-left).
function readRadius(n) {
  if (typeof n.cornerRadius === "number") return n.cornerRadius ? "r" + readRound(n.cornerRadius) : null;
  if (n.cornerRadius === figma.mixed && typeof n.topLeftRadius === "number") {
    return "r" + [n.topLeftRadius, n.topRightRadius, n.bottomRightRadius, n.bottomLeftRadius].map(readRound).join(",");
  }
  return null;
}

// "shadow:0,4/20 #2A2E35@0.15" | "inner:…" | "blur:8" | "bgblur:8".
function readEffects(n) {
  if (!Array.isArray(n.effects)) return null;
  const vis = n.effects.filter(e => e && e.visible !== false);
  if (!vis.length) return null;
  return vis.map(e => {
    if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
      const o = e.offset || { x: 0, y: 0 };
      return (e.type === "DROP_SHADOW" ? "shadow:" : "inner:") + readRound(o.x) + "," + readRound(o.y) + "/" + readRound(e.radius) +
        (e.spread ? "+" + readRound(e.spread) : "") + " " + readHex(e.color, e.color ? e.color.a : 1);
    }
    return (e.type === "BACKGROUND_BLUR" ? "bgblur:" : "blur:") + readRound(e.radius);
  }).join(", ");
}

// Sizing of a child inside an AutoLayout parent that has no layout of its own
// (TEXT, plain frames, instances): "fill/hug". Frames with layout carry it in [...].
function readChildSizing(n) {
  const p = n.parent;
  if (!p || !("layoutMode" in p) || !p.layoutMode || p.layoutMode === "NONE") return null;
  if ("layoutMode" in n && n.layoutMode && n.layoutMode !== "NONE") return null;
  const s = [n.layoutSizingHorizontal, n.layoutSizingVertical].filter(Boolean).map(x => String(x).toLowerCase()).join("/");
  return s || null;
}

// One node as one line: TYPE "name" #id WxH @x,y [layout a:align] size:fill/hug abs
// fill:… stroke:…/w r8 shadow:… "text…"
function describeNodeLine(n, textChars) {
  if (!n) return "MISSING";
  // A TEXT layer named after its own text (Figma's default) shows the text once:
  // the name doubled the line (h13 T1 outline: 3828 B, shrunk).
  const sameName = n.type === "TEXT" && n.name === String(n.characters || "");
  const parts = sameName ? [n.type, "#" + n.id] : [n.type, JSON.stringify(n.name), "#" + n.id];
  if (typeof n.width === "number") parts.push(readRound(n.width) + "x" + readRound(n.height));
  if (typeof n.x === "number" && n.type !== "PAGE") parts.push("@" + readRound(n.x) + "," + readRound(n.y));
  const layout = readLayout(n);
  if (layout) { const al = readAlign(n); parts.push("[" + layout + (al ? " " + al : "") + "]"); }
  const sizing = readChildSizing(n);
  if (sizing) parts.push("size:" + sizing);
  if (n.layoutPositioning === "ABSOLUTE") parts.push("abs");
  if ("fills" in n) { const f = readPaints(n.fills); if (f) parts.push("fill:" + f); }
  if ("strokes" in n) { const st = readPaints(n.strokes); if (st) parts.push("stroke:" + st + readStrokeWeight(n)); }
  const radius = readRadius(n);
  if (radius) parts.push(radius);
  const fx = readEffects(n);
  if (fx) parts.push(fx);
  if (typeof n.opacity === "number" && n.opacity < 1) parts.push("op" + readRound(n.opacity));
  if (n.visible === false) parts.push("hidden");
  if (n.type === "TEXT") {
    const chars = String(n.characters || "");
    const max = textChars || 40;
    parts.push(readFont(n));
    parts.push(JSON.stringify(chars.length > max ? chars.slice(0, max) + "…" : chars));
  }
  if (n.type === "INSTANCE") parts.push(readInstanceOf(n));
  return parts.join(" ");
}

// →"Set name" Status=Default,Size=M. A variant's own name is just its
// "Status=Default, Size=M" list, so the set's name is shown instead of repeating it.
function readInstanceOf(n) {
  let main = null;
  try { main = n.mainComponent; } catch (e) {}
  const variant = n.variantProperties ? Object.keys(n.variantProperties).map(k => k + "=" + n.variantProperties[k]).join(",") : "";
  let name = main ? main.name : "?";
  if (main && variant && main.parent && main.parent.type === "COMPONENT_SET") name = main.parent.name;
  return "→" + JSON.stringify(name) + (variant ? " " + variant : "");
}

// view:"map" — the cheapest useful line: TYPE "name" #id WxH @x,y children:N.
// No fills/fonts/text, so a whole page outline costs a fraction of the full view.
function describeMapLine(n) {
  if (!n) return "MISSING";
  const parts = [n.type, JSON.stringify(n.name), "#" + n.id];
  if (typeof n.width === "number") parts.push(readRound(n.width) + "x" + readRound(n.height));
  if (typeof n.x === "number" && n.type !== "PAGE") parts.push("@" + readRound(n.x) + "," + readRound(n.y));
  if ("children" in n && n.children && n.children.length) parts.push("children:" + n.children.length);
  return parts.join(" ");
}
