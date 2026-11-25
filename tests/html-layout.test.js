// T-134: leading / trailing margins, block flow with different margins, flex rows with unequal flex-grow as a native GRID.
// Run: node tests/html-layout.test.js
//  (a) the 10 fixtures (dom.json) -> htmlMap -> htmlBuild on the strict stub, with an Auto Layout MODEL (tests/helpers/al-sim.js) giving the boxes
//      instead of the plan's own: absolute_fallback must be 0 and no absolute_fallback warning (04 and 06 were 2 and 1 in the live F8 re-run)
//  (b) the model is checked on a known answer: take the fix away from the plan and the fallback must come back
//  (c) hand-made trees: margins, centering, GRID rows and the cases that must stay plain rows
// Honest limits: al-sim.js is my model of Figma, not Figma (text keeps the plan size, no font metrics, FLEX tracks share the whole width by value).
// The fixtures are the Python renderer's dom.json: its flex-start / flex-end are written flow-start / flow-end, restored below (the live walker gives flex-*).
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createHtmlStub } = require("./helpers/html-build-stub");
const { createAlSim } = require("./helpers/al-sim");
const SRC = path.join(__dirname, "..", "figma-plugin-src");
const src = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
const FIX = path.join(__dirname, "fixtures", "html");

let failures = 0, checks = 0;
function check(name, ok, detail) {
  checks++;
  if (ok) return;
  failures++;
  console.log("  FAIL " + name + (detail !== undefined ? " :: " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 500) : ""));
}
const j = (x) => JSON.parse(JSON.stringify(x));
const mctx = vm.createContext({});
["html-map.js", "html-grid.js"].forEach((f) => vm.runInContext(src(f), mctx));
const readDom = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8").replace(/flow-(start|end)/g, "flex-$1"));
const flat = (p, out) => { out = out || []; out.push(p); (p.children || []).forEach((c) => flat(c, out)); return out; };
const byName = (plan, name) => flat(plan.root).find((p) => p.name === name);

async function buildWithSim(plan, o) {
  const stub = createHtmlStub();
  const wrapFrames = o && o.noGrid;
  if (wrapFrames) { // a Figma that knows no GRID: the layoutMode write throws
    const cf = stub.figma.createFrame;
    stub.figma.createFrame = function () { return new Proxy(cf.apply(this, arguments), { set(t, k, v) { if (k === "layoutMode" && v === "GRID") throw new Error("layoutMode GRID is not supported"); return Reflect.set(t, k, v); } }); };
  }
  const ctx = vm.createContext({ figma: stub.figma, console });
  ["html-img.js", "html-build.js"].forEach((f) => vm.runInContext(src(f), ctx));
  stub.hooks.box = createAlSim().hook(stub, {});
  const report = j(await ctx.htmlBuild(plan, { x: 0, y: 0 }));
  return { stub, report };
}
const fbWarn = (r) => r.warnings.filter((w) => w.code === "absolute_fallback");
const names = ["01_login_form@1440", "02_cards_row@1440", "03_table@1440", "04_landing_hero@1440", "05_mobile_profile@390", "06_dashboard@1440", "07_settings_grid@1440", "08_mobile_feed@390", "09_responsive@1440", "09_responsive@390"];

