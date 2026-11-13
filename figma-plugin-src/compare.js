
// ---------------------------------------------------------------------------
// bridge.compare(ref, targets) — "make these like that one" in one read.
// Session 9672b93e spent ~60 figma_inspect calls diffing a correct dropdown
// against six broken copies prop by prop. This walks the reference and each
// target in parallel (children matched by type+name, then by position) and
// lists only what differs. x/y/width and text content are not compared:
// breakpoints legitimately differ there. Height is (h13 T1: Select 40 vs 44 was
// the one fix the diff did not show, so the model read props after it).
// ---------------------------------------------------------------------------
// Stroke weight per side "top,right,bottom,left" (uniform weight repeated).
function strokeSides(n) {
  if (typeof n.strokeTopWeight === "number" && (n.strokeWeight === figma.mixed || typeof n.strokeWeight !== "number")) {
    return [n.strokeTopWeight, n.strokeRightWeight, n.strokeBottomWeight, n.strokeLeftWeight].map(readRound).join(",");
  }
  if (typeof n.strokeWeight === "number") { const w = readRound(n.strokeWeight); return [w, w, w, w].join(","); }
  return null;
}

// Height only when it is set by hand: a HUG/FILL height follows the content or
// the parent and legitimately differs between breakpoints (review 4.2.7 #48:
// cards 96/120 on Desktop/Mobile -> "height 120 (ref 96)" and a fixed resize).
function fixedHeight(n) {
  if (n.type === "TEXT" || typeof n.height !== "number") return undefined;
  if (n.layoutSizingVertical === "HUG" || n.layoutSizingVertical === "FILL") return undefined;
  return readRound(n.height);
}

function shapeOf(n) {
  const s = { type: n.type };
  const h = fixedHeight(n);
  if (h !== undefined) s.height = h;
  const layout = readLayout(n);
  if (layout) s.layout = layout;
  const al = readAlign(n);
  if (al) s.align = al;
  const sizing = readChildSizing(n);
  if (sizing) s.size = sizing;
  if (n.layoutPositioning === "ABSOLUTE") s.abs = "yes";
  if ("fills" in n) { const f = readPaints(n.fills); if (f) s.fill = f; }
  if ("strokes" in n) {
    const st = readPaints(n.strokes);
    if (st) {
      s.stroke = st;
      const sides = strokeSides(n);
      if (sides) s["stroke sides"] = sides;
      if (n.strokeAlign) s.strokeAlign = n.strokeAlign;
    }
  }
  const r = readRadius(n);
  if (r) s.radius = r;
  const fx = readEffects(n);
  if (fx) s.effects = fx;
  if (typeof n.opacity === "number" && n.opacity < 1) s.opacity = readRound(n.opacity);
  if (n.visible === false) s.hidden = "yes";
  if (n.clipsContent === true) s.clip = "yes";
  if (n.type === "TEXT") s.font = readFont(n);
  if (n.type === "INSTANCE") s.component = readInstanceOf(n).slice(1);
  return s;
}

// Figma's default layer names ("Frame 2131329763") differ between copies by design.
const AUTO_NAME_RE = /^(Frame|Group|Rectangle|Ellipse|Vector|Line|Polygon|Star|Text) \d+$/;

function compareKids(n) {
  return n && "children" in n && n.children ? n.children.slice() : [];
}

// describeNodeLine with the id first and the name dropped (the path already
// shows it): #12:3 TEXT 120x16 @0,0 size:fill/hug font "…" children:2
function refLine(n) {
  const line = describeNodeLine(n).replace(/^(\S+) (?:"(?:[^"\\]|\\.)*" )?(#\S+)/, "$2 $1");
  const kids = compareKids(n).length;
  return kids ? line + " children:" + kids : line;
}

