// Golden test for the plugin message handler (figma.ui.onmessage in figma-plugin/code.js).
// Run: node tests/plugin-messages.test.js        (compare with tests/fixtures/plugin-messages/*.json)
//      UPDATE_GOLDEN=1 node tests/plugin-messages.test.js   (re-record the fixtures)
//
// Every scenario loads the WHOLE, unmodified code.js into a fresh stub `figma`
// (tests/helpers/figma-stub.js), sends plugin messages and records (a) every message the
// plugin posts back and (b) every side effect on the stub (document tree, selection, viewport,
// toasts, clientStorage, font loads, exports). The record is compared deeply with the fixture.
// It pins CURRENT behaviour, quirks included: a failing scenario means the plugin's answer
// changed, not necessarily that something broke. Notes on odd behaviour: see QUIRKS at the end.
//
// Determinism: inside the sandbox only, Date is a fixed controllable clock (checkpoint ids,
// PROGRESS ts, durationMs) and setTimeout can be time-scaled (see loadPlugin). Node ids come
// from a counter. Nothing else is faked.
const fs = require("fs");
const path = require("path");
const { createFigmaStub, loadPlugin } = require("./helpers/figma-stub.js");

const FIX_DIR = path.join(__dirname, "fixtures", "plugin-messages");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

let failures = 0;
let passes = 0;
function check(name, cond, extra) {
  if (cond) { passes++; console.log("  ok   " + name); }
  else { failures++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + extra : "")); }
}

// First differing path between two JSON values, or null.
function firstDiff(a, b, p) {
  p = p || "$";
  if (a === b) return null;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return p + ": expected " + JSON.stringify(b) + " got " + JSON.stringify(a);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return p + ": array/object mismatch";
  if (Array.isArray(a)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= a.length) return p + "[" + i + "]: missing, expected " + JSON.stringify(b[i]);
      if (i >= b.length) return p + "[" + i + "]: unexpected " + JSON.stringify(a[i]);
      const d = firstDiff(a[i], b[i], p + "[" + i + "]");
      if (d) return d;
    }
    return null;
  }
  const keys = Array.from(new Set(Object.keys(a).concat(Object.keys(b))));
  for (const k of keys) {
    if (!(k in a)) return p + "." + k + ": missing, expected " + JSON.stringify(b[k]);
    if (!(k in b)) return p + "." + k + ": unexpected " + JSON.stringify(a[k]);
    const d = firstDiff(a[k], b[k], p + "." + k);
    if (d) return d;
  }
  return null;
}
const cut = (s) => (s.length > 300 ? s.slice(0, 300) + "..." : s);

const SCENARIOS = [];
// sc(name, [options], async (ctx) => {...}). options: { timerScale, doc: opts for the stub }.
function sc(name, a, b) {
  const fn = typeof a === "function" ? a : b;
  const options = typeof a === "function" ? {} : a;
  SCENARIOS.push({ name, fn, options });
}

async function runScenario({ name, fn, options }) {
  const stub = createFigmaStub(options.doc || {});
  const onmessage = loadPlugin(stub, { timerScale: options.timerScale });
  const steps = [];
  const extra = {};
  let seq = 0;
  const ctx = {
    stub,
    figma: stub.figma,
    add: stub.add,
    page: stub.page,
    get: stub.get,
    note(k, v) { extra[k] = JSON.parse(JSON.stringify(v === undefined ? null : v)); },
    // Sends one message; the golden keeps the message and everything posted while it ran.
    // opts.record === false: run it but keep it out of the golden (bulk setup steps).
    async send(msg, opts) {
      const from = stub.state.posted.length;
      const step = { send: JSON.parse(JSON.stringify(msg)) };
      try { await onmessage(msg); }
      catch (e) { step.threw = String(e && e.message || e); }
      step.posted = stub.state.posted.slice(from);
      if (!opts || opts.record !== false) steps.push(step);
      return step.posted;
    },
    async exec(code, more, opts) { return ctx.send(Object.assign({ type: "EXECUTE", id: "e" + (++seq), code }, more || {}), opts); },
    // Replaces the bulky result of the last recorded RESULT by fn(result), for scenarios with thousands of nodes.
    compactLast(fn) {
      const last = steps[steps.length - 1].posted.slice(-1)[0];
      last.result = JSON.parse(JSON.stringify(fn(last.result)));
    }
  };
  await fn(ctx);
  const record = { steps, effects: stub.effects() };
  if (options.noTree) {
    // thousands of nodes: keep only the shape of the document, not every node
    const count = (n) => 1 + (n.children || []).reduce((a, k) => a + count(k), 0);
    record.effects.pages = record.effects.pages.map(p => ({ id: p.id, name: p.name, selection: p.selection, nodes: count(p) - 1 }));
  }
  if (Object.keys(extra).length) record.extra = extra;
  return record;
}

// ---- document builders shared by scenarios ---------------------------------
function cardDoc(ctx) {
  const card = ctx.add("FRAME", { name: "Card", x: 0, y: 0, width: 300, height: 200, fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }] });
  const title = ctx.add("TEXT", { name: "Title", characters: "Hello", x: 10, y: 10, width: 80, height: 20 }, card);
  const hero = ctx.add("FRAME", { name: "Hero", x: 400, y: 0, width: 300, height: 200 });
  return { card, title, hero };
}

// Page "Buttons": Button set (Size x State variants + TEXT prop), standalone "Icon / Arrow" and
// "Button Group"; page "Cards": "Card" and a lower-case "button icon".
function componentsDoc(ctx) {
  const stub = ctx.stub;
  stub.figma.currentPage.name = "Buttons";
  const set = ctx.add("COMPONENT_SET", {
    name: "Button", description: "Primary action", key: "key-button",
    componentPropertyDefinitions: {
      Size: { type: "VARIANT", variantOptions: ["S", "L"], defaultValue: "S" },
      State: { type: "VARIANT", variantOptions: ["Default", "Hover"], defaultValue: "Default" },
      "Label#1:0": { type: "TEXT", defaultValue: "Click" }
    }
  });
  const variants = {};
  for (const size of ["S", "L"]) {
    for (const state of ["Default", "Hover"]) {
      const v = ctx.add("COMPONENT", {
        name: "Size=" + size + ", State=" + state, variantProperties: { Size: size, State: state },
        baseProps: { "Label#1:0": { type: "TEXT", value: "Click" } }, width: size === "S" ? 80 : 120, height: 32,
        componentProperties: {}
      }, set);
      ctx.add("TEXT", { name: "Label", characters: "Click" }, v);
      variants[size + state] = v;
    }
  }
  set.defaultVariant = variants.SDefault;
  const arrow = ctx.add("COMPONENT", {
    name: "Icon / Arrow", description: "arrow glyph", key: "key-arrow", width: 24, height: 24,
    componentPropertyDefinitions: { Show: { type: "BOOLEAN", defaultValue: true } }, baseProps: { Show: { type: "BOOLEAN", value: true } }, componentProperties: {}
  });
  const group = ctx.add("COMPONENT", { name: "Button Group", key: "key-group", width: 200, height: 40, componentProperties: {} });
  const cards = ctx.page("Cards");
  const card = ctx.add("COMPONENT", { name: "Card", key: "key-card", width: 300, height: 180, componentProperties: {} }, cards);
  ctx.add("TEXT", { name: "Title", characters: "Card title" }, card);
  ctx.add("TEXT", { name: "Body", characters: "Card body" }, card);
  const small = ctx.add("COMPONENT", { name: "button icon", key: "key-bicon", componentProperties: {} }, cards);
  return { set, variants, arrow, group, cards, card, small };
}

const SVG = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
const SVG_STROKE = '<svg width="48" height="24"><path d="M0 0L10 10" stroke="#000"/></svg>';

// ===== SET_PAUSED + the pause gate =====
sc("set_paused-on", async (c) => { await c.send({ type: "SET_PAUSED", value: true }); });
sc("set_paused-off-after-on", async (c) => { await c.send({ type: "SET_PAUSED", value: true }); await c.send({ type: "SET_PAUSED", value: false }); });
sc("set_paused-truthy-string-is-not-true", async (c) => { await c.send({ type: "SET_PAUSED", value: "true" }); await c.send({ type: "SET_PAUSED" }); });
sc("set_paused-blocks-execute", async (c) => {
  await c.send({ type: "SET_PAUSED", value: true });
  await c.exec("return figma.createFrame().id", { startTime: 111 });
  await c.exec("return 1", { description: "Build hero", startTime: 112 });
});
sc("set_paused-blocks-execute-without-type", async (c) => {
  await c.send({ type: "SET_PAUSED", value: true });
  await c.send({ id: "x1", code: "return 1" });
});
sc("set_paused-blocks-write-types-only", async (c) => {
  componentsDoc(c);
  await c.send({ type: "SET_PAUSED", value: true });
  await c.send({ type: "INSERT_SVG", id: "p1", svg_code: SVG, startTime: 1 });
  await c.send({ type: "INSERT_COMPONENT_INSTANCE", id: "p2", component_name: "Card", startTime: 2 });
  await c.send({ type: "SET_VARIABLES_MODE", id: "p3", collection_name: "c", mode_name: "m", startTime: 3 });
  // reads and bookkeeping keep working while paused
  await c.send({ type: "GET_VARIABLES", id: "p4" });
  await c.send({ type: "LIST_CHECKPOINTS", id: "p5" });
  await c.send({ type: "GET_CANVAS_LAYOUT", id: "p6" });
  await c.send({ type: "FIND_COMPONENTS", id: "p7", query: "card" });
  await c.send({ type: "SCREENSHOT", id: "p8" });
  await c.send({ type: "GET_DOC_INFO" });
});
sc("set_paused-resume-allows-execute", async (c) => {
  await c.send({ type: "SET_PAUSED", value: true });
  await c.send({ type: "SET_PAUSED", value: false });
  await c.exec("return 'back'");
});
sc("misc-unknown-and-missing-type-do-nothing", async (c) => {
  await c.send({ type: "NOPE", id: "u1" });
  await c.send({ id: "u2", code: "return 1" });
  await c.send({});
});
sc("misc-load-without-figma-on", { doc: { noOn: true } }, async (c) => {
  await c.send({ type: "GET_DOC_INFO" });
  c.note("handlers", Object.keys(c.stub.state.handlers));
});
sc("misc-load-registers-ui-and-listeners", async (c) => {
  c.note("showUI", c.stub.state.showUI);
  c.note("handlers", Object.keys(c.stub.state.handlers).sort());
});
sc("misc-page-change-event", async (c) => {
  const p2 = c.page("Second");
  c.stub.setPage(p2);
  c.stub.emit("currentpagechange");
});

