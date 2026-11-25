// Tests for figma-plugin-src/html-build.js (T-077, F8.3): the plan -> Figma nodes builder, run on a strict stub (tests/helpers/html-build-stub.js).
// Run: node tests/html-build.test.js
//
// What is real here and what is not (honest limits):
//  - The stub does NOT compute auto layout. Boxes (absoluteBoundingBox) come from an "oracle" that returns the plan's own boxes
//    (so the self-check passes), or deliberately wrong boxes planted by the test (so the self-check must catch them).
//    That proves the self-check logic, not that real Figma lays the plan out the same way.
//  - The stub enforces the API rules the builder depends on (FILL needs an AL parent, HUG, ABSOLUTE, loaded fonts, WRAP, image bytes),
//    so a wrong call order fails here; names and semantics of the real Plugin API are only as good as the stub's model of them.
// No dependencies, Node >= 18.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createHtmlStub } = require("./helpers/html-build-stub");

const SRC = path.join(__dirname, "..", "figma-plugin-src", "html-build.js");
const FIX = path.join(__dirname, "fixtures", "html-build");
// planning/ is outside git: next to tests/ in the project root, or 3 levels up from a .claude/worktrees/<name> checkout
const DUMP = process.env.FIGMA_DUMP_JS || [path.join(__dirname, "..", "planning", "tools", "html", "figma_dump.js"),
  path.join(__dirname, "..", "..", "..", "..", "planning", "tools", "html", "figma_dump.js")].find((p) => fs.existsSync(p)) || "planning/tools/html/figma_dump.js";

let failures = 0;
let checks = 0;
const round = (_k, v) => (typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v);
function check(name, cond, extra) {
  checks++;
  if (cond) return;
  failures++;
  console.log("  FAIL " + name + (extra !== undefined ? "  -> " + (typeof extra === "string" ? extra : JSON.stringify(extra, round)).slice(0, 600) : ""));
}
const eq = (name, got, want) => check(name, JSON.stringify(got, round) === JSON.stringify(want, round), { got, want });
const near = (name, got, want, eps = 1e-6) => check(name, Math.abs(got - want) <= eps, { got, want });

const SOURCE = fs.readFileSync(path.join(path.dirname(SRC), "html-img.js"), "utf8") + "\n" + fs.readFileSync(SRC, "utf8");
function load(stub) {
  const ctx = vm.createContext({ figma: stub.figma, console });
  vm.runInContext(SOURCE, ctx);
  return ctx;
}
const readPlan = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n + ".plan.json"), "utf8"));
const hex2 = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
const toHex = (c) => "#" + hex2(c.r) + hex2(c.g) + hex2(c.b);

// ---- oracle: the stub returns the plan's own boxes (+ the root's x,y as origin); perturb(planNode, box, node) may spoil some ----
function oracle(stub, plan, o) {
  o = o || {};
  stub.hooks.box = (node, naive) => {
    const path = [];
    let cur = node.__d;
    while (cur.parent && cur.parent.type !== "PAGE" && cur.parent.id !== o.hostId) { path.unshift(cur.parent.children.indexOf(cur.__node)); cur = cur.parent; }
    let pn = plan.root;
    for (const i of path) { pn = pn && pn.children[i]; }
    if (!pn) return naive;
    const box = { x: pn.x + cur.x, y: pn.y + cur.y, width: pn.w, height: pn.h };
    return o.perturb ? o.perturb(pn, box, node) || box : box;
  };
}
const stubKids = (n) => (n.children || []);

