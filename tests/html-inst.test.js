// F9 9.2 (T-077): data-component -> component instances (contract planning/fable/F9_контракт.md, section 2). Run: node tests/html-inst.test.js
//  (a) cases with a known answer, one per rule 1-8 (hand-made DOM trees -> htmlMap -> htmlBuild on the strict stub with stub components)
//  (b) the 10 DOM fixtures (9 etalons, 09 at two widths): instances / elements with data-component, right variant, layers created / expected
// Honest limits: the stub models createInstance / setProperties / variant swap, not real Figma; a library component is a stub node marked remote
// and reached only through an existing instance. No dependencies, Node >= 18.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createHtmlStub } = require("./helpers/html-build-stub");

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
  const ctx = vm.createContext({ figma: stub.figma, console, Date });
  ["components.js", "html-ds.js", "html-inst.js", "html-build.js"].forEach((f) => vm.runInContext(src(f), ctx));
  return ctx;
}

// ---------------------------------------------------------------- DOM tree helpers (same shape as the walker's dom.json)
const STYLE = { bg: null, color: "#1d1a18ff", borderColor: null, borderWidth: [0, 0, 0, 0], radius: [0, 0, 0, 0], fontFamily: "Inter", fontSize: 16, fontWeight: 400, lineHeight: 20, opacity: 1, boxShadow: null, bgImage: null };
const N = (id, parent, o) => {
  o = o || {};
  return Object.assign({ id, parent, tag: "div", classes: [], name: null, component: null, variant: null, prop: null, in_component: false, rect: { x: 0, y: 0, w: 100, h: 50 }, text: null, display: "flex", position: "static", overflow: "visible",
    flex: { dir: "column", wrap: false, gap: 0, justify: "normal", align: "normal" }, grid: null, padding: [0, 0, 0, 0], declared: {}, tokens: {}, significant: true }, o, { style: Object.assign({}, STYLE, o.style || {}) });
};
const TXT = (id, parent, text, rect, o) => N(id, parent, Object.assign({ tag: "#text", display: "text", flex: null, text, rect, in_component: true }, o || {}));
const tree = (nodes) => ({ nodes, viewport: { w: 400, h: 300 }, page: { w: 400, h: 300 } });
// body 400x300 (column) > comp (id 1, a button 100x40 at 24,24) > text(s)
function scene(comp, texts, extra, pad) {
  const body = N(0, null, { rect: { x: 0, y: 0, w: 400, h: 300 }, padding: pad || [24, 24, 24, 24], style: { bg: "#ffffffff" } });
  const at = pad ? 0 : 24;
  const c = N(1, 0, Object.assign({ tag: "button", component: "Button", rect: { x: at, y: at, w: 100, h: 40 }, style: { bg: "#ff957aff", radius: [10, 10, 10, 10] } }, comp || {}));
  const nodes = [body, c];
  // every text is its own element (like in real HTML), so each one is a separate run of text; { prop } puts data-prop on that element
  (texts || []).forEach((t, i) => {
    const o = typeof t === "string" ? { text: t } : t;
    const r = { x: 40, y: 34 + i * 12, w: 40, h: 10 };
    const el = N(nodes.length, 1, { tag: "span", display: o.prop ? "inline" : "block", flex: null, prop: o.prop || null, in_component: true, rect: r });
    nodes.push(el); nodes.push(TXT(nodes.length, el.id, o.text, r));
  });
  return nodes.concat(extra || []);
}
async function run(nodes, dsSpec, o) {
  o = o || {};
  const plan = j(vm.runInContext("htmlMap", mapCtx)(tree(nodes), {}));
  const stub = createHtmlStub({});
  const comps = stub.addComponents(dsSpec || { components: DS.components }, o.comps);
  if (o.lib) { // a library set used in the file: only an instance of it is on the page
    const lib = stub.addComponents({ components: o.lib }, { remote: true });
    const first = Object.values(lib)[0];
    const main = first.defaultVariant || first;
    stub.page.appendChild(main.createInstance());
  }
  const b = newBuild(stub);
  const report = await b.htmlBuild(plan, {});
  const root = stub.registry.get(report.root_id);
  const all = (n) => [n].concat(...(n.children || []).map(all));
  return { plan, stub, report, root, comps, all: all(root), warn: (code) => report.warnings.concat(plan.warnings).filter((w) => w.code === code) };
}
const inst = (r) => r.all.filter((n) => n.type === "INSTANCE");
const variantOf = (n) => n.mainComponent.name;
const noPlanWarn = (r) => r.report.warnings.filter((w) => !/^(absolute_fallback|box_mismatch)$/.test(w.code));

