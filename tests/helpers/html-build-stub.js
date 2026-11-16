// Strict stub of the Figma Plugin API for tests/html-build.test.js (T-077, F8.3).
// Writes of unknown properties THROW (a typo in an API name fails the test), enum values and paints are validated, and the rules that
// bit the builder in real Figma are enforced: layoutSizing FILL needs an auto layout parent, HUG needs a text or AL frame,
// ABSOLUTE needs an AL parent, text writes need a loaded font, wrap is horizontal only, createImage rejects non-PNG bytes.
// It does NOT compute auto layout: absoluteBoundingBox = sum of x,y up the parents + width/height, unless hooks.box(node, naive)
// returns another box (tests use it to feed plan boxes or deliberately wrong boxes).
const MIXED = Symbol("figma.mixed");
const FRAMEISH = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE"]);
const ENUM = {
  layoutMode: ["NONE", "HORIZONTAL", "VERTICAL"], layoutWrap: ["NO_WRAP", "WRAP"],
  primaryAxisSizingMode: ["AUTO", "FIXED"], counterAxisSizingMode: ["AUTO", "FIXED"],
  primaryAxisAlignItems: ["MIN", "CENTER", "MAX", "SPACE_BETWEEN"], counterAxisAlignItems: ["MIN", "CENTER", "MAX", "BASELINE"],
  strokeAlign: ["INSIDE", "OUTSIDE", "CENTER"], layoutSizingHorizontal: ["FIXED", "HUG", "FILL"], layoutSizingVertical: ["FIXED", "HUG", "FILL"],
  layoutPositioning: ["AUTO", "ABSOLUTE"], textAutoResize: ["NONE", "WIDTH_AND_HEIGHT", "HEIGHT", "TRUNCATE"],
  textAlignHorizontal: ["LEFT", "CENTER", "RIGHT", "JUSTIFIED"], textTruncation: ["DISABLED", "ENDING"]
};
const NUM = new Set(["x", "y", "opacity", "itemSpacing", "counterAxisSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "strokeWeight", "strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight", "cornerRadius", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius", "fontSize"]);
const BASE = ["constraints", "name", "visible", "x", "y", "opacity", "layoutSizingHorizontal", "layoutSizingVertical", "layoutPositioning", "effects"];
const WRITABLE = {
  PAGE: [],
  FRAME: [...BASE, "fills", "strokes", "strokeWeight", "strokeAlign", "strokesIncludedInLayout", "strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight", "clipsContent", "layoutMode", "layoutWrap", "primaryAxisSizingMode", "counterAxisSizingMode", "primaryAxisAlignItems", "counterAxisAlignItems", "itemSpacing", "counterAxisSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "cornerRadius", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"],
  RECTANGLE: [...BASE, "fills", "strokes", "strokeWeight", "strokeAlign", "strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight", "cornerRadius", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"],
  VECTOR: [...BASE, "fills", "strokes", "strokeWeight"],
  // F9 9.2: inside an instance only name, visibility, opacity, position and layout sizing may be written (contract section 2, rule 6); colors, radius, padding throw
  INSTANCE: ["name", "visible", "x", "y", "opacity", "constraints", "layoutSizingHorizontal", "layoutSizingVertical", "layoutPositioning"],
  COMPONENT: [...BASE], COMPONENT_SET: [...BASE],
  TEXT: [...BASE, "fills", "characters", "fontName", "fontSize", "lineHeight", "textAlignHorizontal", "textAutoResize", "textTruncation", "maxLines"]
};
const BINDABLE = new Set(["itemSpacing", "counterAxisSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "cornerRadius", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius", "strokeWeight", "strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight", "opacity", "width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight", "visible", "characters", "gridRowGap", "gridColumnGap"]);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function createHtmlStub(opts) {
  opts = opts || {};
  let seq = 0;
  const registry = new Map();
  const state = { fontLoads: [], images: [], svgs: [], notifies: [] };
  const hooks = { box: null, textWidth: null, failFont: (f) => f.family !== "Inter" && !(opts.fonts || []).includes(f.family + "|" + f.style), badSvg: (s) => /BADSVG/.test(s) };
  const installed = new Set(["Inter|Thin", "Inter|Extra Light", "Inter|Light", "Inter|Regular", "Inter|Medium", "Inter|Semi Bold", "Inter|Bold", "Inter|Extra Bold", "Inter|Black"]);
  for (const f of opts.fonts || []) installed.add(f);
  const loaded = new Set();
  const fail = (m) => { throw new Error("stub: " + m); };
  const isAL = (n) => n && FRAMEISH.has(n.type) && n.layoutMode !== "NONE";

  function checkPaints(list, what) {
    if (!Array.isArray(list)) fail(what + " must be an array");
    for (const p of list) {
      if (p.opacity !== undefined && !(p.opacity >= 0 && p.opacity <= 1)) fail(what + ": opacity out of 0..1");
      const col = (c) => { if (!c || ["r", "g", "b"].some((k) => !(c[k] >= 0 && c[k] <= 1))) fail(what + ": color r,g,b must be 0..1"); };
      if (p.type === "SOLID") col(p.color);
      else if (p.type === "GRADIENT_LINEAR") {
        const t = p.gradientTransform;
        if (!Array.isArray(t) || t.length !== 2 || t.some((r) => r.length !== 3 || r.some((v) => !Number.isFinite(v)))) fail(what + ": gradientTransform must be 2x3 finite");
        if (!Array.isArray(p.gradientStops) || p.gradientStops.length < 2) fail(what + ": need 2+ gradientStops");
        for (const s of p.gradientStops) { if (!(s.position >= 0 && s.position <= 1)) fail(what + ": stop position out of 0..1"); col(s.color); if (!(s.color.a >= 0 && s.color.a <= 1)) fail(what + ": stop alpha"); }
      } else if (p.type === "IMAGE") { if (!p.imageHash) fail(what + ": IMAGE needs imageHash"); }
      else fail(what + ": unknown paint type " + p.type);
    }
  }
  function checkEffects(list) {
    if (!Array.isArray(list)) fail("effects must be an array");
    for (const e of list) {
      if (!["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR", "BACKGROUND_BLUR"].includes(e.type)) fail("bad effect type " + e.type);
      if (e.type.endsWith("SHADOW") && (!e.color || !e.offset || typeof e.offset.x !== "number" || typeof e.offset.y !== "number" || typeof e.radius !== "number")) fail("shadow needs color, offset{x,y}, radius");
    }
  }

  function setProp(n, d, k, v) {
    const allowed = WRITABLE[d.type] || [];
    if (!allowed.includes(k)) fail("unimplemented/readonly set " + d.type + "." + k);
    if (ENUM[k] && !ENUM[k].includes(v)) fail("bad value for " + k + ": " + String(v));
    if (NUM.has(k) && !Number.isFinite(v)) fail(k + " must be a finite number");
    if (k === "maxLines" && !(v === null || (Number.isInteger(v) && v >= 1))) fail("maxLines must be an integer >= 1 or null");
    if (k === "opacity" && !(v >= 0 && v <= 1)) fail("opacity out of 0..1");
    if (k === "fills" || k === "strokes") checkPaints(v, k);
    if (k === "effects") checkEffects(v);
    const par = d.parent;
    if (k === "layoutSizingHorizontal" || k === "layoutSizingVertical") {
      if (v === "FILL" && !(isAL(par) && d.layoutPositioning !== "ABSOLUTE")) fail("FILL needs an auto layout parent");
      if (v === "HUG" && !(d.type === "TEXT" || isAL(d))) fail("HUG needs a text or an auto layout frame");
      if (v === "FIXED" || v === "HUG" || v === "FILL") d.sizing = d.sizing || {};
    }
    if (k === "layoutPositioning" && v === "ABSOLUTE" && !isAL(par)) fail("ABSOLUTE needs an auto layout parent");
    if (k === "layoutWrap" && v === "WRAP" && d.layoutMode !== "HORIZONTAL") fail("WRAP needs layoutMode HORIZONTAL");
    if (k === "counterAxisAlignItems" && v === "BASELINE" && d.layoutMode !== "HORIZONTAL") fail("BASELINE needs layoutMode HORIZONTAL");
    if ((k === "primaryAxisSizingMode" || k === "counterAxisSizingMode") && d.layoutMode === "NONE") fail(k + " needs auto layout");
    if ((k === "itemSpacing" || k.startsWith("padding") || k.endsWith("AxisAlignItems") || k === "layoutWrap") && d.layoutMode === "NONE" && !(k === "layoutWrap" && v === "NO_WRAP")) fail(k + " needs auto layout (set layoutMode first)");
    if (k === "characters" || k === "fontName") {
      const f = k === "fontName" ? v : d.fontName;
      if (!f || !loaded.has(f.family + "|" + f.style)) fail("unloaded font " + (f && f.family + " " + f.style) + " (loadFontAsync first)");
    }
    d[k] = k === "fills" || k === "strokes" || k === "effects" || k === "lineHeight" || k === "fontName" ? clone(v) : v;
    if (k === "layoutSizingHorizontal" || k === "layoutSizingVertical") d.sizingSet = true;
    if (d.type === "TEXT" && hooks.textWidth) {
      if (k === "layoutSizingHorizontal" && v === "HUG") d.textAutoResize = "WIDTH_AND_HEIGHT";
      if (k === "layoutSizingHorizontal" && v !== "HUG" && d.textAutoResize === "WIDTH_AND_HEIGHT") d.textAutoResize = "HEIGHT";
      reflow(d);
    }
  }
  // Opt-in text metrics (hooks.textWidth(d) = one-line width in Figma): WIDTH_AND_HEIGHT hugs it, HEIGHT wraps into ceil(natural / width) lines.
  function reflow(d) {
    const lh = d.lineHeight && d.lineHeight.unit === "PIXELS" ? d.lineHeight.value : d.fontSize * 1.2;
    const nat = hooks.textWidth(d);
    if (d.textAutoResize === "WIDTH_AND_HEIGHT") { d.width = nat; d.height = lh; }
    else if (d.textAutoResize === "HEIGHT") d.height = Math.min(Math.max(1, Math.ceil(nat / d.width - 1e-9)), d.textTruncation === "ENDING" && d.maxLines ? d.maxLines : 1e9) * lh;
  }

  function naiveBox(d) {
    let x = d.x, y = d.y, p = d.parent;
    while (p && p.type !== "PAGE") { x += p.x; y += p.y; p = p.parent; }
    return { x, y, width: d.width, height: d.height };
  }

  function make(type, init) {
    const d = Object.assign({ id: "1:" + ++seq, type, name: type[0] + type.slice(1).toLowerCase(), visible: true, parent: null, x: 0, y: 0, width: 100, height: 100, opacity: 1, layoutSizingHorizontal: "FIXED", layoutSizingVertical: "FIXED", layoutPositioning: "AUTO", effects: [], removed: false }, init || {});
    if (type === "PAGE") d.children = [];
    if (FRAMEISH.has(type)) Object.assign(d, { children: [], fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }], strokes: [], strokeWeight: 1, strokeAlign: "INSIDE", strokesIncludedInLayout: false, clipsContent: true, layoutMode: "NONE", layoutWrap: "NO_WRAP", primaryAxisSizingMode: "AUTO", counterAxisSizingMode: "AUTO", primaryAxisAlignItems: "MIN", counterAxisAlignItems: "MIN", itemSpacing: 0, counterAxisSpacing: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0, cornerRadius: 0, topLeftRadius: 0, topRightRadius: 0, bottomLeftRadius: 0, bottomRightRadius: 0 });
    if (type === "RECTANGLE") Object.assign(d, { fills: [{ type: "SOLID", color: { r: 0.85, g: 0.85, b: 0.85 } }], strokes: [], strokeWeight: 1, strokeAlign: "CENTER", cornerRadius: 0, topLeftRadius: 0, topRightRadius: 0, bottomLeftRadius: 0, bottomRightRadius: 0 });
    if (type === "VECTOR") Object.assign(d, { fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }], strokes: [], strokeWeight: 1 });
    if (type === "TEXT") Object.assign(d, { characters: "", fontName: { family: "Inter", style: "Regular" }, fontSize: 12, lineHeight: { unit: "AUTO" }, textAlignHorizontal: "LEFT", textAutoResize: "NONE", fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }], ranges: [] });
    const methods = {
      appendChild(c) {
        if (!d.children) fail(d.type + " cannot have children");
        const cd = c.__d;
        if (cd.parent) cd.parent.children = cd.parent.children.filter((x) => x !== c);
        cd.parent = d; d.children.push(c);
      },
      resize(w, h) {
        if (!(w >= 0.01 && h >= 0.01)) fail("resize needs sizes >= 0.01");
        d.width = w; d.height = h; d.resizes = (d.resizes || 0) + 1;
        if (d.type === "TEXT" && hooks.textWidth) { if (d.textAutoResize === "WIDTH_AND_HEIGHT") d.textAutoResize = "HEIGHT"; reflow(d); }
      },
      remove() { if (d.parent) d.parent.children = d.parent.children.filter((x) => x !== node); d.removed = true; registry.delete(d.id); },
      findAll(pred) { const out = []; (function walk(n) { for (const c of n.children || []) { if (!pred || pred(c)) out.push(c); walk(c); } })(d); return out; },
      async loadAsync() {},
      // F9 9.3: only on a TEXT, only a style of opts.textStyles; like Figma it resets the range overrides, styleSetAfterRanges records the order
      async setTextStyleIdAsync(id) {
        if (d.type !== "TEXT") fail("setTextStyleIdAsync: only on a TEXT");
        const s = (opts.textStyles || []).find((x) => x.id === id);
        if (!s) fail("setTextStyleIdAsync: no text style " + id);
        d.textStyleId = id; d.styleSetAfterRanges = (d.ranges || []).length > 0; d.styleCalls = (d.styleCalls || 0) + 1;
        d.fontName = clone(s.fontName); d.fontSize = s.fontSize; d.lineHeight = clone(s.lineHeight); d.ranges = (d.ranges || []).filter((r) => r.kind === "fills");
      },
      // F9 9.2 component API. Variant COMPONENT nodes carry d.variantProps; an instance carries componentProperties (values by key) and mainComponent.
      createInstance() {
        if (d.type !== "COMPONENT") fail("createInstance: only on a COMPONENT");
        return makeInstance(node);
      },
      setProperties(props) {
        if (d.type !== "INSTANCE") fail("setProperties: only on an INSTANCE");
        d.setPropertiesCalls = (d.setPropertiesCalls || 0) + 1;
        const defs = defsOf(d.mainComponent);
        for (const k of Object.keys(props)) {
          const def = defs[k];
          if (!def) fail("setProperties: no property " + k);
          const v = props[k];
          if (def.type === "VARIANT" && !(def.variantOptions || []).includes(v)) fail("setProperties: bad variant value " + String(v) + " for " + k);
          if (def.type === "BOOLEAN" && typeof v !== "boolean") fail("setProperties: " + k + " needs a boolean");
          if (def.type === "TEXT" && typeof v !== "string") fail("setProperties: " + k + " needs a string");
          d.componentProperties[k].value = v;
        }
        const set = d.mainComponent.__d.parent;
        if (set && set.type === "COMPONENT_SET") {
          const want = {}; for (const k of Object.keys(d.componentProperties)) if (d.componentProperties[k].type === "VARIANT") want[k] = d.componentProperties[k].value;
          const hit = set.children.find((c) => Object.keys(want).every((k) => c.__d.variantProps[k] === want[k]));
          if (!hit) fail("setProperties: no variant for " + JSON.stringify(want));
          d.mainComponent = hit; d.width = hit.__d.width; d.height = hit.__d.height;
        }
        for (const ch of d.children || []) {
          const ref = ch.componentPropertyReferences && ch.componentPropertyReferences.characters;
          if (ref && typeof d.componentProperties[ref].value === "string") ch.__d.characters = d.componentProperties[ref].value;
        }
      },
      async getMainComponentAsync() { return d.mainComponent || null; },
      findAllWithCriteria(crit) { const ts = (crit && crit.types) || []; const out = []; (function walk(n) { for (const c of n.children || []) { if (ts.includes(c.type)) out.push(c); walk(c); } })(d); return out; },
      // Plugin API: node.setBoundVariable(field, Variable | null). The stub checks the field, the variable type and Auto Layout fields.
      setBoundVariable(field, variable) {
        if (!BINDABLE.has(field)) fail("setBoundVariable: field " + field + " is not bindable");
        if (variable !== null && !(variable && typeof variable === "object" && variable.id && variable.resolvedType)) fail("setBoundVariable: needs a Variable object or null (an id string is deprecated)");
        if (variable && variable.resolvedType !== "FLOAT") fail("setBoundVariable: " + field + " needs a FLOAT variable, got " + variable.resolvedType);
        if ((field === "itemSpacing" || field === "counterAxisSpacing" || field.startsWith("padding")) && d.layoutMode === "NONE") fail("setBoundVariable: " + field + " needs auto layout");
        if (field === "counterAxisSpacing" && d.layoutWrap !== "WRAP") fail("setBoundVariable: counterAxisSpacing needs wrap");
        d.boundVars = d.boundVars || {};
        if (variable === null) delete d.boundVars[field]; else d.boundVars[field] = { id: variable.id, name: variable.name };
      },
      setRangeFontName(s, e, f) { if (!loaded.has(f.family + "|" + f.style)) fail("unloaded font in setRangeFontName"); rng("fontName", s, e, f); },
      setRangeFontSize(s, e, v) { rng("fontSize", s, e, v); },
      setRangeFills(s, e, v) { checkPaints(v, "setRangeFills"); rng("fills", s, e, clone(v)); },
      setRangeTextDecoration(s, e, v) { if (!["NONE", "UNDERLINE", "STRIKETHROUGH"].includes(v)) fail("bad textDecoration " + v); rng("textDecoration", s, e, v); },
      async exportAsync() { return Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]); }
    };
    function rng(kind, s, e, v) {
      if (d.type !== "TEXT") fail("setRange on non-text");
      if (!(s >= 0 && e <= d.characters.length && e > s)) fail("range out of text (" + s + "," + e + ") of " + d.characters.length);
      d.ranges.push({ kind, start: s, end: e, value: v });
    }
    function defsOf(comp) {
      const cd = comp.__d, set = cd.parent && cd.parent.type === "COMPONENT_SET" ? cd.parent : null;
      return (set || cd).componentPropertyDefinitions || {};
    }
    function makeInstance(comp) {
      const cd = comp.__d, set = cd.parent && cd.parent.type === "COMPONENT_SET" ? cd.parent : null;
      const defs = (set || cd).componentPropertyDefinitions || {};
      const inst = make("INSTANCE", { name: (set || cd).name, width: cd.width, height: cd.height, mainComponent: comp });
      const idd = inst.__d;
      idd.layoutMode = cd.layoutMode;
      idd.componentProperties = {};
      for (const k of Object.keys(defs)) idd.componentProperties[k] = { type: defs[k].type, value: defs[k].defaultValue };
      for (const ch of cd.children || []) {
        const t = make("TEXT", { name: ch.name, characters: ch.characters, visible: ch.visible, componentPropertyReferences: ch.componentPropertyReferences, fontName: { family: "Inter", style: "Regular" }, width: ch.width, height: ch.height });
        t.__d.characters = ch.characters; t.__d.parent = idd; idd.children.push(t);
      }
      return inst;
    }
    const node = new Proxy({ __d: d }, {
      get(t, k) {
        if (k === "__d") return d;
        if (k === "absoluteBoundingBox") { const nb = naiveBox(d); return hooks.box ? hooks.box(node, nb) : nb; }
        if (k === "children" && !d.children) return undefined;
        if (k === "parent") return d.parent ? d.parent.__node : null;
        if (k === "findAll" && !d.children) return undefined;
        if (k === "appendChild" && !d.children) return undefined;
        if (methods[k] && !(["setRangeFontName", "setRangeFontSize", "setRangeFills", "setRangeTextDecoration"].includes(k) && d.type !== "TEXT")) return methods[k];
        if (k === "textStyleId") return d.textStyleId || "";
        if (k === "boundVariables") { const o = {}; for (const f of Object.keys(d.boundVars || {})) o[f] = { type: "VARIABLE_ALIAS", id: d.boundVars[f].id }; return o; }
        return d[k];
      },
      set(t, k, v) { setProp(node, d, k, v); return true; },
      has(t, k) { return k in d || k in methods; }
    });
    d.__node = node;
    registry.set(d.id, node);
    return node;
  }
  const page = make("PAGE", { name: "Page 1" });
  const root = { type: "DOCUMENT", children: [page], name: "Doc", id: "0:0" };
  const figma = {
    mixed: MIXED,
    root, currentPage: page,
    createFrame() { const n = make("FRAME", { name: "Frame", width: 100, height: 100 }); return n; },
    createRectangle() { return make("RECTANGLE", { name: "Rectangle" }); },
    createText() { return make("TEXT", { name: "Text", width: 10, height: 12 }); },
    createNodeFromSvg(svg) {
      if (typeof svg !== "string" || !/^\s*<svg[\s>]/.test(svg)) fail("createNodeFromSvg: not an svg");
      if (hooks.badSvg(svg)) fail("createNodeFromSvg: invalid svg");
      state.svgs.push(svg);
      const w = /width="([\d.]+)"/.exec(svg), h = /height="([\d.]+)"/.exec(svg);
      const f = make("FRAME", { name: "svg", width: w ? +w[1] : 24, height: h ? +h[1] : 24 });
      f.fills = [];
      f.appendChild(make("VECTOR", { name: "Vector" }));
      return f;
    },
    createImage(bytes) {
      if (!(bytes instanceof Uint8Array)) fail("createImage needs Uint8Array");
      const sig = [137, 80, 78, 71, 13, 10, 26, 10];
      if (bytes.length < 8 || sig.some((b, i) => bytes[i] !== b)) fail("createImage: Image is corrupt or unsupported");
      const hash = "img" + state.images.length;
      state.images.push({ hash, size: bytes.length });
      return { hash };
    },
    base64Decode(s) { return new Uint8Array(Buffer.from(s, "base64")); },
    base64Encode(b) { return Buffer.from(b).toString("base64"); },
    async loadFontAsync(f) {
      state.fontLoads.push(f.family + "|" + f.style);
      const key = f.family + "|" + f.style;
      if (!installed.has(key)) throw new Error("stub: font not found " + key);
      loaded.add(key);
    },
    async getNodeByIdAsync(id) { return registry.get(id) || null; },
    getNodeById(id) { return registry.get(id) || null; },
    async getLocalTextStylesAsync() { return opts.textStyles ? opts.textStyles.slice() : []; },
    // opts.variables = { collections: [{ id, name, defaultModeId, modes }], variables: [{ id, name, resolvedType, variableCollectionId, remote, valuesByMode }] }
    variables: {
      async getVariableByIdAsync(id) { return ((opts.variables || {}).variables || []).find((v) => v.id === id) || null; },
      async getLocalVariablesAsync(type) { if (!opts.variables) fail("variables API not set up (opts.variables)"); return opts.variables.variables.filter((v) => !type || v.resolvedType === type); },
      async getLocalVariableCollectionsAsync() { if (!opts.variables) fail("variables API not set up (opts.variables)"); return opts.variables.collections; },
      // returns a copy of the paint bound to the variable (the Plugin API contract); the paint must be a SOLID and the variable a COLOR
      setBoundVariableForPaint(paint, field, variable) {
        if (!paint || paint.type !== "SOLID") fail("setBoundVariableForPaint: only a SolidPaint can be bound, got " + (paint && paint.type));
        if (field !== "color") fail("setBoundVariableForPaint: field must be 'color'");
        if (!(variable && variable.id && variable.resolvedType)) fail("setBoundVariableForPaint: needs a Variable object or null");
        if (variable.resolvedType !== "COLOR") fail("setBoundVariableForPaint: needs a COLOR variable, got " + variable.resolvedType);
        return Object.assign(clone(paint), { boundVariables: { color: { type: "VARIABLE_ALIAS", id: variable.id } } });
      }
    },
    async getStyleByIdAsync() { return null; },
    notify(t) { state.notifies.push(t); },
    async loadAllPagesAsync() { state.pagesLoaded = (state.pagesLoaded || 0) + 1; }
  };
  // F9 9.2: components of a design system as stub nodes. ds.components = { Button: { properties: { Variant: [...], Size: [...] }, text_props: ["Label"] }, ... } (ds.json).
  // Properties become VARIANT definitions (a set of variant COMPONENTs, the first is the default), text_props become TEXT definitions "<Name>#<n>:0".
  // o.size(name, variantProps) -> [w, h] (default 100 x 40); o.remote: components are marked remote and not put on a page (reached only through instances).
  function addComponents(ds, o) {
    o = o || {};
    const out = {};
    for (const name of Object.keys(ds.components || {})) {
      const spec = ds.components[name];
      const props = spec.properties || {};
      const defs = {};
      Object.keys(props).forEach((k) => { defs[k] = { type: "VARIANT", defaultValue: props[k][0], variantOptions: props[k].slice() }; });
      const tkeys = [];
      (spec.text_props || []).forEach((t, i) => { const key = t + "#" + (i + 1) + ":0"; tkeys.push([t, key]); defs[key] = { type: "TEXT", defaultValue: t }; });
      (spec.booleans || []).forEach((t, i) => { defs[t + "#" + (i + 20) + ":0"] = { type: "BOOLEAN", defaultValue: false }; });
      const layers = spec.layers || []; // plain TEXT layers without a property; a name starting with "~" is hidden
      const mk = (vp, cname) => {
        const sz = o.size ? o.size(name, vp) : [100, 40];
        const c = make("COMPONENT", { name: cname, width: sz[0], height: sz[1], variantProps: vp, remote: !!o.remote });
        c.__d.layoutMode = "HORIZONTAL"; // design-system components are Auto Layout, so an instance can HUG
        for (const [t, key] of tkeys) { const tx = make("TEXT", { name: t, componentPropertyReferences: { characters: key } }); tx.__d.characters = t; tx.__d.parent = c.__d; c.__d.children.push(tx); }
        for (const l of layers) { const hid = l[0] === "~"; const tx = make("TEXT", { name: l, visible: !hid }); tx.__d.characters = l; tx.__d.parent = c.__d; c.__d.children.push(tx); }
        return c;
      };
      const keys = Object.keys(props);
      if (!keys.length) {
        const c = mk({}, name); c.__d.componentPropertyDefinitions = defs;
        if (!o.remote) { c.__d.parent = page.__d; page.__d.children.push(c); }
        out[name] = c; continue;
      }
      const combos = keys.reduce((acc, k) => acc.flatMap((a) => props[k].map((v) => Object.assign({}, a, { [k]: v }))), [{}]);
      const set = make("COMPONENT_SET", { name, componentPropertyDefinitions: defs, remote: !!o.remote });
      for (const vp of combos) { const c = mk(vp, keys.map((k) => k + "=" + vp[k]).join(", ")); c.__d.parent = set.__d; set.__d.children.push(c); }
      set.__d.defaultVariant = set.__d.children[0];
      if (!o.remote) { set.__d.parent = page.__d; page.__d.children.push(set); }
      out[name] = set;
    }
    return out;
  }
  return { figma, state, hooks, page, loaded, registry, addComponents };
}

