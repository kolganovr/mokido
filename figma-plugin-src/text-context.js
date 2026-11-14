
// Loads every distinct font a text node uses, once.
// The previous version walked a mixed-font node character by character and
// awaited loadFontAsync for each one: a 4000-character paragraph meant 4000
// sequential round-trips and the whole tool call timed out.
async function loadFontsForTextNode(textNode) {
  const wanted = [];
  const seen = new Set();

  const remember = (font) => {
    if (!font || !font.family) return;
    const id = font.family + "|" + font.style;
    if (seen.has(id)) return;
    seen.add(id);
    wanted.push(font);
  };

  if (textNode.fontName === figma.mixed) {
    if (typeof textNode.getStyledTextSegments === 'function') {
      for (const segment of textNode.getStyledTextSegments(['fontName'])) {
        remember(segment.fontName);
      }
    } else {
      // Fallback for older plugin API builds. getRangeFontName is synchronous
      // and cheap — it was the per-character *await* that made this quadratic,
      // so collecting first and awaiting the deduped set is enough.
      const len = textNode.characters.length;
      for (let i = 0; i < len; i++) {
        const font = textNode.getRangeFontName(i, i + 1);
        if (font !== figma.mixed) remember(font);
      }
    }
  } else {
    remember(textNode.fontName);
  }

  await Promise.all(wanted.map(font => ensureFont(font.family, font.style)));
}

// New text for a TEXT node without losing its styles. Plain `characters =`
// gives the whole text the style of one place (T6: "Oswald Medium" first word +
// "Oswald Light" tail became all one style in 12 of 12 runs; review 4.2.7 #51:
// a price "1 990 ₽" with 24px digits and a 16px grey sign became one size and
// colour). The old text's words carry their style; new word i takes the style
// of old word i (words beyond the old count take the last one), the whitespace
// before a word goes with that word: first word -> first style, tail from the
// first space -> the second style. Each mixed property goes the same way.
function textWords(text) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) out.push({ start: m.index, end: m.index + m[0].length });
  return out;
}

// fontName first: a range's size and letter spacing need its font set.
const TEXT_STYLE_FIELDS = [
  ["fontName", "setRangeFontName"],
  ["fontSize", "setRangeFontSize"],
  ["fills", "setRangeFills"],
  ["textDecoration", "setRangeTextDecoration"],
  ["letterSpacing", "setRangeLetterSpacing"]
];

// -> [{ field, setter, ranges: [{ start, end, value }] }] for every mixed field, or null.
function styleRangesForNewText(node, value) {
  if (typeof node.getStyledTextSegments !== "function") return null;
  const fields = TEXT_STYLE_FIELDS.filter(f => node[f[0]] === figma.mixed && typeof node[f[1]] === "function");
  if (!fields.length) return null;
  const segs = node.getStyledTextSegments(fields.map(f => f[0]));
  const oldWords = textWords(String(node.characters || ""));
  const newWords = textWords(value);
  if (!segs.length || !oldWords.length || !newWords.length) return null;
  const segAt = i => segs.find(x => i >= x.start && i < x.end) || segs[segs.length - 1];
  const wordSegs = oldWords.map(w => segAt(w.start));
  return fields.map(([field, setter]) => {
    const ranges = [];
    newWords.forEach((w, i) => {
      const start = i === 0 ? 0 : newWords[i - 1].end;
      const end = i === newWords.length - 1 ? value.length : w.end;
      const v = wordSegs[Math.min(i, wordSegs.length - 1)][field];
      const last = ranges[ranges.length - 1];
      if (last && JSON.stringify(last.value) === JSON.stringify(v) && last.end === start) last.end = end;
      else ranges.push({ start: start, end: end, value: v });
    });
    return { field, setter, ranges: ranges.filter(r => r.value !== undefined) };
  });
}

async function setTextKeepingFonts(node, value) {
  await loadFontsForTextNode(node);
  const styles = styleRangesForNewText(node, value);
  trackModification(node);
  node.characters = value;
  if (styles) styles.forEach(s => s.ranges.forEach(r => { if (r.end > r.start) node[s.setter](r.start, r.end, r.value); }));
}

// ==========================================================================
// Macros + context — one call instead of a hand-written recipe
// --------------------------------------------------------------------------
// setProps / setText / replaceWithInstance / shift / moveInto / fitSection are
// the operations agents kept re-deriving (and getting subtly wrong) inside
// figma_execute_code. Each snapshots the EXISTING nodes it changes through the
// same journal as bridge.snapshot, so figma_rollback can restore them.
// ==========================================================================
function macroNodes(refs, who) {
  return (Array.isArray(refs) ? refs : [refs]).map(ref => {
    const n = readNode(ref);
    if (!n) throw new Error("bridge." + who + ": node " + (typeof ref === "string" ? ref : String(ref)) + " does not exist");
    return n;
  });
}