// Pairs ref children with target children: same type+name in order, then the
// leftovers of the same type in order. -> { pairs: [[r, t]], missing: [r], extra: [t] }
function matchChildren(refKids, tgtKids) {
  const used = new Set();
  const pairs = [];
  const missing = [];
  const key = c => c.type + "\u0000" + c.name;
  refKids.forEach(r => {
    const t = tgtKids.find(c => !used.has(c) && key(c) === key(r));
    if (t) { used.add(t); pairs.push([r, t]); } else missing.push(r);
  });
  const stillMissing = [];
  missing.forEach(r => {
    const t = tgtKids.find(c => !used.has(c) && c.type === r.type);
    if (t) { used.add(t); pairs.push([r, t]); } else stillMissing.push(r);
  });
  pairs.sort((a, b) => refKids.indexOf(a[0]) - refKids.indexOf(b[0]));
  return { pairs, missing: stillMissing, extra: tgtKids.filter(c => !used.has(c)) };
}

// The exact values of a reference node, ready to write (h13 T1: after compare
// the model read props of the reference to get them, 15 extra turns over 3 runs):
// REF #1:2: height 44, H pad 10,14,10,14, gap 8, fill #FFFFFF, stroke #D0D5DD 1 INSIDE all sides, radius 8, shadow DROP 0,1 blur 2 #101828@0.05
function refSpecLine(n, path) {
  const p = [];
  const h = fixedHeight(n);
  if (h !== undefined) p.push("height " + h);
  if ("layoutMode" in n && n.layoutMode && n.layoutMode !== "NONE") {
    p.push(n.layoutMode === "VERTICAL" ? "V" : n.layoutMode === "HORIZONTAL" ? "H" : n.layoutMode);
    p.push("pad " + [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft].map(readRound).join(","));
    p.push("gap " + readRound(n.itemSpacing));
    const al = readAlign(n);
    if (al) p.push(al);
  }
  const sizing = [n.layoutSizingHorizontal, n.layoutSizingVertical].filter(Boolean).map(x => String(x).toLowerCase()).join("/");
  if (sizing && n.parent && "layoutMode" in n.parent && n.parent.layoutMode && n.parent.layoutMode !== "NONE") p.push("size " + sizing);
  if (n.layoutPositioning === "ABSOLUTE") p.push("absolute");
  if ("fills" in n) { const f = readPaints(n.fills); if (f) p.push("fill " + f); }
  if ("strokes" in n) {
    const st = readPaints(n.strokes);
    if (st) {
      const sides = strokeSides(n);
      const same = sides && sides.split(",").every(w => w === sides.split(",")[0]);
      p.push("stroke " + st + (sides ? (same ? " " + sides.split(",")[0] : "") : "") + (n.strokeAlign ? " " + n.strokeAlign : "") +
        (sides ? (same ? " all sides" : " sides " + sides) : ""));
    }
  }
  const r = readRadius(n);
  if (r) p.push("radius " + r.slice(1));
  if (Array.isArray(n.effects)) n.effects.filter(e => e && e.visible !== false).forEach(e => {
    if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
      const off = e.offset || { x: 0, y: 0 };
      p.push("shadow " + (e.type === "DROP_SHADOW" ? "DROP " : "INNER ") + readRound(off.x) + "," + readRound(off.y) + " blur " + readRound(e.radius) +
        (e.spread ? " spread " + readRound(e.spread) : "") + " " + readHex(e.color, e.color ? e.color.a : 1));
    } else p.push((e.type === "BACKGROUND_BLUR" ? "bg-blur " : "blur ") + readRound(e.radius));
  });
  if (typeof n.opacity === "number" && n.opacity < 1) p.push("opacity " + readRound(n.opacity));
  if (n.clipsContent === true) p.push("clip");
  if (n.type === "TEXT") p.push("font " + readFont(n));
  if (n.type === "INSTANCE") p.push(readInstanceOf(n));
  return "REF " + (path ? path + " " : "") + "#" + n.id + ": " + (p.join(", ") || n.type);
}

const REF_LINES_MAX = 3;
const REF_TAIL = " - copy from the ref node in figma_execute_code, no props read needed";

