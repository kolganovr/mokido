// html-grid test (T-077, F9 9.4): CSS grid without native GRID, contract F9 section 4, rules 1-3. Run: node tests/html-grid.test.js
// Hand-made trees with a known answer + the 07 etalon (settings grid with span). No dependencies, loads the plugin parts through vm.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createHtmlStub } = require("./helpers/html-build-stub");

const SRC = path.join(__dirname, "..", "figma-plugin-src");
let failures = 0, checks = 0;
function check(name, ok, detail) {
  checks++;
  if (ok) return;
  failures++;
  console.log("  FAIL " + name + (detail !== undefined ? " :: " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 500) : ""));
}
const ctx = vm.createContext({});
["html-map.js", "html-grid.js", "html-ds.js"].forEach((f) => vm.runInContext(fs.readFileSync(path.join(SRC, f), "utf8"), ctx));
const j = (x) => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------- hand-made trees
function el(parent, tag, rect, extra) {
  return Object.assign({
    id: 0, parent: parent, tag: tag, classes: [], name: null, component: null, variant: null, in_component: false,
    rect: { x: rect[0], y: rect[1], w: rect[2], h: rect[3] }, text: null, display: "block", flex: null, grid: null, padding: [0, 0, 0, 0],
    style: { bg: "#cccccc", color: "#000000ff", borderColor: null, borderWidth: [0, 0, 0, 0], radius: [0, 0, 0, 0], fontFamily: "Inter", fontSize: 16, fontWeight: 400, lineHeight: 20, opacity: 1, boxShadow: null, bgImage: null },
    declared: {}, tokens: {}, significant: true
  }, extra || {});
}
// a grid of boxes [x, y, w, h, declared] inside a body `w` wide (default 400); returns { plan, grid }
function gridPlan(cols, gaps, boxes, o) {
  o = o || {};
  const w = o.w || 400;
  const list = [
    el(null, "body", [0, 0, w, 600], { display: "flex", flex: { dir: "column", wrap: false, gap: 0, justify: "normal", align: "normal" } }),
    el(0, "div", [0, 0, w, 500], { display: "grid", grid: { cols: cols, rowGap: gaps[0], colGap: gaps[1] }, declared: o.declared || {}, significant: true })
  ];
  boxes.forEach((b) => list.push(el(1, "div", [b[0], b[1], b[2], b[3]], { declared: b[4] || {} })));
  list.forEach((n, i) => (n.id = i));
  const plan = j(ctx.htmlMap({ etalon: "t", viewport: { w: w, h: 600 }, page: { w: w, h: 600 }, nodes: list }, {}));
  return { plan: plan, grid: plan.root.children[0] };
}
const noAbs = (p) => { let n = 0; (function w(x) { (x.children || []).forEach((c) => { if (c.positioning === "ABSOLUTE") n++; w(c); }); })(p.root); return n === 0 && p.stats.absolute === 0; };
const sz = (g) => g.children.map((k) => k.sizingH + ":" + (k.sizingH === "FIXED" ? k.w : ""));
const codes = (p) => p.warnings.map((w) => w.code);