function propBaseName(key) {
  return String(key).replace(/#\d+:\d+$/, "");
}

// The definitions live on the COMPONENT_SET for variants, on the component otherwise.
function propHolderOf(component) {
  if (!component) return null;
  return component.parent && component.parent.type === "COMPONENT_SET" ? component.parent : component;
}

function describeInstanceProps(inst) {
  const current = inst.componentProperties || {};
  let defs = null;
  try {
    const holder = propHolderOf(inst.mainComponent);
    defs = holder ? holder.componentPropertyDefinitions : null;
  } catch (e) {}
  return Object.keys(current).map(k => {
    const t = current[k].type;
    const d = defs && defs[k];
    const opts = t === "VARIANT" && d && Array.isArray(d.variantOptions) ? ": " + d.variantOptions.join("|") : "";
    return propBaseName(k) + " (" + t + opts + ")";
  }).join(", ");
}

// COMPONENT -> itself, COMPONENT_SET -> defaultVariant, INSTANCE -> mainComponent; ids resolved.
function resolveComponent(ref, who) {
  const n = readNode(ref);
  if (!n) throw new Error("bridge." + who + ": component " + (typeof ref === "string" ? ref : String(ref)) + " does not exist");
  if (n.type === "COMPONENT") return n;
  if (n.type === "COMPONENT_SET") {
    if (!n.defaultVariant) throw new Error("bridge." + who + ": component set \"" + n.name + "\" has no default variant");
    return n.defaultVariant;
  }
  if (n.type === "INSTANCE") {
    let main = null;
    try { main = n.mainComponent; } catch (e) {}
    if (!main) throw new Error("bridge." + who + ": instance \"" + n.name + "\" has no main component");
    return main;
  }
  throw new Error("bridge." + who + ": expected COMPONENT, COMPONENT_SET or INSTANCE, got " + n.type + " \"" + n.name + "\"");
}

function insideInstance(node) {
  for (let p = node.parent; p; p = p.parent) if (p.type === "INSTANCE") return p;
  return null;
}

function hasAutoLayout(n) {
  return !!n && "layoutMode" in n && !!n.layoutMode && n.layoutMode !== "NONE";
}

function widthFrequencies(nodes, types, limit) {
  const freq = new Map();
  nodes.forEach(n => {
    if (!n || types.indexOf(n.type) === -1 || typeof n.width !== "number") return;
    const w = readRound(n.width);
    freq.set(w, (freq.get(w) || 0) + 1);
  });
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, limit)
    .map(e => ({ w: e[0], n: e[1] }));
}

function nodeRef(n) {
  return n.type + " " + JSON.stringify(n.name) + " #" + n.id;
}

// Component sets (or plain components) whose instances live inside `node`, most
// used first: { set: "name #id", used, props: { Status: [options] | "BOOLEAN" | ... } }.
function usedComponentSets(node, limit) {
  const insts = [];
  if (node.type === "INSTANCE") insts.push(node);
  withSkipInvisible(() => { scanNodes(node, ["INSTANCE"]).forEach(i => insts.push(i)); });
  const groups = new Map();
  insts.forEach(inst => {
    let main = null;
    try { main = inst.mainComponent; } catch (e) {}
    const holder = propHolderOf(main);
    if (!holder) return;
    const g = groups.get(holder.id) || { holder: holder, used: 0 };
    g.used++;
    groups.set(holder.id, g);
  });
  return Array.from(groups.values())
    .sort((a, b) => b.used - a.used)
    .slice(0, limit)
    .map(g => {
      const entry = { set: g.holder.name + " #" + g.holder.id, used: g.used };
      let defs = null;
      try { defs = g.holder.componentPropertyDefinitions; } catch (e) {}
      const props = {};
      Object.keys(defs || {}).slice(0, 10).forEach(k => {
        const d = defs[k];
        if (d.type === "VARIANT" && Array.isArray(d.variantOptions)) {
          props[propBaseName(k)] = d.variantOptions.length > 8 ? d.variantOptions.slice(0, 8).concat("…") : d.variantOptions.slice();
        } else {
          props[propBaseName(k)] = d.type;
        }
      });
      if (Object.keys(props).length) entry.props = props;
      return entry;
    });
}

// Layout context of one node, compact enough to read before every build step.
function contextOf(node, conventions) {
  const ancestors = [];
  let page = null;
  for (let p = node.parent; p && p.type !== "DOCUMENT"; p = p.parent) {
    ancestors.unshift(nodeRef(p));
    if (p.type === "PAGE") page = p;
  }
  if (!page) page = figma.currentPage;

  const FRAMES = ["FRAME", "COMPONENT"];
  const siblings = node.parent && node.parent.children
    ? widthFrequencies(node.parent.children.filter(c => c !== node), FRAMES, 6)
    : [];

  const top = (page.children || []).slice();
  const pool = top.slice();
  top.forEach(t => { if (t.type === "SECTION" && t.children) t.children.forEach(c => pool.push(c)); });

  const out = {
    node: { id: node.id, name: node.name, type: node.type, w: readRound(node.width), h: readRound(node.height) },
    ancestors: ancestors,
    siblings: siblings,
    pageWidths: widthFrequencies(pool, FRAMES, 6),
    components: usedComponentSets(node, 12),
    conventions: conventions === undefined ? null : conventions
  };
  return out;
}