// [{ node, path }] of reference nodes with differing props -> the REF lines.
function refSpecLines(list) {
  const seen = new Set();
  const uniq = list.filter(x => !seen.has(x.node.id) && seen.add(x.node.id));
  if (!uniq.length) return [];
  const lines = uniq.slice(0, REF_LINES_MAX).map(x => refSpecLine(x.node, x.path));
  if (uniq.length > REF_LINES_MAX) lines.push("… +" + (uniq.length - REF_LINES_MAX) + " more ref nodes differ");
  lines[lines.length - 1] += REF_TAIL;
  return lines;
}

// One block per target: a header line, then one line per node that differs:
//   <path> #targetId: key target (ref value); …
// "identical" when nothing differs; then REF lines (refSpecLine) of the
// reference nodes that differ. opts: depth (8), maxLines (200), refSink
// (an array: REF nodes go there instead of into the text — likeNodes).
function compareNodes(refRef, targets, opts) {
  const o = opts || {};
  const ref = readNode(refRef);
  if (!ref) return "MISSING reference " + refRef;
  const maxDepth = Number.isFinite(o.depth) ? o.depth : 8;
  const maxLines = Number.isFinite(o.maxLines) ? o.maxLines : 200;
  const refNodes = o.refSink || [];
  const blocks = [];
  (Array.isArray(targets) ? targets : [targets]).forEach(tRef => {
    const tgt = readNode(tRef);
    if (!tgt) { blocks.push("MISSING " + tRef); return; }
    const lines = [];
    let diffs = 0;
    const visit = (r, t, path, level) => {
      if (lines.length >= maxLines) return;
      const a = shapeOf(r), b = shapeOf(t);
      // one side HUG/FILL: the "size" diff already says it, a height diff is noise
      if (!("height" in a) || !("height" in b)) { delete a.height; delete b.height; }
      const keys = Object.keys(a).concat(Object.keys(b).filter(k => !(k in a)));
      const out = [];
      if (level > 0 && r.name !== t.name && !(AUTO_NAME_RE.test(r.name) && AUTO_NAME_RE.test(t.name))) out.push("name " + JSON.stringify(t.name) + " (ref " + JSON.stringify(r.name) + ")");
      keys.forEach(k => {
        if (a[k] === b[k]) return;
        out.push(k + " " + (b[k] === undefined ? "none" : b[k]) + " (ref " + (a[k] === undefined ? "none" : a[k]) + ")");
      });
      if (out.length) {
        diffs += out.length; lines.push("  " + (path || ".") + " #" + t.id + ": " + out.join("; "));
        // a rename or another variant alone needs no values to copy
        if (out.some(x => !/^(name|component) /.test(x))) refNodes.push({ node: r, path: path || "" });
      }
      if (a.type !== b.type || level >= maxDepth) return;
      // Another variant brings its own insides: the variant line is the fix,
      // its children would only add noise (session 87bd6b0a: 23 lines per copy).
      if (a.type === "INSTANCE" && a.component !== b.component) return;
      const m = matchChildren(compareKids(r), compareKids(t));
      const counts = {};
      const label = c => {
        const k = c.name;
        counts[k] = (counts[k] || 0) + 1;
        return (path ? path + "/" : "") + c.name + (counts[k] > 1 ? "[" + counts[k] + "]" : "");
      };
      // A target that wraps reference children in an extra frame (session
      // 87bd6b0a: rows of TEXTs inside "Frame 2131329286") is one fix — unwrap —
      // not a "missing" line per text plus an "extra" line per frame.
      let missing = m.missing;
      const wrapped = [];
      m.extra.slice().forEach(tc => {
        if (!missing.length || !compareKids(tc).length) return;
        const w = matchChildren(missing, compareKids(tc));
        if (!w.pairs.length) return;
        wrapped.push([tc, w.pairs]);
        missing = w.missing;
        m.extra.splice(m.extra.indexOf(tc), 1);
      });
      m.pairs.forEach(([rc, tc]) => visit(rc, tc, label(rc), level + 1));
      wrapped.forEach(([tc, pairs]) => {
        diffs++;
        lines.push("  " + (path ? path + "/" : "") + tc.name + " #" + tc.id + ": wrapper not in ref (" + tc.type + ") — ref holds " + pairs.map(p => JSON.stringify(p[0].name)).join(", ") + " directly");
        pairs.forEach(([rc, wc]) => visit(rc, wc, label(rc), level + 1));
      });
      // The reference's own line, so the fix needs no extra read of it.
      missing.forEach(rc => { diffs++; lines.push("  " + label(rc) + ": missing in target (ref " + refLine(rc) + ")"); });
      m.extra.forEach(tc => { diffs++; lines.push("  " + (path ? path + "/" : "") + tc.name + " #" + tc.id + ": extra in target (" + tc.type + ")"); });
    };
    visit(ref, tgt, "", 0);
    if (lines.length >= maxLines) lines.push("  … stopped at " + maxLines + " lines");
    blocks.push("#" + tgt.id + " " + JSON.stringify(tgt.name) + " vs ref #" + ref.id + ": " + (diffs ? diffs + " diffs" : "identical"));
    lines.forEach(l => blocks.push(l));
  });
  if (!o.refSink) refSpecLines(refNodes).forEach(l => blocks.push(l));
  return blocks.join("\n");
}