{ // rule 1: one row, tracks fill the container: HORIZONTAL, no wrap, gap, FILL
  const { plan, grid } = gridPlan("120px 120px 120px", [0, 20], [[0, 0, 120, 50], [140, 0, 120, 50], [280, 0, 120, 50]]);
  check("rule 1 fr: HORIZONTAL without wrap, gap 20", grid.layoutMode === "HORIZONTAL" && grid.layoutWrap === "NO_WRAP" && grid.itemSpacing === 20, grid);
  check("rule 1 fr: children FILL", sz(grid).join() === "FILL:,FILL:,FILL:", sz(grid));
  check("rule 1 fr: no row frames, no grid_rows, no ABSOLUTE", grid.children.length === 3 && !codes(plan).includes("grid_rows") && noAbs(plan), codes(plan));
}
{ // rule 1: px tracks (authored in px) are FIXED
  const { grid } = gridPlan("100px 200px", [0, 10], [[0, 0, 100, 50], [110, 0, 200, 50]], { w: 600, declared: { "grid-template-columns": "100px 200px" } });
  check("rule 1 px: HORIZONTAL, FIXED by track", grid.layoutMode === "HORIZONTAL" && sz(grid).join() === "FIXED:100,FIXED:200", sz(grid));
}
{ // rule 1: a mixed template "100px 1fr": the px track FIXED, the fr track FILL (authored template from the walker)
  const { grid } = gridPlan("100px 290px", [0, 10], [[0, 0, 100, 50], [110, 0, 290, 50]], { declared: { "grid-template-columns": "100px 1fr" } });
  check("rule 1 mixed: FIXED then FILL", sz(grid).join() === "FIXED:100,FILL:", sz(grid));
}
{ // rule 1: fewer children than tracks: they must not stretch over the empty track
  const { grid } = gridPlan("120px 120px 120px", [0, 20], [[0, 0, 120, 50], [140, 0, 120, 50]]);
  check("rule 1 partial row: FIXED by track, HORIZONTAL", grid.layoutMode === "HORIZONTAL" && sz(grid).join() === "FIXED:120,FIXED:120", sz(grid));
}
{ // rule 2: several rows, equal tracks, no span: HORIZONTAL + WRAP, both gaps, FIXED by track
  const { plan, grid } = gridPlan("190px 190px", [20, 20], [[0, 0, 190, 60], [210, 0, 190, 60], [0, 80, 190, 60], [210, 80, 190, 60], [0, 160, 190, 60]]);
  check("rule 2: HORIZONTAL WRAP, gaps 20/20", grid.layoutMode === "HORIZONTAL" && grid.layoutWrap === "WRAP" && grid.itemSpacing === 20 && grid.counterAxisSpacing === 20, grid);
  check("rule 2: children FIXED 190, no row frames, no grid_rows, no ABSOLUTE", sz(grid).every((s) => s === "FIXED:190") && grid.children.length === 5 && !codes(plan).includes("grid_rows") && noAbs(plan), sz(grid));
  const u = gridPlan("190px 190px", [30, 20], [[0, 0, 190, 60], [210, 0, 190, 60], [0, 90, 190, 60], [210, 90, 190, 60]]);
  check("rule 2: row gap and column gap kept apart", u.grid.itemSpacing === 20 && u.grid.counterAxisSpacing === 30, u.grid);
}
{ // rule 3: span: VERTICAL of row frames "row 1", "row 2", warning grid_rows
  const { plan, grid } = gridPlan("190px 190px", [20, 20], [[0, 0, 400, 50, { "grid-column": "span 2" }], [0, 70, 190, 60], [210, 70, 190, 60]]);
  check("rule 3 span: VERTICAL, row gap", grid.layoutMode === "VERTICAL" && grid.itemSpacing === 20, grid);
  check("rule 3 span: frames row 1, row 2", grid.children.map((k) => k.name).join() === "row 1,row 2" && grid.children.every((k) => k.type === "FRAME" && k.layoutMode === "HORIZONTAL" && k.sizingH === "FILL" && k.sizingV === "HUG"), grid.children.map((k) => k.name));
  check("rule 3 span: the spanning child is alone in row 1 and FILL", grid.children[0].children.length === 1 && grid.children[0].children[0].sizingH === "FILL", grid.children[0]);
  check("rule 3 span: row 2 is a one-row grid, gap 20, FILL FILL", grid.children[1].itemSpacing === 20 && grid.children[1].children.map((k) => k.sizingH).join() === "FILL,FILL", grid.children[1]);
  check("rule 3 span: grid_rows warning, no ABSOLUTE", codes(plan).includes("grid_rows") && noAbs(plan), codes(plan));
  check("rule 3 span: layer count follows (body + grid + 2 row frames + 3 boxes)", plan.count === 1 + 1 + 2 + 3, plan.count);
  const e = gridPlan("190px 190px", [20, 20], [[0, 0, 400, 50, { "grid-column": "1 / 3" }], [0, 70, 190, 60], [210, 70, 190, 60]]);
  check("rule 3: span written as 1 / 3", e.grid.layoutMode === "VERTICAL", e.grid.layoutMode);
}
{ // rule 3: unequal tracks without span: rows with FIXED / FILL by their own track
  const { plan, grid } = gridPlan("100px 290px", [20, 10], [[0, 0, 100, 40], [110, 0, 290, 40], [0, 60, 100, 40], [110, 60, 290, 40]], { declared: { "grid-template-columns": "100px 1fr" } });
  check("rule 3 unequal: VERTICAL of 2 rows + grid_rows", grid.layoutMode === "VERTICAL" && grid.children.length === 2 && codes(plan).includes("grid_rows"), grid);
  check("rule 3 unequal: FIXED 100 + FILL in every row", grid.children.every((r) => r.children.map((k) => k.sizingH + (k.sizingH === "FIXED" ? k.w : "")).join() === "FIXED100,FILL"), grid.children.map((r) => r.children.map((k) => k.sizingH)));
}
{ // a row that does not start at the first track keeps the offset as the row's left padding
  const { grid } = gridPlan("190px 190px", [20, 20], [[0, 0, 400, 50, { "grid-column": "span 2" }], [210, 70, 190, 60]]);
  check("rule 3: second-track child gets padding-left 210 and FIXED", grid.children[1].padding[3] === 210 && grid.children[1].children[0].sizingH === "FIXED", grid.children[1]);
}
{ // no usable tracks (not px): the F8 behaviour, no crash
  const { plan, grid } = gridPlan("none", [10, 10], [[0, 0, 100, 40], [110, 0, 100, 40]]);
  check("no tracks: HORIZONTAL WRAP as in F8", grid.layoutMode === "HORIZONTAL" && grid.layoutWrap === "WRAP" && noAbs(plan), grid);
}
check("htmlGridStrategy is the one extension point", typeof ctx.htmlGridStrategy === "function");

