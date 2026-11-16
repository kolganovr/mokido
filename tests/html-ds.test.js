// F9 9.1 (T-077): var(--token) -> Figma variables (contract planning/fable/F9_контракт.md, section 1). Run: node tests/html-ds.test.js
//  (a) cases with a known answer, one per rule 1-9 (hand-made DOM trees -> htmlMap -> htmlBuild on the strict stub)
//  (b) the DS etalons (01, 02, 03, 05, 06, 07, 09 x2 widths): share of the declared var() slots that got a binding on the stub
// The expected slots in (b) are a JS port of expected_bindings() from planning/tools/html/structure.py (same meter as the live measurement).
// Honest limits: the stub does not compute Auto Layout and knows the variables API only as far as html-build-stub.js models it
// (setBoundVariableForPaint, setBoundVariable); a real Figma file may still refuse a bind, then the build reports var_bind_failed.
// No dependencies, Node >= 18.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createHtmlStub, dsVariables } = require("./helpers/html-build-stub");

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
["html-map.js", "html-ds.js"].forEach((f) => vm.runInContext(src(f), mapCtx));
function newBuild(stub) {
  const ctx = vm.createContext({ figma: stub.figma, console });
  ["html-ds.js", "html-build.js"].forEach((f) => vm.runInContext(src(f), ctx));
  return ctx;
}