// ---------------------------------------------------------------------------
// bridge.like(refs, roots) — "where else is this thing, and how does each copy
// differ". Session 87bd6b0a ("redo the dropdowns like these references") spent
// ~34 figma_inspect calls only pairing references with their copies on three
// breakpoints, and ~14 more on a nested instance's variant. This finds the
// copies and compares them in one read.
// Copy of an INSTANCE = an instance of the same component set (or component);
// of anything else = same type and name, or — for auto names / renamed copies —
// the same child names. roots: node ids (default: the reference's top section).
// ---------------------------------------------------------------------------
function componentRootOf(n) {
  let main = null;
  try { main = n.mainComponent; } catch (e) {}
  if (!main) return null;
  return main.parent && main.parent.type === "COMPONENT_SET" ? main.parent : main;
}

function childNameSet(n) {
  const s = new Set();
  const walk = (x, d) => compareKids(x).forEach(c => {
    if (!AUTO_NAME_RE.test(c.name)) s.add(c.type + "\u0000" + c.name);
    if (d < 2) walk(c, d + 1);
  });
  walk(n, 1);
  return s;
}

function isInside(n, anc) {
  for (let cur = n; cur; cur = cur.parent) if (cur === anc) return true;
  return false;
}

function topSectionOf(n) {
  let best = null;
  for (let cur = n.parent; cur && cur.type !== "PAGE" && cur.type !== "DOCUMENT"; cur = cur.parent) {
    if (cur.type === "SECTION") best = cur;
  }
  return best || figma.currentPage;
}

// The screen a node sits on: its outermost non-section ancestor right under a
// SECTION or the page (breakpoint frames live in sections).
function screenOf(n) {
  for (let cur = n.parent; cur && cur.parent; cur = cur.parent) {
    const up = cur.parent.type;
    if (cur.type !== "SECTION" && (up === "SECTION" || up === "PAGE" || up === "DOCUMENT")) return cur;
  }
  return null;
}

function findCopies(ref, roots, limit) {
  const seen = new Set();
  const found = [];
  const add = n => { if (!seen.has(n.id) && !isInside(n, ref) && !isInside(ref, n)) { seen.add(n.id); found.push(n); } };
  const comp = ref.type === "INSTANCE" ? componentRootOf(ref) : null;
  const named = !AUTO_NAME_RE.test(ref.name);
  // Hidden layers inside instances are skipped while scanning only: compare
  // below must still see them (a hidden inner "Dropdown" is a real difference).
  withSkipInvisible(() => roots.forEach(root => {
    if (comp) {
      scanNodes(root, ["INSTANCE"], n => { const c = componentRootOf(n); return !!c && c.id === comp.id; }).forEach(add);
    } else if (named) {
      scanNodes(root, [ref.type], n => n.name === ref.name).forEach(add);
    }
  }));
  if (!found.length && !comp) {
    // Renamed or auto-named copies: same type, at least half the child names shared.
    const want = childNameSet(ref);
    if (want.size) {
      withSkipInvisible(() => roots.forEach(root => scanNodes(root, [ref.type], n => {
        if (!("children" in n) || !n.children.length) return false;
        const got = childNameSet(n);
        let common = 0;
        want.forEach(k => { if (got.has(k)) common++; });
        return common / Math.max(want.size, got.size) >= 0.5;
      }).forEach(add)));
    }
  }
  const copies = found.slice(0, limit);
  copies.total = found.length;
  return copies;
}

