const { NODE_READ_RE, WHAT_YOU_GET, CAPS_NOTE, classifyScript, suggestInspect, RUN_ANYWAY_RE, pageWideScan, PAGE_SCAN_NOTE } = require("./classify");
const { toJson } = require("./hints");
const { OVERLAY_LOOK_WRITE_RE, RAW_OVERLAY_RE, linkedOverlay, overlayCall } = require("./overlay");

const READ_STATE = { streak: 0, redirects: 0, total: 0, lastIds: [], lastArgs: null, capsShown: false };

// ------------------------------------------------------------------
// Macro guard (bench H3, 15.10). In bench T3 every run spent 3-4 model turns
// learning how to call bridge.openOverlay (bridge.info(), typeof, .toString()
// of the macro = 3 KB of source), and a failed run set the read-only
// overlayPositionType by hand five times. The server answers a look at a
// macro with its call shape, and refuses a hand-written overlay before it runs.
// ------------------------------------------------------------------
const MACRO_SIGNATURES = {
  openOverlay: "await bridge.openOverlay(triggerId, overlayFrameId, { position: 'BOTTOM_CENTER', dim: 0.4, closeOnOutside: true }) - prototype link that opens the overlay frame (transition slides in from the edge). position: CENTER | TOP_LEFT | TOP_CENTER | TOP_RIGHT | BOTTOM_LEFT | BOTTOM_CENTER | BOTTOM_RIGHT; dim: alpha 0..1 or '#000000@0.4'. The overlay look is read-only in the Plugin API: the reply says which part is a MANUAL STEP for the user - report it, don't look for a setter.",
  closeOverlay: "await bridge.closeOverlay(nodeId) - CLOSE action on a node inside an overlay.",
  setReaction: "await bridge.setReaction(nodeId, { trigger: 'ON_CLICK', to: frameId, nav: 'NAVIGATE', transition: 'MOVE_IN/LEFT' }) - one prototype link (replaces the one with the same trigger); action: 'BACK' | 'CLOSE' | { type: 'URL', url } instead of to/nav.",
  // bench H4: T4 read typeof + .toString() of componentize before using it.
  componentize: "bridge.componentize(node) -> the new COMPONENT (sync; pass the node object, e.g. await figma.getNodeByIdAsync(id)). Same name, size, position, look and AutoLayout sizing; the id CHANGES. Many at once: const out = []; for (const id of ids) out.push(bridge.componentize(await figma.getNodeByIdAsync(id)).id); return out;",
  setProps: "bridge.setProps(instance, { Name: value }) - component properties by readable name ('Label' matches 'Label#12:3'); INSTANCE_SWAP takes a component node or id; returns the instance.",
  setText: "await bridge.setText(root, { layerNameOrId: 'text' }) or bridge.setText(textNodeOrId, 'text') - loads all fonts and sets TEXT layers found by id or exact name under root, KEEPING font styles by words - font, size, colour, decoration, letter spacing (first word keeps its style, the tail from the first space keeps its own; more styles: word by word, extra words take the last). Replace text with it, never with `characters =` (that flattens mixed fonts) or a per-character getRangeFontName loop. Returns { set: [ids] }.",
  replaceWithInstance: "await bridge.replaceWithInstance(target, component, { props, text, keepSize: false, remove: true }) - instance of a COMPONENT / COMPONENT_SET / id in target's slot; returns the instance.",
  shift: "bridge.shift(nodesOrIds, { dx: 0, dy: 0 }) - moves nodes by an offset; returns the count.",
  moveInto: "bridge.moveInto(nodesOrIds, container, { layout: 'none' | 'row' | 'column', gap: 100, padding: 0 }) - reparents nodes; returns ids.",
  fitSection: "bridge.fitSection(section, { padding: 100 }) - resizes a SECTION/FRAME to its children + padding; returns the section.",
  setPosition: "bridge.setPosition(node, x, y) - sets x/y, or explains why not (inside an INSTANCE: use AutoLayout)."
};

