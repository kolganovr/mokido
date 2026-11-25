// F9 9.3 (T-077): text styles by exact match (contract planning/fable/F9_контракт.md, section 3). Run: node tests/html-text-style.test.js
//  (a) cases with a known answer for rules 1-5 (hand-made DOM trees -> htmlMap -> htmlBuild on the strict stub)
//  (b) the DS etalons: of the texts outside instances whose DOM values exactly equal a style of ds.json, the share that got the style.
//      The "expected" side is computed from the DOM node style and ds.json only, not from the builder.
// Honest limits: the stub models setTextStyleIdAsync (resets font/size/line-height and the font ranges, keeps fills); letter spacing is not in the
// DOM tree of the walker, so a style with a non-zero letter spacing never matches a walked text (tested on the matcher with a plan field).
// No dependencies, Node >= 18.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createHtmlStub, dsTextStyles } = require("./helpers/html-build-stub");

const SRC = path.join(__dirname, "..", "figma-plugin-src");
const FIX = path.join(__dirname, "fixtures", "html");
const src = (f) => fs.readFileSync(path.join(SRC, f), "utf8");
let failures = 0, checks = 0;
function check(name, ok, detail) {
  checks++;
  if (ok) return;
  failures++;
  console.log("  FAIL " + name + (detail !== undefined ? " :: " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 500) : ""));
}
const j = (x) => JSON.parse(JSON.stringify(x));
const DS = JSON.parse(fs.readFileSync(path.join(FIX, "ds.json"), "utf8"));

const mapCtx = vm.createContext({});
["html-map.js", "html-ds.js", "html-inst.js"].forEach((f) => vm.runInContext(src(f), mapCtx));
function newBuild(stub) {
  const ctx = vm.createContext({ figma: stub.figma, console });
  ["components.js", "html-ds.js", "html-inst.js", "html-img.js", "html-build.js"].forEach((f) => vm.runInContext(src(f), ctx));
  return ctx;
}

const STYLE = { bg: null, color: "#1d1a18ff", borderColor: null, borderWidth: [0, 0, 0, 0], radius: [0, 0, 0, 0], fontFamily: "Inter", fontSize: 16, fontWeight: 400, lineHeight: 24, opacity: 1, boxShadow: null, bgImage: null };
const N = (id, parent, o) => {
  o = o || {};
  return Object.assign({ id, parent, tag: "div", classes: [], name: null, component: null, variant: null, prop: null, in_component: false, rect: { x: 0, y: 0, w: 100, h: 50 }, text: null, display: "flex", position: "static", overflow: "visible",
    flex: { dir: "column", wrap: false, gap: 0, justify: "normal", align: "normal" }, grid: null, padding: [0, 0, 0, 0], declared: {}, tokens: {}, significant: true }, o, { style: Object.assign({}, STYLE, o.style || {}) });
};
// a text element (id) with its #text child (id + 1): the element carries the class, both carry the style
function textEl(id, parent, text, cls, style, y) {
  const r = { x: 20, y: y === undefined ? 20 : y, w: 200, h: 24 };
  return [N(id, parent, { tag: "p", display: "block", flex: null, classes: cls || [], rect: r, style }),
    N(id + 1, id, { tag: "#text", display: "text", flex: null, text, rect: r, style })];
}
const tree = (nodes) => ({ nodes, viewport: { w: 400, h: 300 }, page: { w: 400, h: 300 } });
const body = () => N(0, null, { rect: { x: 0, y: 0, w: 400, h: 300 }, padding: [20, 20, 20, 20], style: { bg: "#ffffffff" } });
const all = (n) => [n].concat(...(n.children || []).map(all));
const texts = (stub, report) => all(stub.registry.get(report.root_id)).filter((n) => n.type === "TEXT");
const S = (name, fam, style, size, lh, ls) => ({ id: "S:" + name, name, fontName: { family: fam, style }, fontSize: size, lineHeight: lh === null ? { unit: "AUTO" } : typeof lh === "object" ? lh : { unit: "PIXELS", value: lh }, letterSpacing: { unit: "PIXELS", value: ls || 0 } });

async function run(nodes, styles, o) {
  const plan = j(vm.runInContext("htmlMap", mapCtx)(tree(nodes), {}));
  const stub = createHtmlStub({ textStyles: styles });
  if (o && o.comps) stub.addComponents({ components: DS.components });
  const report = await newBuild(stub).htmlBuild(plan, {});
  return { plan, stub, report, t: texts(stub, report), codes: report.warnings.map((w) => w.code) };
}
const BASE = [S("Body/M", "Inter", "Regular", 16, 24), S("Heading/L", "Inter", "Bold", 28, 36), S("Copy", "Inter", "Regular", 16, 24)];