// ===== JUMP_TO_NODE =====
sc("jump_to_node-selects-and-zooms", async (c) => {
  const { card } = cardDoc(c);
  await c.send({ type: "JUMP_TO_NODE", nodeId: card.id });
});
sc("jump_to_node-missing-node", async (c) => { cardDoc(c); await c.send({ type: "JUMP_TO_NODE", nodeId: "9:99" }); });
sc("jump_to_node-node-without-x", async (c) => {
  cardDoc(c);
  await c.send({ type: "JUMP_TO_NODE", nodeId: c.figma.currentPage.id }); // a PAGE has no x
});
sc("jump_to_node-lookup-throws-is-swallowed", async (c) => {
  cardDoc(c);
  c.stub.hooks.throwOnGetId = "1:1";
  await c.send({ type: "JUMP_TO_NODE", nodeId: "1:1" });
});

// ===== SET_AUTO_ZOOM / SET_SMART_PLACEMENT (observed through EXECUTE) =====
sc("set_auto_zoom-off-then-execute-does-not-zoom", async (c) => {
  await c.send({ type: "SET_AUTO_ZOOM", value: false });
  await c.exec("const f = figma.createFrame(); figma.currentPage.selection = [f]; return f.id");
});
sc("set_auto_zoom-non-true-means-off", async (c) => {
  await c.send({ type: "SET_AUTO_ZOOM", value: 1 });
  await c.exec("const f = figma.createFrame(); figma.currentPage.selection = [f]; return f.id");
});
sc("set_auto_zoom-off-then-on-again", async (c) => {
  await c.send({ type: "SET_AUTO_ZOOM", value: false });
  await c.send({ type: "SET_AUTO_ZOOM", value: true });
  await c.exec("const f = figma.createFrame(); figma.currentPage.selection = [f]; return f.id");
});
sc("set_auto_zoom-per-call-autozoom-false", async (c) => {
  await c.exec("const f = figma.createFrame(); figma.currentPage.selection = [f]; return f.id", { autoZoom: false });
});
sc("set_smart_placement-on-moves-colliding-selection", async (c) => {
  cardDoc(c);
  await c.exec("const f = figma.createFrame(); f.resize(120, 80); figma.currentPage.selection = [f]; return f.id");
});
sc("set_smart_placement-off-keeps-origin", async (c) => {
  cardDoc(c);
  await c.send({ type: "SET_SMART_PLACEMENT", value: false });
  await c.exec("const f = figma.createFrame(); f.resize(120, 80); figma.currentPage.selection = [f]; return f.id");
});
sc("set_smart_placement-non-true-means-off", async (c) => {
  cardDoc(c);
  await c.send({ type: "SET_SMART_PLACEMENT", value: "yes" });
  await c.exec("const f = figma.createFrame(); figma.currentPage.selection = [f]; return f.id");
});

// ===== RESIZE_WINDOW =====
sc("resize_window-passes-size", async (c) => { await c.send({ type: "RESIZE_WINDOW", width: 420, height: 640 }); });
sc("resize_window-passes-undefined-as-is", async (c) => { await c.send({ type: "RESIZE_WINDOW" }); });

// ===== SAVE_SETTINGS / LOAD_SETTINGS =====
sc("save_settings-then-load", async (c) => {
  await c.send({ type: "SAVE_SETTINGS", settings: { theme: "dark", zoom: true, nested: { a: [1, 2] } } });
  await c.send({ type: "LOAD_SETTINGS" });
});
sc("load_settings-nothing-saved-gives-empty-object", async (c) => { await c.send({ type: "LOAD_SETTINGS" }); });
sc("load_settings-storage-throws-gives-empty-object", async (c) => {
  c.stub.hooks.failStorageGet = true;
  await c.send({ type: "LOAD_SETTINGS" });
});
sc("save_settings-storage-throws-is-swallowed", async (c) => {
  c.stub.hooks.failStorageSet = true;
  await c.send({ type: "SAVE_SETTINGS", settings: { a: 1 } });
  c.stub.hooks.failStorageSet = false;
  await c.send({ type: "LOAD_SETTINGS" });
});
sc("save_settings-null-saved-loads-as-empty", async (c) => {
  await c.send({ type: "SAVE_SETTINGS", settings: null });
  await c.send({ type: "LOAD_SETTINGS" });
});

// ===== GET_DOC_INFO =====
sc("get_doc_info-with-file-key", { doc: { fileKey: "FILEKEY1", fileName: "Design file" } }, async (c) => { await c.send({ type: "GET_DOC_INFO" }); });
sc("get_doc_info-without-file-key-is-null", async (c) => { await c.send({ type: "GET_DOC_INFO" }); });
sc("get_doc_info-second-page", async (c) => {
  c.stub.setPage(c.page("Page 2"));
  await c.send({ type: "GET_DOC_INFO" });
});
sc("get_doc_info-throwing-getter-posts-nothing", async (c) => {
  Object.defineProperty(c.stub.root, "name", { get() { throw new Error("boom"); } });
  await c.send({ type: "GET_DOC_INFO" });
});

// ===== EXECUTE =====
const L = (...lines) => lines.join("\n");
const MK_FRAME = "const f = figma.createFrame(); f.name = 'Built'; f.resize(200, 100); return f.id;";

sc("execute-returns-value-and-journals-creation", async (c) => {
  await c.exec(L("const f = figma.createFrame();", "f.name = 'Hero';", "const t = figma.createText();", "t.characters = 'Hi';", "f.appendChild(t);", "return { frame: f.id, text: t.id };"), { description: "Build hero", startTime: 5 });
});
sc("execute-default-description-and-undefined-result", async (c) => { await c.exec("figma.createRectangle();"); });
sc("execute-result-none-stays-none", async (c) => { await c.exec("return;"); });
sc("execute-read-only-call-drops-its-checkpoint", async (c) => {
  cardDoc(c);
  await c.exec("return figma.currentPage.children.length;");
  await c.send({ type: "LIST_CHECKPOINTS", id: "l1" });
});
sc("execute-bridge-state-survives-between-calls", async (c) => {
  await c.exec("bridge.state.counter = 41; return 'set';");
  await c.exec("return { counter: bridge.state.counter + 1, last: bridge.state.lastResult };");
  await c.exec("return bridge.state.lastResult;");
});
sc("execute-selection-autoposition-and-autozoom", async (c) => {
  cardDoc(c);
  await c.exec("const f = figma.createFrame(); f.resize(250, 100); figma.currentPage.selection = [f]; return f.id;");
});
sc("execute-selecting-an-existing-frame-at-origin-moves-it", async (c) => {
  const { card } = cardDoc(c);
  await c.exec("figma.currentPage.selection = [figma.getNodeById('" + card.id + "')]; return 'selected';");
});
sc("execute-clone-and-createinstance-are-journaled", async (c) => {
  const comp = c.add("COMPONENT", { name: "Comp", componentProperties: {} });
  const card = c.add("FRAME", { name: "Source", x: 500, y: 500 });
  await c.exec(L("const copy = figma.getNodeById('" + card.id + "').clone();", "const inst = figma.getNodeById('" + comp.id + "').createInstance();", "return [copy.id, inst.id];"));
});
sc("execute-group-is-journaled", async (c) => {
  await c.exec(L("const a = figma.createRectangle(); const b = figma.createEllipse();", "const g = figma.group([a, b], figma.currentPage); g.name = 'Pair'; return g.id;"));
});
sc("execute-helpers-log-progress-notify", async (c) => {
  await c.exec(L("progress(1, 3, 'working'); progress(2, 3); progress(3, 3, 42);", "log('hello'); log({ a: 1 }); log(undefined);", "notify('custom toast', { timeout: 100 });", "return 'ok';"), { id: "ex1" });
});
sc("execute-progress-post-failure-is-swallowed", async (c) => {
  c.stub.hooks.failPost = (m) => m.type === "PROGRESS";
  await c.exec("progress(1, 2, 'x'); return 'done';");
});
sc("execute-get-free-canvas-position-helpers", async (c) => {
  cardDoc(c);
  await c.exec(L("return [getFreeCanvasPosition(), getFreeCanvasPosition(200, 100, { direction: 'BOTTOM' }),",
    "getFreeCanvasPosition(100, 100, { layout: 'grid', columns: 2, gap: 20 }), getFreePosition(50, 50, { gap: 10 })];"));
});
sc("execute-get-free-canvas-position-empty-page", async (c) => {
  await c.exec("return [getFreeCanvasPosition(), getFreeCanvasPosition(10, 10, { layout: 'grid' })];");
});
sc("execute-get-free-canvas-position-grid-and-bad-args", async (c) => {
  for (let i = 0; i < 3; i++) c.add("FRAME", { name: "F" + i, x: i * 180, y: 0, width: 100, height: 100 });
  await c.exec("return [getFreeCanvasPosition(100, 100, { layout: 'grid', columns: 3, gap: 80 }), getFreeCanvasPosition(100, 100, { layout: 'grid', columns: 2, gap: 80 }), getFreeCanvasPosition(100, 100, { layout: 'GRID', columns: 0 }), getFreeCanvasPosition(-5, 'x', { direction: 'bottom', gap: 'bad' })];");
});

// -- result sanitizing --
sc("execute-result-sanitized-values", async (c) => {
  const { card } = cardDoc(c);
  await c.exec(L("const circ = { name: 'c' }; circ.self = circ;",
    "return { node: figma.getNodeById('" + card.id + "'), mixed: figma.mixed, fn: () => 1, big: 10n, bytes: new Uint8Array(4),",
    "buf: new ArrayBuffer(8), set: new Set([1, 2]), map: new Map([['k', 'v']]), err: new Error('bad'), circ, list: [1, undefined, () => 2, figma.mixed],",
    "nan: NaN, inf: Infinity, nil: null, nested: { a: { b: [] } }, sym: Symbol('s') };"));
});
sc("execute-result-too-deep", async (c) => {
  await c.exec("let o = { end: true }; for (let i = 0; i < 20; i++) o = { o }; return o;");
});
sc("execute-result-getter-that-throws-is-unreadable", async (c) => {
  await c.exec("return { ok: 1, get bad() { throw new Error('no'); } };");
});
sc("execute-result-unsanitizable-degrades-to-placeholder", async (c) => {
  await c.exec("figma.createFrame(); return new Proxy({}, { ownKeys() { throw new Error('nope'); } });");
});
sc("execute-envelope-post-failure-falls-back", async (c) => {
  let first = true;
  c.stub.hooks.failPost = (m) => { if (m.type === "RESULT" && first) { first = false; return true; } return false; };
  await c.exec("figma.createFrame(); return { a: 1 };");
});