const MACRO_PEEK_RE = /bridge\s*\.\s*(\w+)\s*\.\s*toString\s*\(|String\s*\(\s*bridge\s*\.\s*(\w+)\s*\)|typeof\s+bridge\s*\.\s*(\w+)|Object\s*\.\s*(?:keys|getOwnPropertyNames)\s*\(\s*bridge\s*\)/g;

// -> null (run the script) | { type: "peek" | "overlay", body }
// file: the document the script would run in (callFile), null = unknown.
function macroGuard(code, file) {
  if (typeof code !== "string" || RUN_ANYWAY_RE.test(code)) return null;
  if (!/bridge\s*\.\s*openOverlay\s*\(/.test(code) && (OVERLAY_LOOK_WRITE_RE.test(code) || RAW_OVERLAY_RE.test(code))) {
    const look = OVERLAY_LOOK_WRITE_RE.test(code);
    const linked = look ? (suggestInspect(code).node_ids || []).map(id => linkedOverlay(file, id)).find(Boolean) : null;
    if (linked) {
      return {
        type: "overlay",
        body: {
          ok: false, code: "OVERLAY_ALREADY_LINKED", not_run: true,
          done: linked.manual === false
            ? `Already done: bridge.openOverlay linked #${linked.trigger} → overlay #${linked.overlay} and set its look. Nothing left to do: answer now.`
            : `Already done: bridge.openOverlay linked #${linked.trigger} → overlay #${linked.overlay}. Its look is read-only for scripts (no setter anywhere): this is the MANUAL STEP. Answer now: tell the user to select frame #${linked.overlay} > Prototype panel > Overlay and set position, background and click-outside there.`
        }
      };
    }
    return {
      type: "overlay",
      body: {
        ok: false, code: "USE_OPEN_OVERLAY",
        error: "Not run. " + (look
          ? "overlayPositionType / overlayBackground / overlayBackgroundInteraction are READ-ONLY in the Plugin API (no setter), there is no other way to set them."
          : "A hand-built OVERLAY reaction misses the overlay look and is easy to get wrong (`actions` array, `transition` key).") +
          " If bridge.openOverlay already ran and said MANUAL STEP, the task is done: tell the user that step and stop. Otherwise one call makes the link and tries the look; its reply names what the user must set by hand (MANUAL STEP). Swap the ids if the order is wrong. A script that is not this: add /* run-anyway */.",
        use_instead: overlayCall(code, file)
      }
    };
  }
  // A look at a macro (its source, its type, the key list): nothing on the
  // canvas is read, so answer here with how to call it.
  if (classifyScript(code, null) === "write" || NODE_READ_RE.test(code)) return null;
  const names = [];
  let all = false, m;
  MACRO_PEEK_RE.lastIndex = 0;
  while ((m = MACRO_PEEK_RE.exec(code))) {
    const name = m[1] || m[2] || m[3];
    if (name) { if (names.indexOf(name) === -1) names.push(name); } else all = true;
  }
  const known = names.filter(n => MACRO_SIGNATURES[n]);
  if (!known.length && !(all && names.length === 0)) return null;
  const pick = known.length ? known : Object.keys(MACRO_SIGNATURES);
  const signatures = {};
  for (const n of pick) signatures[n] = MACRO_SIGNATURES[n];
  return {
    type: "peek",
    body: {
      ok: true, not_run: true,
      note: "Answered by the server without running the script: how to call " + pick.map(n => "bridge." + n).join(", ") + ". Call it directly in the write; don't read its source." + (all ? " `return bridge.info()` lists every helper." : ""),
      signatures
    }
  };
}

// -> null (run the script) | { type: "heavy" | "redirect" | "refuse", args, call, n }
function readGuard(code) {
  if (typeof code !== "string" || RUN_ANYWAY_RE.test(code)) return null;
  const kind = classifyScript(code, null);
  if (kind !== "read" && kind !== "stash") return null;
  const heavy = pageWideScan(code);
  if (heavy) {
    const ids = suggestInspect(code, READ_STATE.lastIds);
    const args = heavy === "reactions"
      ? (ids.node_ids ? { node_ids: ids.node_ids, view: "flow" } : { view: "flow" })
      : (ids.find || ids.node_ids ? ids : { view: "map" });
    return { type: "heavy", args, call: "figma_inspect " + JSON.stringify(args), reason: heavy, n: READ_STATE.streak };
  }
  if (!(READ_STATE.streak >= 1)) return null;
  const args = kind === "stash" ? READ_STATE.lastArgs : suggestInspect(code, READ_STATE.lastIds);
  if (!args) return null;
  READ_STATE.streak += 1;
  READ_STATE.total += 1;
  const first = !(READ_STATE.redirects > 0);
  READ_STATE.redirects = (READ_STATE.redirects || 0) + 1;
  return { type: first ? "redirect" : "refuse", args, call: "figma_inspect " + JSON.stringify(args), n: READ_STATE.streak };
}

function guardRefusal(guard) {
  const body = guard.type === "heavy"
    ? { ok: false, code: "PAGE_SCAN_BLOCKED", error: "Not run. " + PAGE_SCAN_NOTE, use_instead: guard.call + (guard.reason === "reactions" ? " — pick the section id from a view:\"map\" call if you don't have it" : "") }
    : {
        ok: false, code: "READ_REFUSED",
        error: `Not run: hand-written read #${guard.n} in a row, and no result comes back for those. Call ${guard.call} (long replies page with offset=K), or make the whole change in ONE figma_execute_code. A script that is not a read: add the comment /* run-anyway */.`,
        use_instead: guard.call
      };
  return { isError: true, content: [{ type: "text", text: toJson(body) }] };
}

// The `use_instead` field for a hand-written read, or null.
function readNudge(code, response) {
  const kind = classifyScript(code, response);
  if (kind !== "read" && kind !== "stash") {
    if (kind === "write") resetReadStreak();
    return null;
  }
  READ_STATE.streak += 1;
  READ_STATE.total += 1;
  // Slicing lastResult re-reads what the previous walk returned: suggest the
  // call that replaces THAT walk.
  const args = kind === "stash" && READ_STATE.lastArgs
    ? READ_STATE.lastArgs
    : suggestInspect(code, READ_STATE.lastIds);
  if (kind === "read" && args.node_ids) { READ_STATE.lastIds = args.node_ids; READ_STATE.lastArgs = args; }
  const call = "figma_inspect " + JSON.stringify(args);
  const n = READ_STATE.streak;
  let text = kind === "stash"
    ? `${call} — slicing bridge.state.lastResult costs a model turn per slice; this returns the tree as an outline, paged with offset=K.`
    : `${call} — reads the same nodes in ONE call (${WHAT_YOU_GET[args.view || (args.props ? "props" : "outline")]}), every id at once; a long reply pages with offset=K.`;
  text += ` Hand-written read #${n} in a row: each is a full model turn that re-sends the whole conversation.`;
  if (n >= 3) text += " Next: one figma_inspect for everything still unknown, then ONE figma_execute_code that makes the whole change and returns only ids/flags.";
  if (!READ_STATE.capsShown) {
    READ_STATE.capsShown = true;
    text += " " + CAPS_NOTE;
  }
  return text;
}

function resetReadStreak() {
  READ_STATE.streak = 0;
  READ_STATE.redirects = 0;
}

module.exports = { READ_STATE, macroGuard, readGuard, guardRefusal, readNudge, resetReadStreak };
