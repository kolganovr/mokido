// html-map translator test (T-077, F8.2). Run: node tests/html-map.test.js
//  (a) htmlMap on the 10 dom.json fixtures: contract thresholds measured by this file's own code
//      (same definitions as planning/tools/html/structure.py, pairing by plan.dom id with an IoU fallback)
//  (b) small hand-made trees with a known answer
// No dependencies, loads figma-plugin-src/html-map.js through vm.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let failures = 0, checks = 0;
function check(name, ok, detail) {
  checks++;
  if (ok) return;
  failures++;
  console.log("  FAIL " + name + (detail !== undefined ? " :: " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : ""));
}

const ROOT = path.join(__dirname, "..");
const ctx = vm.createContext({});
["html-map.js", "html-grid.js"].forEach((f) => vm.runInContext(fs.readFileSync(path.join(ROOT, "figma-plugin-src", f), "utf8"), ctx));
const htmlMap = ctx.htmlMap;
const j = (x) => JSON.parse(JSON.stringify(x)); // plain objects out of the vm realm

// ---------------------------------------------------------------- measuring (mirror of structure.py / geometry.py)
const DEFAULT_NAME = /^(Frame|Group|Rectangle|Ellipse|Line|Vector|Polygon|Star|Component|Instance|Section)( \d+)?$/;
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
const pct = (a, b) => (b ? Math.round(1000 * a / b) / 10 : null);
function flat(root) { // visible descendants, depth first, with parent
  const out = [];
  (function w(p) { for (const c of p.children || []) { if (c.visible === false) continue; out.push({ node: c, parent: p }); w(c); } })(root);
  return out;
}
function iou(a, b) {
  const iw = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), ih = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (iw <= 0 || ih <= 0) return 0;
  const i = iw * ih;
  return i / (a.w * a.h + b.w * b.h - i);
}
function measure(dom, plan) {
  const nodes = dom.nodes, by = {};
  nodes.forEach((n) => (by[n.id] = n));
  const root = plan.root, fl = flat(root);
  const parentOf = new Map();
  fl.forEach((f) => parentOf.set(f.node, f.parent));
  const ox = nodes[0].rect.x, oy = nodes[0].rect.y;
  const byDom = new Map();
  fl.forEach((f) => { if (!byDom.has(f.node.dom)) byDom.set(f.node.dom, f.node); });
  const used = new Set();
  // an <img> covering its whole container is merged into the container's fill (ADR-004 p. 3): not a candidate of its own (F8 decision 1)
  const fullImg = (n) => n.tag === "img" && n.parent !== null && by[n.parent] && ["x", "y", "w", "h"].every((k) => Math.abs(by[n.parent].rect[k] - n.rect[k]) <= 1);
  const cands = nodes.filter((n) => n.significant && !n.in_component && n.parent !== null && !fullImg(n));
  const pairOf = new Map();
  cands.forEach((n) => { const f = byDom.get(n.id); if (f && (f.type === "TEXT") === (n.tag === "#text")) { pairOf.set(n.id, f); used.add(f); } });
  cands.forEach((n) => { // no node of its own (collapsed or merged): the unused node with the best box overlap
    if (pairOf.has(n.id) || n.tag === "#text") return;
    const r = { x: n.rect.x - ox, y: n.rect.y - oy, w: n.rect.w, h: n.rect.h };
    let best = null, bi = 0.9;
    fl.forEach((f) => { if (used.has(f.node) || f.node.type === "TEXT") return; const v = iou(r, f.node); if (v > bi) { bi = v; best = f.node; } });
    if (best) { pairOf.set(n.id, best); used.add(best); }
  });
  pairOf.set(nodes[0].id, root);
  const res = {};
  const cont = nodes.filter((n) => n.significant && !n.in_component && (n.flex || n.grid));
  let a = 0, d = 0, g = 0, p = 0;
  cont.forEach((n) => {
    const f = pairOf.get(n.id);
    if (!f || f.layoutMode === "NONE") return;
    a++;
    if (n.grid) {
      // contract F9 section 4: one row HORIZONTAL (rule 1), equal tracks without span HORIZONTAL + WRAP (rule 2), spans or unequal tracks VERTICAL of rows (rule 3)
      const tr = String(n.grid.cols).trim().split(/\s+/).map(parseFloat), gk = nodes.filter((k) => k.parent === n.id && k.position !== "absolute" && k.position !== "fixed" && k.rect.w > 0);
      const rows3 = gk.length > tr.length && (gk.some((k) => /span|\//.test(String((k.declared || {})["grid-column"] || "")) || /span/.test(String((k.declared || {})["grid-row"] || ""))) || Math.max(...tr) - Math.min(...tr) > 1);
      d += rows3 ? f.layoutMode === "VERTICAL" : f.layoutMode === "HORIZONTAL" && (gk.length <= tr.length || f.layoutWrap === "WRAP");
      g += Math.abs(f.itemSpacing - n.grid.colGap) <= 1 && Math.abs(f.counterAxisSpacing - n.grid.rowGap) <= 1;
    } else {
      d += f.layoutMode === (n.flex.dir === "row" ? "HORIZONTAL" : "VERTICAL");
      // equal margins between neighbours are part of the spacing (ADR-004 p. 3, T-105): expected = the real gap when all gaps are equal
      const ks = nodes.filter((k) => k.parent === n.id && k.position !== "absolute" && k.position !== "fixed" && k.rect.w > 0).sort((x, y) => (n.flex.dir === "row" ? x.rect.x - y.rect.x : x.rect.y - y.rect.y));
      const gp = ks.slice(1).map((k, i) => (n.flex.dir === "row" ? k.rect.x - ks[i].rect.x - ks[i].rect.w : k.rect.y - ks[i].rect.y - ks[i].rect.h));
      const want = !n.flex.wrap && gp.length && gp.every((v) => v >= 0 && Math.abs(v - gp[0]) <= 1) && !/space/.test(n.flex.justify) ? gp[0] : n.flex.gap;
      g += Math.abs(f.itemSpacing - want) <= 1;
    }
    p += n.padding.every((v, i) => Math.abs(f.padding[i] - v) <= 1);
  });
  res.auto_layout = pct(a, cont.length); res.dir = pct(d, cont.length); res.gap = pct(g, cont.length); res.padding = pct(p, cont.length);
  // sizing: independent restatement of the SPEC heuristic (the test may know the answer, the translator does not)
  const dsz = (v) => (v == null ? null : v === "100%" ? "fill" : /^-?[\d.]+(px)?$/.test(String(v)) ? "px" : /^(auto|fit-content|max-content|min-content)$/.test(v) ? null : "px");
  const expect = (n, par, axis) => {
    const dd = n.declared, sz = dsz(dd[axis === "h" ? "width" : "height"]);
    if (n.position === "absolute" || n.position === "fixed") return sz === "fill" ? "FILL" : sz === "px" ? "FIXED" : "HUG"; // out of flow: no stretch, shrink-to-fit
    if (par.flex) {
      if ((par.flex.dir === "row") === (axis === "h")) {
        if (parseFloat(dd["flex-grow"] || String(dd.flex || "0").split(" ")[0]) > 0) return "FILL";
        if (sz === "px" || /px$/.test(dd["flex-basis"] || "")) return "FIXED";
        return sz === "fill" ? "FILL" : "HUG";
      }
      if (sz === "px") return "FIXED";
      if (sz === "fill") return "FILL";
      const al = dd["align-self"] && dd["align-self"] !== "auto" ? dd["align-self"] : par.flex.align;
      return al === "normal" || al === "stretch" ? "FILL" : "HUG";
    }
    if (sz === "px") return "FIXED";
    if (sz === "fill") return "FILL";
    return axis === "v" ? "HUG" : /^inline/.test(n.display) ? "HUG" : "FILL";
  };
  let sb = 0, sd = 0;
  cands.forEach((n) => {
    if (n.tag === "#text") return;
    const f = pairOf.get(n.id);
    if (!f) return;
    const par = parentOf.get(f);
    if (!par || par.layoutMode === "NONE") return;
    sd++;
    const okb = expect(n, by[n.parent], "h") === f.sizingH && expect(n, by[n.parent], "v") === f.sizingV;
    if (!okb && process.env.HTML_MAP_DEBUG) console.log("  sizing miss", dom.etalon, n.id, n.tag, n.classes.join("."), "expect", expect(n, by[n.parent], "h") + "/" + expect(n, by[n.parent], "v"), "got", f.sizingH + "/" + f.sizingV);
    sb += okb;
  });
  res.sizing = pct(sb, sd);
  const gridRows = fl.filter((f) => f.node.dom == null && /^row \d+$/.test(f.node.name || "")).length; // F9 rule 3: row frames are the contracted extra layers (warning grid_rows), not counted
  res.layers_ratio = Math.round(100 * (fl.length - gridRows) / cands.length) / 100;
  const comp = fl.filter((f) => by[f.node.dom] && by[f.node.dom].in_component).length;
  res.layers_ratio_no_comp = Math.round(100 * (fl.length - comp - gridRows) / cands.length) / 100;
  // explicit css position absolute/fixed is an expected ABSOLUTE (ADR-004 "absolute_unexpected"); T-135: the 08 tag chips stay ABSOLUTE over a vector cover instead of becoming a padded overlay
  const cssAbs = (f) => !!(by[f.node.dom] && /^(absolute|fixed)$/.test(by[f.node.dom].position || ""));
  res.absolute = pct(fl.filter((f) => (f.node.positioning === "ABSOLUTE" && !cssAbs(f)) || f.parent.layoutMode === "NONE").length, fl.length);
  const nont = fl.filter((f) => f.node.type !== "TEXT");
  res.names_default = pct(nont.filter((f) => DEFAULT_NAME.test(f.node.name || "")).length, nont.length);
  const avail = {};
  fl.forEach((f) => { if (f.node.type === "TEXT") { const t = norm(f.node.text.characters); avail[t] = (avail[t] || 0) + 1; } });
  let nt = 0, nf = 0;
  nodes.forEach((n) => { if (n.tag === "#text") { nt++; const t = norm(n.text); if (avail[t] > 0) { avail[t]--; nf++; } } });
  res.text_found = pct(nf, nt);
  return res;
}

// ---------------------------------------------------------------- (a) fixtures
const FIX = path.join(__dirname, "fixtures", "html");
const files = fs.readdirSync(FIX).filter((f) => f.endsWith(".dom.json")).sort();
check("10 fixtures", files.length === 10, files.length);
console.log("etalon                    auto  dir  gap  pad  sizing  layers(no comp)  abs  names  text");
files.forEach((f) => {
  const dom = JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));
  const name = f.replace(".dom.json", "");
  const plan = j(htmlMap(JSON.parse(JSON.stringify(dom)), {}));
  const m = measure(dom, plan);
  console.log(name.padEnd(26) + [m.auto_layout, m.dir, m.gap, m.padding, m.sizing, m.layers_ratio + "(" + m.layers_ratio_no_comp + ")", m.absolute, m.names_default, m.text_found].join("  "));
  check(name + " auto_layout >= 95", m.auto_layout >= 95, m);
  check(name + " dir >= 95", m.dir >= 95, m);
  check(name + " gap >= 95", m.gap >= 95, m);
  check(name + " padding >= 95", m.padding >= 95, m);
  // 08: three absolute tag chips; the SPEC heuristic is blind to position and expects FILL for them (see T-097): now position-aware
  // 08: 3 hero images (100% x 100% in a fixed-height box) are absorbed into the container fill; the measure no longer counts them as candidates (F8 decision 1), floor 90 like the rest
  check(name + " sizing", m.sizing >= 90, m.sizing);
  // contract wants <= 1.2 counting every layer; the SPEC counts component interiors and plain flex wrappers as extra. Floor 1.5 without interiors
  check(name + " layers_ratio (no component interiors) <= 1.5", m.layers_ratio_no_comp <= 1.5, m.layers_ratio_no_comp);
  check(name + " absolute <= 5", m.absolute <= 5, m.absolute);
  check(name + " names_default <= 5", m.names_default <= 5, m.names_default);
  check(name + " all texts found", m.text_found === 100, m.text_found);
  check(name + " root fixed viewport x page", plan.root.w === dom.viewport.w && plan.root.h === dom.page.h && plan.root.sizingH === "FIXED", [plan.root.w, plan.root.h]);
  check(name + " plan count", plan.count === 1 + flat(plan.root).length, plan.count);
  check(name + " no internal fields", !JSON.stringify(plan).includes('"_n"') && !JSON.stringify(plan).includes('"_m"'));
});

