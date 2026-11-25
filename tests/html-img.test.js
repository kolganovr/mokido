// T-135: <img> with an SVG source becomes a vector (createNodeFromSvg) fitted by object-fit, not an IMAGE fill. Run: node tests/html-img.test.js
//  (a) the translator keeps an svg img a leaf (no merge into the container fill), layer name from alt / "image"
//  (b) the builder on the strict stub: base64 and url-encoded data URIs, cover / contain / fill / none, raster not broken, broken svg
// Honest limit: the stub does not render svg; the fit is checked on the markup sizes handed to createNodeFromSvg and on the clip frame.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createHtmlStub } = require("./helpers/html-build-stub");
const SRC = path.join(__dirname, "..", "figma-plugin-src");
const src = (f) => fs.readFileSync(path.join(SRC, f), "utf8");

let failures = 0, checks = 0;
function check(name, ok, detail) {
  checks++;
  if (ok) return;
  failures++;
  console.log("  FAIL " + name + (detail !== undefined ? " :: " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 400) : ""));
}
const j = (x) => JSON.parse(JSON.stringify(x));

// ---------- (a) translator
const mctx = vm.createContext({});
["html-map.js", "html-grid.js"].forEach((f) => vm.runInContext(src(f), mctx));
let nid = 0;
function el(parent, tag, rect, extra) {
  return Object.assign({
    id: nid++, parent: parent === null ? null : parent, tag, classes: [], name: null, component: null, variant: null, in_component: false,
    rect: { x: rect[0], y: rect[1], w: rect[2], h: rect[3] }, text: null, display: "block", flex: null, grid: null, padding: [0, 0, 0, 0],
    style: { bg: null, color: "#000000ff", borderColor: null, borderWidth: [0, 0, 0, 0], radius: [0, 0, 0, 0], fontFamily: "Inter", fontSize: 16, fontWeight: 400, lineHeight: 20, opacity: 1, boxShadow: null, bgImage: null, textAlign: "left" },
    declared: {}, tokens: {}, expect_sizing: { h: "HUG", v: "HUG" }, significant: true
  }, extra || {});
}
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="390" height="200" viewBox="0 0 390 200"><rect width="390" height="200" fill="#e8708d"/></svg>';
const B64 = "data:image/svg+xml;base64," + Buffer.from(SVG).toString("base64");
const URLENC = "data:image/svg+xml;utf8," + encodeURIComponent(SVG);
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
function mapMedia(srcUrl, extraImg) {
  nid = 0;
  const body = el(null, "body", [0, 0, 400, 300]);
  const media = el(0, "div", [0, 0, 356, 180], { position: "relative", declared: { height: "180px" } });
  const img = el(1, "img", [0, 0, 356, 180], { src: srcUrl, alt: "Cover", objectFit: "cover", declared: { width: "100%", height: "100%" }, significant: true });
  Object.assign(img, extraImg || {});
  const tag = el(1, "div", [10, 10, 60, 20], { position: "absolute", style: Object.assign(el(0, "div", [0, 0, 1, 1]).style, { bg: "#ffffffff" }) });
  const txt = el(3, "#text", [14, 12, 40, 16], { text: "Tag", display: "text" });
  const tree = { etalon: "t", viewport: { w: 400, h: 300 }, page: { w: 400, h: 300 }, nodes: [body, media, img, tag, txt] };
  return j(mctx.htmlMap(tree, {}));
}
const flat = (p, out) => { out = out || []; out.push(p); (p.children || []).forEach((c) => flat(c, out)); return out; };
{
  const plan = mapMedia(B64);
  const all = flat(plan.root);
  const im = all.find((p) => p.type === "IMAGE");
  check("map: svg img stays a leaf IMAGE node (not merged into the container fill)", !!im, all.map((p) => p.type + ":" + p.name));
  check("map: no IMAGE fill on the container", !all.some((p) => p.type === "FRAME" && p.fills.some((f) => f.type === "IMAGE")), all.map((p) => p.fills.map((f) => f.type)));
  check("map: layer name from alt", im && im.name === "Cover", im && im.name);
  check("map: object-fit and svg src travel in build", im && im.build.fit === "cover" && im.build.img === B64, im && im.build);
  check("map: the absolute tag chip is still ABSOLUTE", all.some((p) => p.positioning === "ABSOLUTE"), all.map((p) => p.positioning));
  const p2 = mapMedia(B64, { alt: null });
  check("map: no alt -> layer name image", flat(p2.root).find((p) => p.type === "IMAGE").name === "image");
  const p3 = mapMedia("pic.svg");
  check("map: external .svg is not merged into a fill either", flat(p3.root).some((p) => p.type === "IMAGE") && !flat(p3.root).some((p) => p.type === "FRAME" && p.fills.some((f) => f.type === "IMAGE")));
  const pr = mapMedia(PNG);
  const ar = flat(pr.root);
  check("map: raster img still merges into the container fill", !ar.some((p) => p.type === "IMAGE") && ar.some((p) => p.type === "FRAME" && p.fills.some((f) => f.type === "IMAGE")), ar.map((p) => p.type));
}

