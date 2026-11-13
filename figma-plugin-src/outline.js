
// view:"flow" — prototype links under the given nodes, grouped by screen:
// source, trigger, action, target, transition; then the overlay settings of
// every overlay target (they live on the target FRAME, not on the action).
// Scans only inside the given nodes, with a node and time cap, so it cannot
// freeze the plugin the way a page-wide findAll over `reactions` did.
const FLOW_MAX_NODES = 30000;
const FLOW_MAX_MS = 6000;

function flowTriggerText(t) {
  if (!t) return "?";
  let s = t.type || "?";
  if (typeof t.timeout === "number") s += " " + readRound(t.timeout) + "s";
  else if (typeof t.delay === "number" && t.delay) s += " delay " + readRound(t.delay) + "s";
  if (Array.isArray(t.keyCodes) && t.keyCodes.length) s += " key " + t.keyCodes.join("+");
  return s;
}

function flowTransitionText(tr) {
  if (!tr) return "";
  let s = tr.type || "?";
  if (tr.direction) s += " " + tr.direction;
  if (typeof tr.duration === "number") s += " " + readRound(tr.duration) + "s";
  if (tr.easing && tr.easing.type) s += " " + tr.easing.type;
  return s;
}

function flowActionText(a, overlays) {
  if (!a) return "?";
  if (a.type === "NODE") {
    const nav = a.navigation || "NAVIGATE";
    let dest = null;
    try { dest = a.destinationId ? figma.getNodeById(a.destinationId) : null; } catch (e) {}
    let s = nav + " " + (a.destinationId ? "#" + a.destinationId + (dest ? " " + JSON.stringify(dest.name) : " MISSING") : "(no target)");
    const tr = flowTransitionText(a.transition);
    s += tr ? " [" + tr + "]" : " [instant]";
    if (nav === "OVERLAY" && dest) overlays[dest.id] = dest;
    return s;
  }
  if (a.type === "URL") return "URL " + a.url;
  if (a.type === "SET_VARIABLE") return "SET_VARIABLE " + (a.variableId || "?") + (a.variableValue ? " = " + JSON.stringify(a.variableValue.value) : "");
  if (a.type === "CONDITIONAL") return "CONDITIONAL (" + (a.conditionalBlocks ? a.conditionalBlocks.length : 0) + " blocks)";
  return a.type || "?";
}

function flowOverlayText(d) {
  const bg = d.overlayBackground;
  let bgText = "none";
  if (bg && bg.type === "SOLID_COLOR") bgText = readHex(bg.color, typeof bg.color.a === "number" ? bg.color.a : 1);
  else if (bg && bg.type) bgText = bg.type;
  return "OVERLAY " + JSON.stringify(d.name) + " #" + d.id + ": position " + (d.overlayPositionType || "n/a") +
    ", dim " + bgText + ", click outside " + (d.overlayBackgroundInteraction === "CLOSE_ON_CLICK_OUTSIDE" ? "closes" : "does nothing");
}

function flowScreenOf(n) {
  let cur = n;
  while (cur.parent && cur.parent.type !== "PAGE" && cur.parent.type !== "SECTION" && cur.parent.type !== "DOCUMENT") cur = cur.parent;
  return cur;
}

