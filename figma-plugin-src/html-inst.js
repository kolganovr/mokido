// html-inst.js (T-077, F9 9.2): data-component -> component instances (contract: planning/fable/F9_контракт.md, section 2).
// A part of the plugin scope (no import/export), prefix htmlInst*. Two halves:
//  - map side: htmlInstPlan(p, c) (called from htmlDsPlan) writes p.component = { name, variant, dataName, texts, fixW, fixH } for an element with
//    data-component that is not itself inside a component. The plan keeps the children: they are built as plain frames only when no component is found.
//  - build side: htmlInstFind (rule 1) and htmlInstBuild (rules 2-6, 8) make the instance; html-build.js places it and checks its box (rule 7).
// Never detaches an instance, never touches colors / radius / padding inside it (the variant does that).

// ---------- map side ----------
function htmlInstAllText(c, n) {
  let out = "";
  for (const k of c.kids[n.id] || []) {
    if (k.tag === "#text") out += (out ? " " : "") + k.text;
    else if (k.tag !== "svg" && k.tag !== "img") { const t = htmlInstAllText(c, k); if (t) out += (out ? " " : "") + t; }
  }
  return out;
}
// Text pieces of the subtree in document order: one item per run of text (inline neighbours merge), an element with data-prop is one item.
function htmlInstTexts(c, n) {
  const items = [];
  (function walk(el, prop) {
    let run = null;
    for (const k of c.kids[el.id] || []) {
      if (k.tag === "#text") {
        if (!run) { run = { prop: prop || null, text: "" }; items.push(run); }
        run.text += (run.text ? " " : "") + k.text;
      } else if (k.tag === "svg" || k.tag === "img") run = null;
      else if (k.prop) { run = null; const t = htmlInstAllText(c, k); if (t) items.push({ prop: k.prop, text: t }); }
      else if (/^inline/.test(k.display || "") && (c.kids[k.id] || []).every((x) => x.tag === "#text")) {
        const t = htmlInstAllText(c, k);
        if (t) { if (!run) { run = { prop: prop || null, text: "" }; items.push(run); } run.text += (run.text ? " " : "") + t; }
      } else { run = null; walk(k, prop); }
    }
  })(n, n.prop || null);
  return items;
}
function htmlInstPlan(p, c) {
  const n = p._n;
  if (!n || !n.component || n.in_component || p.dom !== n.id) return;
  const d = n.declared || {};
  const px = (v) => /^\d+(\.\d+)?px$/.test(String(v || "").trim());
  p.component = { name: String(n.component), variant: n.variant || null, dataName: n.name || null, texts: htmlInstTexts(c, n), fixW: px(d.width), fixH: px(d.height) };
}