// -- capture --
sc("execute-capture-single-created-node", async (c) => {
  await c.exec(MK_FRAME, { capture: true });
});
sc("execute-capture-passes-scale-and-max-px", async (c) => {
  await c.exec("const f = figma.createFrame(); f.resize(3000, 2000); return f.id;", { capture: true, scale: 2, max_px: 800 });
});
sc("execute-capture-oversized-node-is-shrunk", async (c) => {
  await c.exec("const f = figma.createFrame(); f.resize(5000, 5000); return f.id;", { capture: true });
});
sc("execute-capture-children-share-compact-parent", async (c) => {
  await c.exec(L("const p = figma.createFrame(); p.name = 'Row'; p.resize(300, 200);",
    "const a = figma.createRectangle(); a.resize(150, 200); const b = figma.createRectangle(); b.resize(150, 200);",
    "p.appendChild(a); p.appendChild(b); return p.id;"), { capture: true });
});
sc("execute-capture-two-far-apart-nodes-are-shot-individually", async (c) => {
  await c.exec(L("const a = figma.createFrame(); a.name = 'A'; a.resize(100, 100);", "const b = figma.createFrame(); b.name = 'B'; b.resize(100, 100); b.x = 5000;", "return [a.id, b.id];"), { capture: true });
});
sc("execute-capture-more-than-four-nodes-is-capped-with-note", async (c) => {
  await c.exec("for (let i = 0; i < 6; i++) { const r = figma.createRectangle(); r.name = 'R' + i; } return 6;", { capture: true });
});
sc("execute-capture-node-ids-win-over-created", async (c) => {
  const { hero } = cardDoc(c);
  await c.exec(MK_FRAME, { capture: true, capture_node_ids: [hero.id, "9:99"] });
});
sc("execute-capture-two-capture-node-ids-in-one-frame", async (c) => {
  const p = c.add("FRAME", { name: "Wrap", width: 300, height: 200 });
  const a = c.add("RECTANGLE", { name: "A", width: 140, height: 200 }, p);
  const b = c.add("RECTANGLE", { name: "B", width: 140, height: 200, x: 150 }, p);
  await c.exec("return 1;", { capture: true, capture_node_ids: [a.id, b.id] });
});
sc("execute-capture-nothing-to-capture-gives-note", async (c) => {
  cardDoc(c);
  await c.exec("return 1;", { capture: true });
});
sc("execute-capture-falls-back-to-selection", async (c) => {
  const { hero } = cardDoc(c);
  hero.x = 1000;
  await c.exec("figma.currentPage.selection = [figma.getNodeById('" + hero.id + "')]; return 1;", { capture: true });
});
sc("execute-capture-export-failure-becomes-note", async (c) => {
  const { hero } = cardDoc(c);
  hero.exportError = "render failed";
  await c.exec("return 1;", { capture: true, capture_node_ids: [hero.id] });
});
sc("execute-capture-too-large-after-encoding", async (c) => {
  const { hero } = cardDoc(c);
  hero.exportBytes = new Array(6400000).fill(7);
  await c.exec("return 1;", { capture: true, capture_node_ids: [hero.id] });
});
sc("execute-capture-without-flag-takes-no-shot", async (c) => { await c.exec(MK_FRAME); });
sc("execute-capture-multi-with-one-failing-node", async (c) => {
  const a = c.add("FRAME", { name: "Ok", x: 0, y: 0 });
  const b = c.add("FRAME", { name: "Bad", x: 4000, y: 0, exportError: "boom" });
  await c.exec("return 1;", { capture: true, capture_node_ids: [a.id, b.id] });
});

// -- diff (before screenshot) --
sc("execute-diff-attaches-before-screenshot", async (c) => {
  const { hero } = cardDoc(c);
  await c.exec("figma.getNodeById('" + hero.id + "').resize(500, 500); return 1;", { diff: true, capture_node_ids: [hero.id], capture: true });
});
sc("execute-diff-before-shot-too-slow-is-skipped", { timerScale: 0.004 }, async (c) => {
  const { hero } = cardDoc(c);
  hero.exportHang = true;
  await c.exec("return 'ran';", { diff: true, capture_node_ids: [hero.id] });
});
sc("execute-diff-ignored-without-existing-nodes-or-ids", async (c) => {
  await c.exec("return 1;", { diff: true, capture_node_ids: ["9:99"] });
  await c.exec("return 2;", { diff: true, capture_node_ids: [] });
  await c.exec("return 3;", { diff: true });
  await c.exec("return 4;", { diff: "yes", capture_node_ids: ["9:99"] });
});

// -- lint warnings --
sc("execute-lint-low-contrast-text", async (c) => {
  await c.exec(L("const f = figma.createFrame(); f.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];",
    "const t = figma.createText(); t.characters = 'Faint caption'; t.fills = [{ type: 'SOLID', color: { r: 0.8, g: 0.8, b: 0.8 } }]; f.appendChild(t);",
    "const ok = figma.createText(); ok.characters = 'Readable'; ok.fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }]; f.appendChild(ok);",
    "const hidden = figma.createText(); hidden.characters = 'hidden fill'; hidden.fills = [{ type: 'SOLID', visible: false, color: { r: 1, g: 1, b: 1 } }]; f.appendChild(hidden); return f.id;"));
});
sc("execute-lint-truncated-fixed-text", async (c) => {
  await c.exec("const t = figma.createText(); t.characters = 'A very long headline that does not fit into its box at all'; t.textAutoResize = 'NONE'; t.textTruncation = 'ENDING'; return t.id;");
});
sc("execute-lint-zero-dimension", async (c) => { await c.exec("const l = figma.createLine(); l.name = 'Rule'; return l.id;"); });
sc("execute-lint-layout-grow-in-hugging-parent", async (c) => {
  await c.exec(L("const p = figma.createFrame(); p.layoutMode = 'VERTICAL'; p.primaryAxisSizingMode = 'AUTO';",
    "const k = figma.createRectangle(); k.name = 'Grower'; k.layoutGrow = 1; p.appendChild(k);",
    "const fixed = figma.createRectangle(); fixed.name = 'Fine'; fixed.layoutGrow = 0; p.appendChild(fixed);",
    "const loose = figma.createFrame(); loose.layoutMode = 'NONE'; const r = figma.createRectangle(); r.layoutGrow = 1; loose.appendChild(r); return p.id;"));
});
sc("execute-lint-capped-at-ten-warnings", async (c) => {
  await c.exec("for (let i = 0; i < 12; i++) { const l = figma.createLine(); l.name = 'Line' + i; } return 12;");
});
sc("execute-lint-covers-modified-and-capture-ids-without-duplicates", async (c) => {
  const { hero } = cardDoc(c);
  await c.exec("const n = figma.getNodeById('" + hero.id + "'); bridge.snapshot(n); n.resize(0, 50); return n.id;", { capture_node_ids: [hero.id] });
});

// -- fonts / toasts / timers --
sc("execute-loads-the-three-inter-fonts-once", async (c) => {
  await c.exec("return 1;");
  await c.exec("return 2;");
});
sc("execute-font-failure-falls-back-and-still-runs", async (c) => {
  c.stub.hooks.failFonts = (f) => f.style === "Medium";
  await c.exec("return 'ran';");
});
sc("execute-all-fonts-failing-is-swallowed", async (c) => {
  c.stub.hooks.failFonts = () => true;
  await c.exec("return 'ran';");
});
sc("execute-font-load-never-finishing-is-taken-as-done", { timerScale: 0.004 }, async (c) => {
  c.stub.hooks.hangFonts = (f) => f.style === "Bold";
  await c.exec("return 'ran';");
  await c.exec("return 'second';");
});
sc("execute-toasts-are-batched-after-three-in-four-seconds", async (c) => {
  for (let i = 0; i < 5; i++) await c.exec("return " + i + ";", { description: "Call " + i });
  c.stub.clock.advance(4001);
  await c.exec("return 'later';", { description: "Later" });
});
sc("execute-notify-failing-on-the-done-toast-turns-success-into-an-error-envelope", async (c) => {
  c.stub.hooks.notifyThrows = (t) => /done/.test(t);
  await c.exec("figma.createFrame(); return 'built';");
  await c.send({ type: "LIST_CHECKPOINTS", id: "l" });
});
sc("execute-notify-helper-swallows-its-own-failure", async (c) => {
  c.stub.hooks.notifyThrows = (t) => t === "from user code";
  await c.exec("return String(notify('from user code', { timeout: 5 })) + '/' + String(notify('other'));");
});

// -- errors --
sc("execute-error-plain-throw-with-line", async (c) => {
  await c.exec(L("const a = 1;", "const b = 2;", "throw new Error('boom at ' + (a + b));"), { startTime: 9 });
});
sc("execute-error-reference-error-gets-scope-hint", async (c) => {
  await c.exec(L("const kit = 1;", "  return helperFromAnotherCall(kit);"));
});
sc("execute-error-null-node-gets-scope-hint", async (c) => { await c.exec("figma.getNodeById('9:9').remove();"); });
sc("execute-error-syntax", async (c) => { await c.exec("const = ;"); });
sc("execute-error-top-level-import", async (c) => { await c.exec("import x from 'y';"); });
sc("execute-error-unbalanced-parenthesis", async (c) => { await c.exec("function f( { return 1; }"); });
sc("execute-error-rejected-promise", async (c) => {
  await c.exec(L("await Promise.resolve();", "await Promise.reject(new Error('async fail'));"));
});
sc("execute-error-thrown-string-null-and-plain-object", async (c) => {
  await c.exec("throw 'just a string';");
  await c.exec("throw null;");
  await c.exec("throw { message: 'object with message' };");
});
sc("execute-error-font-hint", async (c) => {
  await c.exec("throw new Error('Cannot write to node with unloaded font \"Foo Bold\"');");
});
sc("execute-error-after-creating-keeps-the-checkpoint", async (c) => {
  await c.exec(L("const f = figma.createFrame(); f.name = 'Half done';", "throw new Error('stop here');"));
  await c.send({ type: "LIST_CHECKPOINTS", id: "l" });
});
sc("execute-error-notify-itself-throwing-is-ignored", async (c) => {
  c.stub.hooks.notifyThrows = true;
  await c.exec("throw new Error('x');");
});
sc("execute-error-hint-for-hug-resize", async (c) => {
  await c.exec("throw new Error('Cannot resize an autolayout frame: fixed dimensions are required');");
});
sc("execute-error-hint-for-stale-node", async (c) => { await c.exec("throw new Error('The node with id 1:2 does not exist');"); });
sc("execute-error-hint-for-instance-transform", async (c) => {
  await c.exec("throw new Error('x cannot be overridden in an instance');");
});
sc("execute-error-without-hint-pattern", async (c) => { await c.exec("throw new Error('Something else entirely');"); });