// ---------- (b) builder
function leaf(over) {
  return Object.assign({
    id: "p1", dom: 1, name: "image", type: "IMAGE", x: 0, y: 0, w: 356, h: 180, visible: true, layoutMode: "NONE", layoutWrap: "NO_WRAP", itemSpacing: 0, counterAxisSpacing: 0, padding: [0, 0, 0, 0],
    primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN", sizingH: "FIXED", sizingV: "FIXED", positioning: "AUTO", opacity: 1, clips: false,
    fills: [{ type: "IMAGE", hex: null, opacity: 1, var: null }], strokes: [], strokeWeight: 0, radius: [0, 0, 0, 0], effects: [], bound: {}, component: null, text: null,
    build: { tokens: {}, componentHint: null, img: B64, fit: "cover" }, children: []
  }, over || {});
}
async function build(imgOver) {
  const root = { id: "p0", dom: 0, name: "root", type: "FRAME", x: 0, y: 0, w: 400, h: 300, visible: true, layoutMode: "NONE", layoutWrap: "NO_WRAP", itemSpacing: 0, counterAxisSpacing: 0, padding: [0, 0, 0, 0],
    primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN", sizingH: "FIXED", sizingV: "FIXED", positioning: "AUTO", opacity: 1, clips: false, fills: [], strokes: [], strokeWeight: 0, radius: [0, 0, 0, 0],
    effects: [], bound: {}, component: null, text: null, build: { tokens: {}, componentHint: null }, children: [leaf(imgOver)] };
  const stub = createHtmlStub();
  const ctx = vm.createContext({ figma: stub.figma, console });
  vm.runInContext(src("html-img.js") + "\n" + src("html-build.js"), ctx);
  const report = j(await ctx.htmlBuild({ root }, { x: 0, y: 0 }));
  const rootNode = stub.registry.get(report.root_id);
  const kid = rootNode.__d.children[0].__d;
  return { stub, report, kid, codes: report.warnings.map((w) => w.code) };
}
const attr = (svg, a) => { const m = new RegExp("<svg\\b[^>]*\\s" + a + '="([^"]*)"').exec(svg); return m ? m[1] : null; };

