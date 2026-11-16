// html-bridge.js (T-077, F8.4): the sandbox half of bridge.fromHtml. The sandbox has no DOM, so the HTML goes to the
// plugin window (ui.html: hidden iframe + htmlWalk), the tree comes back as an HTML_TREE message, then htmlMap -> htmlBuild.
// Prefix: htmlBridge*. Message flow: sandbox HTML_WALK {reqId, html, width, height} -> ui; ui HTML_TREE {reqId, tree | error} -> sandbox.

const HTML_BRIDGE_PENDING = new Map();
let htmlBridgeSeq = 0;
let HTML_BRIDGE_TIMEOUT_MS = 20000; // let: the test shortens it
const HTML_BRIDGE_MAX_WARNINGS = 10;

// Called by messages.js for every HTML_TREE message from the window.
function htmlBridgeOnTree(msg) {
  const p = HTML_BRIDGE_PENDING.get(msg.reqId);
  if (!p) return;
  HTML_BRIDGE_PENDING.delete(msg.reqId);
  clearTimeout(p.timer);
  if (msg.error) p.reject(new Error("HTML_WALK_FAILED: " + msg.error));
  else p.resolve(msg.tree);
}

function htmlBridgeRequestTree(html, width, height) {
  return new Promise((resolve, reject) => {
    const reqId = "html_" + Date.now().toString(36) + "_" + (++htmlBridgeSeq);
    const timer = setTimeout(() => {
      HTML_BRIDGE_PENDING.delete(reqId);
      reject(new Error("HTML_WALK_TIMEOUT: the Mokido plugin window did not return the layout in " + (HTML_BRIDGE_TIMEOUT_MS / 1000) +
        " s. The plugin window must stay open (not closed); try again, or build the screen with figma_execute_code."));
    }, HTML_BRIDGE_TIMEOUT_MS);
    HTML_BRIDGE_PENDING.set(reqId, { resolve, reject, timer });
    try {
      figma.ui.postMessage({ type: "HTML_WALK", reqId, html: String(html), width, height });
    } catch (e) {
      HTML_BRIDGE_PENDING.delete(reqId);
      clearTimeout(timer);
      reject(e);
    }
  });
}

function htmlBridgeWarn(w) {
  const where = w.id != null ? w.id : (w.dom != null ? "dom" + w.dom : "-");
  return String(w.code) + " " + where + ": " + String(w.msg || "").slice(0, 110);
}

// bridge.fromHtml(html, { width | widths, height, parent, name, x, y }) -> compact report
async function htmlBridgeFromHtml(html, opts) {
  const o = opts || {};
  if (typeof html !== "string" || !html.trim()) throw new Error("bridge.fromHtml: html must be a non-empty string");
  const widths = Array.isArray(o.widths) && o.widths.length ? o.widths.map(Number) : [Number(o.width) || 1440];
  if (widths.length > 4) throw new Error("bridge.fromHtml: at most 4 widths per call, got " + widths.length + ". Split into several calls.");
  if (widths.some((w) => !(w >= 100 && w <= 8000))) throw new Error("bridge.fromHtml: width must be 100..8000 px, got " + JSON.stringify(widths));
  const height = Number(o.height) || 900;
  let parent = null;
  if (o.parent) {
    parent = typeof o.parent === "string" ? figma.getNodeById(o.parent) : o.parent;
    if (!parent || typeof parent.appendChild !== "function") throw new Error("bridge.fromHtml: parent " + String(o.parent) + " is not a node that can hold children");
  }
  const roots = [], perRoot = [], warnings = [], codes = {};
  let bound = 0, inst = 0, created = 0, al = 0, frames = 0, abs = 0, wrapped = 0, boxNum = 0, boxDen = 0, x = typeof o.x === "number" ? o.x : null, y = typeof o.y === "number" ? o.y : 0;
  for (let i = 0; i < widths.length; i++) {
    const w = widths[i];
    const tree = await htmlBridgeRequestTree(html, w, height);
    const plan = htmlMap(tree, {});
    if (x === null) {
      if (parent) x = 0;
      else { const pos = getFreeCanvasPosition(w, plan.root.h); x = pos.x; y = typeof o.y === "number" ? o.y : pos.y; }
    }
    const name = o.name ? (widths.length > 1 ? o.name + "@" + w : o.name) : (widths.length > 1 ? "HTML@" + w : "HTML");
    const report = await htmlBuild(plan, { parent: parent || figma.currentPage, x, y, name });
    if (report.root_id) {
      roots.push({ id: report.root_id, name, w: plan.root.w, h: plan.root.h, x, y });
      if (widths.length > 1) perRoot.push(w + ": " + report.created + " layers, AL " + report.auto_layout + "/" + plan.stats.frames + ", abs " + report.absolute_fallback + ", bound " + (report.bound || 0));
      try { if (activeCheckpoint) activeCheckpoint.created.push(report.root_id); } catch (e) { /* journal is best effort */ }
    }
    created += report.created; bound += report.bound || 0; inst += report.instances || 0; al += report.auto_layout; frames += plan.stats.frames; abs += report.absolute_fallback; wrapped += report.text_wrapped || 0;
    boxNum += report.box_ok.num; boxDen += report.box_ok.den;
    report.warnings.concat(plan.warnings).forEach((wn) => {
      codes[wn.code] = (codes[wn.code] || 0) + 1;
      if (warnings.length < HTML_BRIDGE_MAX_WARNINGS && wn.code !== "absolute") warnings.push(htmlBridgeWarn(wn));
    });
    x += w + 80;
  }
  const out = {
    ok: roots.length === widths.length,
    roots,
    layers: created,
    auto_layout: frames ? Math.round((1000 * al) / frames) / 10 + "% of " + frames + " frames" : "n/a",
    absolute_fallback: abs,
    bound,
    instances: inst,
    text_wrapped: wrapped,
    boxes_within_1px: boxDen ? boxNum + "/" + boxDen : "n/a",
    warning_counts: codes
  };
  if (perRoot.length) out.per_root = perRoot;
  if (warnings.length) out.warnings = warnings;
  return out;
}
