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
const DUMP = process.env.FIGMA_DUMP_JS || path.join(__dirname, "..", "..", "..", "..", "planning", "tools", "html", "figma_dump.js");

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

const SOURCE = fs.readFileSync(SRC, "utf8");
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
  const stub = createHtmlStub();
  const ctx = load(stub);
  let fontLoadsAtFirstNode = null;
  const cf = stub.figma.createFrame;
  stub.figma.createFrame = function () { if (fontLoadsAtFirstNode === null) fontLoadsAtFirstNode = stub.state.fontLoads.length; return cf.apply(this, arguments); };
  oracle(stub, plan, Object.assign({}, oopts));
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

  // ================= self-check: it catches boxes that are wrong (known answers) =================
  {
    // a leaf (text) off by 5 px: reported with the size, no fallback (a text does not make its container diverge)
    const planOf = () => readPlan("02_cards");
    const spoil = (names, fn) => (pn, box, node) => (names.includes(pn.name) ? fn(box, pn, node) : null);
    let b = await buildFixture("02_cards", {}, { perturb: spoil(["d2"], (box) => Object.assign({}, box, { x: box.x + 5 })) });
    const mm = b.report.warnings.filter((w) => w.code === "box_mismatch");
    eq("self-check: one wrong leaf gives exactly one box_mismatch", mm.length, 1);
    const d2 = (function find(p) { return p.name === "d2" ? p : p.children.map(find).find(Boolean); })(b.plan.root);
    eq("self-check: the warning points at the node", [mm[0].id, mm[0].dom], [d2.id, d2.dom]);
    check("self-check: the warning carries the size of the miss (5 px)", /by 5 px/.test(mm[0].msg), mm[0].msg);
    eq("self-check: box_ok counts the miss", [b.report.box_ok.den - b.report.box_ok.num, b.report.absolute_fallback], [1, 0]);

    // a miss of exactly 1 px is within tolerance, 1.5 px is not
    b = await buildFixture("02_cards", {}, { perturb: spoil(["d2"], (box) => Object.assign({}, box, { y: box.y + 1 })) });
    eq("self-check: 1 px is tolerated", codes(b.report).filter((c) => c === "box_mismatch").length, 0);
    b = await buildFixture("02_cards", {}, { perturb: spoil(["d2"], (box) => Object.assign({}, box, { y: box.y + 1.5 })) });
    eq("self-check: 1.5 px is reported", codes(b.report).filter((c) => c === "box_mismatch").length, 1);

    // a container whose own box is wrong while its children are in flow: children go ABSOLUTE by plan boxes
    b = await buildFixture("02_cards", {}, {
      perturb: (pn, box, node) => {
        if (pn.name !== "Card 2") return null;
        const kidsAbsolute = node.__d.children.some((c) => c.__d.layoutPositioning === "ABSOLUTE");
        return kidsAbsolute ? null : Object.assign({}, box, { width: box.width + 10 });
      }
    });
    eq("fallback: one container fell back", b.report.absolute_fallback, 1);
    check("fallback: absolute_fallback warning with the size", b.report.warnings.some((w) => w.code === "absolute_fallback" && /max 10 px/.test(w.msg)), b.report.warnings);
    const row = b.stub.registry.get(b.report.root_id).__d.children[1].__d;
    const c2 = row.children[1].__d;
    eq("fallback: children of the container are ABSOLUTE at plan offsets", c2.children.map((k) => [k.__d.layoutPositioning, k.__d.x, k.__d.y]), [["ABSOLUTE", 20, 20], ["ABSOLUTE", 20, 60]]);
    eq("fallback: HUG height of the container became FIXED, the plan size set", [c2.layoutSizingVertical, c2.height], ["FIXED", 220]);
    eq("fallback: the siblings stayed in flow", row.children.map((c) => c.__d.layoutPositioning), ["AUTO", "AUTO", "AUTO"]);
    eq("fallback: after it the boxes agree, no leftover mismatch", [b.report.box_ok.num === b.report.box_ok.den, codes(b.report).includes("box_mismatch")], [true, false]);

    // half of the in-flow children wrong -> the parent row diverged as a whole
    b = await buildFixture("02_cards", {}, {
      perturb: (pn, box, node) => {
        if (pn.name !== "Card 1" && pn.name !== "Card 2") return null;
        const rowNode = node.__d.parent;
        return rowNode.children.some((c) => c.__d.layoutPositioning === "ABSOLUTE") ? null : Object.assign({}, box, { x: box.x + 7 });
      }
    });
    eq("fallback: 2 of 3 wrong cards make the row fall back", b.report.absolute_fallback, 1);
    const row2 = b.stub.registry.get(b.report.root_id).__d.children[1].__d;
    eq("fallback: all three cards are ABSOLUTE with plan offsets", row2.children.map((c) => [c.__d.layoutPositioning, c.__d.x, c.__d.y]), [["ABSOLUTE", 0, 0], ["ABSOLUTE", 304, 0], ["ABSOLUTE", 608, 0]]);
    // 1 of 3 wrong -> no fallback (just a warning)
    b = await buildFixture("02_cards", {}, { perturb: (pn, box) => (pn.name === "Card 3" ? Object.assign({}, box, { x: box.x + 7 }) : null) });
    // Card 3 itself is wrong, which makes Card 3 (a container) fall back, but not the row
    eq("fallback: one wrong card falls back alone, not its row", b.report.absolute_fallback, 1);
    const row3 = b.stub.registry.get(b.report.root_id).__d.children[1].__d;
    eq("fallback: row kids stay in flow", row3.children.map((c) => c.__d.layoutPositioning), ["AUTO", "AUTO", "AUTO"]);
    void planOf;
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