(async () => {
  {
    const b = await build();
    const svg = b.stub.state.svgs[0] || "";
    const k = b.kid;
    check("cover base64: createNodeFromSvg got the svg, no createImage", b.stub.state.svgs.length === 1 && b.stub.state.images.length === 0, [b.stub.state.svgs.length, b.stub.state.images.length]);
    check("cover: svg markup scaled by the bigger side (356 x 182.56)", attr(svg, "width") === "356" && Math.abs(+attr(svg, "height") - 182.56) < 0.01, [attr(svg, "width"), attr(svg, "height")]);
    check("cover: clip frame of the img box holds the vector, centered", k.type === "FRAME" && k.clipsContent === true && k.width === 356 && k.height === 180 && k.children.length === 1, [k.type, k.clipsContent, k.width, k.height]);
    const v = k.children[0].__d;
    check("cover: vector is centered (overflows top and bottom equally)", v.x === 0 && Math.abs(v.y + 1.28) < 0.01, [v.x, v.y]);
    check("cover: layer name image, no warnings", k.name === "image" && b.report.warnings.length === 0, [k.name, b.codes]);
  }
  {
    const b = await build({ build: { tokens: {}, componentHint: null, img: URLENC, fit: "contain" } });
    const svg = b.stub.state.svgs[0] || "";
    check("contain urlencoded: scaled by the smaller side (351 x 180)", Math.abs(+attr(svg, "width") - 351) < 0.01 && attr(svg, "height") === "180", [attr(svg, "width"), attr(svg, "height")]);
    const v = b.kid.children[0].__d;
    check("contain: bands left and right, vector centered", b.kid.clipsContent === true && Math.abs(v.x - 2.5) < 0.01 && v.y === 0, [v.x, v.y]);
    check("contain: svg markup is still a valid svg root (xmlns kept)", /^<svg xmlns=/.test(svg) && b.report.warnings.length === 0, svg.slice(0, 80));
  }
  {
    const b = await build({ build: { tokens: {}, componentHint: null, img: B64, fit: "fill" } });
    const svg = b.stub.state.svgs[0] || "";
    check("fill: stretched to the box, preserveAspectRatio none, no wrapper", attr(svg, "width") === "356" && attr(svg, "height") === "180" && attr(svg, "preserveAspectRatio") === "none" && b.kid.children.length === 1 && b.kid.children[0].__d.type === "VECTOR", [svg.slice(0, 160), b.kid.type, b.kid.name]);
    const b2 = await build({ build: { tokens: {}, componentHint: null, img: B64, fit: "" } });
    check("no object-fit given = fill", attr(b2.stub.state.svgs[0], "preserveAspectRatio") === "none");
  }
  {
    const b = await build({ w: 390, h: 200, build: { tokens: {}, componentHint: null, img: B64, fit: "cover" } });
    check("same aspect as the svg: the vector itself, no clip wrapper, no preserveAspectRatio", b.kid.children.length === 1 && b.kid.children[0].__d.type === "VECTOR" && b.kid.name === "image" && b.kid.width === 390 && !/preserveAspectRatio/.test(b.stub.state.svgs[0]), [b.kid.type, b.kid.width]);
    const b3 = await build({ build: { tokens: {}, componentHint: null, img: B64, fit: "none" } });
    check("none: natural size 390 x 200 centered and clipped", attr(b3.stub.state.svgs[0], "width") === "390" && Math.abs(b3.kid.children[0].__d.x + 17) < 0.01, [attr(b3.stub.state.svgs[0], "width"), b3.kid.children[0].__d.x]);
  }
  {
    const b = await build({ build: { tokens: {}, componentHint: null, img: PNG, fit: "cover" } });
    check("raster png: still a rectangle with an IMAGE fill, no svg", b.kid.type === "RECTANGLE" && b.kid.fills[0].type === "IMAGE" && b.stub.state.svgs.length === 0 && b.stub.state.images.length === 1, [b.kid.type, b.kid.fills]);
    const bad = await build({ build: { tokens: {}, componentHint: null, img: "data:image/svg+xml;utf8," + encodeURIComponent("<svg>BADSVG</svg>"), fit: "cover" } });
    check("broken svg: grey placeholder rectangle and exactly one img_failed", bad.kid.type === "RECTANGLE" && bad.kid.fills[0].type === "SOLID" && bad.codes.filter((c) => c === "img_failed").length === 1, [bad.kid.type, bad.codes]);
    const ext = await build({ build: { tokens: {}, componentHint: null, img: "https://example.com/a.svg", fit: "cover" } });
    check("external .svg url: placeholder + img_placeholder warning (the walker cannot fetch it)", ext.kid.type === "RECTANGLE" && ext.codes.includes("img_placeholder"), ext.codes);
  }
  {
    const w = src("html-walk.js");
    check("walker passes alt and object-fit of an img", /node\.alt = el\.getAttribute\("alt"\)/.test(w) && /node\.objectFit = cs\.objectFit/.test(w));
    check("build-plugin lists html-img before html-build", /"html-img", "html-build"/.test(fs.readFileSync(path.join(__dirname, "..", "scripts", "build-plugin.mjs"), "utf8")));
  }
  console.log(failures ? "FAILURES: " + failures + " of " + checks : "ALL PASS (" + checks + " checks passed)");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log("  FAIL harness crashed -> " + (e && e.stack)); console.log("FAILURES: crash"); process.exit(1); });