function likeNodes(refList, rootList, opts) {
  const o = opts || {};
  const limit = Number.isFinite(o.limit) ? o.limit : 30;
  const refs = (Array.isArray(refList) ? refList : String(refList).split(",")).map(r => String(r).trim()).filter(Boolean);
  const out = [];
  refs.forEach(refId => {
    const ref = readNode(refId);
    if (!ref) { out.push("MISSING reference " + refId); return; }
    const roots = (rootList && rootList.length ? rootList : [topSectionOf(ref)]).map(readNode).filter(Boolean);
    const copies = findCopies(ref, roots, limit);
    const comp = ref.type === "INSTANCE" ? componentRootOf(ref) : null;
    // Screen names share a long prefix ("Сервисы / Распределение / … / 1366"):
    // say it once in the header, keep only the rest per copy.
    const screens = copies.map(screenOf);
    const names = screens.filter(Boolean).map(x => x.name);
    let prefix = names.length > 1 ? names.reduce((p, n) => { let k = 0; while (k < p.length && p[k] === n[k]) k++; return p.slice(0, k); }) : "";
    prefix = prefix.slice(0, prefix.lastIndexOf(" / ") + 3);
    const where = k => screens[k] ? " " + JSON.stringify(screens[k].name.slice(prefix.length)) : "";
    out.push("like " + describeNodeLine(ref).replace(/ @\S+/, "") + ": " + copies.length + (copies.total > copies.length ? " of " + copies.total : "") + " cop" + (copies.length === 1 && !(copies.total > 1) ? "y" : "ies") +
      " (" + (comp ? "instances of " + JSON.stringify(comp.name) : "same name/children") + ")" +
      (prefix ? " on screens " + JSON.stringify(prefix + "…") : "") + " under " +
      roots.map(r => JSON.stringify(r.name) + " #" + r.id).join(", "));
    // One group per distinct diff set (ids aside): a fix that repeats on every
    // breakpoint is printed once, with the copies it applies to.
    const groups = [];
    const byKey = {};
    const refSink = [];
    const co = Object.assign({}, o, { refSink });
    copies.forEach((c, k) => {
      const lines = compareNodes(ref, [c], co).split("\n");
      const same = /: identical$/.test(lines[0]);
      const body = same ? [] : lines.slice(1);
      const key = same ? "=" : body.map(l => l.replace(/ #[^\s:]+/g, "")).join("\n");
      if (!byKey[key]) { byKey[key] = { same, head: lines[0].replace(/^.*: /, ""), body, ids: [] }; groups.push(byKey[key]); }
      byKey[key].ids.push("#" + c.id + where(k));
    });
    groups.sort((a, b) => (a.same ? 1 : 0) - (b.same ? 1 : 0));
    groups.forEach(g => {
      const n = g.ids.length + " cop" + (g.ids.length === 1 ? "y" : "ies");
      if (g.same) { out.push(n + " identical: " + g.ids.join(", ")); return; }
      out.push(n + " — " + g.head + (g.ids.length > 1 ? " (ids below: " + g.ids[0].split(" ")[0] + ")" : "") + ": " + g.ids.join(", "));
      g.body.forEach(l => out.push(l));
    });
    refSpecLines(refSink).forEach(l => out.push(l));
  });
  return out.join("\n");
}
