
// view:"table" — structural table detector (never trusts layer names).
// Container = a node with >=2 visible direct children ("rows") that all have the
// same child count k>=2. The topmost such node per branch wins; siblings of one
// frame may hold several tables. Header = nearest previous sibling of the first
// row (or its descendant, up to 2 levels down) with exactly k children holding TEXT.
const TABLE_MAX_DEPTH = 8;

function tableKids(n) {
  return n && "children" in n && n.children ? n.children.filter(c => c && c.visible !== false) : [];
}

function tableFirstText(n, depth) {
  if (!n) return null;
  if (n.type === "TEXT") return n;
  if (depth <= 0) return null;
  for (const c of tableKids(n)) { const t = tableFirstText(c, depth - 1); if (t) return t; }
  return null;
}

function tableFirstInstance(n, depth) {
  if (!n) return null;
  if (n.type === "INSTANCE") return n;
  if (depth <= 0) return null;
  for (const c of tableKids(n)) { const t = tableFirstInstance(c, depth - 1); if (t) return t; }
  return null;
}

function tableClip(s, max) {
  const t = String(s == null ? "" : s).replace(/\s*[\r\n]+\s*/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

// { rows, k, firstIndex, kids } for the best group of equal-width rows, or null.
function tableRowsOf(n) {
  const kids = tableKids(n);
  const freq = {};
  kids.forEach(c => { const k = tableKids(c).length; if (k >= 2) freq[k] = (freq[k] || 0) + 1; });
  let best = 0;
  Object.keys(freq).forEach(key => {
    const k = Number(key);
    if (freq[k] >= 2 && (!best || freq[k] > freq[best] || (freq[k] === freq[best] && k > best))) best = k;
  });
  if (!best) return null;
  // Real rows sit in one column: same x and width (±2 px). A screen frame whose
  // header and sidebar merely share a child count is not a table.
  const same = kids.filter(c => tableKids(c).length === best);
  const near = (a, b) => typeof a !== "number" || typeof b !== "number" || Math.abs(a - b) <= 2;
  const widthVotes = {};
  same.forEach(c => { const w = Math.round(c.width); widthVotes[w] = (widthVotes[w] || 0) + 1; });
  const modeW = Number(Object.keys(widthVotes).sort((a, b) => widthVotes[b] - widthVotes[a])[0]);
  const ref = same.find(c => near(c.width, modeW));
  const rows = same.filter(c => near(c.width, modeW) && near(c.x, ref.x));
  if (rows.length < 2) return null;
  if (rows.length === 2 && tableRowSig(rows[0]) !== tableRowSig(rows[1])) return null;
  return { rows, k: best, firstIndex: kids.indexOf(rows[0]), kids };
}

function tableFindHeader(sib, k) {
  let level = [sib];
  for (let d = 0; d <= 2 && level.length; d++) {
    for (const c of level) {
      const cells = tableKids(c);
      if (cells.length === k && cells.some(x => tableFirstText(x, 3))) return c;
    }
    const next = [];
    level.forEach(c => tableKids(c).forEach(x => next.push(x)));
    level = next;
  }
  return null;
}

// A "table of tables" (e.g. a frame holding two boxes that each hold rows): the
// outer node is not the table when >=2 of its rows are themselves containers
// with at least as many rows of their own, whose cells have children.
function tableLooksNested(info) {
  const deeper = info.rows.filter(r => {
    const s = tableRowsOf(r);
    return s && s.rows.length >= info.rows.length && s.rows.some(r2 => tableKids(r2).some(c => tableKids(c).length > 0));
  });
  return deeper.length >= 2;
}

// Shape of a row's cells, used to tell a header row that sits among the rows.
function tableRowSig(row) {
  return tableKids(row).map(c => c.type + ":" + tableKids(c).length + ":" + (tableFirstInstance(c, 2) ? "I" : "")).join("|");
}

function tableDetect(root) {
  const found = [];
  const visit = (n, level) => {
    const info = tableRowsOf(n);
    if (info && !tableLooksNested(info)) {
      let header = null;
      for (let i = info.firstIndex - 1, tries = 0; i >= 0 && tries < 3 && !header; i--, tries++) header = tableFindHeader(info.kids[i], info.k);
      let rows = info.rows;
      // No header sibling: the first "row" may be the header itself when its cell
      // shape differs from two identically shaped rows after it.
      if (!header && rows.length >= 3 && tableRowSig(rows[0]) !== tableRowSig(rows[1]) && tableRowSig(rows[1]) === tableRowSig(rows[2]) &&
          tableKids(rows[0]).every(c => tableFirstText(c, 3))) {
        header = rows[0];
        rows = rows.slice(1);
      }
      found.push({ container: n, rows, k: info.k, header });
      // Keep looking beside the rows (another table in the same frame).
      if (level < TABLE_MAX_DEPTH) tableKids(n).forEach(c => { if (info.rows.indexOf(c) === -1 && c !== header) visit(c, level + 1); });
      return;
    }
    if (level >= TABLE_MAX_DEPTH) return;
    tableKids(n).forEach(c => visit(c, level + 1));
  };
  visit(root, 0);
  return found;
}

function tableInstanceKey(inst) {
  let name = "?";
  try { if (inst.mainComponent) name = inst.mainComponent.name; } catch (e) {}
  let variant = "";
  try {
    if (inst.variantProperties) variant = Object.keys(inst.variantProperties).map(k => k + "=" + inst.variantProperties[k]).join(",");
  } catch (e) {}
  if (!variant && inst.componentProperties) {
    try {
      variant = Object.keys(inst.componentProperties)
        .filter(k => inst.componentProperties[k].type === "VARIANT" || inst.componentProperties[k].type === "BOOLEAN")
        .map(k => k.replace(/#\d+:\d+$/, "") + "=" + inst.componentProperties[k].value).join(",");
    } catch (e) {}
  }
  return { name, variant };
}

// One column's cells over all rows -> "text «a» «b» … | checkbox State=Default×6 State=Disabled×2".
function tableColumnContent(rows, i) {
  const texts = [];
  const comps = {};
  let empty = 0;
  rows.forEach(r => {
    const cell = tableKids(r)[i];
    const inst = tableFirstInstance(cell, 2);
    if (inst) {
      const key = tableInstanceKey(inst);
      const c = comps[key.name] || (comps[key.name] = {});
      c[key.variant] = (c[key.variant] || 0) + 1;
      return;
    }
    const t = tableFirstText(cell, 4);
    const s = t ? tableClip(t.characters, 30) : "";
    if (s) { if (texts.indexOf(s) === -1) texts.push(s); } else empty++;
  });
  const parts = [];
  if (texts.length) parts.push("text " + texts.slice(0, 2).map(s => "«" + s + "»").join(" ") + (texts.length > 2 ? " …" : ""));
  Object.keys(comps).forEach(name => {
    const label = /^[\w.\-\/]+$/.test(name) ? name : JSON.stringify(name);
    const vs = Object.keys(comps[name]);
    const total = vs.reduce((a, v) => a + comps[name][v], 0);
    parts.push(label + " " + (vs.length === 1 && !vs[0] ? "×" + total : vs.map(v => (v || "default") + "×" + comps[name][v]).join(" ")));
  });
  if (empty) parts.push("empty×" + empty);
  return parts.join(" | ") || "empty";
}

function describeTable(t) {
  const first = t.rows[0];
  const layout = readLayout(first);
  const lines = [
    "TABLE #" + t.container.id + " " + JSON.stringify(t.container.name) + " rows:" + t.rows.length + " cols:" + t.k +
      " rowW:" + readRound(first.width) + (layout ? " [" + layout.replace(/ [a-z]+\/[a-z]+$/, "") + "]" : "")
  ];
  lines.push(t.header ? "  header #" + t.header.id + " " + JSON.stringify(t.header.name) : "  header none");
  const hCells = t.header ? tableKids(t.header) : null;
  const fCells = tableKids(first);
  for (let i = 0; i < t.k; i++) {
    const hc = hCells ? hCells[i] : fCells[i];
    const ht = hCells ? tableFirstText(hc, 3) : null;
    const parts = [String(i + 1)];
    if (hCells) parts.push(JSON.stringify(ht ? tableClip(ht.characters, 30) : ""));
    if (hc && typeof hc.width === "number") parts.push("w" + readRound(hc.width));
    if (hc && hc.layoutSizingHorizontal) parts.push(String(hc.layoutSizingHorizontal).toLowerCase());
    parts.push("→ " + tableColumnContent(t.rows, i));
    lines.push("  " + parts.join(" "));
  }
  lines.push("  row0 #" + first.id + " cells: " + fCells.map(c => "#" + c.id).join(" "));
  return lines.join("\n");
}

// bridge.summarize(refs, { view: "table" }): one block per node (several tables
// in one node -> several blocks; none -> "#id "name": no table found").
function summarizeTables(refs) {
  const blocks = [];
  withSkipInvisible(() => {
    (Array.isArray(refs) ? refs : [refs]).forEach(ref => {
      const n = readNode(ref);
      if (!n) { blocks.push("MISSING " + ref); return; }
      const tables = tableDetect(n);
      if (!tables.length) blocks.push("#" + n.id + " " + JSON.stringify(n.name) + ": no table found");
      else tables.forEach(t => blocks.push(describeTable(t)));
    });
  });
  return blocks.join("\n");
}
