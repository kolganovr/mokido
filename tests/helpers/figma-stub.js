// Stub of the Figma plugin sandbox for tests/plugin-messages.test.js.
// createFigmaStub(opts) builds a `figma` object (pages, nodes, variables, clientStorage,
// viewport, notify, ui) that records everything the plugin does to it; loadPlugin(stub)
// executes the UNMODIFIED figma-plugin/code.js against it and returns the sandbox handles.
// Node ids come from a counter, so every run produces the same ids.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const CODE_PATH = path.join(ROOT, "figma-plugin", "code.js");

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]; // 8 bytes -> "iVBORw0KGgo="
const CONTAINER_TYPES = new Set(["PAGE", "FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "SECTION", "GROUP", "BOOLEAN_OPERATION"]);
const FILL_TYPES = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "RECTANGLE", "ELLIPSE", "TEXT", "VECTOR", "STAR", "POLYGON", "LINE", "SECTION"]);
// Own props of a node that are stub plumbing, not document state.
const NON_STATE_KEYS = new Set(["parent", "children", "mainComponent", "defaultVariant", "exportBytes", "exportHang", "exportError", "removed", "baseProps", "selection"]);

function safeId(n) { try { return n.id; } catch (e) { return "[unreadable id]"; } }
function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

function createFigmaStub(opts = {}) {
  let seq = 0;
  let pageSeq = 0;
  const registry = new Map();
  const mixed = Symbol("figma.mixed");
  const state = {
    posted: [],        // every figma.ui.postMessage payload, JSON-cloned at post time
    notifies: [],      // { text, opts }
    cancels: 0,        // runningToast.cancel() calls
    viewport: [],      // ids passed to scrollAndZoomIntoView, one array per call
    resizes: [],       // figma.ui.resize(w, h)
    fontLoads: [],     // "Family/Style" per loadFontAsync call
    exports: [],       // { id, settings } per node.exportAsync
    showUI: [],
    handlers: {},      // figma.on registrations
    storage: new Map(),
    pluginData: {},
    modeSets: []       // setExplicitVariableModeForCollection calls
  };
  const clock = { t: 1700000000000, advance(ms) { this.t += ms; } };
  const hooks = {
    failPost: null,        // (msg) => boolean: throw from postMessage for this message
    throwOnGetId: null,    // id string: getNodeById throws for it
    failStorageGet: false,
    failStorageSet: false,
    failFonts: null,       // (font) => boolean: loadFontAsync rejects
    hangFonts: null,       // (font) => boolean: loadFontAsync never resolves
    failVariables: false,
    failExports: null,     // message: every exportAsync rejects with it
    failModeSet: null,     // message: setExplicitVariableModeForCollection throws
    notifyThrows: false,   // true, or (text) => boolean
  };

  const allMethods = {
    resize(w, h) { this.width = w; this.height = h; },
    resizeWithoutConstraints(w, h) { this.width = w; this.height = h; },
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this);
      const drop = (n) => { n.removed = true; registry.delete(n.id); (n.children || []).forEach(drop); };
      drop(this);
    },
    clone() {
      const copy = (n) => {
        const props = {};
        for (const k of Object.keys(n)) if (!NON_STATE_KEYS.has(k) && k !== "id") props[k] = clone(n[k]);
        props.mainComponent = n.mainComponent;
        const c = mk(n.type, props);
        c.children = (n.children || []).map(ch => { const cc = copy(ch); cc.parent = c; return cc; });
        return c;
      };
      const c = copy(this);
      if (this.parent) { c.parent = this.parent; this.parent.children.push(c); }
      return c;
    },
    createInstance() {
      const inst = mk("INSTANCE", {
        name: this.name, mainComponent: this, width: this.width, height: this.height,
        componentProperties: clone(this.baseProps || {}),
        variantProperties: this.variantProperties ? clone(this.variantProperties) : null,
        layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED", layoutPositioning: "AUTO"
      });
      const copyKids = (from, to) => from.children.forEach(ch => {
        if (ch.type === "TEXT") to.appendChild(mk("TEXT", {
          name: ch.name, characters: ch.characters, fontName: ch.fontName === mixed ? mixed : clone(ch.fontName),
          getStyledTextSegments: ch.getStyledTextSegments, getRangeFontName: ch.getRangeFontName
        }));
        else if (ch.type === "FRAME") { const f = mk("FRAME", { name: ch.name, width: ch.width, height: ch.height }); to.appendChild(f); copyKids(ch, f); }
      });
      copyKids(this, inst);
      return inst;
    },
    setProperties(map) {
      const props = this.componentProperties || {};
      const variants = this.variantProperties || {};
      for (const k of Object.keys(map)) {
        if (!(k in props) && !(k in variants)) throw new Error("stub: unknown component property " + k);
      }
      for (const k of Object.keys(map)) {
        if (k in props) props[k].value = map[k]; else variants[k] = map[k];
      }
    },
    setExplicitVariableModeForCollection(col, modeId) {
      if (hooks.failModeSet) throw new Error(hooks.failModeSet);
      this.explicitModes = Object.assign({}, this.explicitModes, { [col.id]: modeId });
      state.modeSets.push({ node: this.id, collection: col.id, modeId });
    },
    async exportAsync(settings) {
      state.exports.push({ id: this.id, settings: clone(settings) });
      if (this.exportError) throw new Error(this.exportError);
      if (hooks.failExports) throw new Error(hooks.failExports);
      if (this.exportHang) return new Promise(() => {});
      return Uint8Array.from(this.exportBytes || PNG_SIGNATURE);
    }
  };

  const containerMethods = {
    appendChild(c) {
      if (c.parent) c.parent.children = c.parent.children.filter(x => x !== c);
      c.parent = this; this.children.push(c);
    },
    insertChild(i, c) {
      if (c.parent) c.parent.children = c.parent.children.filter(x => x !== c);
      c.parent = this; this.children.splice(i, 0, c);
    },
    findAll(pred) {
      const out = [];
      (function walk(n) { for (const c of n.children || []) { if (!pred || pred(c)) out.push(c); walk(c); } })(this);
      return out;
    },
    findOne(pred) { return this.findAll(pred)[0] || null; },
    findChildren(pred) { return (this.children || []).filter(pred || (() => true)); }
  };
  // One prototype per node type, like the real Plugin API: the plugin patches clone()/createInstance()
  // on each type's prototype, so types must not share (or chain) one.
  const protos = {};
  function protoFor(type) {
    if (!protos[type]) {
      const p = Object.assign({}, allMethods);
      if (type === "PAGE" || type === "DOCUMENT") { delete p.clone; delete p.resize; delete p.resizeWithoutConstraints; }
      if (type !== "COMPONENT") delete p.createInstance;
      if (CONTAINER_TYPES.has(type)) Object.assign(p, containerMethods);
      protos[type] = p;
    }
    return protos[type];
  }

  function mk(type, props) {
    const isPage = type === "PAGE";
    const id = type === "DOCUMENT" ? "0:0" : isPage ? "0:" + (++pageSeq) : "1:" + (++seq);
    const node = Object.create(protoFor(type));
    node.id = id;
    node.type = type;
    node.name = type;
    node.parent = null;
    node.removed = false;
    node.visible = true;
    if (CONTAINER_TYPES.has(type)) node.children = [];
    if (!isPage && type !== "DOCUMENT") {
      node.x = 0; node.y = 0; node.width = 100; node.height = 100;
      node.constraints = { horizontal: "MIN", vertical: "MIN" };
    }
    if (FILL_TYPES.has(type)) { node.fills = []; node.strokes = []; }
    if (type === "FRAME" || type === "COMPONENT" || type === "INSTANCE" || type === "COMPONENT_SET") {
      node.layoutMode = "NONE";
      node.clipsContent = false;
    }
    if (type === "TEXT") {
      node.characters = ""; node.fontName = { family: "Inter", style: "Regular" }; node.fontSize = 14;
      node.textAutoResize = "WIDTH_AND_HEIGHT"; node.width = 100; node.height = 20;
    }
    if (type === "LINE") node.height = 0;
    if (type === "PAGE") node.selection = [];
    Object.assign(node, props || {});
    registry.set(node.id, node);
    return node;
  }

  const root = Object.assign(mk("DOCUMENT", { name: opts.fileName || "Test File" }), {
    setPluginData(k, v) { state.pluginData[k] = v; },
    getPluginData(k) { return state.pluginData[k] || ""; }
  });
  root.children = [];
  const newPage = (name) => { const p = mk("PAGE", { name }); p.parent = root; root.children.push(p); return p; };
  newPage(opts.pageName || "Page 1");

  const onPage = (node) => { figma.currentPage.appendChild(node); return node; };
  const parseSvgSize = (svg) => {
    const w = /<svg[^>]*\swidth="(\d+(?:\.\d+)?)/.exec(svg);
    const h = /<svg[^>]*\sheight="(\d+(?:\.\d+)?)/.exec(svg);
    return { w: w ? Number(w[1]) : 24, h: h ? Number(h[1]) : 24 };
  };

  const figma = {
    editorType: "figma",
    apiVersion: "1.0.0",
    mixed,
    skipInvisibleInstanceChildren: false,
    root,
    currentPage: root.children[0],
    getNodeById(id) {
      if (hooks.throwOnGetId && id === hooks.throwOnGetId) throw new Error("stub: getNodeById failed for " + id);
      return registry.get(id) || null;
    },
    async getNodeByIdAsync(id) { return figma.getNodeById(id); },
    createFrame: () => onPage(mk("FRAME", { name: "Frame" })),
    createRectangle: () => onPage(mk("RECTANGLE", { name: "Rectangle" })),
    createEllipse: () => onPage(mk("ELLIPSE", { name: "Ellipse" })),
    createText: () => onPage(mk("TEXT", { name: "Text" })),
    createVector: () => onPage(mk("VECTOR", { name: "Vector" })),
    createLine: () => onPage(mk("LINE", { name: "Line" })),
    createStar: () => onPage(mk("STAR", { name: "Star" })),
    createPolygon: () => onPage(mk("POLYGON", { name: "Polygon" })),
    createComponent: () => onPage(mk("COMPONENT", { name: "Component", componentProperties: {} })),
    createSection: () => onPage(mk("SECTION", { name: "Section" })),
    createPage: () => newPage("Page"),
    createNodeFromSvg(svg) {
      const { w, h } = parseSvgSize(svg);
      const frame = onPage(mk("FRAME", { name: "svg", width: w, height: h }));
      const hasStroke = /stroke=/.test(svg);
      const vec = mk("VECTOR", { name: "Vector", width: w, height: h });
      vec.fills = hasStroke ? [] : [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }];
      vec.strokes = hasStroke ? [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }] : [];
      frame.appendChild(vec);
      return frame;
    },
    group(nodes, parent) {
      const g = mk("GROUP", { name: "Group" });
      parent.appendChild(g);
      for (const n of nodes) g.appendChild(n);
      return g;
    },
    async loadFontAsync(font) {
      if (hooks.hangFonts && hooks.hangFonts(font)) return new Promise(() => {});
      state.fontLoads.push(font.family + "/" + font.style);
      if (hooks.failFonts && hooks.failFonts(font)) throw new Error("stub: font not found " + font.family + "/" + font.style);
    },
    notify(text, o) {
      if (hooks.notifyThrows && (hooks.notifyThrows === true || hooks.notifyThrows(String(text)))) throw new Error("stub: notify failed");
      state.notifies.push({ text: String(text), opts: o === undefined ? null : clone(o) });
      return { cancel() { state.cancels++; } };
    },
    viewport: {
      scrollAndZoomIntoView(nodes) { state.viewport.push(nodes.map(safeId)); }
    },
    clientStorage: {
      async getAsync(k) {
        if (hooks.failStorageGet) throw new Error("stub: storage get failed");
        return state.storage.has(k) ? clone(state.storage.get(k)) : undefined;
      },
      async setAsync(k, v) {
        if (hooks.failStorageSet) throw new Error("stub: storage set failed");
        state.storage.set(k, clone(v));
      }
    },
    variables: {
      async getLocalVariableCollectionsAsync() {
        if (hooks.failVariables) throw new Error("stub: variables unavailable");
        return stub.collections;
      },
      async getLocalVariablesAsync() {
        if (hooks.failVariables) throw new Error("stub: variables unavailable");
        return stub.variables;
      }
    },
    ui: {
      onmessage: null,
      postMessage(msg) {
        if (hooks.failPost && hooks.failPost(msg)) throw new Error("stub: DataCloneError");
        assertCloneable(msg, []);
        state.posted.push(plain(msg));
      },
      resize(w, h) { state.resizes.push([w, h]); }
    },
    showUI(html, o) { state.showUI.push({ html, opts: clone(o) }); }
  };
  if (opts.fileKey !== undefined) figma.fileKey = opts.fileKey;
  if (opts.noOn !== true) {
    figma.on = (event, fn) => { (state.handlers[event] = state.handlers[event] || []).push(fn); };
  }

  function assertCloneable(v, trail) {
    const t = typeof v;
    if (t === "symbol" || t === "function") throw new Error("DataCloneError: " + t + " cannot be cloned");
    if (v === null || t !== "object") return;
    if (trail.indexOf(v) !== -1) return;
    trail.push(v);
    for (const k of Object.keys(v)) assertCloneable(v[k], trail);
    trail.pop();
  }
  // JSON-like deep copy; JSON semantics (undefined keys dropped), NaN/Infinity kept visible as strings.
  function plain(v) {
    return JSON.parse(JSON.stringify(v, (k, x) => {
      if (typeof x === "number" && !Number.isFinite(x)) return "[number " + String(x) + "]";
      return x;
    }));
  }

  function describe(n) {
    const out = {};
    for (const k of Object.keys(n)) {
      if (NON_STATE_KEYS.has(k)) continue;
      const v = n[k];
      if (v === mixed) out[k] = "[mixed]";
      else if (typeof v === "function") continue;
      else out[k] = clone(v);
    }
    if (n.mainComponent) out.mainComponent = n.mainComponent.id;
    if (n.children && n.children.length) out.children = n.children.map(describe);
    return out;
  }

  const stub = {
    figma, state, clock, hooks, mixed, root,
    collections: opts.collections || [],
    variables: opts.variables || [],
    // Builders for test setups. All nodes land in `parent` (default: the current page).
    add(type, props, parent) {
      const n = mk(type, props);
      (parent || figma.currentPage).appendChild(n);
      return n;
    },
    page(name) { return newPage(name); },
    makeNode: mk,
    get(id) { return registry.get(id) || null; },
    setPage(p) { figma.currentPage = p; },
    emit(event, payload) { (state.handlers[event] || []).forEach(fn => fn(payload)); },
    // Everything the plugin did to the stub that is not a posted message.
    effects() {
      const e = {
        pages: root.children.map(p => Object.assign(describe(p), { selection: p.selection.map(safeId) })),
        currentPage: figma.currentPage.id,
        viewport: state.viewport,
        notifies: state.notifies,
        cancels: state.cancels,
        uiResizes: state.resizes,
        fontLoads: state.fontLoads,
        exports: state.exports,
        modeSets: state.modeSets,
        storage: Object.fromEntries(state.storage)
      };
      if (Object.keys(state.pluginData).length) e.pluginData = state.pluginData;
      return e;
    }
  };
  return stub;
}