// ---- tree comparison: the created nodes against the plan ----
const isAL = (p) => p.layoutMode === "HORIZONTAL" || p.layoutMode === "VERTICAL";
function expectedFont(known, p, style) { return known.has((p.text.fontFamily || "Inter") + "|" + style) ? { family: p.text.fontFamily || "Inter", style } : { family: "Inter", style: "Regular" }; }
function compareNode(tag, p, n, par, known, plan) {
  const nm = tag + " " + p.name;
  const d = n.__d;
  const wantType = { FRAME: "FRAME", TEXT: "TEXT", RECTANGLE: "RECTANGLE", SVG: "FRAME", IMAGE: "RECTANGLE" }[p.type];
  let wantTypeFinal = wantType;
  if (p.type === "IMAGE" && /^data:image\/svg/.test((p.build && p.build.img) || "")) wantTypeFinal = "FRAME";
  if (p.type === "SVG" && /BADSVG/.test((p.build && p.build.svg) || "")) wantTypeFinal = "RECTANGLE";
  eq(nm + ": type", d.type, wantTypeFinal);
  eq(nm + ": name", d.name, p.name);
  eq(nm + ": visible", d.visible, p.visible !== false);
  eq(nm + ": opacity", d.opacity, p.opacity);
  // position and sizing
  const parAL = par && isAL(par);
  if (par && (!parAL || p.positioning === "ABSOLUTE")) {
    eq(nm + ": x,y relative to parent", [d.x, d.y], [p.x - par.x, p.y - par.y]);
    if (parAL) eq(nm + ": positioning ABSOLUTE", d.layoutPositioning, "ABSOLUTE");
  }
  if (!par || !parAL || p.positioning === "ABSOLUTE") eq(nm + ": sizing FIXED outside AL flow", [d.layoutSizingHorizontal, d.layoutSizingVertical], ["FIXED", "FIXED"]);
  else {
    const canHug = p.type === "TEXT" || (p.type === "FRAME" && isAL(p));
    const fix = (s) => (s === "HUG" && !canHug ? "FIXED" : s);
    eq(nm + ": sizing H,V", [d.layoutSizingHorizontal, d.layoutSizingVertical], [fix(p.sizingH), fix(p.sizingV)]);
  }
  if (p.type === "FRAME") {
    eq(nm + ": layoutMode", d.layoutMode, isAL(p) ? p.layoutMode : "NONE");
    eq(nm + ": clips", d.clipsContent, !!p.clips);
    if (isAL(p)) {
      eq(nm + ": wrap", d.layoutWrap, p.layoutMode === "HORIZONTAL" ? p.layoutWrap : "NO_WRAP");
      eq(nm + ": itemSpacing", d.itemSpacing, p.itemSpacing);
      if (p.layoutWrap === "WRAP") eq(nm + ": counterAxisSpacing", d.counterAxisSpacing, p.counterAxisSpacing);
      eq(nm + ": padding", [d.paddingTop, d.paddingRight, d.paddingBottom, d.paddingLeft], p.padding);
      eq(nm + ": alignment", [d.primaryAxisAlignItems, d.counterAxisAlignItems], [p.primaryAxisAlignItems, p.counterAxisAlignItems === "BASELINE" && p.layoutMode !== "HORIZONTAL" ? "MIN" : p.counterAxisAlignItems]);
      const horiz = p.layoutMode === "HORIZONTAL";
      const hugP = (horiz ? p.sizingH : p.sizingV) === "HUG", hugC = (horiz ? p.sizingV : p.sizingH) === "HUG";
      eq(nm + ": axis sizing modes", [d.primaryAxisSizingMode, d.counterAxisSizingMode], [hugP ? "AUTO" : "FIXED", hugC ? "AUTO" : "FIXED"]);
    }
  }
  if (p.type !== "SVG" && !(p.type === "IMAGE" && wantTypeFinal === "FRAME")) {
    // fills
    if (p.type === "IMAGE") {
      const f = d.fills[0];
      const remote = !/^data:image\/png;base64,iVBOR/.test(p.build.img);
      if (remote) eq(nm + ": placeholder fill", [f.type, toHex(f.color)], ["SOLID", "#d9d9d9"]);
      else if (/AAAA$/.test(p.build.img)) eq(nm + ": corrupt image -> placeholder", f.type, "SOLID");
      else eq(nm + ": image fill", [f.type, !!f.imageHash, f.scaleMode], ["IMAGE", true, "FILL"]);
    } else {
      eq(nm + ": fills types", d.fills.map((f) => f.type), p.fills.map((f) => f.type));
      p.fills.forEach((pf, i) => {
        const f = d.fills[i];
        if (!f) return;
        if (pf.type === "SOLID") eq(nm + ": fill " + i + " color/opacity", [toHex(f.color), f.opacity], [pf.hex, pf.opacity]);
        else eq(nm + ": gradient " + i + " first stop", [toHex(f.gradientStops[0].color), f.opacity], [pf.hex, pf.opacity]);
      });
    }
  }
  if (p.type === "FRAME" || p.type === "RECTANGLE" || p.type === "IMAGE") {
    // strokes
    if (p.strokes.length && wantTypeFinal !== "FRAME" || (p.type === "FRAME" && p.strokes.length)) {
      eq(nm + ": stroke color", d.strokes.map((s) => toHex(s.color)), p.strokes.map((s) => s.hex));
      const s = p.build.strokeSides;
      if (s && !s.every((v) => v === s[0])) eq(nm + ": per-side stroke weights", [d.strokeTopWeight, d.strokeRightWeight, d.strokeBottomWeight, d.strokeLeftWeight], s);
      else eq(nm + ": stroke weight", d.strokeWeight, p.strokeWeight);
      eq(nm + ": stroke inside", d.strokeAlign, "INSIDE");
      if (p.type === "FRAME" && isAL(p)) eq(nm + ": strokes counted in layout", d.strokesIncludedInLayout, true);
    } else if (p.type === "FRAME") eq(nm + ": no strokes", d.strokes.length, 0);
    // radius
    if (p.type !== "IMAGE" || wantTypeFinal === "RECTANGLE") {
      const r = p.radius;
      if (r.every((v) => v === r[0])) eq(nm + ": radius", d.cornerRadius, r[0]);
      else eq(nm + ": radius per corner", [d.topLeftRadius, d.topRightRadius, d.bottomRightRadius, d.bottomLeftRadius], r);
    }
  }
  // effects
  eq(nm + ": effects", d.effects.map((e) => [e.type, e.radius, e.offset.x, e.offset.y, e.spread, Math.round(e.color.a * 1e4) / 1e4, toHex(e.color)]),
    p.effects.map((e) => [e.type, e.radius, e.offset[0], e.offset[1], e.spread || 0, Math.round(e.opacity * 1e4) / 1e4, e.hex]));
  if (p.type === "TEXT") {
    const t = p.text;
    eq(nm + ": characters", d.characters, t.characters);
    eq(nm + ": font", d.fontName, expectedFont(known, p, t.fontStyle));
    eq(nm + ": fontSize/lineHeight/align", [d.fontSize, d.lineHeight, d.textAlignHorizontal], [t.fontSize, { unit: "PIXELS", value: t.lineHeight }, t.align]);
    eq(nm + ": autoResize", d.textAutoResize, t.autoResize);
    const want = [];
    for (const r of t.ranges) {
      const s = r.start, e = Math.min(t.characters.length, r.end);
      if (r.fontStyle) want.push(["fontName", s, e, expectedFont(known, p, r.fontStyle)]);
      if (r.fontSize) want.push(["fontSize", s, e, r.fontSize]);
      if (r.hex) want.push(["fills", s, e, r.hex]);
      if (r.decoration) want.push(["textDecoration", s, e, r.decoration]);
    }
    eq(nm + ": ranges", d.ranges.map((r) => [r.kind, r.start, r.end, r.kind === "fills" ? toHex(r.value[0].color) : r.value]), want);
  }
  // children
  const skipKids = p.type === "SVG" || p.type === "IMAGE";
  if (!skipKids) {
    const kids = stubKids(d);
    eq(nm + ": child names in order", kids.map((k) => k.__d.name), p.children.map((c) => c.name));
    p.children.forEach((c, i) => kids[i] && compareNode(tag, c, kids[i], p, known, plan));
  }
}
const countPlan = (p) => 1 + p.children.reduce((a, c) => a + countPlan(c), 0);