// ===== SCREENSHOT =====
sc("screenshot-explicit-node-id", async (c) => {
  const { card } = cardDoc(c);
  await c.send({ type: "SCREENSHOT", id: "s1", nodeIds: card.id, startTime: 3 });
});
sc("screenshot-several-ids-with-spaces-and-dashes", async (c) => {
  const { card, hero } = cardDoc(c);
  await c.send({ type: "SCREENSHOT", id: "s1", nodeIds: card.id.replace(":", "-") + " , " + hero.id + ", 9:99", description: "Both" });
});
sc("screenshot-unknown-ids-fall-back-to-selection", async (c) => {
  const { hero } = cardDoc(c);
  c.figma.currentPage.selection = [hero];
  await c.send({ type: "SCREENSHOT", id: "s1", nodeIds: "9:98,9:99" });
});
sc("screenshot-no-ids-no-selection-captures-the-page", async (c) => {
  cardDoc(c);
  await c.send({ type: "SCREENSHOT", id: "s1" });
});
sc("screenshot-blank-or-non-string-ids-count-as-none", async (c) => {
  const { card } = cardDoc(c);
  c.figma.currentPage.selection = [card];
  await c.send({ type: "SCREENSHOT", id: "s1", nodeIds: "   " });
  await c.send({ type: "SCREENSHOT", id: "s2", nodeIds: [card.id] });
  await c.send({ type: "SCREENSHOT", id: "s3", nodeIds: "" });
});
sc("screenshot-autozoom-flags", async (c) => {
  const { card } = cardDoc(c);
  await c.send({ type: "SCREENSHOT", id: "s1", nodeIds: card.id, autoZoom: false });
  await c.send({ type: "SET_AUTO_ZOOM", value: false });
  await c.send({ type: "SCREENSHOT", id: "s2", nodeIds: card.id });
});
sc("screenshot-scale-and-max-px-reach-the-export", async (c) => {
  const big = c.add("FRAME", { name: "Big", width: 4000, height: 1000 });
  await c.send({ type: "SCREENSHOT", id: "s1", nodeIds: big.id, scale: 3, max_px: 600 });
  await c.send({ type: "SCREENSHOT", id: "s2", nodeIds: big.id });
  await c.send({ type: "SCREENSHOT", id: "s3", nodeIds: big.id, scale: -1, max_px: -5 });
  await c.send({ type: "SCREENSHOT", id: "s4", nodeIds: big.id, scale: 0.25, max_px: 99999 });
});
sc("screenshot-megapixel-cap", async (c) => {
  const huge = c.add("FRAME", { name: "Huge", width: 9000, height: 9000 });
  await c.send({ type: "SCREENSHOT", id: "s1", nodeIds: huge.id, scale: 1, max_px: 100000 });
});
sc("screenshot-export-failure-is-reported-per-node", async (c) => {
  const ok = c.add("FRAME", { name: "Fine" });
  const bad = c.add("FRAME", { name: "Broken", exportError: "no pixels" });
  await c.send({ type: "SCREENSHOT", id: "s1", nodeIds: ok.id + "," + bad.id });
});
sc("screenshot-too-large-after-encoding", async (c) => {
  const big = c.add("FRAME", { name: "Heavy", exportBytes: new Array(6400000).fill(1) });
  await c.send({ type: "SCREENSHOT", id: "s1", nodeIds: big.id });
});
sc("screenshot-base64-padding-for-every-length", async (c) => {
  const ids = [1, 2, 3, 4, 5].map(n => c.add("FRAME", { name: "L" + n, exportBytes: Array.from({ length: n }, (_, i) => 250 - i * 37) }).id);
  await c.send({ type: "SCREENSHOT", id: "s1", nodeIds: ids.join(",") });
});
sc("screenshot-default-name-for-unnamed-node", async (c) => {
  const n = c.add("FRAME", { name: "" });
  await c.send({ type: "SCREENSHOT", id: "s1", nodeIds: n.id });
});
sc("screenshot-failure-inside-loop-is-an-error-envelope", async (c) => {
  const weird = { name: "Weird", exportAsync: async () => new Uint8Array([1]) };
  Object.defineProperty(weird, "id", { get() { throw new Error("id unreadable"); } });
  c.figma.currentPage.selection = [weird];
  await c.send({ type: "SCREENSHOT", id: "s1", startTime: 7, autoZoom: false });
});
sc("screenshot-failure-inside-loop-default-description", async (c) => {
  const weird = { name: "Weird", exportAsync: async () => new Uint8Array([1]) };
  Object.defineProperty(weird, "id", { get() { throw new Error(); } });
  c.figma.currentPage.selection = [weird];
  await c.send({ type: "SCREENSHOT", id: "s2", autoZoom: false });
});
sc("screenshot-notify-failure-escapes-the-handler", async (c) => {
  const { card } = cardDoc(c);
  c.stub.hooks.notifyThrows = true;
  await c.send({ type: "SCREENSHOT", id: "s1", nodeIds: card.id });
});
sc("screenshot-toast-names-the-targets", async (c) => {
  const { card, hero } = cardDoc(c);
  await c.send({ type: "SCREENSHOT", id: "s1", nodeIds: card.id + "," + hero.id });
});

// ===== FIND_COMPONENTS =====
const FC = (o) => Object.assign({ type: "FIND_COMPONENTS", id: "f1", startTime: 1 }, o);
sc("find_components-empty-query-lists-everything", async (c) => {
  componentsDoc(c);
  await c.send(FC({}));
});
sc("find_components-exact-prefix-ranking", async (c) => {
  componentsDoc(c);
  await c.send(FC({ query: "button" }));
});
sc("find_components-query-is-trimmed-and-case-insensitive", async (c) => {
  componentsDoc(c);
  await c.send(FC({ query: "  BUTTON  " }));
});
sc("find_components-token-prefix", async (c) => {
  componentsDoc(c);
  await c.send(FC({ query: "arrow" }));
  await c.send(FC({ query: "ico" }));
});
sc("find_components-multi-token-query-is-dropped-by-the-detail-recheck", async (c) => {
  componentsDoc(c);
  await c.send(FC({ query: "icon arrow" }));
});
sc("find_components-multi-token-query-rescued-by-description", async (c) => {
  const d = componentsDoc(c);
  d.arrow.description = "the icon arrow used in nav";
  await c.send(FC({ query: "icon arrow" }));
});
sc("find_components-multi-token-query-rescued-by-variant-values", async (c) => {
  const set = c.add("COMPONENT_SET", { name: "Nav / Item", componentPropertyDefinitions: { Kind: { type: "VARIANT", variantOptions: ["nav item", "other"] } } });
  c.add("COMPONENT", { name: "Kind=nav item", variantProperties: { Kind: "nav item" }, componentProperties: {} }, set);
  await c.send(FC({ query: "nav item" }));
});
sc("find_components-fuzzy-typo-is-dropped-by-the-detail-recheck", async (c) => {
  componentsDoc(c);
  await c.send(FC({ query: "buton" }));
  await c.send(FC({ query: "crad" }));
});
sc("find_components-typo-rescued-when-description-contains-it", async (c) => {
  const d = componentsDoc(c);
  d.card.description = "crad of the day";
  await c.send(FC({ query: "crad" }));
});
sc("find_components-no-match", async (c) => {
  componentsDoc(c);
  await c.send(FC({ query: "zzzzzz" }));
});
sc("find_components-page-name-filter", async (c) => {
  componentsDoc(c);
  await c.send(FC({ page_name: "cards" }));
  await c.send(FC({ page_name: "BUTTONS", query: "button" }));
  await c.send(FC({ page_name: "Nope" }));
});
sc("find_components-include-variants-false", async (c) => {
  componentsDoc(c);
  await c.send(FC({ query: "button", include_variants: false }));
});
sc("find_components-limit", async (c) => {
  componentsDoc(c);
  await c.send(FC({ limit: 1 }));
  await c.send(FC({ limit: 2, query: "button" }));
  await c.send(FC({ limit: 0 }));
  await c.send(FC({ limit: null }));
});
sc("find_components-variant-axes-from-children-when-no-definitions", async (c) => {
  componentsDoc(c);
  const set = c.add("COMPONENT_SET", { name: "Toggle", key: "tg" });
  c.add("COMPONENT", { name: "On=true", variantProperties: { On: "true" }, componentProperties: {} }, set);
  c.add("COMPONENT", { name: "On=false", variantProperties: { On: "false" }, componentProperties: {} }, set);
  c.add("COMPONENT", { name: "plain child", componentProperties: {} }, set);
  await c.send(FC({ query: "toggle" }));
});
sc("find_components-set-with-only-non-variant-properties", async (c) => {
  const set = c.add("COMPONENT_SET", { name: "Badge", componentPropertyDefinitions: { Text: { type: "TEXT", defaultValue: "New" }, Dot: { type: "BOOLEAN", defaultValue: false } } });
  c.add("COMPONENT", { name: "x", componentProperties: {} }, set);
  await c.send(FC({ query: "badge" }));
});
sc("find_components-component-properties-and-description", async (c) => {
  componentsDoc(c);
  await c.send(FC({ query: "icon / arrow" }));
});
sc("find_components-index-is-cached-until-refresh", async (c) => {
  componentsDoc(c);
  await c.send(FC({ query: "late" }));
  c.add("COMPONENT", { name: "Latecomer", componentProperties: {} });
  await c.send(FC({ query: "late" }));
  await c.send(FC({ query: "late", refresh_index: true }));
  await c.send(FC({ query: "late", refresh_index: "true" }));
});
sc("find_components-document-change-events-invalidate-the-index", async (c) => {
  componentsDoc(c);
  await c.send(FC({ query: "fresh" }));
  const n = c.add("COMPONENT", { name: "Fresh one", componentProperties: {} });
  c.stub.emit("documentchange", { documentChanges: [{ type: "PROPERTY_CHANGE", properties: ["x"] }, { type: "STYLE_CREATE" }] });
  await c.send(FC({ query: "fresh" }));
  c.stub.emit("documentchange", { documentChanges: [{ type: "CREATE" }] });
  await c.send(FC({ query: "fresh" }));
  n.name = "Renamed thing";
  await c.send(FC({ query: "renamed" }));
  c.stub.emit("documentchange", { documentChanges: [{ type: "PROPERTY_CHANGE", properties: ["name"] }] });
  await c.send(FC({ query: "renamed" }));
  c.stub.emit("documentchange", {});
  c.stub.emit("documentchange", { documentChanges: [{ type: "DELETE" }] });
});
sc("find_components-index-expires-after-sixty-seconds", async (c) => {
  componentsDoc(c);
  await c.send(FC({ query: "aged" }));
  c.add("COMPONENT", { name: "Aged well", componentProperties: {} });
  c.stub.clock.advance(59999);
  await c.send(FC({ query: "aged" }));
  c.stub.clock.advance(2);
  await c.send(FC({ query: "aged" }));
});
sc("find_components-deleted-component-is-skipped", async (c) => {
  const d = componentsDoc(c);
  await c.send(FC({ query: "card" }));
  d.card.remove();
  await c.send(FC({ query: "card" }));
});
sc("find_components-page-that-fails-to-scan-is-skipped", async (c) => {
  componentsDoc(c);
  const bad = c.page("Broken");
  bad.findAll = () => { throw new Error("cannot scan"); };
  await c.send(FC({ query: "button" }));
});
sc("find_components-non-string-query-is-an-error", async (c) => {
  componentsDoc(c);
  await c.send(FC({ query: 123 }));
});
sc("find_components-non-string-page-name-is-an-error", async (c) => {
  componentsDoc(c);
  await c.send(FC({ page_name: 5 }));
});
sc("find_components-empty-document", async (c) => {
  await c.send(FC({ query: "anything" }));
  await c.send(FC({}));
});
sc("find_components-nested-components-in-frames-are-found", async (c) => {
  const f = c.add("FRAME", { name: "Wrapper" });
  c.add("COMPONENT", { name: "Deep Item", componentProperties: {} }, f);
  await c.send(FC({ query: "deep" }));
});