(async () => {
  // ---------- (a) all fixtures
  const plans = {};
  for (const nm of names) {
    const plan = j(mctx.htmlMap(readDom(nm + ".dom.json"), {}));
    plans[nm] = plan;
    const b = await buildWithSim(j(plan));
    check(nm + ": absolute_fallback 0", b.report.absolute_fallback === 0, b.report.absolute_fallback);
    check(nm + ": no absolute_fallback warning", fbWarn(b.report).length === 0, fbWarn(b.report));
    check(nm + ": every box within 1 px of the DOM (box_ok)", b.report.box_ok.num === b.report.box_ok.den, b.report.box_ok);
    if (nm === "04_landing_hero@1440" || nm === "06_dashboard@1440") console.log("  info: " + nm + " absolute_fallback=" + b.report.absolute_fallback + ", absolute_fallback warnings=" + fbWarn(b.report).length + ", box_ok " + b.report.box_ok.num + "/" + b.report.box_ok.den + ", warnings " + b.report.warnings.length);
  }

  // ---------- (b) the model must see the old defects (known answer)
  {
    const p06 = j(plans["06_dashboard@1440"]);
    const split = byName(p06, "Charts and activity");
    check("06: the split row carries build.grid", !!(split && split.build.grid), split && split.build);
    delete split.build.grid;
    const b = await buildWithSim(p06);
    check("model: 06 without the grid has absolute_fallback again (FILL splits 50:50)", b.report.absolute_fallback >= 1 && fbWarn(b.report).some((w) => w.dom === split.dom), [b.report.absolute_fallback]);
    const p04 = j(plans["04_landing_hero@1440"]);
    const links = byName(p04, "links");
    links.padding[3] = 0;
    const b4 = await buildWithSim(p04);
    check("model: 04 without the leading margin in padding has absolute_fallback again", b4.report.absolute_fallback >= 1 && fbWarn(b4.report).some((w) => w.dom === links.dom), [b4.report.absolute_fallback]);
  }

  // ---------- (c) 04: margins and centering in the plan
  {
    const p = plans["04_landing_hero@1440"];
    const links = byName(p, "links");
    check("04 links: itemSpacing 32, the first link's margin-left 32 is padding-left (no wrapper)", links.itemSpacing === 32 && JSON.stringify(links.padding) === "[0,0,0,32]" && links.children.length === 5, [links.itemSpacing, links.padding, links.children.length]);
    check("04 links: the padding is marked as margin-derived (build.marginPad)", JSON.stringify(links.build.marginPad) === "[0,0,0,32]", links.build.marginPad);
    const hero = byName(p, "Hero");
    check("04 Hero: block flow is a VERTICAL AL, children centered (counter axis CENTER)", hero.layoutMode === "VERTICAL" && hero.counterAxisAlignItems === "CENTER", [hero.layoutMode, hero.counterAxisAlignItems]);
    check("04 Hero: the smallest margin is the spacing (20), the other margins are padding / wrappers", hero.itemSpacing === 20, hero.itemSpacing);
    const kids = hero.children.map((k) => k.name);
    check("04 Hero: two margin wrappers (h1 +4, preview +44), actions took its +16 as its own padding", kids.filter((n) => / margin$/.test(n)).length === 2 && byName(p, "actions").padding[0] === 16, kids);
    const wr = hero.children.filter((k) => / margin$/.test(k.name)).map((k) => k.padding[0]).sort((a, b) => a - b);
    check("04 Hero: wrapper paddings are the margin differences 4 and 44", JSON.stringify(wr) === "[4,44]", wr);
    check("04: no uneven-margin warning is left", !p.warnings.some((w) => w.code === "uneven-margin"), p.warnings.filter((w) => w.code === "uneven-margin"));
    const actions = byName(p, "actions");
    check("04 actions (btn-primary margin-right 12): spacing 12, buttons in flow, still no fallback (see (a))", actions.itemSpacing === 12 && actions.children.length === 2, [actions.itemSpacing, actions.children.length]);
  }

  // ---------- (c) 06: the GRID row in the plan and on the stub
  {
    const p = plans["06_dashboard@1440"];
    const split = byName(p, "Charts and activity");
    check("06 split: plan says GRID with the measured widths (padding makes 2:1 of grow 724.67 : 387.33 outer) and gap 24", split.build.grid.gap === 24 && JSON.stringify(split.build.grid.cols) === "[724.67,387.33]", split.build.grid);
    const b = await buildWithSim(j(p));
    const root = b.stub.registry.get(b.report.root_id).__d;
    const find = (d, nm) => { if (d.name === nm) return d; for (const c of d.children || []) { const r = find(c.__d, nm); if (r) return r; } return null; };
    const g = find(root, "Charts and activity");
    check("06 stub: layoutMode GRID, 1 row x 2 columns, FLEX tracks, gap 24", g.layoutMode === "GRID" && g.gridRowCount === 1 && g.gridColumnCount === 2 && g.gridColumnGap === 24 && g.gridRowGap === 0 && JSON.stringify(g.gridColumnSizes) === '[{"type":"FLEX","value":724.67},{"type":"FLEX","value":387.33}]', [g.layoutMode, g.gridColumnSizes]);
    check("06 stub: children at (0, 0) and (0, 1), FILL horizontally", g.children.map((c) => JSON.stringify(c.__d.gridPos)).join() === '{"row":0,"col":0},{"row":0,"col":1}' && g.children.every((c) => c.__d.layoutSizingHorizontal === "FILL"), g.children.map((c) => [c.__d.gridPos, c.__d.layoutSizingHorizontal]));
    check("06: no grid warnings, no layout errors", !b.report.warnings.some((w) => /^grid_|layout_error|sizing_error/.test(w.code)), b.report.warnings.map((w) => w.code));
    const nog = await buildWithSim(j(p), { noGrid: true });
    const g2 = find(nog.stub.registry.get(nog.report.root_id).__d, "Charts and activity");
    check("a Figma without GRID: the plain HORIZONTAL row, warning grid_unsupported, the build goes on", g2.layoutMode === "HORIZONTAL" && nog.report.warnings.some((w) => w.code === "grid_unsupported") && nog.report.created === b.report.created, [g2.layoutMode, nog.report.warnings.map((w) => w.code)]);
  }

  // ---------- (c) hand-made trees
  let nid = 0;
  const el = (parent, tag, rect, extra) => Object.assign({
    id: nid++, parent: parent, tag, classes: [], name: null, component: null, variant: null, in_component: false,
    rect: { x: rect[0], y: rect[1], w: rect[2], h: rect[3] }, text: null, display: "block", flex: null, grid: null, padding: [0, 0, 0, 0],
    style: { bg: null, color: "#000000ff", borderColor: null, borderWidth: [0, 0, 0, 0], radius: [0, 0, 0, 0], fontFamily: "Inter", fontSize: 16, fontWeight: 400, lineHeight: 20, opacity: 1, boxShadow: null, bgImage: null, textAlign: "left" },
    declared: {}, tokens: {}, expect_sizing: { h: "HUG", v: "HUG" }, significant: true
  }, extra || {});
  const paint = (n, hex) => { n.style = Object.assign({}, n.style, { bg: hex || "#112233ff" }); return n; };
  const row = (gap, justify, align) => ({ display: "flex", flex: { dir: "row", wrap: false, gap: gap || 0, justify: justify || "normal", align: align || "normal" } });
  const run = (list, vw) => { const tree = { etalon: "t", viewport: { w: vw || 400, h: 300 }, page: { w: vw || 400, h: 300 }, nodes: list }; return j(mctx.htmlMap(tree, {})); };
  const grow = (g) => ({ declared: { flex: String(g) + " 1 0%", "flex-grow": String(g) } });
  {
    // plain padding-free row 2:1 -> exact grow values
    nid = 0;
    const body = el(null, "body", [0, 0, 400, 100], row(10));
    const a = paint(el(0, "div", [0, 0, 260, 100], grow(2)));
    const b = paint(el(0, "div", [270, 0, 130, 100], grow(1)));
    const plan = run([body, a, b]);
    check("grid: padding-free 2:1 row keeps the grow values [2, 1]", JSON.stringify(plan.root.build.grid) === '{"cols":[2,1],"gap":10}', plan.root.build);
    check("grid: the plan stays HORIZONTAL (a Figma without GRID still gets a row) and the children FILL", plan.root.layoutMode === "HORIZONTAL" && plan.root.children.every((k) => k.sizingH === "FILL"), plan.root.children.map((k) => k.sizingH));
    // equal grows: untouched
    nid = 0;
    const body2 = el(null, "body", [0, 0, 400, 100], row(10));
    const e1 = paint(el(0, "div", [0, 0, 195, 100], grow(1))), e2 = paint(el(0, "div", [205, 0, 195, 100], grow(1)));
    check("grid: equal flex-grow stays a plain row (no build.grid)", !run([body2, e1, e2]).root.build.grid);
    // grow mixed with a fixed width: untouched
    nid = 0;
    const body3 = el(null, "body", [0, 0, 400, 100], row(10));
    const f1 = paint(el(0, "div", [0, 0, 100, 100], { declared: { width: "100px" } })), f2 = paint(el(0, "div", [110, 0, 290, 100], grow(2)));
    check("grid: a fixed width mixed with grow stays a plain row", !run([body3, f1, f2]).root.build.grid);
    // three children 3:1:1 on a row with padding on the children: measured widths
    nid = 0;
    const body4 = el(null, "body", [0, 0, 400, 100], row(0));
    const c1 = paint(el(0, "div", [0, 0, 224, 100], Object.assign(grow(3), { padding: [0, 10, 0, 10] }))), c2 = paint(el(0, "div", [224, 0, 88, 100], Object.assign(grow(1), { padding: [0, 10, 0, 10] }))), c3 = paint(el(0, "div", [312, 0, 88, 100], Object.assign(grow(1), { padding: [0, 10, 0, 10] })));
    const p4 = run([body4, c1, c2, c3]);
    check("grid: three children with padding 20 each, grow 3:1:1: css gives 20 + 204, 20 + 68, 20 + 68 of the free 340 -> the plan uses the measured widths [224, 88, 88]", JSON.stringify(p4.root.build.grid) === '{"cols":[224,88,88],"gap":0}', p4.root.build.grid);
    const bad = run([body4, Object.assign({}, c1, { rect: { x: 0, y: 0, w: 240, h: 100 } }), Object.assign({}, c2, { rect: { x: 240, y: 0, w: 80, h: 100 } }), Object.assign({}, c3, { rect: { x: 320, y: 0, w: 80, h: 100 } })]);
    check("grid: widths that css would not produce from the grow values (min-content wins, etc.) stay a plain row", !bad.root.build.grid, bad.root.build.grid);
    // a hugging row never becomes a grid
    nid = 0;
    const body5 = el(null, "body", [0, 0, 400, 100], row(0));
    const h = paint(el(0, "div", [0, 0, 200, 40], { display: "inline-flex", flex: { dir: "row", wrap: false, gap: 10, justify: "normal", align: "normal" } }));
    const h1 = paint(el(1, "div", [0, 0, 130, 40], grow(2))), h2 = paint(el(1, "div", [140, 0, 60, 40], grow(1)));
    check("grid: an inline-flex (hugging) row stays a plain row", !run([body5, h, h1, h2]).root.children[0].build.grid);
  }
  {
    // leading margin: first child margin-left 24 in a MIN row; hugging container with a trailing margin; centered row untouched
    nid = 0;
    const body = el(null, "body", [0, 0, 400, 100], row(0, "flex-start"));
    const a = paint(el(0, "div", [24, 0, 60, 40], { declared: { width: "60px" } })), b = paint(el(0, "div", [96, 0, 60, 40], { declared: { width: "60px" } }));
    const plan = run([body, a, b]);
    check("margin: first child margin-left 24 (MIN row) -> padding-left 24, spacing 12", JSON.stringify(plan.root.padding) === "[0,0,0,24]" && plan.root.itemSpacing === 12, [plan.root.padding, plan.root.itemSpacing]);
    nid = 0;
    const bodyC = el(null, "body", [0, 0, 400, 100], row(0, "center"));
    const a2 = paint(el(0, "div", [150, 0, 40, 40], { declared: { width: "40px" } })), b2 = paint(el(0, "div", [200, 0, 40, 40], { declared: { width: "40px" } }));
    const pc = run([bodyC, a2, b2]);
    check("margin: a centered row: the free space is not a margin, padding untouched", JSON.stringify(pc.root.padding) === "[0,0,0,0]", pc.root.padding);
    nid = 0;
    const bodyH = el(null, "body", [0, 0, 400, 100], { display: "block" });
    const hug = el(0, "div", [0, 0, 130, 40], { display: "inline-flex", flex: { dir: "row", wrap: false, gap: 0, justify: "normal", align: "normal" } });
    const t1 = paint(el(1, "div", [0, 0, 50, 40], { declared: { width: "50px" } })), t2 = paint(el(1, "div", [60, 0, 50, 40], { declared: { width: "50px" } }));
    const ph = run([bodyH, hug, t1, t2]);
    const hp = flat(ph.root).find((k) => k.dom === 1);
    check("margin: a hugging row takes the first child's margin (0), the gap 10 and a trailing margin 20 as padding-right", hp && hp.padding[3] === 0 && hp.itemSpacing === 10 && hp.padding[1] === 20, hp && [hp.padding, hp.itemSpacing]);
  }
  {
    // block flow: margins 24 / 20 / 36 between children, centered children
    nid = 0;
    const body = el(null, "body", [0, 0, 400, 300], { padding: [0, 0, 0, 0] });
    const a = paint(el(0, "div", [150, 0, 100, 40], { display: "inline-block", declared: { width: "100px" } }));
    const b = paint(el(0, "div", [50, 64, 300, 40], { declared: { width: "300px" } }));
    const c = paint(el(0, "div", [50, 124, 300, 40], { declared: { width: "300px" } }));
    const plan = run([body, a, b, c]);
    check("block: gaps 24, 20 -> spacing 20, one wrapper (+4) before the 2nd child, no uneven-margin warning", plan.root.itemSpacing === 20 && plan.root.children.length === 3 && / margin$/.test(plan.root.children[1].name) && plan.root.children[1].padding[0] === 4 && !plan.warnings.some((w) => w.code === "uneven-margin"), [plan.root.itemSpacing, plan.root.children.map((k) => k.name), plan.warnings]);
    check("block: children with margin auto (all centered) -> counterAxisAlignItems CENTER", plan.root.counterAxisAlignItems === "CENTER", plan.root.counterAxisAlignItems);
    const bb = await buildWithSim(plan);
    check("block: the model agrees (no fallback)", bb.report.absolute_fallback === 0, bb.report);
  }
  console.log(failures ? "FAILURES: " + failures + " of " + checks : "ALL PASS (" + checks + " checks passed)");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log("  FAIL harness crashed -> " + (e && e.stack)); console.log("FAILURES: crash"); process.exit(1); });