// ---------------------------------------------------------------- DOM tree helpers
const STYLE = { bg: null, color: "#1d1a18ff", borderColor: null, borderWidth: [0, 0, 0, 0], radius: [0, 0, 0, 0], fontFamily: "Inter", fontSize: 16, fontWeight: 400, lineHeight: 20, opacity: 1, boxShadow: null, bgImage: null };
const N = (id, parent, o) => {
  o = o || {};
  return Object.assign({ id, parent, tag: "div", classes: [], name: null, component: null, variant: null, in_component: false, rect: { x: 0, y: 0, w: 100, h: 50 }, text: null, display: "flex", position: "static", overflow: "visible",
    flex: { dir: "column", wrap: false, gap: 0, justify: "normal", align: "normal" }, grid: null, padding: [0, 0, 0, 0], declared: {}, tokens: {}, significant: true }, o, { style: Object.assign({}, STYLE, o.style || {}) });
};
const TXT = (id, parent, text, rect, o) => N(id, parent, Object.assign({ tag: "#text", display: "text", flex: null, text, rect }, o || {}));
const tokensOf = (declared) => {
  const t = {};
  Object.keys(declared).forEach((k) => {
    const names = []; const re = /var\(\s*(--[\w-]+)/g; let m;
    while ((m = re.exec(declared[k])) !== null) names.push(m[1]);
    if (!names.length) return;
    const key = k === "background" ? "background-color" : (k === "border" || /^border-(top|right|bottom|left)(-color)?$/.test(k)) ? "border-color" : k;
    t[key] = names.length === 1 ? names[0] : names;
  });
  return t;
};
// declared drives the tokens like the walker does
const D = (id, parent, declared, o) => N(id, parent, Object.assign({ declared, tokens: tokensOf(declared) }, o || {}));
const tree = (nodes) => ({ nodes, viewport: { w: 400, h: 300 }, page: { w: 400, h: 300 } });

// Variables by hand: { n: "status/ok", t: "COLOR"|"FLOAT", v: "#112233"|16, coll?, remote? }
function vars(list) {
  const hex = (h) => ({ r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255, a: 1 });
  const cols = {}; const variables = []; let i = 0;
  list.forEach((x) => {
    const cn = x.coll || "Etalon UI";
    if (!cols[cn]) cols[cn] = { id: "VariableCollectionId:" + cn, name: cn, defaultModeId: "m", modes: [{ modeId: "m", name: "Default" }] };
    variables.push({ id: "VariableID:" + ++i, name: x.n, resolvedType: x.t, variableCollectionId: cols[cn].id, remote: !!x.remote, valuesByMode: { m: x.t === "COLOR" ? hex(x.v) : x.v } });
  });
  return { collections: Object.values(cols), variables };
}
async function run(nodes, variables, extraOpts) {
  const plan = j(vm.runInContext("htmlMap", mapCtx)(tree(nodes), {}));
  const stub = createHtmlStub(Object.assign({ variables }, extraOpts || {}));
  const b = newBuild(stub);
  const report = await b.htmlBuild(plan, {});
  const root = stub.registry.get(report.root_id);
  return { plan, stub, report, root, warn: (code) => report.warnings.concat(plan.warnings).filter((w) => w.code === code) };
}
const varName = (variables, id) => { const v = variables.variables.find((x) => x.id === id); return v ? v.name : null; };
function paintVar(variables, paints) { const p = (paints || []).find((x) => x.boundVariables && x.boundVariables.color); return p ? varName(variables, p.boundVariables.color.id) : null; }
const boundOf = (variables, node, f) => { const b = node.boundVariables[f]; return b ? varName(variables, b.id) : null; };

// ---------------------------------------------------------------- (a) cases
const V0 = () => vars([
  { n: "surface", t: "COLOR", v: "#faf8f6" }, { n: "bg", t: "COLOR", v: "#ffffff" }, { n: "accent", t: "COLOR", v: "#ff957a" }, { n: "border", t: "COLOR", v: "#e7e2dd" },
  { n: "text", t: "COLOR", v: "#1d1a18" }, { n: "status/ok-bg", t: "COLOR", v: "#e6f5ec" },
  { n: "space/8", t: "FLOAT", v: 8 }, { n: "space/12", t: "FLOAT", v: 12 }, { n: "space/16", t: "FLOAT", v: 16 }, { n: "space/24", t: "FLOAT", v: 24 }, { n: "radius/md", t: "FLOAT", v: 10 }, { n: "radius/full", t: "FLOAT", v: 999 }, { n: "border/1", t: "FLOAT", v: 1 }
]);
// body 400x300, padding 24, gap 16; card inside: bg accent, 1px border, radius 10, padding 8 12, one text
function scene(over) {
  over = over || {};
  const body = D(0, null, Object.assign({ background: "var(--surface)", padding: "var(--space-24)", gap: "var(--space-16)" }, over.body || {}), {
    rect: { x: 0, y: 0, w: 400, h: 300 }, padding: [24, 24, 24, 24], flex: { dir: "column", wrap: false, gap: 16, justify: "normal", align: "normal" }, style: { bg: "#faf8f6ff" } });
  const card = D(1, 0, Object.assign({ background: "var(--accent)", border: "var(--border-1) solid var(--border)", "border-radius": "var(--radius-md)", padding: "var(--space-8) var(--space-12)", gap: "var(--space-8)" }, over.card || {}), {
    rect: { x: 24, y: 24, w: 352, h: 40 }, padding: [8, 12, 8, 12], flex: { dir: "row", wrap: false, gap: 8, justify: "normal", align: "center" },
    style: Object.assign({ bg: "#ff957aff", borderColor: "#e7e2ddff", borderWidth: [1, 1, 1, 1], radius: [10, 10, 10, 10] }, over.cardStyle || {}) });
  const t = TXT(2, 1, "Hi", { x: 37, y: 31, w: 20, h: 20 }, { declared: { color: "var(--text)" }, tokens: { color: "--text" }, style: { color: "#1d1a18ff" } });
  return [body, card, t];
}
const findBy = (root, pred) => { let hit = null; (function w(n) { if (!hit && pred(n)) hit = n; (n.children || []).forEach(w); })(root); return hit; };

async function cases() {
  const V = V0();
  // rules 1 + 9: every kind of slot is bound by the normalized name; color through setBoundVariableForPaint, numbers through setBoundVariable
  let r = await run(scene(), V);
  const body = r.root, card = body.children[0], text = card.children[0];
  check("r1 body fill bound to surface", paintVar(V, body.fills) === "surface", body.fills);
  check("r1 card fill bound to accent", paintVar(V, card.fills) === "accent", card.fills);
  check("r1 card stroke bound to border (the color part of the shorthand, not the width)", paintVar(V, card.strokes) === "border", card.strokes);
  check("r1 card strokeWeight bound to border/1", boundOf(V, card, "strokeWeight") === "border/1");
  check("r1 card radius bound to radius/md (all four corners)", ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"].every((f) => boundOf(V, card, f) === "radius/md"));
  check("r1 padding 'var(--space-8) var(--space-12)': top/bottom 8, left/right 12",
    boundOf(V, card, "paddingTop") === "space/8" && boundOf(V, card, "paddingBottom") === "space/8" && boundOf(V, card, "paddingLeft") === "space/12" && boundOf(V, card, "paddingRight") === "space/12");
  check("r1 gap of the column body = itemSpacing space/16, row card = space/8", boundOf(V, body, "itemSpacing") === "space/16" && boundOf(V, card, "itemSpacing") === "space/8");
  check("r1 body padding bound to space/24 on all four sides", ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].every((f) => boundOf(V, body, f) === "space/24"));
  check("r8 text fill bound to text", paintVar(V, text.fills) === "text", text.fills);
  // the stub has no Auto Layout engine, so the self-check may place children ABSOLUTE; that is not what this case is about
  const ws = r.report.warnings.concat(r.plan.warnings).filter((w) => w.code !== "absolute_fallback");
  check("no warnings in a clean scene", ws.length === 0, ws);
  check("bound counter = 19 slots (body 6, card 12, text 1), each counted once", r.report.bound === 19, r.report.bound);
  // normalization: "--status-ok-bg" finds "status/ok-bg"; "Brand/Primary Color" is found by --brand-primary-color; collection + name by --theme-x
  const V1 = vars([{ n: "status/ok-bg", t: "COLOR", v: "#faf8f6" }, { n: "Brand/Primary Color", t: "COLOR", v: "#ff957a" }]);
  r = await run(scene({ body: { background: "var(--status-ok-bg)" }, card: { background: "var(--brand-primary-color)" } }), V1);
  check("r1 normalized names: status/ok-bg and 'Brand/Primary Color'", paintVar(V1, r.root.fills) === "status/ok-bg" && paintVar(V1, r.root.children[0].fills) === "Brand/Primary Color", [r.root.fills, r.root.children[0].fills]);
  const V1b = vars([{ n: "accent", t: "COLOR", v: "#ff957a", coll: "Theme" }]);
  r = await run(scene({ card: { background: "var(--theme-accent)" } }), V1b);
  check("r1 collection + name: --theme-accent finds 'accent' of collection Theme", paintVar(V1b, r.root.children[0].fills) === "accent", r.root.children[0].fills);

  // rule 2: several matches
  const V2 = vars([{ n: "accent", t: "COLOR", v: "#ff957a", coll: "A" }, { n: "accent", t: "COLOR", v: "#ff957a", coll: "B" }]);
  r = await run(scene(), V2);
  check("r2 two equal local matches: not bound, var_ambiguous", paintVar(V2, r.root.children[0].fills) === null && r.warn("var_ambiguous").some((w) => /--accent/.test(w.msg)), r.report.warnings);
  const V2b = vars([{ n: "accent", t: "COLOR", v: "#ff957a", coll: "Lib", remote: true }, { n: "accent", t: "COLOR", v: "#ff957a", coll: "Local" }]);
  r = await run(scene(), V2b);
  const cf = r.root.children[0].fills.find((p) => p.boundVariables);
  check("r2 local before library", cf && V2b.variables.find((v) => v.id === cf.boundVariables.color.id).remote === false, cf);
  const V2c = vars([{ n: "accent", t: "FLOAT", v: 3 }, { n: "accent", t: "COLOR", v: "#ff957a" }]);
  r = await run(scene(), V2c);
  check("r2 the matching type first: color slot takes the COLOR 'accent'", V2c.variables.find((v) => v.id === r.root.children[0].fills.find((p) => p.boundVariables).boundVariables.color.id).resolvedType === "COLOR");
  const V2d = vars([{ n: "b-c", t: "COLOR", v: "#ff957a", coll: "A" }, { n: "c", t: "COLOR", v: "#ff957a", coll: "B" }]);
  r = await run(scene({ card: { background: "var(--b-c)" } }), V2d);
  check("r2 exact collection + name beats a plain name match", paintVar(V2d, r.root.children[0].fills) === "c", r.root.children[0].fills);

  // rule 3: type mismatch
  r = await run(scene({ card: { gap: "var(--accent)" } }), V);
  check("r3 color variable in gap: not bound, var_type_mismatch", boundOf(V, r.root.children[0], "itemSpacing") === null && r.warn("var_type_mismatch").some((w) => /--accent/.test(w.msg)), r.report.warnings);
  r = await run(scene({ body: { background: "var(--space-16)" } }), V);
  check("r3 float variable in a fill: not bound", paintVar(V, r.root.fills) === null && r.warn("var_type_mismatch").length === 1);

  // rule 4: value differs, bound anyway
  const V4 = vars([{ n: "accent", t: "COLOR", v: "#ff0000" }, { n: "space/8", t: "FLOAT", v: 12 }, { n: "space/12", t: "FLOAT", v: 12 }]);
  r = await run(scene(), V4);
  check("r4 color 100 off: bound and var_value_differs", paintVar(V4, r.root.children[0].fills) === "accent" && r.warn("var_value_differs").some((w) => /--accent/.test(w.msg) && /#ff957a/.test(w.msg)), r.report.warnings);
  check("r4 size 8 vs 12: bound and var_value_differs (with both values)", boundOf(V4, r.root.children[0], "itemSpacing") === "space/8" && r.warn("var_value_differs").some((w) => /--space-8/.test(w.msg) && /css 8 var 12/.test(w.msg)), r.report.warnings);
  const V4b = vars([{ n: "accent", t: "COLOR", v: "#ff957c" }, { n: "space/8", t: "FLOAT", v: 8.4 }, { n: "space/12", t: "FLOAT", v: 12 }, { n: "border", t: "COLOR", v: "#e7e2dd" }, { n: "border/1", t: "FLOAT", v: 1 }, { n: "radius/md", t: "FLOAT", v: 10 }]);
  r = await run(scene(), V4b);
  check("r4 within tolerance (2 of 255 per channel, 0.5 px): no var_value_differs", r.warn("var_value_differs").length === 0, r.report.warnings);
  const V4c = vars([{ n: "accent", t: "COLOR", v: "#ff957d" }, { n: "space/8", t: "FLOAT", v: 8.6 }, { n: "space/12", t: "FLOAT", v: 12 }]);
  r = await run(scene(), V4c);
  check("r4 just over tolerance (3 of 255, 0.6 px): var_value_differs for both", r.warn("var_value_differs").length === 2, r.report.warnings);
  r = await run(scene({ card: { "border-radius": "var(--radius-full)" }, cardStyle: { radius: [20, 20, 20, 20] } }), V);
  check("r4 radius-full (999) against a clamped radius is not a difference", boundOf(V, r.root.children[0], "topLeftRadius") === "radius/full" && r.warn("var_value_differs").length === 0, r.report.warnings);

  // rule 5: fallback is a name; calc and gradients are not bound
  r = await run(scene({ card: { background: "var(--accent, #fff)" } }), V);
  check("r5 var(--accent, #fff) takes the name", paintVar(V, r.root.children[0].fills) === "accent");
  r = await run(scene({ card: { padding: "calc(var(--space-8) * 2)" }, cardStyle: {} }), V);
  check("r5 calc() with a var: not bound, var_expr", boundOf(V, r.root.children[0], "paddingTop") === null && r.warn("var_expr").some((w) => /--space-8/.test(w.msg)), r.plan.warnings);
  const nodes5 = scene({ card: { background: "linear-gradient(90deg, var(--accent), var(--border))" }, cardStyle: { bgImage: "gradient" } });
  r = await run(nodes5, V);
  const gf = r.root.children[0].fills;
  check("r5 gradient with vars: not bound, no warning at all", gf.length >= 1 && gf.every((p) => !p.boundVariables) && r.warn("var_expr").length === 0 && r.warn("var_not_found").length === 0, [gf, r.report.warnings]);

  // rule 6: not found, raw value, merged warning
  const nodes6 = scene({ body: { background: "var(--ghost)" }, card: { background: "var(--ghost)" } });
  r = await run(nodes6, V);
  check("r6 not found: raw fill stays, no binding", paintVar(V, r.root.fills) === null && r.root.fills.length === 1 && r.root.fills[0].type === "SOLID");
  const nf = r.warn("var_not_found");
  check("r6 same code and name merge into one line 'x2'", nf.length === 1 && /--ghost x2$/.test(nf[0].msg), nf);

  // rule 7: translucent color keeps its opacity, only the color is bound
  r = await run(scene({ cardStyle: { bg: "#ff957a80" } }), V);
  const tf = r.root.children[0].fills.find((p) => p.boundVariables);
  check("r7 translucent fill: bound, opacity stays about 0.5", tf && Math.abs(tf.opacity - 128 / 255) < 0.01, tf);

  // rule 8: range with its own token gets a bound range fill; the base fill of the whole TEXT is bound
  const body8 = D(0, null, {}, { rect: { x: 0, y: 0, w: 400, h: 300 } });
  const p8 = D(1, 0, {}, { display: "block", flex: null, rect: { x: 0, y: 0, w: 400, h: 20 } });
  const t1 = TXT(2, 1, "Hello ", { x: 0, y: 0, w: 40, h: 20 }, { declared: { color: "var(--text)" }, tokens: { color: "--text" } });
  const b8 = N(3, 1, { tag: "b", display: "inline", flex: null, rect: { x: 40, y: 0, w: 40, h: 20 } });
  const t2 = TXT(4, 3, "world", { x: 40, y: 0, w: 40, h: 20 }, { declared: { color: "var(--accent)" }, tokens: { color: "--accent" }, style: { color: "#ff957aff", fontWeight: 700 } });
  r = await run([body8, p8, t1, b8, t2], V);
  const tx = findBy(r.root, (n) => n.type === "TEXT");
  check("r8 whole-text fill bound to text", tx && paintVar(V, tx.fills) === "text", tx && tx.fills);
  const rg = tx && tx.ranges.find((x) => x.kind === "fills");
  check("r8 range with its own token: bound range fill (accent)", rg && paintVar(V, rg.value) === "accent", tx && tx.ranges);

  // rule 9 / robustness: no variables in the file, or no variables API at all: nothing breaks, raw values stay
  r = await run(scene(), vars([]));
  check("no variables in the file: build ok, bound 0, var_not_found warnings", r.report.root_id && r.report.bound === 0 && r.warn("var_not_found").length > 0);
  r = await run(scene(), undefined);
  check("variables API missing: build ok, bound 0", r.report.root_id && r.report.bound === 0 && r.root.children[0].fills.length === 1);
  // sources of truth: both API calls are the ones the contract names
  check("source: setBoundVariableForPaint and setBoundVariable are used", /setBoundVariableForPaint\(paint, "color"/.test(src("html-ds.js")) && /n\.setBoundVariable\(f, v\)/.test(src("html-ds.js")));
  check("source: bridge reports the bound counter", /bound \+= report\.bound/.test(src("html-bridge.js")) && /\r?\n\s+bound,\r?\n/.test(src("html-bridge.js")));
}

// ---------------------------------------------------------------- (b) DS etalons
// JS port of expected_bindings() (planning/tools/html/structure.py): which var() slots a DOM node declares
const DSIDX = {};
DS.colors.forEach((c) => (DSIDX[c.css_var] = { kind: "color", name: c.name }));
DS.sizes.forEach((s) => (DSIDX[s.css_var] = { kind: "size", name: s.name }));
const split = (s) => mapCtx.htmlDsSplit(s);
const varOf = (part) => { const m = /^var\(\s*(--[\w-]+)/.exec(part || ""); return m ? m[1] : null; };
function expectedBindings(n) {
  const out = [], tok = n.tokens || {}, decl = n.declared || {};
  const add = (v, slot, kind) => { const e = DSIDX[v]; if (e && (!kind || e.kind === kind)) out.push({ kind: e.kind, slot, name: e.name }); };
  const list = (v) => (typeof v === "string" ? [v] : (v || []).slice());
  if (n.tag === "#text") { list(tok.color).slice(0, 1).forEach((v) => add(v, "fill", "color")); return out; }
  for (const v of list(tok["background-color"])) { const e = DSIDX[v]; if (e && e.kind === "color") { add(v, "fill"); break; } }
  for (const v of list(tok["border-color"])) { const e = DSIDX[v]; if (e && e.kind === "color") { add(v, "stroke"); break; } }
  if (n.flex || n.grid) {
    const g = list(tok.gap);
    if (g.length) add(g.length === 1 || (n.flex || {}).dir === "column" ? g[0] : g[g.length - 1], "itemSpacing", "size");
    [["column-gap", "itemSpacing"], ["row-gap", "counterAxisSpacing"]].forEach(([k, slot]) => { if (!g.length) list(tok[k]).slice(0, 1).forEach((v) => add(v, slot, "size")); });
  }
  let sides = [null, null, null, null];
  if (decl.padding) sides = mapCtx.htmlDsBox4(split(decl.padding)).map(varOf);
  ["padding-top", "padding-right", "padding-bottom", "padding-left"].forEach((k, i) => { if (decl[k]) sides[i] = varOf(decl[k]); });
  ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].forEach((k, i) => { if (sides[i]) add(sides[i], k, "size"); });
  if (decl["border-radius"]) mapCtx.htmlDsBox4(split(decl["border-radius"].split("/")[0])).map(varOf).forEach((v, i) => { if (v) add(v, ["topLeftRadius", "topRightRadius", "bottomRightRadius", "bottomLeftRadius"][i], "size"); });
  return out;
}

async function etalon(file) {
  const dom = JSON.parse(fs.readFileSync(path.join(FIX, file), "utf8"));
  const variables = dsVariables(DS);
  const stub = createHtmlStub({ variables });
  const plan = j(vm.runInContext("htmlMap", mapCtx)(dom, {}));
  const report = await newBuild(stub).htmlBuild(plan, {});
  const root = stub.registry.get(report.root_id);
  // plan node <-> built node in parallel (same child order)
  const pairs = new Map(); let shapeOk = true;
  (function w(p, n) {
    if (p.dom != null && !pairs.has(p.dom)) pairs.set(p.dom, { p, n });
    if (p.type !== "FRAME") return; // an svg node gets its vector child from createNodeFromSvg
    if ((p.children || []).length !== (n.children || []).length) { shapeOk = false; return; }
    p.children.forEach((c, i) => w(c, n.children[i]));
  })(plan.root, root);
  const by = {}; dom.nodes.forEach((n) => (by[n.id] = n));
  const res = { color: [0, 0], size: [0, 0], raw: 0, ruledOut: 0 };
  dom.nodes.forEach((n) => {
    if (n.in_component) return; // 9.2: components are built as instances
    const pr = pairs.get(n.id) || (n.tag === "#text" && pairs.get(n.parent) && pairs.get(n.parent).p.type === "TEXT" ? pairs.get(n.parent) : null);
    expectedBindings(n).forEach((b) => {
      const acc = b.kind === "color" ? res.color : res.size;
      acc[1]++;
      if (!pr) return;
      let ok;
      if (b.slot === "fill" || b.slot === "stroke") ok = paintVar(variables, pr.n[b.slot === "fill" ? "fills" : "strokes"]) === b.name;
      else ok = boundOf(variables, pr.n, b.slot) === b.name;
      if (ok) acc[0]++; else { if (b.kind === "color") res.raw++; if (process.env.HTML_DS_DEBUG) console.log("  miss", n.id, n.tag, n.classes.join("."), b.slot, b.name, pr.p.type, JSON.stringify(pr.p.bound), pr.p.padding); }
    });
  });
  return { res, report, shapeOk, warnings: report.warnings.concat(plan.warnings) };
}
const pct = (a, b) => (b ? Math.round(1000 * a / b) / 10 : null);

async function etalons() {
  const FILES = ["01_login_form@1440", "02_cards_row@1440", "03_table@1440", "05_mobile_profile@390", "06_dashboard@1440", "07_settings_grid@1440", "09_responsive@1440", "09_responsive@390"];
  console.log("etalon                    color slots  size slots  all     raw colors at a declared token  bound  warnings");
  let allNum = 0, allDen = 0;
  for (const f of FILES) {
    const { res, report, shapeOk, warnings } = await etalon(f + ".dom.json");
    const num = res.color[0] + res.size[0], den = res.color[1] + res.size[1];
    allNum += num; allDen += den;
    const w = {}; warnings.forEach((x) => { if (/^var_/.test(x.code)) w[x.code] = (w[x.code] || 0) + 1; });
    console.log(f.padEnd(26) + (res.color[0] + "/" + res.color[1]).padEnd(13) + (res.size[0] + "/" + res.size[1]).padEnd(12) + (pct(num, den) + "%").padEnd(8) + String(res.raw).padEnd(31) + String(report.bound).padEnd(7) + JSON.stringify(w));
    check(f + ": built tree has the shape of the plan", shapeOk);
    check(f + ": declared var() slots bound >= 95% (" + num + "/" + den + ")", den > 0 && num / den >= 0.95, { num, den });
    check(f + ": no raw color where a color token is declared", res.raw === 0, res.raw);
    check(f + ": no var_* warnings on a file whose tokens all exist", Object.keys(w).length === 0, w);
  }
  console.log("all DS etalons: " + allNum + "/" + allDen + " = " + pct(allNum, allDen) + "%");
}

(async () => {
  await cases();
  await etalons();
  console.log(failures ? "\nFAILURES: " + failures + " of " + checks : "\nALL PASS (" + checks + " checks passed)");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log("  FAIL crash :: " + (e && e.stack || e)); process.exit(1); });