// ---------------------------------------------------------------- gap tokens (9.4 follow-up): by meaning, on the plan and on the stub
const gv = (list) => ({ collections: [{ id: "C:1", name: "DS", defaultModeId: "m", modes: [{ modeId: "m", name: "D" }] }], variables: list.map((x, i) => ({ id: "V:" + (i + 1), name: x[0], resolvedType: "FLOAT", variableCollectionId: "C:1", remote: false, valuesByMode: { m: x[1] } })) });
const GV = gv([["space/8", 8], ["space/16", 16], ["space/24", 24]]);
async function gapCase(cols, rowGap, colGap, decl, boxes, w) {
  const g = gridPlan(cols, [rowGap, colGap], boxes, { w: w || 400, declared: decl });
  g.plan.root.children[0].name = "g";
  const stub = createHtmlStub({ variables: GV });
  const b = vm.createContext({ figma: stub.figma, console });
  ["html-ds.js", "html-img.js", "html-build.js"].forEach((f) => vm.runInContext(fs.readFileSync(path.join(SRC, f), "utf8"), b));
  const rep = await b.htmlBuild(g.plan, {});
  const root = stub.registry.get(rep.root_id);
  const find = (pred) => { let hit = null; (function w(n) { if (!hit && pred(n)) hit = n; (n.children || []).forEach(w); })(root); return hit; };
  const nm = (n, f) => { const x = n && n.boundVariables && n.boundVariables[f]; const v = x && GV.variables.find((y) => y.id === x.id); return v ? v.name : null; };
  return { g: g, find: find, nm: nm, rep: rep };
}
const SPANNED = [[0, 0, 400, 50, { "grid-column": "span 2" }], [0, 66, 192, 60], [208, 66, 192, 60]];
const SPANNED2 = [[0, 0, 400, 50, { "grid-column": "span 2" }], [0, 74, 196, 60], [204, 74, 196, 60]];
const EQ4 = (cw, rg, cg) => [[0, 0, cw, 60], [cw + cg, 0, cw, 60], [0, 60 + rg, cw, 60], [cw + cg, 60 + rg, cw, 60]];
const gapRun = (async () => {
  { // rows + shorthand gap: both gaps are the one token
    const r = await gapCase("192px 192px", 16, 16, { gap: "var(--space-16)" }, SPANNED);
    const row1 = r.find((n) => n.name === "row 1"), row2 = r.find((n) => n.name === "row 2");
    check("gap rows+shorthand: grid itemSpacing bound to space/16 (row gap), plan keeps it once", r.nm(r.find((n) => n.name === "g"), "itemSpacing") === "space/16", r.g.plan.root.children[0].bound);
    check("gap rows+shorthand: every row frame itemSpacing bound to space/16", r.nm(row1, "itemSpacing") === "space/16" && r.nm(row2, "itemSpacing") === "space/16", [row1 && row1.boundVariables, row2 && row2.boundVariables]);
  }
  { // rows + separate tokens: row-gap to the stack, column-gap to the rows
    const r = await gapCase("196px 196px", 24, 8, { "row-gap": "var(--space-24)", "column-gap": "var(--space-8)" }, SPANNED2);
    check("gap rows+separate: stack itemSpacing = row-gap token space/24", r.nm(r.find((n) => n.name === "g"), "itemSpacing") === "space/24", r.g.plan.root.children[0].bound);
    check("gap rows+separate: row frames itemSpacing = column-gap token space/8", ["row 1", "row 2"].every((x) => r.nm(r.find((n) => n.name === x), "itemSpacing") === "space/8"));
    check("gap rows: the stack is not bound to the column-gap token", r.g.plan.root.children[0].bound.itemSpacing === "--space-24", r.g.plan.root.children[0].bound);
  }
  { // wrap + shorthand and separate tokens: column-gap -> itemSpacing, row-gap -> counterAxisSpacing
    const a = await gapCase("190px 190px", 16, 16, { gap: "var(--space-16)" }, EQ4(190, 16, 16), 396);
    const ga = a.find((n) => n.name === "g");
    check("gap wrap+shorthand: itemSpacing and counterAxisSpacing both space/16", a.nm(ga, "itemSpacing") === "space/16" && a.nm(ga, "counterAxisSpacing") === "space/16", ga && ga.boundVariables);
    const b = await gapCase("196px 196px", 24, 8, { "row-gap": "var(--space-24)", "column-gap": "var(--space-8)" }, EQ4(196, 24, 8));
    const gb = b.find((n) => n.name === "g");
    check("gap wrap+separate: column-gap space/8 -> itemSpacing, row-gap space/24 -> counterAxisSpacing", b.nm(gb, "itemSpacing") === "space/8" && b.nm(gb, "counterAxisSpacing") === "space/24", gb && gb.boundVariables);
    check("gap wrap: no row frames", !b.find((n) => n.name === "row 1"));
  }
})();