let cachedSource = null;
function pluginSource() {
  // CRLF-normalized like tests/bridge-runtime.test.js: a Windows checkout must not change the text.
  if (cachedSource === null) cachedSource = fs.readFileSync(CODE_PATH, "utf8").replace(/\r\n/g, "\n");
  return cachedSource;
}

// Runs the whole, unmodified code.js with `figma` = stub.figma.
// Shadowed inside the sandbox only: Date (fixed, controllable clock -> deterministic
// checkpoint ids, timestamps, durationMs) and setTimeout (optional time scale so the
// 5 s before-shot / font timeouts can be reached in milliseconds; unref'd when
// unscaled so a loser timer of Promise.race never keeps the process alive).
function loadPlugin(stub, o = {}) {
  const scale = o.timerScale === undefined ? 1 : o.timerScale;
  const clock = stub.clock;
  class SandboxDate extends Date { static now() { return clock.t; } }
  const sandboxSetTimeout = (fn, ms, ...rest) => {
    const t = setTimeout(fn, Math.max(0, (ms || 0) * scale), ...rest);
    if (scale === 1 && t && t.unref) t.unref();
    return t;
  };
  const run = new Function("figma", "__html__", "Date", "setTimeout", pluginSource());
  run(stub.figma, "<html>stub</html>", SandboxDate, sandboxSetTimeout);
  return stub.figma.ui.onmessage;
}

module.exports = { createFigmaStub, loadPlugin, pluginSource, PNG_SIGNATURE };
