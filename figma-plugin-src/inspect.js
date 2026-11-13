
const TEXTS_HINT = 'not a TEXT node: use props:["texts"]';

// Property definitions of a COMPONENT_SET / COMPONENT as { name: { type, default, options? } }
// (the "#id" suffix of the name is dropped). A variant inside a set throws on its own
// componentPropertyDefinitions, so it reads the parent set's. null when there are none.
function readPropDefs(n) {
  let defs = null;
  try { defs = n.componentPropertyDefinitions; } catch (e) { defs = null; }
  if (!defs && n.parent && n.parent.type === "COMPONENT_SET") {
    try { defs = n.parent.componentPropertyDefinitions; } catch (e) { defs = null; }
  }
  if (!defs) return null;
  const out = {};
  Object.keys(defs).forEach(k => {
    const d = defs[k] || {};
    const row = { type: d.type, default: d.defaultValue };
    if (d.variantOptions) row.options = d.variantOptions.slice();
    out[k.replace(/#\d+:\d+$/, "")] = row;
  });
  return Object.keys(out).length ? out : null;
}

// Every TEXT descendant (depth-first) as "id characters" lines, no truncation.
function readTexts(n) {
  const nodes = n.type === "TEXT" ? [n] : (typeof n.findAll === "function" ? n.findAll(x => x.type === "TEXT") : []);
  return nodes.map(t => t.id + " " + String(t.characters).replace(/\n/g, "\\n"));
}

// Named read-outs for inspect() and check(). Anything else is read straight
// off the node (width, itemSpacing, layoutSizingHorizontal, ...).
const READ_PROPS = {
  fill: n => ("fills" in n ? readPaints(n.fills) : null),
  fills: n => ("fills" in n ? readPaints(n.fills) : null),
  stroke: n => ("strokes" in n ? readPaints(n.strokes) : null),
  strokes: n => ("strokes" in n ? readPaints(n.strokes) : null),
  text: n => (n.type === "TEXT" ? n.characters : TEXTS_HINT),
  characters: n => (n.type === "TEXT" ? n.characters : null),
  font: n => readFont(n),
  fontFamily: n => (n.type === "TEXT" && n.fontName !== figma.mixed ? n.fontName.family : null),
  fontStyle: n => (n.type === "TEXT" && n.fontName !== figma.mixed ? n.fontName.style : null),
  layout: n => readLayout(n),
  padding: n => ("paddingTop" in n ? [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft].map(readRound) : null),
  parent: n => (n.parent ? n.parent.id : null),
  parentName: n => (n.parent ? n.parent.name : null),
  children: n => ("children" in n && n.children ? n.children.length : 0),
  main: n => { try { return n.type === "INSTANCE" && n.mainComponent ? n.mainComponent.name : null; } catch (e) { return null; } },
  mainId: n => { try { return n.type === "INSTANCE" && n.mainComponent ? n.mainComponent.id : null; } catch (e) { return null; } },
  variant: n => {
    if (n.type === "COMPONENT_SET") {
      const defs = readPropDefs(n);
      const out = {};
      Object.keys(defs || {}).forEach(k => { if (defs[k].type === "VARIANT") out[k] = defs[k].options || []; });
      return Object.keys(out).length ? out : null;
    }
    return n.variantProperties || null;
  },
  props: n => {
    if (n.type === "COMPONENT_SET" || n.type === "COMPONENT") return readPropDefs(n);
    if (!n.componentProperties) return null;
    const out = {};
    Object.keys(n.componentProperties).forEach(k => { out[k.replace(/#\d+:\d+$/, "")] = n.componentProperties[k].value; });
    return out;
  },
  texts: n => readTexts(n),
  absolute: n => (n.absoluteBoundingBox ? ["x", "y", "width", "height"].map(k => readRound(n.absoluteBoundingBox[k])) : null),
  reactions: n => readReactions(n),
  connector: n => (n.type === "CONNECTOR"
    ? { start: connectorEndpoint(n.connectorStart), end: connectorEndpoint(n.connectorEnd) }
    : null)
};

function connectorEndpoint(ep) {
  return ep && ep.endpointNodeId ? ep.endpointNodeId : null;
}

// Prototype links as short strings: "ON_CLICK→NODE/OVERLAY #183:80012". Handles
// reactions[].actions[] (current API) and the legacy reaction.action.
function readReactions(n) {
  if (!Array.isArray(n.reactions)) return null;
  const out = [];
  n.reactions.forEach(r => {
    if (!r) return;
    const trigger = r.trigger && r.trigger.type ? r.trigger.type : "?";
    const actions = Array.isArray(r.actions) && r.actions.length ? r.actions : (r.action ? [r.action] : []);
    if (actions.length === 0) out.push(trigger);
    actions.forEach(a => {
      if (!a) return;
      let s = trigger + "→" + (a.type || "?") + (a.navigation ? "/" + a.navigation : "");
      if (a.destinationId) s += " #" + a.destinationId;
      else if (a.url) s += " " + a.url;
      out.push(s);
    });
  });
  return out;
}

function readProp(n, key) {
  if (READ_PROPS[key]) return READ_PROPS[key](n);
  const v = n[key];
  if (v === figma.mixed) return "mixed";
  if (v && typeof v === "object") {
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return String(v); }
  }
  return readRound(v);
}

const INSPECT_DEFAULT_PROPS = ["type", "name", "width", "height", "x", "y"];

// { id: { prop: value } | "MISSING" } for exactly the props asked for.
function inspectNodes(refs, props) {
  const keys = Array.isArray(props) && props.length ? props : INSPECT_DEFAULT_PROPS;
  const out = {};
  (Array.isArray(refs) ? refs : [refs]).forEach(ref => {
    const n = readNode(ref);
    const id = typeof ref === "string" ? ref : (n ? n.id : String(ref));
    if (!n) { out[id] = "MISSING"; return; }
    const row = {};
    keys.forEach(k => { try { row[k] = readProp(n, k); } catch (e) { row[k] = "ERR: " + (e.message || e); } });
    out[id] = row;
  });
  return out;
}