async function cases() {
  // rule 1: lookup by name
  let r = await run(scene({ variant: "Variant=Primary, Size=M" }, ["Save"]));
  check("r1 local set 'Button' found: 1 instance, counter 1", inst(r).length === 1 && r.report.instances === 1, [inst(r).length, r.report.instances]);
  check("r1 the instance is the child of the body and the DOM children are not built (only the component's own layers)", inst(r)[0].parent === r.root && inst(r)[0].children.length === 1, inst(r)[0].children.length);
  r = await run(scene({ component: "button" }, ["Save"]));
  check("r1 'button' finds 'Button' ignoring case", inst(r).length === 1 && r.warn("component_not_found").length === 0);
  const SEP = { components: { "Primary-Button": { properties: {}, text_props: ["Label"] } } };
  r = await run(scene({ component: "primary_button" }, ["Go"]), SEP);
  check("r1 'primary_button' finds 'Primary-Button' ignoring separators", inst(r).length === 1);
  const BOTH = { components: { Chip: { properties: { Tone: ["A", "B"] }, text_props: [] }, chip: { properties: {}, text_props: [], layers: ["single"] } } };
  r = await run(scene({ component: "Chip" }, []), BOTH);
  check("r1 a local set wins over a local single component of the same name", inst(r).length === 1 && inst(r)[0].mainComponent.__d.parent && inst(r)[0].mainComponent.__d.parent.type === "COMPONENT_SET");
  r = await run(scene({ component: "chip" }, []), BOTH);
  check("r1 exact name beats the case-insensitive one (a single 'chip' by exact name)", inst(r).length === 1 && inst(r)[0].mainComponent.__d.parent.type === "PAGE", inst(r)[0] && inst(r)[0].mainComponent.__d.parent.type);
  r = await run(scene({ component: "Toast" }, []), { components: {} }, { lib: { Toast: { properties: { Kind: ["Info", "Error"] }, text_props: ["Message"] } } });
  const toast = inst(r).filter((n) => n.parent === r.root);
  check("r1 library set that already has an instance in the file is found (nothing imported by key)", toast.length === 1 && toast[0].mainComponent.__d.remote === true, [toast.length]);
  r = await run(scene({ component: "Ghost" }, ["Boo"]));
  check("r1 not found: plain frames as in slice 1 (the DOM children are built), component_not_found, 0 instances",
    r.report.instances === 0 && inst(r).length === 0 && r.all.some((n) => n.type === "TEXT" && n.characters === "Boo") && r.warn("component_not_found").some((w) => /Ghost/.test(w.msg)), r.report.warnings);

  // rule 2: variant
  r = await run(scene({ variant: "variant=secondary, SIZE=s" }, ["Save"]));
  check("r2 property names and values compared without case: Variant=Secondary, Size=S", variantOf(inst(r)[0]) === "Variant=Secondary, Size=S", variantOf(inst(r)[0]));
  r = await run(scene({ variant: "Variant=Secondary, Color=Red" }, ["Save"]));
  check("r2 unknown property: the instance is still made, the rest applied, variant_unknown names it",
    inst(r).length === 1 && variantOf(inst(r)[0]) === "Variant=Secondary, Size=M" && r.warn("variant_unknown").some((w) => /Color=Red/.test(w.msg)), [variantOf(inst(r)[0]), r.report.warnings]);
  r = await run(scene({ variant: "Variant=Neon, Size=S" }, ["Save"]));
  check("r2 unknown value: that property stays default, the other applies, variant_unknown", variantOf(inst(r)[0]) === "Variant=Primary, Size=S" && r.warn("variant_unknown").some((w) => /Variant=Neon/.test(w.msg)), [variantOf(inst(r)[0]), r.report.warnings]);
  const BOOL = { components: { Toggle: { properties: {}, text_props: [], booleans: ["Disabled"], layers: ["x"] } } };
  r = await run(scene({ component: "Toggle", variant: "disabled=TRUE" }, []), BOOL);
  const tp = inst(r)[0].componentProperties;
  check("r2 BOOLEAN takes true/false text, found by the start of 'Disabled#20:0'", tp["Disabled#20:0"].value === true && r.warn("variant_unknown").length === 0, tp);
  r = await run(scene({ component: "Toggle", variant: "Disabled=maybe" }, []), BOOL);
  check("r2 BOOLEAN with a value that is not true/false: variant_unknown, stays false", inst(r)[0].componentProperties["Disabled#20:0"].value === false && r.warn("variant_unknown").length === 1);

  // rule 3: default variant + exactly one setProperties
  r = await run(scene({ variant: "Variant=Ghost, Size=S" }, ["Save"]));
  check("r3 one setProperties call for variant and text together", inst(r)[0].setPropertiesCalls === 1, inst(r)[0].setPropertiesCalls);
  r = await run(scene({}, []));
  check("r3 nothing to set: no setProperties, the default variant stays", !inst(r)[0].setPropertiesCalls && variantOf(inst(r)[0]) === "Variant=Primary, Size=M");

  // rule 4: texts
  const INPUT = (o) => scene(Object.assign({ component: "Input", tag: "div" }, o || {}));
  r = await run(scene({ component: "Input" }, [{ prop: "placeholder", text: "you@mail.com" }, { prop: "Label", text: "Email" }]));
  let cp = inst(r)[0].componentProperties;
  check("r4 by data-prop, whatever the order of the elements", cp["Label#1:0"].value === "Email" && cp["Placeholder#2:0"].value === "you@mail.com", cp);
  r = await run(scene({ component: "Input" }, ["Email", "you@mail.com"]));
  cp = inst(r)[0].componentProperties;
  check("r4 without data-prop: by order into the text properties", cp["Label#1:0"].value === "Email" && cp["Placeholder#2:0"].value === "you@mail.com", cp);
  check("r4 the text of the instance layers follows the property", inst(r)[0].children.map((c) => c.characters).join("|") === "Email|you@mail.com", inst(r)[0].children.map((c) => c.characters));
  r = await run(scene({ component: "Input" }, [{ prop: "Label", text: "Email" }, "you@mail.com"]));
  cp = inst(r)[0].componentProperties;
  check("r4 data-prop first, the rest in order into the free properties", cp["Label#1:0"].value === "Email" && cp["Placeholder#2:0"].value === "you@mail.com", cp);
  r = await run(scene({ component: "Input" }, ["a", "b", "c"]));
  check("r4 more texts than properties: not lost silently, text_override_mismatch with the count", r.warn("text_override_mismatch").some((w) => /1 text without a place/.test(w.msg)), r.report.warnings);
  const LAY = { components: { Card: { properties: {}, text_props: [], layers: ["Title", "~Hidden", "Note"] } } };
  r = await run(scene({ component: "Card" }, ["Hello", "World"]), LAY);
  const lay = inst(r)[0].children;
  check("r4 no text properties: by order into the visible TEXT layers (a hidden layer is skipped)", lay[0].characters === "Hello" && lay[1].characters === "~Hidden" && lay[2].characters === "World", lay.map((c) => c.characters));
  check("r4 the font was loaded before the text was written", r.stub.state.fontLoads.includes("Inter|Regular"));
  r = await run(scene({ component: "Card" }, ["a", "b", "c"]), LAY);
  check("r4 no text properties and too many texts: text_override_mismatch", r.warn("text_override_mismatch").some((w) => /1 text without a place/.test(w.msg)), r.report.warnings);

  // rule 5: no descendants, nested data-component is not handled
  const nodes5 = scene({ variant: "Variant=Primary, Size=M" }, ["Save"], [N(9, 1, { tag: "span", display: "inline", in_component: true, rect: { x: 60, y: 30, w: 10, h: 10 }, style: { bg: "#ff0000ff" } }),
    N(10, 1, { tag: "span", component: "Badge", in_component: true, rect: { x: 70, y: 30, w: 10, h: 10 }, style: { bg: "#00ff00ff" } })]);
  r = await run(nodes5);
  check("r5 the plan keeps the children, the build makes only the instance (no frame for the red span, no nested Badge instance)", r.plan.root.children[0].children.length >= 2 && inst(r).length === 1 && r.report.instances === 1 && r.all.length === 1 + 1 + 1, [inst(r).length, r.all.length]);

  // rule 6: override only size, opacity, visibility
  const decl = { width: "200px" };
  r = await run(scene({ declared: decl, rect: { x: 24, y: 24, w: 200, h: 40 }, style: { bg: "#ff0000ff", opacity: 0.5, radius: [3, 3, 3, 3] }, padding: [8, 8, 8, 8] }, ["Save"]));
  let i0 = inst(r)[0];
  check("r6 opacity from the DOM is applied", i0.opacity === 0.5, i0.opacity);
  check("r6 a declared px width resizes the instance, the height stays the component's", i0.width === 200 && i0.height === 40, [i0.width, i0.height]);
  check("r6 fills, radius and padding inside the instance are not touched (the variant does that)", JSON.stringify(i0.fills) === JSON.stringify([{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }]) && i0.cornerRadius === 0 && i0.paddingTop === 0, [i0.fills, i0.cornerRadius, i0.paddingTop]);
  check("r6 the strict stub took no forbidden write (it throws on them, the builder would have warned)", noPlanWarn(r).length === 0, noPlanWarn(r));
  const body6 = scene({ tag: "div", style: { bg: "#ff0000ff" }, declared: { background: "var(--accent)" }, tokens: { "background-color": "--accent" } }, ["Save"]);
  r = await run(body6);
  check("r6 a token on the component element binds nothing (inside an instance nothing is bound)", r.report.bound === 0 && !(inst(r)[0].boundVars), r.report.bound);
  const row = scene({ flex: null }, ["Save"]); row[0].flex = { dir: "row", wrap: false, gap: 0, justify: "normal", align: "normal" }; row[1].declared = { flex: "1" };
  r = await run(row);
  check("r6 flex:1 in a row: the instance is FILL horizontally like a frame", inst(r)[0].layoutSizingHorizontal === "FILL", inst(r)[0].layoutSizingHorizontal);

  // rule 7: box check, never stretched, never detached
  r = await run(scene({ variant: "Variant=Primary, Size=M" }, ["Save"]), { components: DS.components }, { comps: { size: () => [140, 40] } });
  i0 = inst(r)[0];
  check("r7 DOM 100x40 vs component 140x40: instance_size_differs with both sizes", r.warn("instance_size_differs").some((w) => /css 100x40 figma 140x40/.test(w.msg)), r.report.warnings);
  check("r7 the instance is not stretched to the DOM box", i0.width === 140 && !i0.resizes, [i0.width, i0.resizes]);
  r = await run(scene({ variant: "Variant=Primary, Size=M" }, ["Save"]), { components: DS.components }, { comps: { size: () => [101, 41] } });
  check("r7 within 2 px: no instance_size_differs", r.warn("instance_size_differs").length === 0, r.report.warnings);
  check("r7 detachInstance is never called anywhere in the instance code", !/\.detachInstance\s*\(/.test(src("html-inst.js") + src("html-build.js")));
  // the self-check does not go inside: a wrong instance box does not make the parent fall back to ABSOLUTE
  r = await run(scene({}, [], [], [0, 0, 0, 0]), { components: DS.components }, { comps: { size: () => [300, 90] } });
  check("r7 self-check: a wrong instance box alone gives no absolute_fallback and no resize", r.report.absolute_fallback === 0 && !inst(r)[0].resizes, [r.report.absolute_fallback, inst(r)[0].resizes]);

  // rule 8: layer name
  r = await run(scene({ name: "Save button" }, ["Save"]));
  check("r8 data-name is the layer name", inst(r)[0].name === "Save button", inst(r)[0].name);
  r = await run(scene({}, ["Save"]));
  check("r8 without data-name the component's own name stays", inst(r)[0].name === "Button", inst(r)[0].name);

  // walker: data-prop is read into the field `prop`
  check("walker reads data-prop into the field prop", /prop:\s*el\.getAttribute\("data-prop"\)/.test(src("html-walk.js")));
}

// ---------------------------------------------------------------- (b) etalons
function expectedVariant(name, variant) {
  const spec = DS.components[name];
  if (!spec) return null;
  const want = {};
  String(variant || "").split(",").forEach((p) => { const i = p.indexOf("="); if (i > 0) want[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim().toLowerCase(); });
  return Object.keys(spec.properties).map((k) => { const v = spec.properties[k].find((x) => x.toLowerCase() === want[k.toLowerCase()]) || spec.properties[k][0]; return k + "=" + v; }).join(", ");
}
async function etalons() {
  console.log("\netalon                       elements  instances  variant ok  layers/expected");
  const files = fs.readdirSync(FIX).filter((f) => /\.dom\.json$/.test(f)).sort();
  check("10 fixtures", files.length === 10, files.length);
  let allEl = 0, allInst = 0, allVar = 0, allVarDen = 0;
  for (const f of files) {
    const dom = JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));
    const els = dom.nodes.filter((n) => n.component && !n.in_component);
    const plan = j(vm.runInContext("htmlMap", mapCtx)(dom, {}));
    const stub = createHtmlStub({});
    stub.addComponents({ components: DS.components }, {});
    const b = newBuild(stub);
    const report = await b.htmlBuild(plan, {});
    const root = stub.registry.get(report.root_id);
    const insts = []; (function w(n) { if (n.type === "INSTANCE") { insts.push(n); return; } (n.children || []).forEach(w); })(root);
    const exp = []; let planNodes = 0; (function w(p) { planNodes++; if (p.component) { exp.push(p.component); return; } (p.children || []).forEach(w); })(plan.root);
    const ok = exp.filter((c, i) => insts[i] && insts[i].mainComponent.name === expectedVariant(c.name, c.variant)).length;
    const ratio = planNodes ? report.created / (planNodes - 0) : 0;
    const expectedLayers = planNodes; // plan nodes without the subtrees of components (each component counts as one)
    const rr = report.created / expectedLayers;
    console.log(f.replace(".dom.json", "").padEnd(28) + String(els.length).padStart(8) + String(report.instances).padStart(11) + (els.length ? (ok + "/" + exp.length) : "-").padStart(12) + (report.created + "/" + expectedLayers + " = " + rr.toFixed(2)).padStart(18));
    check(f + ": instances = elements with data-component (nested ones do not count)", report.instances === els.length && insts.length === els.length && exp.length === els.length, [report.instances, els.length, insts.length]);
    check(f + ": no component_not_found, no variant_unknown", !report.warnings.some((w) => w.code === "component_not_found" || w.code === "variant_unknown"), report.warnings.filter((w) => /component|variant/.test(w.code)));
    check(f + ": layers created / expected <= 1.2", rr <= 1.2, rr);
    allEl += els.length; allInst += report.instances; allVar += ok; allVarDen += exp.length;
  }
  console.log("total".padEnd(28) + String(allEl).padStart(8) + String(allInst).padStart(11) + (allVar + "/" + allVarDen).padStart(12));
  check("etalons: instances 100% of the elements with data-component", allInst === allEl && allEl > 0, [allInst, allEl]);
  check("etalons: right variant >= 95%", allVarDen > 0 && allVar / allVarDen >= 0.95, [allVar, allVarDen]);
}

(async () => {
  await cases();
  await etalons();
  console.log(failures ? "\nFAILURES: " + failures + " of " + checks : "\nALL PASS (" + checks + " checks passed)");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log("  FAIL crashed :: " + (e && e.stack || e)); process.exit(1); });
