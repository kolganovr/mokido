const { outputBudgetInfo } = require("./budget");
const { normalizeNodeIds } = require("./hints");

// figma_inspect runs as ordinary plugin code over the bridge's cheap-read
// helpers (bridge.find / summarize / inspect / check), so it needs no plugin
// message type of its own and inherits the job ledger, target routing and
// bridge.state.lastResult. Arguments travel as a JSON literal, never spliced
// in as code.
const AUTO_DEPTH_RESERVE = 300;

function buildInspectCode(args = {}) {
  const ids = normalizeNodeIds(args.node_ids || args.node_id || args.ids);
  const depth = Number(args.depth);
  const limit = Number(args.limit);
  const spec = {
    ids: ids ? ids.split(",") : [],
    depth: Number.isFinite(depth) ? Math.max(0, Math.min(6, Math.floor(depth))) : null,
    props: Array.isArray(args.props) && args.props.length ? args.props.map(String) : null,
    view: args.view === "map" || args.view === "table" || args.view === "flow" ? args.view : null,
    context: args.context === true,
    find: typeof args.find === "string" && args.find ? args.find : null,
    findText: typeof args.find_text === "string" && args.find_text ? args.find_text : null,
    type: typeof args.find_type === "string" && args.find_type ? args.find_type.toUpperCase() : null,
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 30,
    check: args.check && typeof args.check === "object" ? args.check : null,
    compare: typeof args.compare === "string" && args.compare ? args.compare.replace(/-/g, ":") : null,
    like: normalizeNodeIds(args.like) ? normalizeNodeIds(args.like).split(",") : null,
    // No depth: the plugin picks the deepest outline that fits the reply. The
    // envelope around the outline ({"ok":true,"result":{"outline":…},"duration_ms":…}
    // plus the reserved truncation note) measured 295 B (bench/tools/autodepth_check.js),
    // so the outline may take the budget minus AUTO_DEPTH_RESERVE (was a guessed 500).
    autoBytes: Math.max(600, outputBudgetInfo(args).bytes - AUTO_DEPTH_RESERVE),
    screens: args.screens === true,
    notes: args.notes === true,
    findTreeMax: 8,
    notesMax: 30,
    findTreeBytes: Math.max(600, outputBudgetInfo(args).bytes - AUTO_DEPTH_RESERVE)
  };
  const literal = JSON.stringify(spec); // ES2019+: U+2028/2029 are legal in string literals
  return [
    `const a = ${literal};`,
    "const out = {};",
    "let targets = a.ids;",
    "const query = a.findText || a.find;", // find_text (names AND text content) wins over find
    "let hits = [];",
    "if (query) {",
    "  let more = [];",
    "  for (const root of (a.ids.length ? a.ids : [null])) {",
    "    const opts = { limit: a.limit };",
    "    if (root) opts.root = root;",
    "    if (a.type) opts.type = a.type;",
    "    if (a.findText) opts.text = true;",
    "    for (const f of bridge.find(query, opts)) (typeof f === 'string' ? more : hits).push(f);",
    "  }",
    "  targets = hits.map(f => f.id);",
    "  if (!targets.length) {",
    "    out.found = 'no matches';",
    // Searching the current page only is a trap in a multi-page file: name the page and count hits elsewhere
    // (loading at most 8 other pages; the rest are listed by name only).
    "    if (!a.ids.length) {",
    "      const cur = figma.currentPage;",
    "      out.found = 'no matches on page ' + JSON.stringify(cur.name);",
    "      const others = (figma.root && figma.root.children || []).filter(p => p.id !== cur.id);",
    "      if (others.length) {",
    "        const parts = [];",
    "        let loaded = 0;",
    "        for (const p of others) {",
    "          if (loaded >= 8) { parts.push(JSON.stringify(p.name) + ': not scanned'); continue; }",
    "          loaded++;",
    "          try {",
    "            if (typeof p.loadAsync === 'function') await p.loadAsync();",
    "            const opts = { limit: 1, root: p.id };",
    "            if (a.type) opts.type = a.type;",
    "            if (a.findText) opts.text = true;",
    "            const r = bridge.find(query, opts);",
    "            const more = r.find(x => typeof x === 'string');",
    "            const m = more && /\\((\\d+) total\\)/.exec(more);",
    "            parts.push(JSON.stringify(p.name) + ': ' + (m ? m[1] : r.filter(x => typeof x !== 'string').length));",
    "          } catch (e) { parts.push(JSON.stringify(p.name) + ': ?'); }",
    "        }",
    "        out.other_pages = parts.join(', ') + ' (matches; switch page to use them)';",
    "      }",
    "    }",
    "  }",
    "  if (more.length) out.found_more = more;",
    "}",
    // No ids: every top-level node of the page (a capped walk that says what it scanned),
    // not a refusal that costs a turn (h13: 3 empty flow calls). The selection goes first,
    // so the cap never cuts what the user pointed at (review 4.2.7 #52).
    "if (a.view === 'flow' && !targets.length && !query) {",
    "  const sel = (figma.currentPage.selection || []).map(n => n.id);",
    "  targets = sel.concat(figma.currentPage.children.map(n => n.id).filter(id => sel.indexOf(id) === -1));",
    "  if (!targets.length) out.flow = 'the page is empty';",
    "}",
    // flow of whole screens: each id -> the top-level frame it sits in (under the page or a section)
    "if (a.view === 'flow' && a.screens && targets.length) {",
    "  const tops = [];",
    "  for (const id of targets) {",
    "    let n = figma.getNodeById(id);",
    "    if (!n) continue;",
    "    while (n.parent && n.parent.type !== 'PAGE' && n.parent.type !== 'SECTION' && n.parent.type !== 'DOCUMENT') n = n.parent;",
    "    if (tops.indexOf(n.id) === -1) tops.push(n.id);",
    "  }",
    "  if (tops.length) targets = tops;",
    "}",
    "if (a.like) out.like = bridge.like(a.like, a.ids);",
    "const wantsRead = !a.like && (a.props || query || a.ids.length || a.view || a.context || !a.check);",
    "if (a.compare && targets.length) out.compare = bridge.compare(a.compare, targets);",
    "if (wantsRead && !out.flow && (targets.length || !query)) {",
    "  const refs = targets.length ? targets : [figma.currentPage];",
    "  if (a.compare) {}",
    "  else if (a.props) {",
    "    out.props = bridge.inspect(refs, a.props);",
    // props:["texts"]: lines "id characters" move to the top-level string out.texts, which pages with offset.
    "    if (a.props.indexOf('texts') !== -1) {",
    "      const lines = [];",
    "      const multi = Object.keys(out.props).length > 1;",
    "      for (const id of Object.keys(out.props)) {",
    "        const row = out.props[id];",
    "        if (!row || typeof row !== 'object' || !Array.isArray(row.texts)) continue;",
    "        if (multi) lines.push('@' + id);",
    "        for (const l of row.texts) lines.push(l);",
    "        delete row.texts;",
    "        if (!Object.keys(row).length) delete out.props[id];",
    "      }",
    "      out.texts = lines.length ? lines.join('\\n') : 'no TEXT nodes';",
    "      if (!Object.keys(out.props).length) delete out.props;",
    "    }",
    "  }",
    "  else if (a.findText && !a.view) out.found = hits.map(f => '#' + f.id + ' ' + JSON.stringify(f.name) + ' «' + f.text + '» in ' + (f.parent ? f.parent + ', screen ' + JSON.stringify(String(f.frame).replace(/ #\\S+$/, '')) : f.frame)).join('\\n');",
    "  else {",
    "    const so = { maxChildren: 200 };",
    // H6: a few hits come with their subtree (the next call was an outline of the same ids in 16 of 24 finds).
    "    const findTree = query && !a.view && a.depth === null && hits.length > 0 && hits.length <= a.findTreeMax;",
    "    if (a.depth !== null) so.depth = a.depth; else if (findTree) so.autoBytes = a.findTreeBytes; else if (query || a.view === 'map') so.depth = query ? 0 : 1; else so.autoBytes = a.autoBytes;",
    "    if (a.view === 'map') so.view = 'map';",
    "    if (a.view === 'table') so.view = 'table';",
    "    if (a.view === 'flow') so.view = 'flow';",
    // Hits nested in another hit are shown inside its tree, not counted as roots; one extra line only if the depth did not reach them.
    "    let s;",
    "    if (findTree) {",
    // Budget in JSON bytes, as the plugin counts it (review 4.2.7 #49: Cyrillic names are
    // 2 bytes a char, a chars check let ~5000 B through and the reply got shrunk).
    "      const jb = t => { let b = 2; for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); b += c === 34 || c === 92 || c === 10 ? 2 : c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xD800 && c <= 0xDBFF ? (i++, 4) : 3; } return b; };",
    "      const hitSet = new Set(targets);",
    "      const inHit = id => { let p = figma.getNodeById(id); p = p && p.parent; while (p) { if (hitSet.has(p.id)) return true; p = p.parent; } return false; };",
    "      const tops = targets.filter(id => !inHit(id));",
    "      const withLost = tree => { const lost = targets.filter(id => tops.indexOf(id) === -1 && tree.indexOf('#' + id + ' ') === -1); return lost.length ? tree + '\\n' + bridge.summarize(lost, { depth: 0 }) : tree; };",
    "      s = withLost(bridge.summarize(tops, so));",
    // the lost lines come out of the tree's budget, not on top of it
    "      if (jb(s) > a.findTreeBytes) { const room = so.autoBytes - (jb(s) - jb(bridge.summarize(tops, so))); if (room > 200) s = withLost(bridge.summarize(tops, Object.assign({}, so, { autoBytes: room }))); }",
    // depth 1 that does not fit comes back uncapped (up to 200 children): keep the one-line hits then
    "      if (jb(s) > a.findTreeBytes) s = bridge.summarize(refs, { maxChildren: 200, depth: 0 });",
    "    } else s = bridge.summarize(refs, so);",
    "    out[query ? 'found' : a.view === 'flow' ? 'flow' : 'outline'] = s;",
    "  }",
    "  if (a.context) {",
    "    out.context = {};",
    // One-line strings: nested {w,n} objects came back as \"{object with 2 keys}\" once shrunk.
    "    const ws = l => (l || []).map(x => x.w + '×' + x.n).join(', ');",
    "    for (const r of refs) {",
    "      const id = typeof r === 'string' ? r : r.id;",
    "      const c = bridge.context(id);",
    "      out.context[id] = { node: c.node.type + ' ' + JSON.stringify(c.node.name) + ' #' + c.node.id + ' ' + c.node.w + 'x' + c.node.h, ancestors: c.ancestors.join(' › '), siblings: ws(c.siblings), pageWidths: ws(c.pageWidths),",
    "        components: c.components.map(x => x.set + ' ×' + x.used + (x.props ? ' ' + Object.keys(x.props).map(k => k + '=' + (Array.isArray(x.props[k]) ? x.props[k].join('|') : x.props[k])).join('; ') : '')), conventions: c.conventions };",
    "    }",
    "  }",
    "}",
    // ids of layers inside an instance (I<inst>;<layer>): is the master, and every other instance of it, really untouched?
    // One getInstancesAsync per master and at most notesMax neighbours compared (review 4.2.7 #50:
    // a Button with 400 instances ran past the 15 s timeout and the whole after was lost).
    "if (a.notes) {",
    "  const notes = [];",
    "  const instancesOf = new Map();",
    "  for (const id of a.ids) {",
    "    if (id.charAt(0) !== 'I' || id.indexOf(';') === -1) continue;",
    "    const parts = id.slice(1).split(';');",
    "    const inst = figma.getNodeById(parts[0]);",
    "    const layer = figma.getNodeById(parts[parts.length - 1]);",
    "    if (!inst || inst.type !== 'INSTANCE' || !layer || !figma.getNodeById(id)) continue;",
    "    const main = inst.mainComponent;",
    "    if (!main) continue;",
    "    if (!instancesOf.has(main.id)) instancesOf.set(main.id, typeof main.getInstancesAsync === 'function' ? await main.getInstancesAsync() : (main.instances || []));",
    "    const others = instancesOf.get(main.id).filter(i => i.id !== inst.id);",
    "    const checked = others.slice(0, a.notesMax);",
    "    const differ = [];",
    "    for (const o of checked) {",
    "      const cid = 'I' + o.id + ';' + parts.slice(1).join(';');",
    "      if (!figma.getNodeById(cid)) continue;",
    "      if (!/: identical$/.test(bridge.compare(layer.id, [cid]).split('\\n')[0])) differ.push(o.id);",
    "    }",
    "    const same = checked.length - differ.length;",
    "    const scope = others.length > checked.length ? ', of ' + checked.length + ' checked (' + others.length + ' other instances in all)' : '';",
    "    notes.push('NOTE ' + id + ': an override inside instance #' + inst.id + '; main COMPONENT ' + JSON.stringify(main.name) + ' #' + main.id + ' and ' + same + ' other instance' + (same === 1 ? '' : 's') + ' untouched' + scope + (differ.length ? ' (' + differ.length + ' differ from the master: ' + differ.slice(0, 4).map(x => '#' + x).join(' ') + ')' : ''));",
    "  }",
    "  if (notes.length) out.notes = notes;",
    "}",
    "if (a.check) out.check = bridge.check(a.check);",
    "return out;"
  ].join("\n");
}

module.exports = { buildInspectCode };