// ===== INSERT_COMPONENT_INSTANCE =====
const IC = (o) => Object.assign({ type: "INSERT_COMPONENT_INSTANCE", id: "i1", startTime: 1 }, o);
sc("insert_component_instance-by-id-with-dashes", async (c) => {
  const d = componentsDoc(c);
  await c.send(IC({ component_id: d.arrow.id.replace(":", "-") }));
});
sc("insert_component_instance-by-exact-name", async (c) => {
  componentsDoc(c);
  await c.send(IC({ component_name: " CARD " }));
});
sc("insert_component_instance-by-partial-name-first-page-wins", async (c) => {
  componentsDoc(c);
  await c.send(IC({ component_name: "icon" }));
});
sc("insert_component_instance-exact-set-beats-looser-matches", async (c) => {
  componentsDoc(c);
  await c.send(IC({ component_name: "button" }));
});
sc("insert_component_instance-unknown-id-falls-back-to-name", async (c) => {
  componentsDoc(c);
  await c.send(IC({ component_id: "9:99", component_name: "card" }));
});
sc("insert_component_instance-not-found", async (c) => {
  componentsDoc(c);
  await c.send(IC({ component_name: "Nope" }));
  await c.send(IC({ component_id: "9:99" }));
  await c.send(IC({}));
});
sc("insert_component_instance-id-of-a-non-component", async (c) => {
  const { card } = cardDoc(c);
  await c.send(IC({ component_id: card.id }));
});
sc("insert_component_instance-set-variant-match", async (c) => {
  const d = componentsDoc(c);
  await c.send(IC({ component_name: "Button", properties: { Size: "L", State: "Hover" } }));
  c.note("master", d.variants.LHover.id);
});
sc("insert_component_instance-set-variant-match-ignores-case", async (c) => {
  componentsDoc(c);
  await c.send(IC({ component_name: "Button", properties: { size: "l", STATE: "default" } }));
});
sc("insert_component_instance-set-variant-no-match-is-an-error", async (c) => {
  componentsDoc(c);
  await c.send(IC({ component_name: "Button", properties: { Size: "XL" } }));
});
sc("insert_component_instance-set-component-property-only-uses-default-variant", async (c) => {
  componentsDoc(c);
  await c.send(IC({ component_name: "Button", properties: { "Label#1:0": "Buy now" } }));
});
sc("insert_component_instance-set-unknown-property-is-a-warning", async (c) => {
  componentsDoc(c);
  await c.send(IC({ component_name: "Button", properties: { Colour: "red" } }));
});
sc("insert_component_instance-set-without-default-variant-takes-first-child", async (c) => {
  const d = componentsDoc(c);
  d.set.defaultVariant = undefined;
  await c.send(IC({ component_name: "Button" }));
});
sc("insert_component_instance-empty-set-is-an-error", async (c) => {
  c.add("COMPONENT_SET", { name: "Hollow" });
  await c.send(IC({ component_name: "Hollow" }));
});
sc("insert_component_instance-set-with-non-component-child-only", async (c) => {
  const set = c.add("COMPONENT_SET", { name: "Odd" });
  c.add("FRAME", { name: "not a variant" }, set);
  await c.send(IC({ component_name: "Odd" }));
});
sc("insert_component_instance-properties-are-ignored-for-plain-components", async (c) => {
  componentsDoc(c);
  await c.send(IC({ component_name: "Icon / Arrow", properties: { Show: false } }));
});
sc("insert_component_instance-text-override-by-property-layer-name-and-content", async (c) => {
  componentsDoc(c);
  await c.send(IC({ component_name: "Button", text_overrides: { "Label#1:0": "Via prop" } }));
  await c.send(IC({ component_name: "Button", text_overrides: { Label: "Via name" } }));
  await c.send(IC({ component_name: "Button", text_overrides: { Click: "Via old text" } }));
});
sc("insert_component_instance-text-override-partial-name-only-when-unambiguous", async (c) => {
  componentsDoc(c);
  await c.send(IC({ component_name: "Card", text_overrides: { tit: "Unique partial" } }));
  const two = c.add("COMPONENT", { name: "Twin", componentProperties: {} });
  c.add("TEXT", { name: "Title A", characters: "a" }, two);
  c.add("TEXT", { name: "Title B", characters: "b" }, two);
  await c.send(IC({ component_name: "Twin", text_overrides: { title: "Ambiguous" } }));
});
sc("insert_component_instance-text-override-misses-become-warnings", async (c) => {
  componentsDoc(c);
  await c.send(IC({ component_name: "Card", text_overrides: { Title: "Ok", Ghost: "x", Phantom: 5 } }));
});
sc("insert_component_instance-text-override-values-are-stringified", async (c) => {
  componentsDoc(c);
  await c.send(IC({ component_name: "Card", text_overrides: { Title: 42, Body: null } }));
});
sc("insert_component_instance-text-overrides-of-wrong-shape-are-skipped", async (c) => {
  componentsDoc(c);
  await c.send(IC({ component_name: "Card", text_overrides: "Title" }));
  await c.send(IC({ component_name: "Card", text_overrides: null }));
  await c.send(IC({ component_name: "Card", text_overrides: {} }));
  await c.send(IC({ component_name: "Card", text_overrides: ["Title"] }));
});
sc("insert_component_instance-text-override-loads-fonts-of-the-target", async (c) => {
  const comp = c.add("COMPONENT", { name: "Fancy", componentProperties: {} });
  c.add("TEXT", { name: "Plain", characters: "p", fontName: { family: "Roboto", style: "Bold" } }, comp);
  c.add("TEXT", { name: "Mixed", characters: "m", fontName: c.stub.mixed, getStyledTextSegments: () => [{ fontName: { family: "Lora", style: "Italic" } }, { fontName: { family: "Lora", style: "Italic" } }, { fontName: { family: "Oswald", style: "Light" } }, { fontName: null }] }, comp);
  c.add("TEXT", { name: "Old", characters: "ab", fontName: c.stub.mixed, getRangeFontName: (i) => (i === 0 ? { family: "Georgia", style: "Regular" } : c.stub.mixed) }, comp);
  await c.send(IC({ component_name: "Fancy", text_overrides: { Plain: "1", Mixed: "2", Old: "3" } }));
});
sc("insert_component_instance-text-override-write-failure-leaves-it-unapplied", async (c) => {
  const comp = c.add("COMPONENT", { name: "Locked", componentProperties: {} });
  c.add("TEXT", { name: "Label", characters: "x" }, comp);
  const orig = comp.createInstance;
  comp.createInstance = function () {
    const inst = orig.call(this);
    const t = inst.children[0];
    Object.defineProperty(t, "characters", { get() { return "x"; }, set() { throw new Error("font missing"); } });
    return inst;
  };
  await c.send(IC({ component_name: "Locked", text_overrides: { Label: "y" } }));
});
sc("insert_component_instance-into-target-parent", async (c) => {
  const d = componentsDoc(c);
  const frame = c.add("FRAME", { name: "Container", x: 800, y: 0 });
  await c.send(IC({ component_name: "Card", target_parent_id: frame.id }));
  await c.send(IC({ component_name: "Card", target_parent_id: frame.id.replace(":", "-") }));
  c.note("master", d.card.id);
});
sc("insert_component_instance-bad-parent-falls-back-to-selected-frame-then-page", async (c) => {
  componentsDoc(c);
  const frame = c.add("FRAME", { name: "Selected frame", x: 800, y: 0 });
  const text = c.add("TEXT", { name: "Selected text", x: 1200 });
  c.figma.currentPage.selection = [frame];
  await c.send(IC({ component_name: "Card", target_parent_id: "9:99" }));
  c.figma.currentPage.selection = [text];
  await c.send(IC({ component_name: "Card" }));
  c.figma.currentPage.selection = [];
  await c.send(IC({ component_name: "Card" }));
});
sc("insert_component_instance-position-index-and-xy", async (c) => {
  componentsDoc(c);
  const frame = c.add("FRAME", { name: "Container", x: 800 });
  c.add("RECTANGLE", { name: "first" }, frame);
  c.add("RECTANGLE", { name: "second" }, frame);
  await c.send(IC({ component_name: "Card", target_parent_id: frame.id, position: { index: 1 } }));
  await c.send(IC({ component_name: "Card", target_parent_id: frame.id, position: { x: 30, y: 40 } }));
  await c.send(IC({ component_name: "Card", target_parent_id: frame.id, position: { index: 0, x: 5, y: 6 } }));
  await c.send(IC({ component_name: "Card", target_parent_id: frame.id, position: { x: 5 } }));
  await c.send(IC({ component_name: "Card", target_parent_id: frame.id, position: { index: "0" } }));
  await c.send(IC({ component_name: "Card", position: { x: 700, y: 900 } }));
});
sc("insert_component_instance-on-page-avoids-overlap", async (c) => {
  componentsDoc(c);
  c.stub.setPage(c.page("Work"));
  c.add("FRAME", { name: "Existing", width: 400, height: 300 });
  await c.send(IC({ component_name: "Card" }));
  await c.send(IC({ component_name: "Card" }));
});
sc("insert_component_instance-capture", async (c) => {
  componentsDoc(c);
  await c.send(IC({ component_name: "Card", capture: true, scale: 2, max_px: 500 }));
});
sc("insert_component_instance-capture-failure-becomes-note", async (c) => {
  componentsDoc(c);
  c.stub.hooks.failExports = "no render";
  await c.send(IC({ component_name: "Card", capture: true }));
});
sc("insert_component_instance-autozoom-off", async (c) => {
  componentsDoc(c);
  await c.send({ type: "SET_AUTO_ZOOM", value: false });
  await c.send(IC({ component_name: "Card" }));
});
sc("insert_component_instance-parent-that-cannot-hold-children-fails-after-creating", async (c) => {
  componentsDoc(c);
  const text = c.add("TEXT", { name: "Not a container" });
  await c.send(IC({ component_name: "Card", target_parent_id: text.id }));
  await c.send({ type: "ROLLBACK", id: "r1" });
});
sc("insert_component_instance-then-rollback", async (c) => {
  componentsDoc(c);
  await c.send(IC({ component_name: "Card" }));
  await c.send({ type: "ROLLBACK", id: "r1" });
});
sc("insert_component_instance-font-loading-and-toast-batching", async (c) => {
  componentsDoc(c);
  for (let i = 0; i < 4; i++) await c.send(IC({ id: "i" + i, component_name: "Card" }));
});

