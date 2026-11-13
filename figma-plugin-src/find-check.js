
// Runs fn with figma.skipInvisibleInstanceChildren = true and puts the previous
// value back in `finally`. NEVER left on globally: agents legitimately toggle
// hidden layers inside instances, and those would vanish from every later read.
function withSkipInvisible(fn) {
  const canSkip = typeof figma.skipInvisibleInstanceChildren === "boolean";
  const prev = canSkip ? figma.skipInvisibleInstanceChildren : undefined;
  try {
    if (canSkip) figma.skipInvisibleInstanceChildren = true;
    return fn();
  } finally {
    if (canSkip) {
      try { figma.skipInvisibleInstanceChildren = prev; } catch (e) {}
    }
  }
}

// All descendants of `root` (never root itself) of the given types (or every
// node when types is empty), narrowed by pred. Uses findAllWithCriteria — much
// faster than findAll on big files — when the method exists.
function scanNodes(root, types, pred) {
  if (!root || typeof root.findAll !== "function") return [];
  const typed = types && types.length ? types : null;
  const ok = n => (!typed || typed.indexOf(n.type) !== -1) && (!pred || pred(n));
  if (typed && typeof root.findAllWithCriteria === "function") {
    return root.findAllWithCriteria({ types: typed }).filter(ok);
  }
  return root.findAll(ok);
}

// The top-level frame/section (direct child of the page) that holds `n`.
function topContainerOf(n) {
  let cur = n;
  while (cur && cur.parent && cur.parent.type !== "PAGE" && cur.parent.type !== "DOCUMENT") cur = cur.parent;
  return cur;
}

// Search under a root (default: current page). query: substring
// (case-insensitive) or RegExp. opts: root, type (string or array), limit (20),
// text (true = match TEXT `characters` instead of layer names).
function findNodes(query, opts) {
  const o = opts || {};
  const root = o.root ? readNode(o.root) : figma.currentPage;
  if (!root) throw new Error("bridge.find: root " + o.root + " does not exist");
  const textMode = o.text === true;
  const types = textMode ? ["TEXT"] : (o.type ? (Array.isArray(o.type) ? o.type : [o.type]) : null);
  const limit = Number.isFinite(o.limit) ? o.limit : 20;
  const test = query instanceof RegExp
    ? (s) => { query.lastIndex = 0; return query.test(s); }
    : (s) => String(s).toLowerCase().indexOf(String(query == null ? "" : query).toLowerCase()) !== -1;
  // Page-wide searches skip invisible instance children (the slow part on big
  // files); a scoped search (root given) still sees hidden layers inside
  // instances, which agents look up to toggle them on.
  const scan = () => scanNodes(root, types, n => (textMode ? test(String(n.characters == null ? "" : n.characters)) : test(n.name)));
  const matches = root.type === "PAGE" ? withSkipInvisible(scan) : scan();
  const out = matches.slice(0, limit).map(n => {
    if (!textMode) return { id: n.id, name: n.name, type: n.type };
    const top = topContainerOf(n);
    return {
      id: n.id, name: n.name, type: n.type,
      text: String(n.characters || "").slice(0, 40),
      frame: top ? top.name + " #" + top.id : null,
      // the layer the text sits in (a button frame to click, a row to edit), unless that is the screen itself
      parent: n.parent && n.parent !== top ? n.parent.type + " " + JSON.stringify(n.parent.name) + " #" + n.parent.id : null
    };
  });
  if (matches.length > limit) out.push("… +" + (matches.length - limit) + " more (" + matches.length + " total) — narrow with root/type/limit");
  return out;
}

function checkEquals(want, got, tolerance) {
  if (want instanceof RegExp) return typeof got === "string" && want.test(got);
  if (typeof want === "number" && typeof got === "number") return Math.abs(want - got) <= tolerance;
  if (typeof want === "string" && typeof got === "string" && /^#[0-9a-f]{6}/i.test(want)) {
    return got.toUpperCase().indexOf(want.toUpperCase()) === 0;
  }
  if (Array.isArray(want)) {
    return Array.isArray(got) && want.length === got.length && want.every((w, i) => checkEquals(w, got[i], tolerance));
  }
  if (want && typeof want === "object") {
    return !!got && typeof got === "object" && Object.keys(want).every(k => checkEquals(want[k], got[k], tolerance));
  }
  return want === got;
}

// Declarative verification. specs: { "12:3": { width: 320, fill: "#FFFFFF",
// text: /Submit/ }, ... } or [{ id: "12:3", width: 320 }, ...]. Returns
// { pass, fail: [{ id, key, want, got }], missing: [ids] } — `fail` and
// `missing` are empty when everything matches. opts.tolerance (0.5) for numbers.
function checkNodes(specs, opts) {
  const tolerance = opts && Number.isFinite(opts.tolerance) ? opts.tolerance : 0.5;
  const list = Array.isArray(specs)
    ? specs
    : Object.keys(specs || {}).map(id => Object.assign({ id: id }, specs[id]));
  const result = { pass: 0, fail: [], missing: [] };
  list.forEach(spec => {
    const n = readNode(spec.id);
    if (!n) { result.missing.push(spec.id); return; }
    Object.keys(spec).forEach(key => {
      if (key === "id") return;
      let got;
      try { got = readProp(n, key); } catch (e) { got = "ERR: " + (e.message || e); }
      if (checkEquals(spec[key], got, tolerance)) result.pass++;
      else result.fail.push({ id: spec.id, key: key, want: spec[key] instanceof RegExp ? String(spec[key]) : spec[key], got: got });
    });
  });
  return result;
}