const KNOWN = new Set(["Inter|Thin", "Inter|Extra Light", "Inter|Light", "Inter|Regular", "Inter|Medium", "Inter|Semi Bold", "Inter|Bold", "Inter|Extra Bold", "Inter|Black"]);
const codes = (r) => r.warnings.map((w) => w.code);

async function buildFixture(name, opts, oopts) {
  const plan = readPlan(name);
  if (oopts && oopts.mutate) oopts.mutate(plan);
  const stub = createHtmlStub();
  const ctx = load(stub);
  let fontLoadsAtFirstNode = null;
  const cf = stub.figma.createFrame;
  stub.figma.createFrame = function () { if (fontLoadsAtFirstNode === null) fontLoadsAtFirstNode = stub.state.fontLoads.length; return cf.apply(this, arguments); };
  oracle(stub, plan, Object.assign({}, oopts));
  if (oopts && oopts.textWidth) stub.hooks.textWidth = oopts.textWidth(plan);
  const report = await ctx.htmlBuild(plan, opts);
  return { plan, stub, ctx, report, fontLoadsAtFirstNode };
}

(async () => {
  // ================= gradient math (known answers) =================
  {
    const ctx = load(createHtmlStub());
    const G = ctx.htmlBuildGradient;
    // t of a normalized node point under gradientTransform: row 1 . (x, y, 1)
    const tAt = (g, x, y) => g.gradientTransform[0][0] * x + g.gradientTransform[0][1] * y + g.gradientTransform[0][2];
    let g = G("linear-gradient(to bottom, #000000, #ffffff)", 100, 100, 1);
    eq("gradient to bottom: row 1 of the transform", g.gradientTransform[0], [0, 1, 0]);
    g = G("linear-gradient(90deg, #000000, #ffffff)", 100, 100, 1);
    eq("gradient 90deg: row 1 of the transform", g.gradientTransform[0], [1, 0, 0]);
    g = G("linear-gradient(135deg, #ff0000, #0000ff)", 200, 100, 1);
    near("gradient 135deg on 200x100: top-left corner is 0", tAt(g, 0, 0), 0);
    near("gradient 135deg on 200x100: bottom-right corner is 1", tAt(g, 1, 1), 1);
    near("gradient 135deg on 200x100: center is 0.5", tAt(g, 0.5, 0.5), 0.5);
    g = G("linear-gradient(to top right, #000, #fff)", 200, 100, 1);
    near("gradient to top right: bottom-left corner is 0", tAt(g, 0, 1), 0);
    near("gradient to top right: top-right corner is 1", tAt(g, 1, 0), 1);
    near("gradient to top right: the other diagonal is the 50% line (top-left)", tAt(g, 0, 0), 0.5);
    near("gradient to top right: the other diagonal is the 50% line (bottom-right)", tAt(g, 1, 1), 0.5);
    const det = (m) => m[0][0] * m[1][1] - m[0][1] * m[1][0];
    check("gradient transform is invertible", Math.abs(det(g.gradientTransform)) > 1e-9);
    g = G("linear-gradient(#000000, #888888, #ffffff)", 50, 50, 1);
    eq("stops: even spread 0, 0.5, 1", g.gradientStops.map((s) => s.position), [0, 0.5, 1]);
    g = G("linear-gradient(0deg, #000 10%, #888, #999, #fff 90%)", 50, 50, 1);
    eq("stops: unset positions interpolate between 10% and 90%", g.gradientStops.map((s) => Math.round(s.position * 1e4) / 1e4), [0.1, 0.3667, 0.6333, 0.9]);
    g = G("linear-gradient(to right, rgba(16, 24, 40, 0.5), transparent)", 50, 50, 0.8);
    eq("stops: rgba and transparent alpha", g.gradientStops.map((s) => Math.round(s.color.a * 100) / 100), [0.5, 0]);
    eq("gradient opacity kept", g.opacity, 0.8);
    eq("gradient: named color other than white/black is not parsed", G("linear-gradient(red, blue)", 10, 10, 1), null);
    eq("gradient: radial is not parsed", G("radial-gradient(#000, #fff)", 10, 10, 1), null);
    eq("gradient: zero box is not parsed", G("linear-gradient(#000, #fff)", 0, 10, 1), null);
  }

  // ================= stub self-checks: the rules the builder must obey are really enforced =================
  {
    const s = createHtmlStub();
    const f = s.figma.createFrame();
    const r = s.figma.createRectangle();
    s.figma.currentPage.appendChild(f);
    f.appendChild(r);
    let threw = false;
    try { r.layoutSizingHorizontal = "FILL"; } catch (e) { threw = /auto layout/.test(e.message); }
    check("stub: FILL under a non-AL parent throws", threw);
    threw = false;
    try { f.layoutSizingHorizontal = "FILL"; } catch (e) { threw = true; }
    check("stub: FILL on a node whose parent is the page throws", threw);
    threw = false;
    try { f.itemSpacing = 4; } catch (e) { threw = true; }
    check("stub: itemSpacing before layoutMode throws", threw);
    const t = s.figma.createText();
    threw = false;
    try { t.characters = "x"; } catch (e) { threw = /unloaded font/.test(e.message); }
    check("stub: characters before loadFontAsync throws", threw);
    threw = false;
    try { t.nonsense = 1; } catch (e) { threw = true; }
    check("stub: unknown property write throws", threw);
    threw = false;
    try { s.figma.createImage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])); } catch (e) { threw = true; }
    check("stub: createImage rejects non-PNG bytes", threw);
  }

  // ================= every hand-made plan builds into a tree equal to the plan =================
  const EXPECT = {
    "01_login": { codes: ["img_placeholder"] },
    "02_cards": { codes: ["img_placeholder"] },
    "03_hero": { codes: ["svg_failed", "img_failed", "font_fallback", "font_fallback"] },
    "04_canvas": { codes: ["sizing_coerced", "sizing_coerced"] }
  };
  const built = {};
  for (const name of Object.keys(EXPECT)) {
    let b;
    try { b = await buildFixture(name); } catch (e) { check(name + ": builds without an exception", false, e.stack); continue; }
    built[name] = b;
    const { plan, stub, report } = b;
    const root = stub.registry.get(report.root_id);
    check(name + ": root id returned and node exists", !!root);
    eq(name + ": created = plan.count", report.created, plan.count);
    eq(name + ": auto_layout = plan.stats.auto_layout", report.auto_layout, plan.stats.auto_layout);
    eq(name + ": warning codes", codes(report).sort(), EXPECT[name].codes.slice().sort());
    eq(name + ": no box mismatch, no fallback", [report.absolute_fallback, report.box_ok.num === report.box_ok.den, report.box_ok.den > 0], [0, true, true]);
    eq(name + ": every created node was measured", report.box_ok.den, plan.count - (name === "03_hero" ? 0 : 0) - countSvgInner(plan.root));
    eq(name + ": tree hangs on the current page", root.parent.id, stub.page.id);
    check(name + ": all fonts were loaded before the first node was created", b.fontLoadsAtFirstNode >= 1 && b.fontLoadsAtFirstNode === stub.state.fontLoads.length, [b.fontLoadsAtFirstNode, stub.state.fontLoads.length]);
    eq(name + ": every font family|style loaded once per batch", new Set(stub.state.fontLoads).size, stub.state.fontLoads.length);
    compareNode(name, plan.root, root, null, KNOWN, plan);
    eq(name + ": root x,y default 0,0", [root.x, root.y], [0, 0]);
  }
  function countSvgInner() { return 0; } // svg frames get an inner vector the plan does not know, the oracle gives it no box so it is not measured

  // warning details
  {
    const b = built["01_login"];
    const w = b.report.warnings.find((x) => x.code === "img_placeholder");
    const remote = b.plan.root.children[0].children[2].children[3].children[1];
    eq("01: image placeholder warning names the node", [w.id, w.dom], [remote.id, remote.dom]);
    check("01: image placeholder warning shows the src", /example\.com\/a\.jpg/.test(w.msg), w.msg);
    const data = b.stub.state.images;
    eq("01: the data: URI image went through createImage once", data.length, 1);
    eq("01: the icon svg was created from the plan markup", b.stub.state.svgs.length, 1);
  }
  {
    const b = built["03_hero"];
    const fw = b.report.warnings.filter((x) => x.code === "font_fallback").map((x) => x.msg);
    check("03: font_fallback names the missing font", fw.some((m) => /Fancy Sans Black/.test(m)) && fw.some((m) => /Fancy Sans Bold/.test(m)), fw);
    check("03: missing fonts were really tried", b.stub.state.fontLoads.includes("Fancy Sans|Black"), b.stub.state.fontLoads);
    const fancy = b.stub.registry.get(b.report.root_id).__d.children[b.plan.root.children.findIndex((c) => c.name === "fancy")].__d;
    eq("03: the text fell back to Inter Regular", fancy.fontName, { family: "Inter", style: "Regular" });
    eq("03: range end clamped to the text length", fancy.ranges.filter((r) => r.kind === "fills").map((r) => [r.start, r.end]), [[0, 5], [15, 19]]);
    const body = b.stub.registry.get(b.report.root_id).__d;
    eq("03: body gradient stops (to bottom, 3 stops with rgba and transparent)", body.fills[0].gradientStops.map((s) => [Math.round(s.position * 100) / 100, Math.round(s.color.a * 100) / 100]), [[0, 1], [0.6, 0.5], [1, 0]]);
    const sv = body.children.find((c) => c.__d.name === "svg-data").__d;
    eq("03: svg data: URI image became a vector frame", [sv.type, sv.width, sv.height], ["FRAME", 24, 24]);
  }
  {
    const b = built["02_cards"];
    const row = b.stub.registry.get(b.report.root_id).__d.children[1].__d;
    eq("02: wrapped row", [row.layoutWrap, row.itemSpacing, row.counterAxisSpacing], ["WRAP", 24, 24]);
    const card1 = row.children[0].__d;
    const badge = card1.children[2].__d;
    eq("02: ABSOLUTE child is placed relative to its parent", [badge.layoutPositioning, badge.x, badge.y], ["ABSOLUTE", 210, 8]);
    eq("02: card 1 has a left-only border", [card1.strokeTopWeight, card1.strokeRightWeight, card1.strokeBottomWeight, card1.strokeLeftWeight], [0, 0, 0, 4]);
  }
  {
    const b = built["01_login"];
    const body = b.stub.registry.get(b.report.root_id).__d;
    const row = body.children[0].__d.children[2].__d.children[1].__d;
    eq("01: SPACE_BETWEEN row", row.primaryAxisAlignItems, "SPACE_BETWEEN");
  }

  // ================= opts: parent, x, y, name =================
  {
    const stub = createHtmlStub();
    const host = stub.figma.createFrame();
    stub.figma.currentPage.appendChild(host);
    const plan = readPlan("04_canvas");
    oracle(stub, plan, { hostId: host.id });
    const ctx = load(stub);
    const report = await ctx.htmlBuild(plan, { parent: host, x: 120, y: 45, name: "Imported page" });
    const root = stub.registry.get(report.root_id);
    eq("opts: parent, x, y, name honored", [root.parent.id, root.x, root.y, root.name], [host.id, 120, 45, "Imported page"]);
    eq("opts: boxes measured against the root origin", [report.box_ok.num === report.box_ok.den, report.absolute_fallback], [true, 0]);
  }

  // ================= self-check (T-104): size and position judged apart, bottom-up, 2 px threshold =================
  {
    const spoil = (names, fn) => (pn, box, node) => (names.includes(pn.name) ? fn(box, pn, node) : null);
    // a physical shift: the named nodes and everything under them move together (a child never moves alone inside its parent)
    const under = (node, names) => { for (let d = node.__d; d; d = d.parent) if (names.includes(d.name)) return true; return false; };
    const shiftTree = (names, dx, dy) => (pn, box, node) => { let top = null; for (let d = node.__d; d; d = d.parent) if (names.includes(d.name)) top = d; return top && top.layoutPositioning !== "ABSOLUTE" ? Object.assign({}, box, { x: box.x + dx, y: box.y + dy }) : null; };
    const inFlow = (node) => node.__d.layoutPositioning !== "ABSOLUTE";
    const d2of = (b) => (function find(p) { return p.name === "d2" ? p : p.children.map(find).find(Boolean); })(b.plan.root);

    // a leaf (text d2) that stays 5 px off for good: one box_mismatch with the size; its container put its children ABSOLUTE once
    let b = await buildFixture("02_cards", {}, { perturb: spoil(["d2"], (box) => Object.assign({}, box, { x: box.x + 5 })) });
    const mm = b.report.warnings.filter((w) => w.code === "box_mismatch");
    eq("self-check: a leaf that stays wrong gives exactly one box_mismatch", mm.length, 1);
    eq("self-check: the warning points at the node", [mm[0].id, mm[0].dom], [d2of(b).id, d2of(b).dom]);
    check("self-check: the warning carries the size of the miss (5 px)", /by 5 px/.test(mm[0].msg), mm[0].msg);
    eq("self-check: only d2's own container fell back, nobody above it", b.report.absolute_fallback, 1);
    eq("self-check: box_ok counts the miss", b.report.box_ok.den - b.report.box_ok.num, 1);
    // the same leaf off only while it is in the flow: the ABSOLUTE placement cures it
    b = await buildFixture("02_cards", {}, { perturb: spoil(["d2"], (box, pn, node) => (inFlow(node) ? Object.assign({}, box, { x: box.x + 5 }) : null)) });
    eq("self-check: a wrong in-flow position is cured by ABSOLUTE children of ITS container only", [b.report.absolute_fallback, codes(b.report).includes("box_mismatch")], [1, false]);

    // tolerance: 1 px silent, 1.5 px reported but nothing moved, 2 px nothing moved, 2.5 px action
    b = await buildFixture("02_cards", {}, { perturb: spoil(["d2"], (box) => Object.assign({}, box, { y: box.y + 1 })) });
    eq("self-check: 1 px is tolerated, no warning", [codes(b.report).filter((c) => c === "box_mismatch").length, b.report.absolute_fallback], [0, 0]);
    b = await buildFixture("02_cards", {}, { perturb: spoil(["d2"], (box) => Object.assign({}, box, { y: box.y + 1.5 })) });
    eq("self-check: 1.5 px is reported but nothing is moved", [codes(b.report).filter((c) => c === "box_mismatch").length, b.report.absolute_fallback], [1, 0]);
    b = await buildFixture("02_cards", {}, { perturb: spoil(["d2"], (box) => Object.assign({}, box, { y: box.y + 2 })) });
    eq("self-check: exactly 2 px does not trigger a fallback", b.report.absolute_fallback, 0);
    b = await buildFixture("02_cards", {}, { perturb: spoil(["d2"], (box, pn, node) => (inFlow(node) ? Object.assign({}, box, { y: box.y + 2.5 }) : null)) });
    eq("self-check: 2.5 px triggers the fallback of its container", b.report.absolute_fallback, 1);

    // a container whose own size is wrong while its children are right: fixed IN PLACE (HUG height -> FIXED, plan size), children stay in flow
    b = await buildFixture("02_cards", {}, { perturb: (pn, box, node) => (pn.name === "Card 2" && node.__d.layoutSizingVertical !== "FIXED" ? Object.assign({}, box, { width: box.width + 10 }) : null) });
    eq("size fix: no fallback, the container is repaired on the spot", b.report.absolute_fallback, 0);
    const row = b.stub.registry.get(b.report.root_id).__d.children[1].__d;
    const c2 = row.children[1].__d;
    eq("size fix: HUG height became FIXED at the plan size", [c2.layoutSizingVertical, c2.height], ["FIXED", 220]);
    eq("size fix: its children stayed in flow", c2.children.map((k) => k.__d.layoutPositioning), ["AUTO", "AUTO"]);
    eq("size fix: siblings stayed in flow, no leftover mismatch", [row.children.map((c) => c.__d.layoutPositioning), codes(b.report).includes("box_mismatch")], [["AUTO", "AUTO", "AUTO"], false]);

    // a container whose children are the right size but at the wrong places: they go ABSOLUTE at plan offsets, nothing above it moves
    b = await buildFixture("02_cards", {}, { perturb: (pn, box, node) => (node.__d.name !== "Card 2" && under(node, ["Card 2"]) && inFlow(node) ? Object.assign({}, box, { y: box.y + 10 }) : null) });
    eq("position fix: one container fell back", b.report.absolute_fallback, 1);
    check("position fix: absolute_fallback warning with the size", b.report.warnings.some((w) => w.code === "absolute_fallback" && /max 10 px/.test(w.msg)), b.report.warnings);
    const rowB = b.stub.registry.get(b.report.root_id).__d.children[1].__d;
    eq("position fix: children are ABSOLUTE at plan offsets", rowB.children[1].__d.children.map((k) => [k.__d.layoutPositioning, k.__d.x, k.__d.y]), [["ABSOLUTE", 20, 20], ["ABSOLUTE", 20, 60]]);
    eq("position fix: siblings and the row stayed in flow", [rowB.layoutPositioning, rowB.children.map((c) => c.__d.layoutPositioning)], ["AUTO", ["AUTO", "AUTO", "AUTO"]]);

    // a leaf with a wrong SIZE is repaired on the spot (resized to the DOM box), no fallback
    const fixedCover = (p) => { p.root.children[1].children[0].children[0].sizingH = "FIXED"; };
    b = await buildFixture("02_cards", {}, { mutate: fixedCover, perturb: spoil(["cover"], (box, pn, node) => (node.__d.resizes >= 2 ? null : Object.assign({}, box, { width: box.width + 9 }))) });
    const cover = b.stub.registry.get(b.report.root_id).__d.children[1].__d.children[0].__d.children[0].__d;
    eq("leaf fix: a leaf 9 px too wide was resized to the plan box once more, no fallback, no leftover", [cover.resizes, cover.width, cover.height, b.report.absolute_fallback, codes(b.report).includes("box_mismatch")], [2, 240, 100, 0, false]);
    // one-line text is never forced to the browser width (it would wrap): the miss stays reported
    b = await buildFixture("02_cards", {}, { perturb: spoil(["new"], (box) => Object.assign({}, box, { width: box.width + 5 })) });
    const nw = [...b.stub.registry.values()].map((n) => n.__d).find((d) => d.type === "TEXT" && d.characters === "New") || [...b.stub.registry.values()].map((n) => n.__d).find((d) => d.name === "new");
    eq("leaf fix: a one-line text 5 px wider is left alone (resized only at creation), reported once", [nw.resizes, codes(b.report).filter((c) => c === "box_mismatch").length, b.report.absolute_fallback], [1, 1, 0]);

    // cards shifted whole (with their content): the ROW falls back, the cards keep their layout
    b = await buildFixture("02_cards", {}, { perturb: shiftTree(["Card 1", "Card 2"], 7, 0) });
    eq("position fix: 2 of 3 shifted cards make the row fall back, once", b.report.absolute_fallback, 1);
    const row2 = b.stub.registry.get(b.report.root_id).__d.children[1].__d;
    eq("position fix: all three cards are ABSOLUTE with plan offsets", row2.children.map((c) => [c.__d.layoutPositioning, c.__d.x, c.__d.y]), [["ABSOLUTE", 0, 0], ["ABSOLUTE", 304, 0], ["ABSOLUTE", 608, 0]]);
    eq("position fix: card contents stayed as the plan had them (the badge is ABSOLUTE in the plan itself)", row2.children[0].__d.children.map((k) => k.__d.layoutPositioning), ["AUTO", "AUTO", "ABSOLUTE"]);
    // the old cascade: one shifted node must not drag its ancestors into ABSOLUTE (it did: 25 of 56 nodes on screen 04)
    b = await buildFixture("02_cards", {}, { perturb: shiftTree(["Card 3"], 7, 0) });
    eq("cascade: one shifted card makes its row fall back once, nothing else", b.report.absolute_fallback, 1);
    check("cascade: the root stays an Auto Layout frame, the card contents stay in flow", b.stub.registry.get(b.report.root_id).__d.children.every((c) => c.__d.layoutPositioning !== "ABSOLUTE"));
  }

  // ================= text wrap guard (T-105): Figma Inter runs wider than the browser's =================
  {
    const wider = (dx) => (plan) => {
      const nat = new Map();
      (function walk(p) { if (p.type === "TEXT") nat.set(p.text.characters, p.w + dx); (p.children || []).forEach(walk); })(plan.root);
      return (d) => nat.get(d.characters) || d.width;
    };
    const texts = (stub) => [...stub.registry.values()].map((n) => n.__d).filter((d) => d.type === "TEXT" && !d.removed);
    const lhOf = (d) => d.lineHeight.unit === "PIXELS" ? d.lineHeight.value : d.fontSize * 1.2;
    // the fallback cascade (Card 2 off by 10 px) used to resize every child, one-line texts included, to the browser width
    let b = await buildFixture("02_cards", {}, {
      textWidth: wider(2),
      perturb: (pn, box, node) => {
        // Card 2's children sit 10 px low while in flow: the container falls back, its texts become ABSOLUTE
        let in2 = false;
        for (let d = node.__d.parent; d; d = d.parent) if (d.name === "Card 2") in2 = true;
        return in2 && node.__d.layoutPositioning !== "ABSOLUTE" ? Object.assign({}, box, { y: box.y + 10 }) : null;
      }
    });
    eq("wrap guard: the fallback happened", b.report.absolute_fallback, 1);
    const planLines = new Map();
    (function walk(p) { if (p.type === "TEXT") planLines.set(p.text.characters, Math.max(1, Math.round(p.h / (p.text.lineHeight || p.text.fontSize * 1.2)))); (p.children || []).forEach(walk); })(b.plan.root);
    const grown = texts(b.stub).filter((d) => Math.round(d.height / lhOf(d)) > (planLines.get(d.characters) || 1)).map((d) => d.characters);
    eq("wrap guard: no text has more lines than in the browser (fallback, +2 px)", grown, []);
    eq("wrap guard: nothing left wrapped", b.report.text_wrapped, 0);
    // without fallback: every text 2 px wider than the browser still keeps its lines
    b = await buildFixture("01_login", {}, { textWidth: wider(2) });
    const lines01 = new Map();
    (function walk(p) { if (p.type === "TEXT") lines01.set(p.text.characters, Math.max(1, Math.round(p.h / (p.text.lineHeight || p.text.fontSize * 1.2)))); (p.children || []).forEach(walk); })(b.plan.root);
    eq("wrap guard: 01_login +2 px, nothing wrapped", [b.report.text_wrapped, texts(b.stub).filter((d) => Math.round(d.height / lhOf(d)) > (lines01.get(d.characters) || 1)).map((d) => d.characters)], [0, []]);

    // direct plan: FILL / FIXED texts in a column, known answers
    const tpl = readPlan("01_login");
    let tt = null;
    (function walk(p) { if (!tt && p.type === "TEXT") tt = p; (p.children || []).forEach(walk); })(tpl.root);
    const mk = (chars, w, h, sizingH, align, lines) => Object.assign(JSON.parse(JSON.stringify(tt)), { id: "t" + chars.length, name: chars, x: 0, y: 0, w, h, sizingH, sizingV: "HUG", positioning: "AUTO",
      text: Object.assign({}, tt.text, { characters: chars, fontSize: 16, lineHeight: 20, align: align || "LEFT", autoResize: "HEIGHT", ranges: [] }, lines ? { lines } : {}) });
    const root = Object.assign(JSON.parse(JSON.stringify(tpl.root)), { x: 0, y: 0, w: 400, h: 300, layoutMode: "VERTICAL", itemSpacing: 0, padding: [0, 0, 0, 0], primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN",
      children: [mk("One line fill", 100, 20, "FILL", "LEFT", 1), mk("Two lines fixed", 100, 40, "FIXED"), mk("Far too long text", 100, 40, "FIXED"), mk("Centered fill x", 100, 20, "FILL", "CENTER")] });
    const nat = { "One line fill": 103, "Two lines fixed": 202, "Far too long text": 260, "Centered fill x": 103 };
    const stub = createHtmlStub();
    const ctx = load(stub);
    stub.hooks.textWidth = (d) => nat[d.characters] || d.width;
    const r = await ctx.htmlBuild({ root }, {});
    const byChars = Object.fromEntries(texts(stub).map((d) => [d.characters, d]));
    eq("wrap guard: one-line FILL text wrapped -> HUG, one line", [byChars["One line fill"].layoutSizingHorizontal, byChars["One line fill"].height], ["HUG", 20]);
    eq("wrap guard: two-line text got a 3rd line -> widened, 2 lines", [byChars["Two lines fixed"].height, byChars["Two lines fixed"].width <= 104], [40, true]);
    eq("wrap guard: counters (fixed 2, still wrapped 2)", [r.text_fixed, r.text_wrapped], [2, 2]);
    eq("wrap guard: a text_wrapped warning per unresolved text", r.warnings.filter((w) => w.code === "text_wrapped").length, 2);
    check("wrap guard: the warning names the text and both line counts", r.warnings.some((w) => w.code === "text_wrapped" && /3 lines, browser had 2/.test(w.msg) && /Far too long/.test(w.msg)), r.warnings);
  }

  // ================= T-103: image fill of a container, truncated text =================
  {
    const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const card3 = (p) => p.root.children[1].children[2];
    const withImg = (src) => ({ mutate: (p) => { const c = card3(p); c.fills.push({ type: "IMAGE", hex: null, opacity: 1, var: null }); c.build = Object.assign({}, c.build, { img: src }); } });
    const fillsOf = (b) => b.stub.registry.get(b.report.root_id).__d.children[1].__d.children[2].__d.fills;
    let b = await buildFixture("02_cards", {}, withImg(PNG));
    let f = fillsOf(b);
    eq("img fill: the container really got an IMAGE fill (hash, FILL) after its solid", [f.map((x) => x.type), !!f[1].imageHash, f[1].scaleMode], [["SOLID", "IMAGE"], true, "FILL"]);
    eq("img fill: one image created; the only img_ warning is the fixture's own remote cover", [b.stub.state.images.length, codes(b.report).filter((c) => /^img_/.test(c)).length], [1, 1]);
    b = await buildFixture("02_cards", {}, withImg("https://example.com/cover.jpg"));
    f = fillsOf(b);
    eq("img fill: src is not data: -> grey placeholder fill + warning, never empty", [f.map((x) => x.type), codes(b.report).filter((c) => c === "img_placeholder").length], [["SOLID", "SOLID"], 2]);
    b = await buildFixture("02_cards", {}, withImg("data:image/png;base64,AAAA"));
    f = fillsOf(b);
    eq("img fill: createImage fails -> grey placeholder fill + img_failed", [f.map((x) => x.type), codes(b.report).includes("img_failed")], [["SOLID", "SOLID"], true]);

    // truncation: 3 lines of 20 px at width 240 where the text would need 4: maxLines 3 + ENDING keep it at 3
    const clampD2 = (n, lines) => ({ mutate: (p) => { const d = p.root.children[1].children[1].children[1]; d.text.maxLines = n; d.text.truncation = "ENDING"; d.text.lines = lines; d.h = lines * 20; } });
    const natural = (plan) => (d) => (d.characters === plan.root.children[1].children[1].children[1].text.characters ? 4 * 240 - 10 : d.width);
    const textOf = (b) => [...b.stub.registry.values()].map((n) => n.__d).find((d) => d.type === "TEXT" && d.name === "d2");
    b = await buildFixture("02_cards", {}, Object.assign(clampD2(3, 3), { textWidth: natural }));
    let d2 = textOf(b);
    eq("truncation: textTruncation ENDING and maxLines 3 are set (Plugin API names)", [d2.textTruncation, d2.maxLines], ["ENDING", 3]);
    eq("truncation: Figma lays it out in 3 lines, not 4; nothing wrapped, no warning", [d2.height, b.report.text_wrapped, codes(b.report).includes("text_wrapped")], [60, 0, false]);
    b = await buildFixture("02_cards", {}, { textWidth: natural });
    d2 = textOf(b);
    eq("truncation: without maxLines the same text takes 4 lines (the stub does model it)", [d2.textTruncation === "ENDING", d2.height >= 60], [false, true]);
    b = await buildFixture("02_cards", {}, Object.assign(clampD2(1, 1), { textWidth: natural }));
    d2 = textOf(b);
    eq("truncation: one-line ellipsis keeps one line at the container width", [d2.maxLines, d2.height, d2.width], [1, 20, 240]);
  }

  // ================= ABSOLUTE child constraints (ADR-004 p. 3) =================
  {
    const b = await buildFixture("02_cards", {}, { mutate: (p) => { p.root.children[1].children[0].children[2].constraints = { h: "STRETCH", v: "MAX" }; } });
    const badge = b.stub.registry.get(b.report.root_id).__d.children[1].__d.children[0].__d.children[2].__d;
    eq("absolute child: constraints are written (Plugin API horizontal/vertical)", [badge.layoutPositioning, badge.constraints], ["ABSOLUTE", { horizontal: "STRETCH", vertical: "MAX" }]);
  }

  // ================= one failing node does not stop the build =================
  {
    const stub = createHtmlStub();
    const plan = readPlan("02_cards");
    const ctx = load(stub);
    const cr = stub.figma.createRectangle;
    let n = 0;
    stub.figma.createRectangle = function () { if (n++ === 0) throw new Error("boom"); return cr.apply(this, arguments); };
    const report = await ctx.htmlBuild(plan, {});
    check("failure: node_error warning with the message", report.warnings.some((w) => w.code === "node_error" && /boom/.test(w.msg)), report.warnings);
    eq("failure: everything else was still built", report.created, plan.count - 1);
    // a bad text property is a warning, the text stays
    const stub2 = createHtmlStub();
    const plan2 = readPlan("04_canvas");
    plan2.root.children[1].children[0].text.align = "BOGUS";
    const r2 = await load(stub2).htmlBuild(plan2, {});
    check("failure: a bad text property is a text_error warning, not an exception", r2.warnings.some((w) => w.code === "text_error"), r2.warnings);
    eq("failure: the text node still exists", r2.created, plan2.count);
    const r3 = await load(createHtmlStub()).htmlBuild({}, {});
    eq("failure: an empty plan gives a no_plan warning", codes(r3), ["no_plan"]);
  }

  // ================= figma_dump.js on the built tree (needs planning/tools/html/figma_dump.js, skipped when absent) =================
  if (!fs.existsSync(DUMP)) console.log("  SKIP figma_dump.js not found at " + DUMP);
  else {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const src = fs.readFileSync(DUMP, "utf8");
    for (const name of Object.keys(EXPECT)) {
      const b = built[name];
      if (!b) continue;
      const body = src.replace('"__ROOT__"', JSON.stringify(b.report.root_id)).replace("__PNG__", "false");
      let out;
      try { out = await new AsyncFunction("figma", body)(b.stub.figma); } catch (e) { check(name + ": figma_dump runs on the built tree", false, e.stack); continue; }
      const dumpCount = (function c(n) { return 1 + n.children.reduce((a, k) => a + c(k), 0); })(out.root);
      check(name + ": dump count covers the plan", dumpCount >= b.plan.count, [dumpCount, b.plan.count]);
      const walk = (p, d, par) => {
        const nm = name + " dump " + p.name;
        eq(nm + ": box", [d.x, d.y, d.w, d.h], [p.x - b.plan.root.x, p.y - b.plan.root.y, p.w, p.h]);
        eq(nm + ": visible, opacity", [d.visible, d.opacity], [p.visible !== false, p.opacity]);
        if (p.type === "FRAME") {
          eq(nm + ": layoutMode, padding", [d.layoutMode, d.padding], [isAL(p) ? p.layoutMode : "NONE", isAL(p) ? p.padding : [0, 0, 0, 0]]);
          if (isAL(p)) eq(nm + ": spacing, wrap, align", [d.itemSpacing, d.layoutWrap, d.primaryAxisAlignItems], [p.itemSpacing, p.layoutMode === "HORIZONTAL" ? p.layoutWrap : "NO_WRAP", p.primaryAxisAlignItems]);
        }
        if (par && isAL(par) && p.positioning !== "ABSOLUTE") {
          const canHug = p.type === "TEXT" || (p.type === "FRAME" && isAL(p));
          const fix = (s) => (s === "HUG" && !canHug ? "FIXED" : s);
          eq(nm + ": sizing H,V", [d.sizingH, d.sizingV], [fix(p.sizingH), fix(p.sizingV)]);
        }
        if (p.type === "FRAME" || p.type === "TEXT" || p.type === "RECTANGLE") {
          eq(nm + ": fill types and hex", d.fills.map((f) => [f.type, f.hex]), p.fills.filter((f) => f.type !== "IMAGE").map((f) => [f.type, f.hex]));
        }
        if (p.type === "TEXT") eq(nm + ": text", [d.text.characters, d.text.fontSize, d.text.fontStyle], [p.text.characters, p.text.fontSize, expectedFont(KNOWN, p, p.text.fontStyle).style]);
        if (p.type === "FRAME") {
          eq(nm + ": dump children match the plan by name", d.children.map((k) => k.name), p.children.map((k) => k.name));
          p.children.forEach((k, i) => d.children[i] && walk(k, d.children[i], p));
        }
      };
      walk(b.plan.root, out.root, null);
    }
  }

  console.log(failures ? "FAILURES: " + failures + " of " + checks + " checks" : "ALL PASS (" + checks + " checks passed)");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log("  FAIL harness crashed -> " + (e && e.stack)); console.log("FAILURES: crash"); process.exit(1); });