async function cases() {
  // rule 1 + 4: exact match, style on the whole TEXT, counter text_styles
  let r = await run([body()].concat(textEl(1, 0, "Hello", [], { fontSize: 28, fontWeight: 700, lineHeight: 36 })), BASE);
  check("r1 exact match: style set on the TEXT", r.t.length === 1 && r.t[0].textStyleId === "S:Heading/L", r.t.map((x) => x.textStyleId));
  check("r4 counter text_styles = 1", r.report.text_styles === 1, r.report.text_styles);
  check("r1 no text_style warnings", r.codes.filter((c) => /^text_style/.test(c)).length === 0, r.codes);
  // plan.text.styleName: the build writes the name into the plan object it got
  {
    const plan = j(vm.runInContext("htmlMap", mapCtx)(tree([body()].concat(textEl(1, 0, "Hello", [], { fontSize: 28, fontWeight: 700, lineHeight: 36 }))), {}));
    const stub = createHtmlStub({ textStyles: BASE });
    await newBuild(stub).htmlBuild(plan, {});
    const tp = all(plan.root).find((p) => p.type === "TEXT");
    check("r4 plan text.styleName = Heading/L", tp.text.styleName === "Heading/L", tp.text.styleName);
  }
  // r1 mismatch of each field: no style
  for (const [what, st] of [["family", { fontFamily: "Roboto" }], ["weight", { fontWeight: 600 }], ["size", { fontSize: 29 }], ["line height", { lineHeight: 37 }]]) {
    r = await run([body()].concat(textEl(1, 0, "Hello", [], Object.assign({ fontSize: 28, fontWeight: 700, lineHeight: 36 }, st))), BASE);
    check("r1 " + what + " differs: no style, no failure", r.t.length === 1 && !r.t[0].textStyleId && r.report.text_styles === 0, r.t.map((x) => x.textStyleId));
  }
  // r1 tolerances: line height 0.5 px, percent line height, AUTO = normal
  r = await run([body()].concat(textEl(1, 0, "Hello", [], { fontSize: 16, lineHeight: 24.4 })), BASE);
  check("r1 line height 24.4 vs 24: within 0.5, style set", r.t[0].textStyleId === "S:Body/M", r.t[0].textStyleId);
  r = await run([body()].concat(textEl(1, 0, "Hello", [], { fontSize: 16, lineHeight: 24.6 })), BASE);
  check("r1 line height 24.6 vs 24: outside 0.5, no style", !r.t[0].textStyleId);
  r = await run([body()].concat(textEl(1, 0, "Hello", [], { fontSize: 20, lineHeight: 30 })), [S("P150", "Inter", "Regular", 20, { unit: "PERCENT", value: 150 })]);
  check("r1 line height 150% of 20 = 30 px", r.t[0].textStyleId === "S:P150", r.t[0].textStyleId);
  r = await run([body()].concat(textEl(1, 0, "Hello", [], { fontSize: 20, lineHeight: 24.2 })), [S("Auto", "Inter", "Regular", 20, null)]);
  check("r1 AUTO line height = browser normal (1.21 x size = 24.2)", r.t[0].textStyleId === "S:Auto", r.t[0].textStyleId);
  // r1 letter spacing: a style that has one needs the text to have it (the walker does not carry it yet)
  r = await run([body()].concat(textEl(1, 0, "Hello", [], { fontSize: 16, lineHeight: 24 })), [S("Spaced", "Inter", "Regular", 16, 24, 0.5)]);
  check("r1 style with letter spacing 0.5, text has none: no style", !r.t[0].textStyleId);
  const m = vm.runInContext("htmlDsTsMatch", newBuild(createHtmlStub({})));
  const E1 = { family: "Inter", style: "Regular", size: 16, lh: 24, ls: 0.5 };
  const tt = (ls) => ({ fontFamily: "Inter", fontStyle: 400, fontSize: 16, lineHeight: 24, letterSpacing: ls });
  check("r1 letter spacing 0.55 vs 0.5 matches (tolerance 0.1), 0.65 does not", m(E1, tt(0.55)) === true && m(E1, tt(0.65)) === false);
  check("r1 style with zero letter spacing ignores the text's", m(Object.assign({}, E1, { ls: 0 }), tt(2)) === true);

  // rule 2: several matches: the class name decides (prefix t- dropped), else the first by name
  r = await run([body()].concat(textEl(1, 0, "A", ["t-copy"], { fontSize: 16, lineHeight: 24 })), BASE);
  check("r2 two styles match, class t-copy picks Copy", r.t[0].textStyleId === "S:Copy", r.t[0].textStyleId);
  r = await run([body()].concat(textEl(1, 0, "A", ["x", "body-m"], { fontSize: 16, lineHeight: 24 })), BASE.slice().reverse());
  check("r2 class body-m (no prefix, second class) picks Body/M", r.t[0].textStyleId === "S:Body/M", r.t[0].textStyleId);
  r = await run([body()].concat(textEl(1, 0, "A", [], { fontSize: 16, lineHeight: 24 })), BASE.slice().reverse());
  check("r2 no class: first by name (Body/M before Copy), whatever the order in the file", r.t[0].textStyleId === "S:Body/M", r.t[0].textStyleId);
  r = await run([body()].concat(textEl(1, 0, "A", ["t-heading-l"], { fontSize: 16, lineHeight: 24 })), BASE);
  check("r2/r3 the class names Heading/L, the values equal Body/M: Body/M by value, no warning (the values did match a style)", r.t[0].textStyleId === "S:Body/M", [r.t[0].textStyleId, r.codes]);

  // rule 3: class like a style name, values equal no style at all: no style, text_style_differs (merged by name)
  r = await run([body()].concat(textEl(1, 0, "A", ["t-heading-l"], { fontSize: 27, fontWeight: 700, lineHeight: 36 }), textEl(3, 0, "B", ["t-heading-l"], { fontSize: 27, fontWeight: 700, lineHeight: 36 }, 60)), BASE);
  check("r3 style not set", r.t.length === 2 && r.t.every((x) => !x.textStyleId) && r.report.text_styles === 0, r.t.map((x) => x.textStyleId));
  const w3 = r.report.warnings.filter((w) => w.code === "text_style_differs");
  check("r3 one merged warning text_style_differs Heading/L x2", w3.length === 1 && /^Heading\/L .*x2$/.test(w3[0].msg), w3);
  r = await run([body()].concat(textEl(1, 0, "A", ["Heading/L"], { fontSize: 27, fontWeight: 700, lineHeight: 36 })), BASE);
  check("r3 the name is compared normalized (Heading/L = heading-l)", r.codes.includes("text_style_differs"), r.codes);
  r = await run([body()].concat(textEl(1, 0, "A", ["hero"], { fontSize: 27, fontWeight: 700, lineHeight: 36 })), BASE);
  check("r3 a class that is not a style name: silent", !r.codes.includes("text_style_differs") && !r.t[0].textStyleId, r.codes);

  // rule 4: ranges stay as edits on top, written AFTER the style
  const nodes = [body()].concat(textEl(1, 0, "Hello", [], { fontSize: 16, lineHeight: 24 }));
  nodes.push(N(3, 1, { tag: "#text", display: "text", flex: null, text: "bold", rect: { x: 60, y: 20, w: 40, h: 24 }, style: { fontWeight: 700, fontSize: 16, lineHeight: 24 } }));
  r = await run(nodes, BASE);
  const rt = r.t[0];
  check("r4 base style set and a bold range kept on top", rt.textStyleId === "S:Body/M" && rt.ranges.some((x) => x.kind === "fontName" && x.value.style === "Bold"), { id: rt.textStyleId, ranges: rt.ranges });
  check("r4 order: the style is written before the first range", rt.styleSetAfterRanges === false, rt.styleSetAfterRanges);
  check("r4 one setTextStyleIdAsync per text", rt.styleCalls === 1, rt.styleCalls);

  // rule 5: texts inside instances are not touched; outside ones get a style
  const cb = [body(), N(1, 0, { tag: "button", component: "Button", rect: { x: 20, y: 20, w: 100, h: 40 }, style: { bg: "#ff957aff", radius: [10, 10, 10, 10] } })];
  cb.push(N(2, 1, { tag: "span", display: "block", flex: null, in_component: true, classes: ["t-body-m"], rect: { x: 40, y: 30, w: 40, h: 24 } }),
    N(3, 2, { tag: "#text", display: "text", flex: null, text: "Save", in_component: true, rect: { x: 40, y: 30, w: 40, h: 24 } }));
  textEl(4, 0, "Outside", ["t-body-m"], { fontSize: 16, lineHeight: 24 }, 100).forEach((x) => cb.push(x));
  r = await run(cb, BASE, { comps: true });
  const inInst = all(r.stub.registry.get(r.report.root_id)).filter((n) => n.type === "INSTANCE").flatMap(all).filter((n) => n.type === "TEXT");
  check("r5 the scene has an instance with a text inside it", r.report.instances === 1 && inInst.length >= 1, { inst: r.report.instances, texts: inInst.length });
  check("r5 no text style call inside the instance", inInst.every((n) => !n.styleCalls && !n.textStyleId), inInst.map((n) => n.styleCalls));
  check("r5 the text outside got its style, counter 1", r.report.text_styles === 1 && r.t.filter((n) => n.textStyleId).length === 1, r.report.text_styles);

  // no local text styles in the file: nothing happens, no warnings
  r = await run([body()].concat(textEl(1, 0, "Hello", ["t-body-m"], { fontSize: 16, lineHeight: 24 })), []);
  check("no styles in the file: text built as before, no style warnings", r.t.length === 1 && r.report.text_styles === 0 && r.codes.every((c) => !/^text_style/.test(c)), r.codes);
}