// ---------- build side ----------
const htmlInstBase = (k) => String(k).replace(/#.*$/, "");
// Library components that the file already uses: the main components of existing instances (nothing is imported by key).
async function htmlInstLoadLib(idx) {
  idx.libLoaded = true;
  const seen = new Set(idx.components.map((e) => e.id));
  let left = 1500;
  for (const page of figma.root.children) {
    let list = [];
    try { list = page.findAllWithCriteria({ types: ["INSTANCE"] }); } catch (e) { continue; }
    for (const inst of list) {
      if (left-- <= 0) return;
      let main = null;
      try { main = await inst.getMainComponentAsync(); } catch (e) { main = null; }
      if (!main || !main.remote || seen.has(main.id)) continue;
      const set = main.parent && main.parent.type === "COMPONENT_SET" ? main.parent : null;
      const node = set || main;
      if (seen.has(node.id)) continue;
      seen.add(main.id); seen.add(node.id);
      idx.components.push({ id: node.id, name: node.name, norm: htmlDsNorm(node.name), type: node.type, remote: true, node });
    }
  }
}
// Rule 1: local set, local single component, then the same ignoring case and separators, then library components already in the file.
async function htmlInstFind(ctx, name) {
  const idx = ctx.ds;
  if (!idx) return null;
  if (!idx.compsLoaded) { idx.compsLoaded = true; try { idx.components = await htmlDsComponents(); } catch (e) { idx.components = []; } }
  const q = htmlDsNorm(name);
  let hit = null;
  for (const exact of [true, false]) {
    for (const type of ["COMPONENT_SET", "COMPONENT"]) {
      hit = hit || idx.components.find((e) => !e.remote && e.type === type && (exact ? e.name === name : e.norm === q));
    }
  }
  if (!hit) {
    if (!idx.libLoaded) await htmlInstLoadLib(idx);
    hit = idx.components.find((e) => e.remote && e.name === name) || idx.components.find((e) => e.remote && e.norm === q);
  }
  if (!hit) return null;
  const node = hit.node || (await figma.getNodeByIdAsync(hit.id));
  if (!node) return null;
  return node.type === "COMPONENT_SET" ? { comp: node.defaultVariant, defs: node.componentPropertyDefinitions } : { comp: node, defs: node.componentPropertyDefinitions };
}
function htmlInstDefKey(defs, name) {
  const lo = String(name).trim().toLowerCase(), q = htmlDsNorm(name);
  const keys = Object.keys(defs || {});
  return keys.find((k) => htmlInstBase(k).toLowerCase() === lo) || keys.find((k) => htmlDsNorm(htmlInstBase(k)) === q);
}
// Rules 2-3: "Variant=Primary, Size=M" -> { propertyKey: value }; what is unknown stays at its default (variant_unknown).
function htmlInstVariant(ctx, p, c, defs, props) {
  if (!c.variant) return;
  for (const part of String(c.variant).split(",")) {
    const i = part.indexOf("=");
    const pn = (i < 0 ? part : part.slice(0, i)).trim(), pv = (i < 0 ? "" : part.slice(i + 1)).trim();
    if (!pn) continue;
    const key = htmlInstDefKey(defs, pn), d = key ? defs[key] : null;
    let ok = false;
    if (d && d.type === "VARIANT") { const o = (d.variantOptions || []).find((x) => String(x).toLowerCase() === pv.toLowerCase()); if (o !== undefined) { props[key] = o; ok = true; } }
    else if (d && d.type === "BOOLEAN" && /^(true|false)$/i.test(pv)) { props[key] = pv.toLowerCase() === "true"; ok = true; }
    else if (d && d.type === "TEXT") { props[key] = pv; ok = true; }
    if (!ok) htmlDsWarnAdd(ctx.dsw, p, "variant_unknown", c.name, pn + "=" + pv);
  }
}
// Rule 4: texts by data-prop, else in order into the free TEXT properties; returns the texts that have no property to go to.
function htmlInstTextProps(ctx, p, c, defs, props) {
  const free = Object.keys(defs || {}).filter((k) => defs[k].type === "TEXT" && !(k in props));
  const rest = [];
  for (const it of c.texts || []) {
    if (!it.prop) continue;
    const key = htmlInstDefKey(defs, it.prop);
    if (key && defs[key].type === "TEXT") { props[key] = it.text; const j = free.indexOf(key); if (j >= 0) free.splice(j, 1); it.done = true; }
    else htmlDsWarnAdd(ctx.dsw, p, "text_override_mismatch", c.name, "no text property " + it.prop);
  }
  for (const it of c.texts || []) {
    if (it.done) continue;
    if (free.length) props[free.shift()] = it.text; else rest.push(it);
  }
  return rest;
}
// No text property left: the texts go into the visible TEXT layers inside the instance, in order (font loaded first).
async function htmlInstTextLayers(ctx, p, c, inst, rest) {
  let places = [];
  try { places = inst.findAll((x) => x.type === "TEXT" && x.visible !== false); } catch (e) { places = []; }
  let used = 0;
  for (const it of rest) {
    const t = places[used];
    if (!t) break;
    used++;
    try { await htmlBuildLoadOne(t.fontName); t.characters = it.text; } catch (e) { htmlDsWarnAdd(ctx.dsw, p, "text_override_mismatch", c.name, "text layer not writable"); }
  }
  if (rest.length > used) htmlDsWarnAdd(ctx.dsw, p, "text_override_mismatch", c.name, (rest.length - used) + " text without a place");
}
// Returns the instance (not yet in the tree), or null: the caller builds plain frames (the warning is recorded).
async function htmlInstBuild(p, ctx) {
  const c = p.component;
  const hit = await htmlInstFind(ctx, c.name);
  if (!hit || !hit.comp) { htmlDsWarnAdd(ctx.dsw, p, "component_not_found", c.name, ""); return null; }
  let inst;
  try { inst = hit.comp.createInstance(); } catch (e) { htmlDsWarnAdd(ctx.dsw, p, "instance_failed", c.name, htmlBuildErr(e).slice(0, 80)); return null; }
  try {
    const defs = hit.defs || {}, props = {};
    htmlInstVariant(ctx, p, c, defs, props);
    const rest = htmlInstTextProps(ctx, p, c, defs, props);
    if (Object.keys(props).length) inst.setProperties(props);
    if (rest.length && Object.keys(defs).some((k) => defs[k].type === "TEXT")) htmlDsWarnAdd(ctx.dsw, p, "text_override_mismatch", c.name, rest.length + " text without a place");
    else if (rest.length) await htmlInstTextLayers(ctx, p, c, inst, rest);
    // rule 6: only name, visibility, opacity, and a size the CSS declared in px
    if (c.dataName) inst.name = c.dataName;
    if (p.visible === false) inst.visible = false;
    if (typeof p.opacity === "number" && p.opacity !== 1) inst.opacity = p.opacity;
    if (c.fixW || c.fixH) inst.resize(Math.max(c.fixW ? p.w : inst.width, 0.01), Math.max(c.fixH ? p.h : inst.height, 0.01));
  } catch (e) { htmlDsWarnAdd(ctx.dsw, p, "instance_failed", c.name, htmlBuildErr(e).slice(0, 80)); }
  return inst;
}