function summarizeFlow(refs) {
  const list = Array.isArray(refs) ? refs : [refs];
  const started = Date.now();
  const screens = {};
  const order = [];
  const overlays = {};
  let scanned = 0, links = 0, sources = 0, partial = false, rootsDone = 0;
  const visit = (n) => {
    scanned++;
    if (Array.isArray(n.reactions) && n.reactions.length) {
      const parts = [];
      n.reactions.forEach(r => {
        if (!r) return;
        const actions = Array.isArray(r.actions) && r.actions.length ? r.actions : (r.action ? [r.action] : [null]);
        actions.forEach(a => { parts.push(flowTriggerText(r.trigger) + " → " + (a ? flowActionText(a, overlays) : "(no action)")); links++; });
      });
      if (parts.length) {
        sources++;
        const top = flowScreenOf(n);
        if (!screens[top.id]) { screens[top.id] = { head: "SCREEN " + JSON.stringify(top.name) + " #" + top.id, lines: [] }; order.push(top.id); }
        parts.forEach(p => screens[top.id].lines.push("  " + (n === top ? "(screen)" : n.type + " " + JSON.stringify(n.name) + " #" + n.id) + " " + p));
      }
    }
  };
  list.forEach(ref => {
    if (partial) return;
    const root = readNode(ref);
    if (!root) return;
    const stack = [root];
    while (stack.length) {
      if (scanned >= FLOW_MAX_NODES || Date.now() - started > FLOW_MAX_MS) { partial = true; break; }
      const n = stack.pop();
      visit(n);
      if ("children" in n && n.children) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
    }
    if (!partial) rootsDone++;
  });
  const lines = ["FLOW: " + links + " link" + (links === 1 ? "" : "s") + " from " + sources + " node" + (sources === 1 ? "" : "s") + " in " + order.length + " screen" + (order.length === 1 ? "" : "s") + " (scanned " + scanned + " nodes" +
    (partial ? ", STOPPED at the scan cap: scanned " + rootsDone + " of " + list.length + " top-level nodes, pass node_ids (a section or screens) for the rest" : "") + ")"];
  order.forEach(id => { lines.push(screens[id].head); screens[id].lines.forEach(l => lines.push(l)); });
  const ov = Object.keys(overlays);
  if (ov.length) { lines.push("OVERLAY SETTINGS (frame properties of the overlay target, not part of the action)"); ov.forEach(id => lines.push("  " + flowOverlayText(overlays[id]))); }
  if (!links) lines.push("no prototype links under the given nodes");
  return lines.join("\n");
}

// Bytes a string costs once JSON-encoded (UTF-8, quotes/backslashes/newlines
// escaped) — the sandbox has no TextEncoder.
function jsonByteCost(s) {
  let b = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 34 || c === 92 || c === 10) b += 2;
    else if (c < 0x80) b += 1;
    else if (c < 0x800) b += 2;
    else if (c >= 0xD800 && c <= 0xDBFF) { b += 4; i++; }
    else b += 3;
  }
  return b;
}

const PRUNE_STOP = { stop: true };

// Indented outline, one line per node. opts: depth (2), maxChildren (15), text (40),
// view ("map" = geometry only, see describeMapLine), autoBytes (depth not given:
// the deepest level, up to 6, whose outline fits in that many JSON bytes — one
// read shows as much as the reply can carry instead of a depth-1 slice that
// the model then deepens call by call). A node cut off by the depth ends with
// "children:N" so the reader knows there is more.
function summarizeNodes(refs, opts) {
  const o = opts || {};
  if (o.view === "table") return summarizeTables(refs);
  if (o.view === "flow") return summarizeFlow(refs);
  const maxChildren = Number.isFinite(o.maxChildren) ? o.maxChildren : 15;
  const list = Array.isArray(refs) ? refs : [refs];
  const render = (depth, byteCap) => {
    const lines = [];
    let bytes = 0;
    const push = (line) => {
      lines.push(line);
      bytes += jsonByteCost(line) + 2;
      if (byteCap && bytes > byteCap) throw PRUNE_STOP;
    };
    const walk = (n, level) => {
      let line = "  ".repeat(level) + (o.view === "map" ? describeMapLine(n) : describeNodeLine(n, o.text));
      const kids = n && "children" in n && n.children ? n.children : null;
      if (kids && kids.length && level >= depth && o.view !== "map") line += " children:" + kids.length;
      push(line);
      if (!kids || level >= depth) return;
      kids.slice(0, maxChildren).forEach(k => walk(k, level + 1));
      if (kids.length > maxChildren) push("  ".repeat(level + 1) + "… +" + (kids.length - maxChildren) + " more children");
    };
    list.forEach(ref => {
      const n = readNode(ref);
      if (n) walk(n, 0); else push("MISSING " + ref);
    });
    return lines.join("\n");
  };
  if (!Number.isFinite(o.depth) && Number.isFinite(o.autoBytes) && o.autoBytes > 0) {
    let best = null;
    for (let d = 1; d <= 6; d++) {
      let text;
      try { text = render(d, o.autoBytes); } catch (e) { if (e !== PRUNE_STOP) throw e; break; }
      best = text;
      if (text.indexOf(" children:") === -1) break; // nothing was cut by the depth
    }
    return best !== null ? best : render(1, 0);
  }
  return render(Number.isFinite(o.depth) ? o.depth : 2, 0);
}