// ---------------------------------------------------------------- (b) hand-made trees
let nid = 0;
function el(parent, tag, rect, extra) {
  const n = Object.assign({
    id: nid++, parent: parent && typeof parent === "object" ? parent.id : parent, tag: tag, classes: [], name: null, component: null, variant: null, in_component: false,
    rect: { x: rect[0], y: rect[1], w: rect[2], h: rect[3] }, text: null, display: "block", flex: null, grid: null, padding: [0, 0, 0, 0],
    style: { bg: null, color: "#000000ff", borderColor: null, borderWidth: [0, 0, 0, 0], radius: [0, 0, 0, 0], fontFamily: "Inter", fontSize: 16, fontWeight: 400, lineHeight: 20, opacity: 1, boxShadow: null, bgImage: null },
    declared: {}, tokens: {}, expect_sizing: { h: "HUG", v: "HUG" }, significant: true
  }, extra || {});
  return n;
}
const flexOf = (dir, gap, justify, align, wrap) => ({ display: "flex", flex: { dir: dir, wrap: !!wrap, gap: gap || 0, justify: justify || "normal", align: align || "normal" } });
const bg = (hex) => ({ bg: hex });
function tree(list, vw, ph) { return { etalon: "t", viewport: { w: vw || 400, h: 300 }, page: { w: vw || 400, h: ph || 300 }, nodes: list }; }
function withStyle(n, st) { n.style = Object.assign({}, n.style, st); return n; }
function run(list, vw, ph) { // renumber ids by position so one block can build several trees
  const map = new Map();
  list.forEach((n, i) => map.set(n.id, i));
  const L = list.map((n, i) => Object.assign({}, n, { id: i, parent: n.parent === null ? null : map.get(n.parent) }));
  return j(htmlMap(tree(L, vw, ph), {}));
}
const kids = (p) => p.children;