// ===== GET_VARIABLES =====
const VARS = {
  collections: [
    { id: "c1", name: "Colors", defaultModeId: "m1", modes: [{ modeId: "m1", name: "Light" }, { modeId: "m2", name: "Dark" }] },
    { id: "c2", name: "Spacing", defaultModeId: "m3", modes: [{ modeId: "m3", name: "Default" }] }
  ],
  variables: [
    { id: "v1", name: "bg/primary", resolvedType: "COLOR", variableCollectionId: "c1", description: "Main background", valuesByMode: { m1: { r: 1, g: 1, b: 1, a: 1 }, m2: { r: 0, g: 0, b: 0, a: 1 } } },
    { id: "v2", name: "text/primary", resolvedType: "COLOR", variableCollectionId: "c1", description: "", valuesByMode: { m1: { r: 0, g: 0, b: 0, a: 1 }, m2: { type: "VARIABLE_ALIAS", id: "v1" } } },
    { id: "v3", name: "space/sm", resolvedType: "FLOAT", variableCollectionId: "c2", valuesByMode: { m3: 8 } },
    { id: "v4", name: "space/md", resolvedType: "FLOAT", variableCollectionId: "c2", description: "Medium", valuesByMode: { m3: 16 } },
    { id: "v5", name: "orphan", resolvedType: "STRING", variableCollectionId: "gone", valuesByMode: { m9: "x" } }
  ]
};
const GV = (o) => Object.assign({ type: "GET_VARIABLES", id: "g1", startTime: 2 }, o);
sc("get_variables-everything", { doc: VARS }, async (c) => { await c.send(GV({})); });
sc("get_variables-empty-document", async (c) => { await c.send(GV({})); });
sc("get_variables-filter-by-collection-name", { doc: VARS }, async (c) => {
  await c.send(GV({ collection_name: "colors" }));
  await c.send(GV({ collection_name: "  SPAC " }));
  await c.send(GV({ collection_name: "nothing" }));
});
sc("get_variables-limit-truncates-with-note", { doc: VARS }, async (c) => {
  await c.send(GV({ limit: 3 }));
  await c.send(GV({ limit: 1 }));
  await c.send(GV({ limit: 4 }));
});
sc("get_variables-bad-limits-mean-300", { doc: VARS }, async (c) => {
  await c.send(GV({ limit: 0 }));
  await c.send(GV({ limit: -2 }));
  await c.send(GV({ limit: "2" }));
  await c.send(GV({ limit: null }));
});
sc("get_variables-api-failure", { doc: VARS }, async (c) => {
  c.stub.hooks.failVariables = true;
  await c.send(GV({ collection_name: "colors" }));
});

// ===== SET_VARIABLES_MODE =====
const SM = (o) => Object.assign({ type: "SET_VARIABLES_MODE", id: "m1", startTime: 3 }, o);
sc("set_variables_mode-on-explicit-target", { doc: VARS }, async (c) => {
  const { card } = cardDoc(c);
  await c.send(SM({ collection_name: "Colors", mode_name: "Dark", target_id: card.id }));
});
sc("set_variables_mode-target-id-with-dashes-and-partial-names", { doc: VARS }, async (c) => {
  const { hero } = cardDoc(c);
  await c.send(SM({ collection_name: "col", mode_name: "DAR", target_id: hero.id.replace(":", "-") }));
});
sc("set_variables_mode-defaults-to-first-selected-node-then-page", { doc: VARS }, async (c) => {
  const { hero } = cardDoc(c);
  c.figma.currentPage.selection = [hero];
  await c.send(SM({ collection_name: "Colors", mode_name: "Light" }));
  c.figma.currentPage.selection = [];
  await c.send(SM({ collection_name: "Colors", mode_name: "Dark", target_id: "9:99" }));
});
sc("set_variables_mode-collection-not-found", { doc: VARS }, async (c) => {
  await c.send(SM({ collection_name: "Nope", mode_name: "Dark" }));
});
sc("set_variables_mode-mode-not-found-lists-available", { doc: VARS }, async (c) => {
  await c.send(SM({ collection_name: "Colors", mode_name: "Sepia" }));
});
sc("set_variables_mode-empty-names-match-the-first-collection-and-mode", { doc: VARS }, async (c) => {
  await c.send(SM({ collection_name: "", mode_name: "" }));
  await c.send(SM({ id: "m2" }));
});
sc("set_variables_mode-capture", { doc: VARS }, async (c) => {
  const { card } = cardDoc(c);
  await c.send(SM({ collection_name: "Colors", mode_name: "Dark", target_id: card.id, capture: true, scale: 2 }));
});
sc("set_variables_mode-capture-failure-becomes-note", { doc: VARS }, async (c) => {
  const { card } = cardDoc(c);
  c.stub.hooks.failExports = "nope";
  await c.send(SM({ collection_name: "Colors", mode_name: "Dark", target_id: card.id, capture: true }));
});
sc("set_variables_mode-api-rejects-the-switch", { doc: VARS }, async (c) => {
  const { card } = cardDoc(c);
  c.stub.hooks.failModeSet = "mode switch denied";
  await c.send(SM({ collection_name: "Colors", mode_name: "Dark", target_id: card.id }));
});
sc("set_variables_mode-variables-api-failure", { doc: VARS }, async (c) => {
  c.stub.hooks.failVariables = true;
  await c.send(SM({ collection_name: "Colors", mode_name: "Dark" }));
});

// ===== INSERT_SVG =====
const SV = (o) => Object.assign({ type: "INSERT_SVG", id: "v1", startTime: 4 }, o);
sc("insert_svg-basic", async (c) => { await c.send(SV({ svg_code: SVG })); });
sc("insert_svg-named-and-avoids-existing-frames", async (c) => {
  cardDoc(c);
  await c.send(SV({ svg_code: SVG, name: "Arrow" }));
});
sc("insert_svg-invalid-svg-code", async (c) => {
  await c.send(SV({}));
  await c.send(SV({ svg_code: "" }));
  await c.send(SV({ svg_code: 42 }));
  await c.send(SV({ svg_code: "<div>not svg</div>" }));
});
sc("insert_svg-width-height-scaling", async (c) => {
  await c.send(SV({ svg_code: SVG_STROKE, width: 96 }));
  await c.send(SV({ svg_code: SVG_STROKE, height: 12 }));
  await c.send(SV({ svg_code: SVG_STROKE, width: 10, height: 50 }));
  await c.send(SV({ svg_code: SVG_STROKE, width: 48 }));
  await c.send(SV({ svg_code: SVG_STROKE, width: 48, height: 24 }));
  await c.send(SV({ svg_code: SVG_STROKE, width: 0, height: 0 }));
});
sc("insert_svg-scaling-sets-scale-constraints-on-the-subtree", async (c) => {
  await c.send(SV({ svg_code: SVG, width: 48 }));
});
sc("insert_svg-color-overrides", async (c) => {
  await c.send(SV({ svg_code: SVG, name: "Fill", fill_override: "#FF0000" }));
  await c.send(SV({ svg_code: SVG_STROKE, name: "Stroke", stroke_override: "#00ff00" }));
  await c.send(SV({ svg_code: SVG_STROKE, name: "Universal", color_override: "rgb(10, 20, 30)", fill_override: "white" }));
  await c.send(SV({ svg_code: SVG, name: "Short hex", color_override: "#f00" }));
  await c.send(SV({ svg_code: SVG, name: "Black", fill_override: "black" }));
  await c.send(SV({ svg_code: SVG, name: "Clamped", fill_override: "rgba(300, 0, 0, 0.5)" }));
});
sc("insert_svg-transparent-and-non-string-colors-are-ignored", async (c) => {
  await c.send(SV({ svg_code: SVG, name: "T", fill_override: "transparent" }));
  await c.send(SV({ svg_code: SVG, name: "N", fill_override: 255, color_override: {} }));
});
sc("insert_svg-invalid-colors-are-errors", async (c) => {
  await c.send(SV({ svg_code: SVG, fill_override: "#zzzzzz" }));
  await c.send(SV({ svg_code: SVG, stroke_override: "#ffff" }));
  await c.send(SV({ svg_code: SVG, color_override: "notacolor" }));
  await c.send(SV({ svg_code: SVG, fill_override: "rgb(1,2)" }));
});
sc("insert_svg-as-component", async (c) => {
  await c.send(SV({ svg_code: SVG, as_component: true, name: "Icon / Check", width: 32 }));
  await c.send(SV({ svg_code: SVG, as_component: true }));
});
sc("insert_svg-as-component-then-rollback", async (c) => {
  await c.send(SV({ svg_code: SVG, as_component: true, name: "Icon / Check" }));
  await c.send({ type: "ROLLBACK", id: "r1" });
});
sc("insert_svg-into-target-parent-and-selection", async (c) => {
  const frame = c.add("FRAME", { name: "Container", x: 500 });
  const text = c.add("TEXT", { name: "T", x: 900 });
  await c.send(SV({ svg_code: SVG, target_parent_id: frame.id.replace(":", "-") }));
  c.figma.currentPage.selection = [frame];
  await c.send(SV({ svg_code: SVG, target_parent_id: "9:99", name: "via selection" }));
  c.figma.currentPage.selection = [text];
  await c.send(SV({ svg_code: SVG, name: "page because text selected" }));
});
sc("insert_svg-position", async (c) => {
  const frame = c.add("FRAME", { name: "Container", x: 500 });
  c.add("RECTANGLE", { name: "first" }, frame);
  await c.send(SV({ svg_code: SVG, target_parent_id: frame.id, position: { index: 0 }, name: "idx" }));
  await c.send(SV({ svg_code: SVG, target_parent_id: frame.id, position: { x: 7, y: 9 }, name: "xy" }));
  await c.send(SV({ svg_code: SVG, position: { x: 300, y: 300 }, name: "page xy" }));
  await c.send(SV({ svg_code: SVG, position: { x: 1 }, name: "half xy" }));
});
sc("insert_svg-capture", async (c) => {
  await c.send(SV({ svg_code: SVG, capture: true }));
  await c.send(SV({ svg_code: SVG, capture: true, scale: 1, max_px: 30 }));
});
sc("insert_svg-capture-failure-becomes-note", async (c) => {
  c.stub.hooks.failExports = "no render";
  await c.send(SV({ svg_code: SVG, capture: true }));
});
sc("insert_svg-autozoom-off", async (c) => {
  await c.send({ type: "SET_AUTO_ZOOM", value: false });
  await c.send(SV({ svg_code: SVG }));
});
sc("insert_svg-zero-size-svg-gets-a-lint-warning", async (c) => {
  await c.send(SV({ svg_code: '<svg width="0" height="10"></svg>', name: "Flat" }));
});
sc("insert_svg-parent-that-cannot-hold-children-fails-after-creating", async (c) => {
  const text = c.add("TEXT", { name: "Not a container" });
  await c.send(SV({ svg_code: SVG, target_parent_id: text.id }));
  await c.send({ type: "ROLLBACK", id: "r1" });
});
sc("insert_svg-toast-batching-and-error-toast", async (c) => {
  for (let i = 0; i < 3; i++) await c.send(SV({ id: "v" + i, svg_code: SVG, name: "S" + i }));
  await c.send(SV({ id: "bad", svg_code: "nope" }));
});