// ---------------------------------------------------------------- etalon 07 and the stub
const T07 = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "html", "07_settings_grid@1440.dom.json"), "utf8"));
const p07 = j(ctx.htmlMap(T07, {}));
const grids = [];
(function w(x) { if (x.dom != null && T07.nodes[x.dom] && T07.nodes[x.dom].grid) grids.push(x); (x.children || []).forEach(w); })(p07.root);
check("07: three grids found in the plan", grids.length === 3, grids.length);
check("07: every grid has span: VERTICAL of row frames, never ABSOLUTE", grids.every((g) => g.layoutMode === "VERTICAL" && g.children.every((r) => /^row \d+$/.test(r.name) && r.layoutMode === "HORIZONTAL")) && noAbs(p07), grids.map((g) => g.layoutMode));
check("07: rows 4 + 3 + 2, one grid_rows per grid", grids.map((g) => g.children.length).join() === "4,3,2" && p07.warnings.filter((w) => w.code === "grid_rows").length === 3, grids.map((g) => g.children.length));
check("07: in a row the 468 px tracks fill the container: FILL", grids.every((g) => g.children.every((r) => r.children.every((k) => k.sizingH === "FILL"))), "sizing");

(async () => { await gapRun;
  // the same tree built on the strict stub: row frames are made as ordinary frames
  const stub = createHtmlStub({});
  const bctx = vm.createContext({ figma: stub.figma, console, setTimeout, clearTimeout, Promise });
  bctx.activeCheckpoint = { created: [] };
  bctx.getFreeCanvasPosition = () => ({ x: 5000, y: 100 });
  stub.figma.ui = { postMessage(m) { if (m.type === "HTML_WALK") setTimeout(() => bctx.htmlBridgeOnTree({ type: "HTML_TREE", reqId: m.reqId, tree: T07 }), 0); } };
  ["html-map.js", "html-grid.js", "html-img.js", "html-build.js", "html-bridge.js"].forEach((f) => vm.runInContext(fs.readFileSync(path.join(SRC, f), "utf8"), bctx));
  const r = j(await bctx.htmlBridgeFromHtml("<div/>", { name: "S07" }));
  check("07 on the stub: builds, +9 row layers (66 -> 75), grid_rows 3", r.ok === true && r.layers === 75 && r.warning_counts && r.warning_counts.grid_rows === 3, r);
  check("07 on the stub: response under 3500 bytes", Buffer.byteLength(JSON.stringify(r)) <= 3500, Buffer.byteLength(JSON.stringify(r)));
  console.log(failures ? "FAILURES: " + failures + " of " + checks : "ALL PASS (" + checks + " checks passed)");
  process.exit(failures ? 1 : 0);
})();