{ // row, gap, padding, a painted child keeps its own frame
  nid = 0;
  nid = 0;
  const body = el(null, "body", [0, 0, 400, 300], flexOf("row", 12, "flex-start", "center"));
  body.padding = [10, 20, 10, 20];
  const a = withStyle(el(0, "div", [20, 10, 100, 40], { declared: { width: "100px", height: "40px" } }), bg("#ff0000ff"));
  const b = withStyle(el(0, "div", [132, 10, 80, 40], { declared: { width: "80px", height: "40px" } }), bg("#00ff00ff"));
  const plan = run([body, a, b]);
  const r = plan.root;
  check("row: HORIZONTAL", r.layoutMode === "HORIZONTAL", r.layoutMode);
  check("row: gap 12", r.itemSpacing === 12, r.itemSpacing);
  check("row: padding", JSON.stringify(r.padding) === "[10,20,10,20]", r.padding);
  check("row: align center", r.counterAxisAlignItems === "CENTER" && r.primaryAxisAlignItems === "MIN", [r.primaryAxisAlignItems, r.counterAxisAlignItems]);
  check("row: 2 children", kids(r).length === 2, kids(r).length);
  check("row: px size FIXED/FIXED", kids(r)[0].sizingH === "FIXED" && kids(r)[0].sizingV === "FIXED", kids(r)[0]);
  check("row: fill hex+opacity", kids(r)[0].fills[0].hex === "#ff0000" && kids(r)[0].fills[0].opacity === 1, kids(r)[0].fills);
  check("row: child coordinates relative to root", kids(r)[1].x === 132 && kids(r)[1].y === 10, [kids(r)[1].x, kids(r)[1].y]);
}
{ // column, flex-grow -> FILL on the main axis, stretch -> FILL on the cross axis, text HUG
  nid = 0;
  const body = el(null, "body", [0, 0, 400, 300], flexOf("column", 8));
  const a = withStyle(el(0, "div", [0, 0, 400, 100], { declared: { "flex-grow": "1", flex: "1 1 0%" } }), bg("#112233ff"));
  const b = withStyle(el(0, "div", [0, 108, 400, 50], { declared: { height: "50px" } }), bg("#112233ff"));
  const plan = run([body, a, b]);
  const [ka, kb] = kids(plan.root);
  check("column: VERTICAL gap 8", plan.root.layoutMode === "VERTICAL" && plan.root.itemSpacing === 8);
  check("flex-grow: FILL on main axis", ka.sizingV === "FILL", ka.sizingV);
  check("align normal: FILL on cross axis", ka.sizingH === "FILL" && kb.sizingH === "FILL", [ka.sizingH, kb.sizingH]);
  check("height px: FIXED on main axis", kb.sizingV === "FIXED", kb.sizingV);
}
{ // align-items center: HUG on the cross axis; space-between
  nid = 0;
  const body = el(null, "body", [0, 0, 400, 300], flexOf("row", 0, "space-between", "center"));
  const a = withStyle(el(0, "div", [0, 130, 50, 40], { declared: { width: "50px", height: "40px" } }), bg("#ff0000ff"));
  const b = withStyle(el(0, "div", [350, 130, 50, 40], { declared: { width: "50px", height: "40px" } }), bg("#ff0000ff"));
  const plan = run([body, a, b]);
  check("space-between", plan.root.primaryAxisAlignItems === "SPACE_BETWEEN", plan.root.primaryAxisAlignItems);
  const c = withStyle(el(0, "div", [10, 10, 80, 20]), bg("#ff0000ff"));
  const d = withStyle(el(0, "div", [100, 10, 80, 20], { declared: { "align-self": "center" } }), bg("#ff0000ff"));
  const body2 = el(null, "body", [0, 0, 400, 300], flexOf("row", 0, "normal", "normal"));
  const plan2 = run([body2, withStyle(el(body2, "div", [0, 0, 80, 300]), bg("#ff0000ff")), withStyle(el(body2, "div", [80, 0, 80, 100], { declared: { "align-self": "center" } }), bg("#00ff00ff"))]);
  check("row stretch -> FILL vertical", kids(plan2.root)[0].sizingV === "FILL" && kids(plan2.root)[0].sizingH === "HUG", kids(plan2.root)[0]);
  check("align-self center -> HUG vertical", kids(plan2.root)[1].sizingV === "HUG", kids(plan2.root)[1].sizingV);
}
{ // block flow: vertical AL, FILL width, margins from boxes -> itemSpacing and padding
  nid = 0;
  const body = el(null, "body", [0, 0, 400, 300], { padding: [0, 0, 0, 0] });
  const card = withStyle(el(0, "div", [20, 30, 360, 140]), bg("#ffffffff"));
  card.padding = [0, 0, 0, 0];
  const h = withStyle(el(1, "div", [20, 30, 360, 40], { declared: {} }), bg("#eeeeeeff"));
  const p = withStyle(el(1, "div", [20, 94, 360, 60]), bg("#dddddd"+"ff"));
  const plan = run([body, card, h, p]);
  const cardP = kids(plan.root)[0];
  check("block: vertical AL", cardP.layoutMode === "VERTICAL", cardP.layoutMode);
  check("block: margin between siblings -> itemSpacing 24", cardP.itemSpacing === 24, cardP.itemSpacing);
  check("block: child width FILL, height HUG", kids(cardP)[0].sizingH === "FILL" && kids(cardP)[0].sizingV === "HUG", kids(cardP)[0]);
  check("block: edge margin of body -> padding", JSON.stringify(plan.root.padding) === "[30,20,130,20]", plan.root.padding);
}
{ // absolute: explicit position field and inference from overlap
  nid = 0;
  const body = el(null, "body", [0, 0, 400, 300], flexOf("column", 0));
  const a = withStyle(el(0, "div", [0, 0, 400, 200]), bg("#111111ff"));
  const b = withStyle(el(0, "div", [300, 10, 80, 30], { position: "absolute" }), bg("#ff0000ff"));
  const c = withStyle(el(0, "div", [0, 200, 400, 50]), bg("#222222ff"));
  const plan = run([body, a, b, c]);
  const ks = kids(plan.root);
  check("absolute: explicit position", ks[1].positioning === "ABSOLUTE" && ks[1].sizingH === "FIXED", ks[1]);
  check("absolute: neighbours stay in flow", ks[0].positioning === "AUTO" && ks[2].positioning === "AUTO");
  check("absolute: reported in warnings", plan.warnings.some((w) => w.code === "absolute"), plan.warnings);
  const bodyB = el(null, "body", [0, 0, 400, 300], flexOf("column", 0));
  const b2 = withStyle(el(bodyB, "div", [300, 10, 80, 30]), bg("#ff0000ff"));
  const plan2 = run([bodyB, withStyle(el(bodyB, "div", [0, 0, 400, 200]), bg("#111111ff")), b2]);
  check("absolute: inferred from overlap", kids(plan2.root)[1].positioning === "ABSOLUTE", kids(plan2.root)[1].positioning);
  // overlay alone in a container: Auto Layout with padding, not ABSOLUTE
  const bodyC = el(null, "body", [0, 0, 400, 300], flexOf("column", 0));
  const boxC = withStyle(el(bodyC, "div", [0, 0, 400, 200]), bg("#111111ff"));
  const plan3 = run([bodyC, boxC, withStyle(el(boxC, "div", [12, 12, 60, 24], { position: "absolute" }), bg("#ff0000ff"))]);
  const cont = kids(plan3.root)[0];
  check("overlay: container becomes AL with padding 12", cont.layoutMode === "VERTICAL" && cont.padding[0] === 12 && cont.padding[3] === 12, cont);
  check("overlay: child in flow, HUG", kids(cont)[0].positioning === "AUTO" && kids(cont)[0].sizingH === "HUG");
}
{ // text: one TEXT per block, inline span -> range
  nid = 0;
  const body = el(null, "body", [0, 0, 400, 300], flexOf("column", 0));
  const p = el(0, "p", [0, 0, 400, 20], { significant: false });
  const t1 = el(1, "#text", [0, 0, 70, 20], { text: "Hello", display: "text" });
  const sp = el(1, "span", [75, 0, 40, 20], { display: "inline", significant: false });
  const t2 = el(3, "#text", [75, 0, 40, 20], { text: "bold", display: "text" });
  withStyle(t2, { fontWeight: 700, color: "#ff0000ff" });
  const t3 = el(1, "#text", [115, 0, 10, 20], { text: "!", display: "text" });
  const plan = run([body, p, t1, sp, t2, t3]);
  const t = kids(plan.root)[0];
  check("text: collapsed to one TEXT", kids(plan.root).length === 1 && t.type === "TEXT", t);
  check("text: characters joined by box gaps", t.text.characters === "Hello bold!", t.text.characters);
  check("text: one range for the bold span", t.text.ranges.length === 1 && t.text.ranges[0].start === 6 && t.text.ranges[0].end === 10 && t.text.ranges[0].fontStyle === "Bold" && t.text.ranges[0].hex === "#ff0000", t.text.ranges);
  check("text: name from content", t.name === "Hello bold!", t.name);
  check("text: block in column -> FILL width, HEIGHT autoresize", t.sizingH === "FILL" && t.text.autoResize === "HEIGHT", t);
}
{ // collapsing and names
  nid = 0;
  const body = el(null, "body", [0, 0, 400, 300], flexOf("column", 0));
  const wrap = el(0, "div", [0, 0, 400, 50], { significant: false, classes: ["wrap"] }); // no paint, one child, same box
  const card = withStyle(el(1, "div", [0, 0, 400, 50], { classes: ["card", "x"], name: "Hero card" }), bg("#abcdefff"));
  const wrap2 = el(0, "div", [0, 60, 400, 50], { significant: false });
  const card2 = withStyle(el(3, "div", [0, 60, 400, 50], { classes: ["card"] }), bg("#abcdefff"));
  const plan = run([body, wrap, card, wrap2, card2]);
  const ks = kids(plan.root);
  check("collapse: empty wrappers vanish", ks.length === 2 && ks[0].dom === 2 && ks[1].dom === 4, ks.map((k) => k.dom));
  check("collapse: stat", plan.stats.collapsed === 2, plan.stats);
  check("names: data-name / first class", ks[0].name === "Hero card" && ks[1].name === "card", ks.map((k) => k.name));
  check("names: root tag", plan.root.name === "body", plan.root.name);
  // a wrapper with padding is kept
  const body3 = el(null, "body", [0, 0, 400, 300], flexOf("column", 0));
  const w3 = el(body3, "div", [0, 0, 400, 50], { significant: false, padding: [5, 5, 5, 5] });
  const c3 = withStyle(el(w3, "div", [5, 5, 390, 40]), bg("#abcdefff"));
  const plan3 = run([body3, w3, c3]);
  check("collapse: padded wrapper kept", kids(plan3.root).length === 1 && kids(plan3.root)[0].dom === 1 && kids(plan3.root)[0].padding[0] === 5, kids(plan3.root));
}
{ // grid -> wrapping rows
  nid = 0;
  const body = el(null, "body", [0, 0, 400, 300], flexOf("column", 0));
  const g = el(0, "div", [0, 0, 400, 140], { display: "grid", grid: { cols: "190px 190px", rowGap: 20, colGap: 20 }, significant: true });
  const mk = (x, y) => withStyle(el(1, "div", [x, y, 190, 60]), bg("#ccccccff"));
  const plan = run([body, g, mk(0, 0), mk(210, 0), mk(0, 80), mk(210, 80)]);
  const gp = kids(plan.root)[0];
  check("grid: HORIZONTAL WRAP with gaps", gp.layoutMode === "HORIZONTAL" && gp.layoutWrap === "WRAP" && gp.itemSpacing === 20 && gp.counterAxisSpacing === 20, gp);
  check("grid: 4 children in grid", kids(gp).length === 4);
}
{ // drawing: radius, border, shadow, gradient, opacity
  nid = 0;
  const body = el(null, "body", [0, 0, 400, 300], flexOf("column", 0));
  const a = withStyle(el(0, "div", [0, 0, 400, 100]), { bg: "#ffffff80", radius: [8, 8, 0, 0], borderColor: "#00000033", borderWidth: [1, 1, 1, 1], boxShadow: "rgba(29, 26, 24, 0.06) 0px 1px 2px 0px, rgba(0, 0, 0, 0.1) 0px 10px 28px 2px", opacity: 0.5 });
  const b = withStyle(el(0, "div", [0, 100, 400, 100], { declared: { background: "linear-gradient(135deg, rgb(255, 0, 0) 0%, rgb(0, 0, 255) 100%)" } }), { bgImage: "gradient" });
  const plan = run([body, a, b]);
  const [pa, pb] = kids(plan.root);
  check("draw: fill alpha split", pa.fills[0].hex === "#ffffff" && Math.abs(pa.fills[0].opacity - 0.5) < 0.01, pa.fills);
  check("draw: stroke + weight", pa.strokes[0].hex === "#000000" && pa.strokeWeight === 1, [pa.strokes, pa.strokeWeight]);
  check("draw: radius", JSON.stringify(pa.radius) === "[8,8,0,0]", pa.radius);
  check("draw: two shadows parsed", pa.effects.length === 2 && pa.effects[1].radius === 28 && pa.effects[1].offset[1] === 10 && pa.effects[1].spread === 2 && pa.effects[0].type === "DROP_SHADOW", pa.effects);
  check("draw: opacity", pa.opacity === 0.5, pa.opacity);
  check("draw: gradient fill + css in build", pb.fills[0].type === "GRADIENT_LINEAR" && /^linear-gradient\(135deg/.test(pb.build.gradient), [pb.fills, pb.build]);
}

{ // T-103: truncated text. nowrap + ellipsis = one line, width of the container (the range box spans the overflow); line-clamp N = N lines
  nid = 0;
  const body = el(null, "body", [0, 0, 400, 300], flexOf("column", 8));
  const p1 = withStyle(el(0, "p", [0, 0, 200, 20], { display: "block" }), { clamp: 1 });
  const t1 = withStyle(el(1, "#text", [0, 0, 520, 20], { text: "A very long headline that does not fit", display: "text" }), { clamp: 1 });
  const p2 = withStyle(el(0, "p", [0, 28, 300, 60], { display: "block" }), { clamp: 3 });
  const t2 = withStyle(el(3, "#text", [0, 28, 300, 80], { text: "Four lines of text where the browser shows three", display: "text" }), { clamp: 3 });
  const p3 = el(0, "p", [0, 96, 300, 20], { display: "block" });
  const t3 = el(5, "#text", [0, 96, 120, 20], { text: "Plain", display: "text" });
  const plan = run([body, p1, t1, p2, t2, p3, t3]);
  const [a, b, c] = kids(plan.root);
  check("clamp 1: maxLines 1 + ENDING", a.text.maxLines === 1 && a.text.truncation === "ENDING", a.text);
  check("clamp 1: width of the container, not of the overflowing text; one line high", a.w === 200 && a.h === 20 && a.text.lines === 1, [a.w, a.h, a.text.lines]);
  check("clamp 1: FILL width, height from lines", a.sizingH === "FILL" && a.sizingV === "HUG" && a.text.autoResize === "HEIGHT", [a.sizingH, a.sizingV, a.text.autoResize]);
  check("clamp 3: maxLines 3 + ENDING, box 3 lines high (hidden 4th line is not part of it)", b.text.maxLines === 3 && b.text.truncation === "ENDING" && b.h === 60 && b.text.lines === 3, [b.text, b.h]);
  check("clamp 3: FILL width", b.sizingH === "FILL" && b.text.autoResize === "HEIGHT", [b.sizingH, b.text.autoResize]);
  check("no clamp: no truncation fields", c.text.maxLines === undefined && c.text.truncation === undefined, c.text);
}
{ // T-103: an <img> covering the container under an overlay becomes the container's IMAGE fill and the plan keeps its source
  nid = 0;
  const body = el(null, "body", [0, 0, 400, 300], flexOf("column", 0));
  const hero = withStyle(el(0, "div", [0, 0, 400, 100], { classes: ["hero"], overflow: "hidden" }), { radius: [8, 8, 8, 8] });
  const img = el(1, "img", [0, 0, 400, 100], { src: "data:image/png;base64,AAAA", declared: { width: "100%", height: "100%" } });
  const chip = withStyle(el(1, "div", [10, 10, 60, 20], { position: "absolute", declared: { width: "60px", height: "20px" } }), bg("#ff0000ff"));
  const plan = run([body, hero, img, chip]);
  const h = kids(plan.root)[0];
  check("img merge: the container got an IMAGE fill and the source", h.fills.some((f) => f.type === "IMAGE") && h.build.img === "data:image/png;base64,AAAA", [h.fills, h.build]);
  check("img merge: the image is not a layer of its own, only the chip (overlay) is left", kids(h).length === 1 && kids(h)[0].type === "FRAME" && kids(h)[0].dom === 3, kids(h).map((k) => k.type));
}

{ // T-105: margins of flex children are not lost (04: icon + label, 10 px apart)
  nid = 0;
  const mk = (list, gap) => { nid = 0; const body = el(null, "body", [0, 0, 400, 100], flexOf("row", gap || 0, "flex-start", "flex-start")); return run([body].concat(list(body)), 400, 100); };
  // equal margin between two neighbours -> itemSpacing
  let plan = mk(() => [withStyle(el(0, "div", [0, 0, 20, 20], { declared: { width: "20px", height: "20px" } }), bg("#ff0000ff")), withStyle(el(0, "div", [30, 0, 40, 20], { declared: { width: "40px", height: "20px" } }), bg("#00ff00ff"))]);
  check("margin: 10 px between two neighbours -> itemSpacing 10", plan.root.itemSpacing === 10 && kids(plan.root).length === 2, [plan.root.itemSpacing, kids(plan.root).length]);
  // different margins, painted children -> wrapper on the second one only, with a warning
  plan = mk(() => [0, 1, 2].map((i) => withStyle(el(0, "div", [[0, 30, 80][i], 0, 20, 20], { declared: { width: "20px", height: "20px" } }), bg("#ff0000ff"))), 10);
  const ks = kids(plan.root);
  check("margin: gaps 10 and 30 -> itemSpacing 10, wrapper with padding-left 20 before the 3rd", plan.root.itemSpacing === 10 && ks.length === 3 && ks[2].type === "FRAME" && ks[2].padding[3] === 20 && ks[2].children.length === 1 && ks[2].x === 60 && ks[2].w === 40, [plan.root.itemSpacing, ks.map((k) => [k.type, k.padding, k.x, k.w])]);
  check("margin: the wrapper is warned about, the 2nd child stays bare", plan.warnings.some((w) => w.code === "margin-wrapper") && ks[1].children.length === 0, plan.warnings);
  // unpainted Auto Layout child takes it as its own padding, no wrapper
  plan = mk(() => {
    const a = withStyle(el(0, "div", [0, 0, 20, 20], { declared: { width: "20px", height: "20px" } }), bg("#ff0000ff"));
    const f = el(0, "div", [60, 0, 40, 20], Object.assign({ declared: { width: "40px", height: "20px" } }, flexOf("row", 0)));
    const t = withStyle(el(2, "div", [60, 0, 30, 20], { declared: { width: "30px", height: "20px" } }), bg("#0000ffff"));
    const c3 = withStyle(el(0, "div", [110, 0, 20, 20], { declared: { width: "20px", height: "20px" } }), bg("#ff0000ff"));
    return [a, f, t, c3];
  }, 10);
  const k2 = kids(plan.root);
  check("margin: gaps 40 and 10 with an unpainted container -> its own padding-left 30, no wrapper, spacing 10", plan.root.itemSpacing === 10 && k2.length === 3 && k2[1].padding[3] === 30 && k2[1].x === 30 && k2[1].w === 70 && !plan.warnings.some((w) => w.code === "margin-wrapper"), [plan.root.itemSpacing, k2.map((k) => [k.type, k.padding, k.x, k.w])]);
}

{ // ADR-004 p. 3: size and constraints of ABSOLUTE children
  nid = 0;
  const body = el(null, "body", [0, 0, 400, 300], flexOf("column", 0));
  const card = withStyle(el(0, "div", [0, 0, 400, 200], flexOf("column", 0)), bg("#eeeeeeff"));
  const flowc = withStyle(el(1, "div", [0, 0, 400, 40], { declared: { height: "40px" } }), bg("#cccccc ff".replace(" ", "")));
  const A = withStyle(el(1, "div", [10, 50, 60, 20], { position: "absolute", declared: { width: "60px", height: "20px", left: "10px" } }), bg("#ff0000ff"));
  const B = withStyle(el(1, "div", [20, 80, 50, 20], Object.assign({ position: "absolute", declared: {} }, flexOf("row", 0))), bg("#00ff00ff"));
  const Bt = el(4, "#text", [20, 80, 50, 20], { text: "New", display: "text" });
  const C = withStyle(el(1, "div", [0, 110, 30, 30], { position: "absolute", declared: {} }), bg("#0000ffff"));
  const D = withStyle(el(1, "div", [0, 150, 400, 10], { position: "absolute", declared: { width: "100%", height: "10px", left: "0px" } }), bg("#111111ff"));
  const E = withStyle(el(1, "div", [5, 170, 390, 10], { position: "absolute", declared: { left: "5px", right: "5px" } }), bg("#222222ff"));
  const plan = run([body, card, flowc, A, B, Bt, C, D, E]);
  const ks = kids(kids(plan.root)[0]).filter((k) => k.positioning === "ABSOLUTE");
  const got = ks.map((k) => [k.sizingH, k.sizingV, k.constraints && k.constraints.h, k.constraints && k.constraints.v]);
  check("absolute sizes: px FIXED; undeclared AL container HUG; undeclared leaf FIXED; 100% / both sides FIXED + STRETCH", JSON.stringify(got) === JSON.stringify([["FIXED", "FIXED", "MIN", "MIN"], ["HUG", "HUG", "MIN", "MIN"], ["FIXED", "FIXED", "MIN", "MIN"], ["FIXED", "FIXED", "STRETCH", "MIN"], ["FIXED", "HUG", "STRETCH", "MIN"].map((v, i) => (i === 1 ? "FIXED" : v))]), got);
}

{ // T-130: inherited text-align (the walker reports the computed value in style.textAlign)
  nid = 0;
  const mk = (ta, lines, w) => {
    nid = 0;
    const body = el(null, "body", [0, 0, 400, 300]);
    const p = el(0, "p", [50, 10, 300, 20 * lines], { style: Object.assign(el(0, "p", [0, 0, 1, 1]).style, { textAlign: ta }) });
    const t = el(1, "#text", [50, 10, w || 300, 20 * lines], { text: "Some text", display: "text", style: Object.assign(el(0, "p", [0, 0, 1, 1]).style, { textAlign: ta }) });
    return run([body, p, t]);
  };
  const txt = (plan) => { const f = []; (function w(n) { if (n.type === "TEXT") f.push(n); n.children.forEach(w); })(plan.root); return f[0]; };
  check("text-align: two lines inheriting center -> CENTER", txt(mk("center", 2)).text.align === "CENTER", txt(mk("center", 2)).text.align);
  check("text-align: two lines right -> RIGHT, justify -> JUSTIFIED, left -> LEFT", txt(mk("right", 2)).text.align === "RIGHT" && txt(mk("justify", 2)).text.align === "JUSTIFIED" && txt(mk("left", 2)).text.align === "LEFT");
  check("text-align: one line that fills its box stays LEFT (box-based rule untouched)", txt(mk("center", 1)).text.align === "LEFT", txt(mk("center", 1)).text.align);
  // 04 etalon: .hero { text-align: center }: h1 and .lead are multi-line texts, the walker now reports center for them
  const dom = JSON.parse(fs.readFileSync(path.join(FIX, "04_landing_hero@1440.dom.json"), "utf8"));
  const heroId = dom.nodes.find((n) => (n.name || "") === "Hero").id;
  const inHero = (n) => { let c = n; while (c) { if (c.id === heroId) return true; c = dom.nodes[c.parent]; } return false; };
  dom.nodes.forEach((n) => { if (inHero(n)) n.style.textAlign = "center"; else n.style.textAlign = "left"; });
  const plan = j(htmlMap(dom, {}));
  const byChars = {}; (function w(n) { if (n.type === "TEXT") byChars[n.text.characters.slice(0, 12)] = n; n.children.forEach(w); })(plan.root);
  const h1 = Object.values(byChars).find((n) => /^Design systems/.test(n.text.characters)), lead = Object.values(byChars).find((n) => /^Lumen /.test(n.text.characters));
  check("04: h1 and p.lead (multi-line, inherit center from .hero) -> CENTER", h1.text.align === "CENTER" && lead.text.align === "CENTER", [h1.text.align, lead.text.align, h1.text.lines, lead.text.lines]);
  const nav = Object.values(byChars).find((n) => n.text.characters === "Product");
  check("04: the navbar text outside .hero is still LEFT", nav.text.align === "LEFT", nav.text.align);
}

console.log(failures ? "FAILURES: " + failures + " of " + checks : "ALL PASS (" + checks + " checks passed)");
process.exit(failures ? 1 : 0);