// ===== GET_CANVAS_LAYOUT =====
const GL = (o) => Object.assign({ type: "GET_CANVAS_LAYOUT", id: "L1", startTime: 6 }, o);
sc("get_canvas_layout-empty-page", async (c) => { await c.send(GL({})); });
sc("get_canvas_layout-lists-artboards-and-suggests-a-slot", async (c) => {
  cardDoc(c);
  c.add("FRAME", { name: "Hidden", x: 2000, y: 2000, visible: false });
  c.add("RECTANGLE", { name: "Fractional", x: 1000.4, y: -50.6, width: 10.5, height: 20.49 });
  await c.send(GL({}));
});
sc("get_canvas_layout-direction-gap-and-grid", async (c) => {
  cardDoc(c);
  await c.send(GL({ direction: "BOTTOM", gap: 40 }));
  await c.send(GL({ layout: "grid", columns: 2, gap: 20 }));
  await c.send(GL({ direction: "RIGHT", gap: 0 }));
  await c.send(GL({ direction: "bottom", gap: "wide" }));
});
sc("get_canvas_layout-limit-caps-the-listing-not-the-bounds", async (c) => {
  for (let i = 0; i < 5; i++) c.add("FRAME", { name: "F" + i, x: i * 500, y: 0 });
  await c.send(GL({ limit: 2 }));
  await c.send(GL({ limit: 0 }));
  await c.send(GL({ limit: -1 }));
  await c.send(GL({ limit: "2" }));
  await c.send(GL({ limit: 5 }));
});
sc("get_canvas_layout-only-hidden-nodes", async (c) => {
  c.add("FRAME", { name: "Hidden", visible: false });
  await c.send(GL({}));
});
sc("get_canvas_layout-full-grid-wraps-to-the-next-row", async (c) => {
  for (let i = 0; i < 4; i++) c.add("FRAME", { name: "F" + i, x: i * 480, y: 0, width: 400, height: 800 });
  await c.send(GL({ layout: "grid", columns: 4 }));
  await c.send(GL({ layout: "grid", columns: 3 }));
});
sc("get_canvas_layout-page-read-failure", async (c) => {
  const page = c.figma.currentPage;
  const kids = page.children;
  Object.defineProperty(page, "children", { get() { throw new Error("page unreadable"); }, configurable: true });
  await c.send(GL({}));
  Object.defineProperty(page, "children", { value: kids, writable: true, enumerable: true, configurable: true });
});

// ===== READ_CANVAS =====
const RC = (o) => Object.assign({ type: "READ_CANVAS", id: "R1", startTime: 8 }, o);
function richDoc(c) {
  const mixed = c.stub.mixed;
  const white = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
  const comp = c.add("COMPONENT", { name: "Chip", componentProperties: {}, x: 2000, y: 0 });
  const screen = c.add("FRAME", {
    name: "Screen", x: 0, y: 0, width: 375, height: 812, layoutMode: "VERTICAL", itemSpacing: 16, paddingTop: 8, paddingRight: 12, paddingBottom: 8, paddingLeft: 12,
    counterAxisAlignItems: "CENTER", primaryAxisAlignItems: "MIN", layoutWrap: "WRAP", fills: white, strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }], strokeWeight: 2,
    cornerRadius: 12, opacity: 0.9, clipsContent: true, layoutSizingHorizontal: "FILL", layoutSizingVertical: "HUG", layoutPositioning: "ABSOLUTE"
  });
  c.add("TEXT", { name: "Title", characters: "Welcome", fontName: { family: "Inter", style: "Semi Bold Italic" }, fontSize: 24, lineHeight: { unit: "PIXELS", value: 32 }, letterSpacing: { unit: "PIXELS", value: -0.5 }, textAlignHorizontal: "LEFT", fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }] }, screen);
  c.add("TEXT", { name: "Mixed", characters: "a b", fontName: mixed, fontSize: mixed, lineHeight: mixed, letterSpacing: mixed, textAlignHorizontal: "CENTER", fills: mixed }, screen);
  c.add("TEXT", { name: "Percent", characters: "", fontName: { family: "Roboto", style: "Mystery" }, fontSize: 12, lineHeight: { unit: "PERCENT", value: 120 }, letterSpacing: { unit: "PERCENT", value: 5 }, textAlignHorizontal: "RIGHT" }, screen);
  c.add("RECTANGLE", { name: "Corners", rectangleCornerRadii: [1, 2, 3, 4], cornerRadius: mixed, strokes: [] }, screen);
  c.add("RECTANGLE", { name: "Hidden box", visible: false }, screen);
  c.add("INSTANCE", { name: "Chip instance", mainComponent: comp, variantProperties: { Kind: "A" }, componentProperties: { Label: { type: "TEXT", value: "x" } } }, screen);
  c.add("INSTANCE", { name: "Detached-looking", mainComponent: null, componentProperties: {} }, screen);
  const bbox = c.add("FRAME", { name: "With bbox", x: 10, y: 20, width: 5, height: 5, absoluteBoundingBox: { x: 100, y: 200, width: 50, height: 60 } }, screen);
  c.add("FRAME", { name: "Plain nested" }, bbox);
  const flat = c.add("FRAME", { name: "No layout", layoutMode: "NONE" });
  return { comp, screen, bbox, flat };
}
sc("read_canvas-whole-page-rest-shape", async (c) => { richDoc(c); await c.send(RC({})); });
sc("read_canvas-include-hidden", async (c) => { richDoc(c); await c.send(RC({ include_hidden: true })); await c.send(RC({ include_hidden: "true" })); });
sc("read_canvas-node-ids", async (c) => {
  const d = richDoc(c);
  await c.send(RC({ node_ids: d.screen.id + " , 9:99 , " + d.flat.id }));
  await c.send(RC({ node_ids: "9:99" }));
  await c.send(RC({ node_ids: "" }));
  await c.send(RC({ node_ids: " , , " }));
  await c.send(RC({ node_ids: 5 }));
});
sc("read_canvas-depth-truncates-and-clamps", async (c) => {
  let parent = c.add("FRAME", { name: "L0" });
  for (let i = 1; i <= 14; i++) parent = c.add("FRAME", { name: "L" + i }, parent);
  const summarize = (r) => { let d = 0, n = r.document.children[0]; while (n && n.children) { d++; n = n.children[0]; } return { depthReached: d, lastName: n && n.name, lastTruncated: n && n.truncated }; };
  for (const depth of [1, 3, 99, 0, -1, "3", null, undefined, 12, 13, 2.5]) {
    await c.send(RC({ depth }));
    c.compactLast(summarize);
  }
});
sc("read_canvas-unreadable-property-keeps-the-node", async (c) => {
  const n = c.add("FRAME", { name: "Grumpy", width: 10, height: 10 });
  Object.defineProperty(n, "strokes", { get() { throw new Error("locked"); }, enumerable: false, configurable: true });
  c.add("TEXT", { name: "Kid", characters: "still here" }, n);
  await c.send(RC({}));
});
sc("read_canvas-node-budget-of-4000", { noTree: true }, async (c) => {
  const big = c.add("FRAME", { name: "Big" });
  for (let i = 0; i < 4005; i++) c.add("RECTANGLE", { name: "r" + i }, big);
  c.add("FRAME", { name: "After budget" });
  await c.send(RC({}));
  c.compactLast((r) => ({ truncatedTop: r.truncatedTop, top: r.document.children.map(n => ({ name: n.name, truncated: n.truncated, kids: (n.children || []).length })) }));
  await c.send(RC({ node_ids: big.id + "," + big.id }));
  c.compactLast((r) => ({ truncatedTop: r.truncatedTop, top: r.document.children.map(n => ({ name: n.name, truncated: n.truncated, kids: (n.children || []).length })) }));
});
sc("read_canvas-document-name-and-page", async (c) => {
  c.stub.setPage(c.page("Second page"));
  c.add("FRAME", { name: "Only here" });
  await c.send(RC({}));
});
sc("read_canvas-empty-page", async (c) => { await c.send(RC({})); });
sc("read_canvas-failure-gets-the-hint", async (c) => {
  const page = c.figma.currentPage;
  const kids = page.children;
  Object.defineProperty(page, "children", { get() { throw new Error("Cannot read properties of undefined (reading 'filter')"); }, configurable: true });
  await c.send(RC({}));
  Object.defineProperty(page, "children", { value: kids, writable: true, enumerable: true, configurable: true });
});
sc("read_canvas-failure-without-hint", async (c) => {
  const page = c.figma.currentPage;
  const kids = page.children;
  Object.defineProperty(page, "children", { get() { throw new Error("plain failure"); }, configurable: true });
  await c.send(RC({}));
  Object.defineProperty(page, "children", { value: kids, writable: true, enumerable: true, configurable: true });
});