// A design system as stub variables: collection "Etalon UI" (one mode), colors COLOR, sizes FLOAT, names as in ds.json ("status/ok", "space/16").
function dsVariables(ds, extra) {
  const hex = (h) => ({ r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255, a: 1 });
  const cl = { id: "VariableCollectionId:1:1", name: ds.name || "Etalon UI", defaultModeId: "1:0", modes: [{ modeId: "1:0", name: "Default" }] };
  let i = 0;
  const mk = (name, resolvedType, value) => ({ id: "VariableID:1:" + ++i, name, resolvedType, variableCollectionId: cl.id, remote: false, valuesByMode: { "1:0": value } });
  const variables = [].concat(ds.colors.map((c) => mk(c.name, "COLOR", hex(c.value))), ds.sizes.map((s) => mk(s.name, "FLOAT", s.value)), extra || []);
  return { collections: [cl], variables };
}

// ds.json text_styles as stub local text styles ("Heading/L": Inter Bold 28 / 36 px).
function dsTextStyles(ds) {
  const W = { 100: "Thin", 200: "Extra Light", 300: "Light", 400: "Regular", 500: "Medium", 600: "Semi Bold", 700: "Bold", 800: "Extra Bold", 900: "Black" };
  return ds.text_styles.map((s, i) => ({ id: "S:" + (i + 1), name: s.name, fontName: { family: s.family, style: W[s.weight] }, fontSize: s.size, lineHeight: { unit: "PIXELS", value: s.lineHeight }, letterSpacing: { unit: "PIXELS", value: 0 } }));
}

module.exports = { createHtmlStub, MIXED, dsVariables, dsTextStyles };