// ---------------------------------------------------------------- (b) DS etalons
const pct = (a, b) => (b ? Math.round(1000 * a / b) / 10 : null);
async function etalon(file) {
  const dom = JSON.parse(fs.readFileSync(path.join(FIX, file), "utf8"));
  const stub = createHtmlStub({ textStyles: dsTextStyles(DS) });
  const plan = j(vm.runInContext("htmlMap", mapCtx)(dom, {}));
  const report = await newBuild(stub).htmlBuild(plan, {});
  const root = stub.registry.get(report.root_id);
  const by = {}; dom.nodes.forEach((n) => (by[n.id] = n));
  const inComp = (n) => { for (let x = n; x; x = by[x.parent]) if (x.component || x.in_component) return true; return false; };
  const pairs = [];
  (function w(p, n) {
    if (p.type === "TEXT") pairs.push({ p, n });
    if (p.type !== "FRAME") return;
    if ((p.children || []).length !== (n.children || []).length) return;
    p.children.forEach((c, i) => w(c, n.children[i]));
  })(plan.root, root);
  const r = { texts: 0, exact: 0, got: 0, falsePos: 0 };
  for (const { p, n } of pairs) {
    const d = by[p.dom];
    if (!d || inComp(d)) continue;
    r.texts++;
    const s = d.style;
    const exact = DS.text_styles.some((x) => x.family === s.fontFamily && x.weight === s.fontWeight && x.size === s.fontSize && Math.abs(x.lineHeight - s.lineHeight) <= 0.5);
    if (exact) { r.exact++; if (n.textStyleId) r.got++; } else if (n.textStyleId) r.falsePos++;
  }
  return { r, report };
}
async function etalons() {
  const FILES = ["01_login_form@1440", "02_cards_row@1440", "03_table@1440", "05_mobile_profile@390", "06_dashboard@1440", "07_settings_grid@1440", "09_responsive@1440", "09_responsive@390"];
  console.log("etalon                    texts outside instances  exact match with ds.json  got a style  share  style without exact match");
  let T = 0, X = 0, G = 0, F = 0;
  for (const f of FILES) {
    const { r, report } = await etalon(f + ".dom.json");
    T += r.texts; X += r.exact; G += r.got; F += r.falsePos;
    console.log(f.padEnd(26) + String(r.texts).padEnd(25) + String(r.exact).padEnd(26) + String(r.got).padEnd(13) + (pct(r.got, r.exact) + "%").padEnd(7) + r.falsePos);
    check(f + ": >= 95% of the exact-match texts got a style (" + r.got + "/" + r.exact + ")", r.exact === 0 || r.got / r.exact >= 0.95, r);
    check(f + ": no text got a style without an exact match", r.falsePos === 0, r);
    check(f + ": counter text_styles covers the styles set outside instances", report.text_styles >= r.got, { counter: report.text_styles, got: r.got });
  }
  console.log("all DS etalons: " + T + " texts outside instances, " + X + " exact, " + G + " got a style = " + pct(G, X) + "%, false positives " + F);
  check("the etalons have exact-match texts to measure (not an empty measurement)", X > 0, X);
}

(async () => {
  await cases();
  await etalons();
  console.log(failures ? "\nFAILURES: " + failures + " of " + checks : "\nALL PASS (" + checks + " checks passed)");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log("  FAIL crash :: " + (e && e.stack || e)); process.exit(1); });