// ===== ROLLBACK / LIST_CHECKPOINTS =====
const RB = (o) => Object.assign({ type: "ROLLBACK", id: "b1", startTime: 9 }, o);
sc("rollback-by-checkpoint-id-removes-creations", async (c) => {
  const [r] = await c.exec("const a = figma.createFrame(); const b = figma.createText(); a.appendChild(b); return [a.id, b.id];");
  await c.send(RB({ checkpoint_id: r.checkpointId }));
  await c.send({ type: "LIST_CHECKPOINTS", id: "l1" });
});
sc("rollback-without-id-takes-the-last-and-then-the-one-before", async (c) => {
  await c.exec("figma.createFrame().name = 'one'; return 1;");
  c.stub.clock.advance(1000);
  await c.exec("figma.createFrame().name = 'two'; return 2;");
  await c.send(RB({}));
  await c.send(RB({ checkpoint_id: "" }));
  await c.send(RB({}));
  await c.send({ type: "LIST_CHECKPOINTS", id: "l1" });
});
sc("rollback-unknown-and-already-rolled-back", async (c) => {
  await c.send(RB({}));
  await c.send(RB({ checkpoint_id: "cp_nope" }));
  const [r] = await c.exec("figma.createFrame(); return 1;");
  await c.send(RB({ checkpoint_id: r.checkpointId }));
  await c.send(RB({ checkpoint_id: r.checkpointId }));
});
sc("rollback-restores-snapshotted-properties", async (c) => {
  const { card, title, hero } = cardDoc(c);
  title.opacity = 0.5;
  hero.cornerRadius = 4;
  hero.reactions = [{ trigger: { type: "ON_CLICK" } }];
  const [r] = await c.exec(L("for (const id of ['" + card.id + "', '" + title.id + "', '" + hero.id + "']) bridge.snapshot(figma.getNodeById(id));",
    "const card = figma.getNodeById('" + card.id + "'); card.x = 99; card.y = 98; card.resize(10, 11); card.fills = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }]; card.visible = false;",
    "const t = figma.getNodeById('" + title.id + "'); t.characters = 'Changed'; t.opacity = 1;",
    "const h = figma.getNodeById('" + hero.id + "'); h.cornerRadius = 40; h.reactions = [];",
    "return 'edited';"));
  await c.send(RB({ checkpoint_id: r.checkpointId }));
});
sc("rollback-zoom-follows-autozoom", async (c) => {
  const { card } = cardDoc(c);
  const [r1] = await c.exec("bridge.snapshot(figma.getNodeById('" + card.id + "')).x; figma.getNodeById('" + card.id + "').x = 77; return 1;");
  await c.send(RB({ checkpoint_id: r1.checkpointId }));
  const [r2] = await c.exec("bridge.snapshot(figma.getNodeById('" + card.id + "')); figma.getNodeById('" + card.id + "').x = 78; return 2;");
  await c.send({ type: "SET_AUTO_ZOOM", value: false });
  await c.send(RB({ checkpoint_id: r2.checkpointId }));
});
sc("rollback-reports-nodes-it-cannot-find-or-remove", async (c) => {
  const { hero } = cardDoc(c);
  const [r] = await c.exec(L("const f = figma.createFrame(); const g = figma.createFrame(); bridge.snapshot(figma.getNodeById('" + hero.id + "')); figma.getNodeById('" + hero.id + "').x = 5; return [f.id, g.id];"));
  const ids = r.result;
  c.get(ids[0]).remove = () => { throw new Error("locked node"); };
  hero.remove();
  await c.send(RB({ checkpoint_id: r.checkpointId }));
});
sc("rollback-overlay-settings-are-best-effort", async (c) => {
  const overlay = c.add("FRAME", { name: "Overlay", overlayPositionType: "CENTER", overlayBackground: { type: "NONE" }, overlayBackgroundInteraction: "NONE" });
  let writes = 0;
  Object.defineProperty(overlay, "overlayBackgroundInteraction", { get() { return "NONE"; }, set() { writes++; throw new Error("read-only"); }, configurable: true });
  const [r] = await c.exec("const n = figma.getNodeById('" + overlay.id + "'); bridge.snapshot(n); n.overlayPositionType = 'MANUAL'; n.overlayBackground = { type: 'SOLID_COLOR' }; return 1;");
  Object.defineProperty(overlay, "overlayBackgroundInteraction", { get() { return "CLICK_OUTSIDE"; }, set() { writes++; throw new Error("read-only"); }, configurable: true });
  await c.send(RB({ checkpoint_id: r.checkpointId }));
  c.note("attemptedReadOnlyWrites", writes);
});
sc("rollback-of-clone-and-instance-creations", async (c) => {
  const comp = c.add("COMPONENT", { name: "Comp", componentProperties: {} });
  const [r] = await c.exec("const i = figma.getNodeById('" + comp.id + "').createInstance(); const k = figma.getNodeById('" + comp.id + "').clone(); return [i.id, k.id];");
  await c.send(RB({ checkpoint_id: r.checkpointId }));
});
sc("rollback-after-failed-execute-removes-what-was-built", async (c) => {
  await c.exec("figma.createFrame().name = 'partial'; throw new Error('late failure');");
  await c.send(RB({}));
});
sc("list_checkpoints-empty-and-after-writes", async (c) => {
  await c.send({ type: "LIST_CHECKPOINTS", id: "l0" });
  await c.exec("figma.createFrame(); return 1;", { description: "First write" });
  c.stub.clock.advance(5000);
  await c.exec("return 2;", { description: "A read" });
  await c.exec("figma.createRectangle(); figma.createEllipse(); return 3;", { description: "Second write" });
  await c.send({ type: "LIST_CHECKPOINTS", id: "l1", startTime: 77 });
});
sc("list_checkpoints-keeps-only-the-last-fifty", async (c) => {
  for (let i = 0; i < 53; i++) await c.exec("figma.createRectangle(); return " + i + ";", { description: "W" + i }, { record: false });
  await c.send({ type: "LIST_CHECKPOINTS", id: "l1" });
  c.compactLast((list) => ({ count: list.length, first: list[0], last: list[list.length - 1] }));
});
sc("list_checkpoints-bridge-api-shows-the-same-journal", async (c) => {
  await c.exec("figma.createFrame(); return 1;");
  await c.exec("return bridge.checkpoints();");
  await c.exec("const cp = bridge.checkpoint('manual'); figma.createFrame(); cp.commit(); return bridge.checkpoints().length;");
});

//@@SCENARIOS

// ---------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(FIX_DIR, { recursive: true });
  const names = new Set();
  for (const s of SCENARIOS) {
    if (names.has(s.name)) throw new Error("duplicate scenario " + s.name);
    names.add(s.name);
  }
  for (const s of SCENARIOS) {
    const file = path.join(FIX_DIR, s.name + ".json");
    let record;
    try { record = await runScenario(s); }
    catch (e) { check(s.name, false, "scenario crashed: " + (e && e.stack || e)); continue; }
    const text = JSON.stringify(record, null, 1) + "\n";
    if (UPDATE) { fs.writeFileSync(file, text); check(s.name + " (recorded)", true); continue; }
    if (!fs.existsSync(file)) { check(s.name, false, "no fixture, run UPDATE_GOLDEN=1 node tests/plugin-messages.test.js"); continue; }
    const expected = JSON.parse(fs.readFileSync(file, "utf8"));
    const d = firstDiff(JSON.parse(text), expected);
    check(s.name, d === null, d && cut(d));
  }
  // A fixture without a scenario is a deleted/renamed scenario nobody noticed.
  for (const f of fs.readdirSync(FIX_DIR)) {
    if (f.endsWith(".json") && !names.has(f.slice(0, -5))) {
      if (UPDATE) fs.unlinkSync(path.join(FIX_DIR, f));
      else check("fixture " + f + " has a scenario", false);
    }
  }
  const types = new Set();
  for (const s of SCENARIOS) types.add(s.name.split("-")[0]);
  console.log("\n" + SCENARIOS.length + " scenarios, " + types.size + " message groups");
  console.log(passes + " checks passed");
  console.log(failures === 0 ? "ALL PASS" : failures + " FAILURES");
  finished = true;
  process.exitCode = failures ? 1 : 0;
}

let finished = false;
process.on("exit", () => {
  if (!finished) { console.log("  FAIL run did not finish (a scenario awaited something that never resolved)"); process.exitCode = 1; }
});
main().catch((e) => { console.error(e); process.exitCode = 1; finished = true; });

// QUIRKS pinned by the fixtures (current behaviour, not endorsed; fix on purpose and re-record):
// - FIND_COMPONENTS: multi-token ("icon arrow") and typo queries get ranked as candidates but are dropped by the
//   detail re-check, so they return [] unless the description/variant values contain the query; limit 0 returns 1 item;
//   an array in text_overrides is accepted ("0" shows up as a missed key).
// - INSERT_COMPONENT_INSTANCE: `created` lists the instance id twice (createInstance patch + recordCreated);
//   `properties` are ignored for a plain COMPONENT (only applied for COMPONENT_SET variants); the warnings are
//   reported twice (result.warnings and top-level warnings).
// - EXECUTE: selecting an existing top-level frame at 0,0 moves it (autoPositionIfColliding on selection);
//   a throwing figma.notify on the "done" toast turns a finished edit into a failure envelope.
// - SCREENSHOT: figma.notify / scrollAndZoomIntoView failures escape the handler (nothing is posted).
// - SET_VARIABLES_MODE: empty/missing collection_name or mode_name matches the first collection / mode.
// - INSERT_SVG / INSERT_COMPONENT_INSTANCE: after an insert the new node is selected, so the next insert without
//   target_parent_id nests inside it when it is a FRAME.
