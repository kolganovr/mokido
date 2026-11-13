
function createBridgeApi() {
  const api = {};
  let proxy = null;   // the object handed out; module sources get it too

  // --- ephemeral scratch: survives calls, dies on plugin reload ------------
  api.state = BRIDGE_STATE;

  // --- durable key/value stored inside the .fig document -------------------
  api.store = {
    set(key, value) {
      bridgeWrite("kv:" + key, JSON.stringify(value === undefined ? null : value));
      bridgeIndexAdd("kv", key);
      return value;
    },
    get(key, fallback) {
      const raw = bridgeRead("kv:" + key);
      if (!raw) return fallback;
      try { return JSON.parse(raw); } catch (e) { return fallback; }
    },
    remove(key) {
      bridgeWrite("kv:" + key, "");
      bridgeIndexRemove("kv", key);
    },
    keys() { return bridgeIndex("kv"); }
  };

  // --- reusable code modules ----------------------------------------------
  api.define = function (name, source) {
    const exported = bridgeCompile(name, source, proxy || api);   // fail fast before saving
    bridgeWrite("mod:" + name, source);
    bridgeIndexAdd("mod", name);
    return exported;
  };

  api.require = function (name) {
    if (BRIDGE_MODULES[name]) return BRIDGE_MODULES[name];
    const source = bridgeRead("mod:" + name);
    if (!source) {
      throw new Error(
        "Module \"" + name + "\" is not defined. Available: [" + api.list().join(", ") + "]. " +
        "Create it with bridge.define(\"" + name + "\", \"...source ending in module.exports = {...}...\")."
      );
    }
    return bridgeCompile(name, source, proxy || api);
  };

  api.list = function () {
    const saved = bridgeIndex("mod");
    Object.keys(BRIDGE_MODULES).forEach(n => { if (saved.indexOf(n) === -1) saved.push(n); });
    return saved;
  };

  api.source = function (name) { return bridgeRead("mod:" + name); };

  api.remove = function (name) {
    delete BRIDGE_MODULES[name];
    bridgeWrite("mod:" + name, "");
    bridgeIndexRemove("mod", name);
  };

  // --- platform workarounds ------------------------------------------------
  // figma.createComponentFromNode() can force every AutoLayout frame in the
  // subtree to FIXED sizing at whatever size it happened to have mid-convert.
  // Node ids change during conversion, so positions in the tree map them back.
  api.componentize = function (node) {
    const saved = [];
    (function walk(n, path) {
      if ("layoutMode" in n && n.layoutMode !== "NONE") {
        saved.push({ path: path.slice(), p: n.primaryAxisSizingMode, c: n.counterAxisSizingMode });
      }
      if ("children" in n) n.children.forEach((ch, i) => walk(ch, path.concat(i)));
    })(node, []);

    const comp = figma.createComponentFromNode(node);

    for (const s of saved) {
      let n = comp;
      for (let i = 0; i < s.path.length && n; i++) n = n.children ? n.children[s.path[i]] : null;
      if (!n || !("layoutMode" in n)) continue;
      if (s.p) n.primaryAxisSizingMode = s.p;
      if (s.c) n.counterAxisSizingMode = s.c;
    }
    if ("resize" in comp) comp.resize(comp.width, comp.height); // force relayout
    return comp;
  };

  // Figma forbids overriding relative-transform inside an INSTANCE. Fail with
  // the actual remedy instead of the raw platform error.
  api.setPosition = function (node, x, y) {
    let p = node.parent;
    while (p) {
      if (p.type === "INSTANCE") {
        throw new Error(
          "Cannot set x/y on \"" + node.name + "\": it lives inside INSTANCE \"" + p.name +
          "\" and relative-transform cannot be overridden there. Position it through layout instead — " +
          "itemSpacing / primaryAxisAlignItems / counterAxisAlignItems on the parent AutoLayout, or " +
          "layoutPositioning = \"ABSOLUTE\" plus constraints set on the MASTER COMPONENT, not the instance."
        );
      }
      p = p.parent;
    }
    node.x = x; node.y = y;
    return node;
  };

  // --- write macros ---------------------------------------------------------
  // Set component properties by readable name: "Label" matches "Label#12:3"
  // (case-insensitive), INSTANCE_SWAP takes a component node or id.
  api.setProps = function (instance, props) {
    const inst = readNode(instance);
    if (!inst || inst.type !== "INSTANCE") {
      throw new Error("bridge.setProps: expected an INSTANCE, got " + (inst ? inst.type + " \"" + inst.name + "\"" : String(instance)));
    }
    const current = inst.componentProperties || {};
    const keys = Object.keys(current);
    const norm = s => propBaseName(s).trim().toLowerCase();
    const patch = {};
    Object.keys(props || {}).forEach(name => {
      let key = keys.indexOf(name) !== -1 ? name : null;
      if (!key) {
        const want = norm(name);
        key = keys.find(k => norm(k) === want) || null;
      }
      if (!key) {
        throw new Error(
          "bridge.setProps: instance \"" + inst.name + "\" has no property \"" + name + "\". Available: " +
          (describeInstanceProps(inst) || "none")
        );
      }
      let val = props[name];
      if (current[key].type === "INSTANCE_SWAP" && val !== null && val !== undefined) {
        try { val = resolveComponent(val, "setProps").id; } catch (e) { /* raw id of a not-yet-imported component */ }
      }
      patch[key] = val;
    });
    if (Object.keys(patch).length) {
      trackModification(inst);
      inst.setProperties(patch);
    }
    return inst;
  };

  // Sets text by layer id or exact layer name under root (or root itself).
  // Async: every font used by a node is loaded first. Nothing is written unless
  // every key resolved.
  api.setText = async function (root, map) {
    const r = macroNodes(root, "setText")[0];
    if (typeof map === "string") {
      if (r.type !== "TEXT") throw new Error("bridge.setText(node, \"string\"): \"" + r.name + "\" is a " + r.type + ", not a TEXT layer. For layers inside it: bridge.setText(root, { layerNameOrId: \"text\" })");
      map = { [r.id]: map };
    }
    const texts = (r.type === "TEXT" ? [r] : []).concat(scanNodes(r, ["TEXT"]));
    const plan = [];
    Object.keys(map || {}).forEach(key => {
      const id = key.replace(/-/g, ":");
      let hits = texts.filter(t => t.id === id);
      if (hits.length === 0) hits = texts.filter(t => t.name === key);
      if (hits.length === 0) {
        const names = texts.slice(0, 20).map(t => JSON.stringify(t.name) + " #" + t.id).join(", ");
        throw new Error(
          "bridge.setText: no TEXT layer \"" + key + "\" under \"" + r.name + "\". Text layers: " +
          (names || "none") + (texts.length > 20 ? ", … +" + (texts.length - 20) + " more" : "")
        );
      }
      hits.forEach(t => plan.push({ node: t, value: String(map[key]) }));
    });
    const set = [];
    for (const step of plan) {
      await setTextKeepingFonts(step.node, step.value);
      set.push(step.node.id);
    }
    return { set: set };
  };

  // Swap a placeholder for a real component instance in the same slot.
  api.replaceWithInstance = async function (target, component, opts) {
    const o = opts || {};
    const keepSize = o.keepSize === true;
    const remove = o.remove !== false;
    const t = macroNodes(target, "replaceWithInstance")[0];
    const host = insideInstance(t);
    if (host) {
      throw new Error(
        "bridge.replaceWithInstance: \"" + t.name + "\" lives inside INSTANCE \"" + host.name +
        "\" and cannot be replaced there. Edit the master component, or use bridge.setProps / bridge.setText on the instance."
      );
    }
    const parent = t.parent;
    if (!parent || typeof parent.insertChild !== "function") {
      throw new Error("bridge.replaceWithInstance: \"" + t.name + "\" has no parent that can hold an instance");
    }
    const inst = resolveComponent(component, "replaceWithInstance").createInstance();
    try {
      parent.insertChild(parent.children.indexOf(t), inst);
      const attempt = fn => { try { fn(); } catch (e) { /* property not applicable to this pair */ } };
      if (hasAutoLayout(parent)) {
        ["layoutSizingHorizontal", "layoutSizingVertical", "layoutAlign", "layoutGrow", "layoutPositioning"].forEach(k => {
          if (k in t && k in inst) attempt(() => { inst[k] = t[k]; });
        });
        if (t.layoutPositioning === "ABSOLUTE") attempt(() => { inst.x = t.x; inst.y = t.y; });
      } else {
        attempt(() => { inst.x = t.x; inst.y = t.y; });
      }
      if (keepSize) inst.resize(t.width, t.height);
      if (o.props) api.setProps(inst, o.props);
      if (o.text) await api.setText(inst, o.text);
    } catch (e) {
      try { inst.remove(); } catch (e2) {}
      throw e;
    }
    if (remove) t.remove();
    return inst;
  };

  api.shift = function (nodesOrIds, opts) {
    const o = opts || {};
    const dx = Number(o.dx) || 0;
    const dy = Number(o.dy) || 0;
    const nodes = macroNodes(nodesOrIds, "shift");
    nodes.forEach(n => {
      trackModification(n);
      api.setPosition(n, n.x + dx, n.y + dy);
    });
    return nodes.length;
  };

  // Reparent into container. layout "none" keeps each node where it was on the
  // canvas; "row"/"column" lay them out one after another from `padding`.
  api.moveInto = function (nodesOrIds, container, opts) {
    const o = opts || {};
    const layout = o.layout || "none";
    const gap = Number.isFinite(o.gap) ? o.gap : 100;
    const padding = Number.isFinite(o.padding) ? o.padding : 0;
    if (["none", "row", "column"].indexOf(layout) === -1) {
      throw new Error("bridge.moveInto: layout must be \"none\", \"row\" or \"column\", got " + JSON.stringify(layout));
    }
    const nodes = macroNodes(nodesOrIds, "moveInto");
    const box = macroNodes(container, "moveInto")[0];
    if (typeof box.appendChild !== "function") throw new Error("bridge.moveInto: " + box.type + " \"" + box.name + "\" cannot hold children");
    const flow = hasAutoLayout(box);
    let cursor = padding;
    nodes.forEach(n => {
      trackModification(n);
      const before = n.absoluteTransform;
      box.appendChild(n);
      if (flow) return;                       // AutoLayout places it itself
      if (layout === "none") {
        const after = n.absoluteTransform;
        if (before && after) {
          n.x += before[0][2] - after[0][2];
          n.y += before[1][2] - after[1][2];
        }
      } else if (layout === "row") {
        n.x = cursor; n.y = padding;
        cursor += n.width + gap;
      } else {
        n.x = padding; n.y = cursor;
        cursor += n.height + gap;
      }
    });
    return nodes.map(n => n.id);
  };

  // Size a SECTION/FRAME to its children's bbox + padding without moving anything
  // on the canvas: the container shifts, the children shift back.
  api.fitSection = function (section, opts) {
    const padding = opts && Number.isFinite(opts.padding) ? opts.padding : 100;
    const box = macroNodes(section, "fitSection")[0];
    if (["SECTION", "FRAME", "COMPONENT"].indexOf(box.type) === -1) {
      throw new Error("bridge.fitSection: expected SECTION or FRAME, got " + box.type + " \"" + box.name + "\"");
    }
    const kids = (box.children || []).slice();
    if (kids.length === 0) return box;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    kids.forEach(k => {
      minX = Math.min(minX, k.x); minY = Math.min(minY, k.y);
      maxX = Math.max(maxX, k.x + k.width); maxY = Math.max(maxY, k.y + k.height);
    });
    const shiftX = padding - minX;
    const shiftY = padding - minY;
    trackModification(box);
    kids.forEach(k => trackModification(k));
    if (shiftX !== 0 || shiftY !== 0) {
      box.x -= shiftX; box.y -= shiftY;
      kids.forEach(k => { k.x += shiftX; k.y += shiftY; });
    }
    const w = Math.max(1, maxX - minX + 2 * padding);
    const h = Math.max(1, maxY - minY + 2 * padding);
    // SECTION only has resizeWithoutConstraints; for a FRAME it is also the safe
    // choice (plain resize() would re-apply children's constraints and shift them).
    if (typeof box.resizeWithoutConstraints === "function") box.resizeWithoutConstraints(w, h);
    else box.resize(w, h);
    return box;
  };

  // --- prototype reactions -------------------------------------------------
  // Figma's reactions validator answers a wrong shape with a union error of
  // several KB. These build the one valid shape. Overlay look (position, dim,
  // click outside) lives on the overlay FRAME, never on the action, and the
  // Plugin API exposes it read-only.
  const REACTION_DIRECTIONAL = ["MOVE_IN", "MOVE_OUT", "PUSH", "SLIDE_IN", "SLIDE_OUT"];
  const REACTION_SIMPLE = ["DISSOLVE", "SMART_ANIMATE", "SCROLL_ANIMATE"];
  const REACTION_NAV = ["NAVIGATE", "SWAP", "OVERLAY", "SCROLL_TO", "CHANGE_TO"];
  const OVERLAY_POSITIONS = ["CENTER", "TOP_LEFT", "TOP_CENTER", "TOP_RIGHT", "BOTTOM_LEFT", "BOTTOM_CENTER", "BOTTOM_RIGHT", "MANUAL"];

  // null | "DISSOLVE" | "MOVE_IN/BOTTOM" | "PUSH/LEFT/0.4" | { type, direction, duration, easing } -> Transition | null
  function reactionTransition(t, who) {
    if (t === undefined || t === null || t === false || t === "INSTANT") return null;
    let o = t;
    if (typeof t === "string") {
      const parts = t.split("/");
      o = { type: parts[0].toUpperCase() };
      if (parts[1]) { if (isNaN(Number(parts[1]))) o.direction = parts[1].toUpperCase(); else o.duration = Number(parts[1]); }
      if (parts[2]) o.duration = Number(parts[2]);
    }
    const type = String(o.type || "").toUpperCase();
    const easing = o.easing ? (typeof o.easing === "string" ? { type: o.easing } : o.easing) : { type: "EASE_OUT" };
    const duration = Number.isFinite(o.duration) ? o.duration : 0.3;
    if (REACTION_DIRECTIONAL.indexOf(type) !== -1) {
      if (["LEFT", "RIGHT", "TOP", "BOTTOM"].indexOf(o.direction) === -1) {
        throw new Error("bridge." + who + ": transition " + type + " needs direction LEFT | RIGHT | TOP | BOTTOM, e.g. \"" + type + "/BOTTOM\"");
      }
      return { type: type, direction: o.direction, matchLayers: o.matchLayers === true, easing: easing, duration: duration };
    }
    if (REACTION_SIMPLE.indexOf(type) !== -1) return { type: type, easing: easing, duration: duration };
    throw new Error("bridge." + who + ": transition type \"" + o.type + "\" is not one of " + REACTION_DIRECTIONAL.concat(REACTION_SIMPLE).join(", ") + " (null = instant)");
  }

  function reactionTrigger(t, o, who) {
    const spec = typeof t === "string" ? { type: t } : (t || {});
    const type = String(spec.type || "ON_CLICK").toUpperCase();
    if (type === "AFTER_TIMEOUT") return { type: type, timeout: Number.isFinite(spec.timeout) ? spec.timeout : (Number.isFinite(o.timeout) ? o.timeout : 0.8) };
    if (["MOUSE_ENTER", "MOUSE_LEAVE", "MOUSE_UP", "MOUSE_DOWN"].indexOf(type) !== -1) return { type: type, delay: Number.isFinite(spec.delay) ? spec.delay : (Number.isFinite(o.delay) ? o.delay : 0) };
    if (type === "ON_KEY_DOWN") return { type: type, device: spec.device || "KEYBOARD", keyCodes: spec.keyCodes || o.keys || [] };
    if (["ON_CLICK", "ON_HOVER", "ON_PRESS", "ON_DRAG"].indexOf(type) === -1) {
      throw new Error("bridge." + who + ": trigger \"" + type + "\" is not one of ON_CLICK, ON_HOVER, ON_PRESS, ON_DRAG, AFTER_TIMEOUT, MOUSE_ENTER, MOUSE_LEAVE, MOUSE_UP, MOUSE_DOWN, ON_KEY_DOWN");
    }
    return { type: type };
  }

  // opts: trigger ("ON_CLICK"), to (id | node), nav ("NAVIGATE" | "SWAP" | "OVERLAY" | "SCROLL_TO" | "CHANGE_TO"),
  // transition, action ("BACK" | "CLOSE" | { type: "URL", url }), replace ("trigger" | "all" | "none").
  api.setReaction = async function (node, opts) {
    const o = opts || {};
    const n = macroNodes(node, "setReaction")[0];
    if (!Array.isArray(n.reactions)) throw new Error("bridge.setReaction: " + n.type + " \"" + n.name + "\" cannot have prototype reactions");
    const trigger = reactionTrigger(o.trigger, o, "setReaction");
    let action;
    if (o.action) {
      if (o.action === "BACK" || o.action === "CLOSE") action = { type: o.action };
      else if (o.action && o.action.type === "URL") action = { type: "URL", url: o.action.url, openInNewTab: o.action.openInNewTab !== false };
      else if (o.action && typeof o.action === "object") action = o.action;
      else throw new Error("bridge.setReaction: action must be \"BACK\", \"CLOSE\" or { type: \"URL\", url }; for a screen / overlay target use to + nav");
    } else {
      if (!o.to) throw new Error("bridge.setReaction: give `to` (target frame id or node) with nav, or `action`: \"BACK\" | \"CLOSE\"");
      const dest = macroNodes(o.to, "setReaction")[0];
      const nav = String(o.nav || "NAVIGATE").toUpperCase();
      if (REACTION_NAV.indexOf(nav) === -1) throw new Error("bridge.setReaction: nav \"" + o.nav + "\" is not one of " + REACTION_NAV.join(", "));
      action = { type: "NODE", destinationId: dest.id, navigation: nav, transition: reactionTransition(o.transition, "setReaction"), resetVideoPosition: false };
    }
    const keep = o.replace === "all" ? [] : (o.replace === "none" ? n.reactions.slice() : n.reactions.filter(r => !(r && r.trigger && r.trigger.type === trigger.type)));
    trackModification(n);
    const next = keep.concat([{ trigger: trigger, actions: [action] }]);
    if (typeof n.setReactionsAsync === "function") await n.setReactionsAsync(next); else n.reactions = next;
    return "#" + n.id + " " + trigger.type + " → " + (action.type === "NODE" ? action.navigation + " #" + action.destinationId : action.type);
  };

  // Overlay = a reaction on `node` plus the overlay look on the overlay FRAME.
  // opts: trigger, position (OVERLAY_POSITIONS, default CENTER), dim (true | alpha 0..1 | "#000000@0.4" | false),
  // closeOnOutside (true), transition (default: slides in from the nearest edge, DISSOLVE for CENTER).
  api.openOverlay = async function (node, overlay, opts) {
    const o = opts || {};
    const target = macroNodes(overlay, "openOverlay")[0];
    const trig = macroNodes(node, "openOverlay")[0];
    if (!("overlayPositionType" in target)) {
      throw new Error("bridge.openOverlay: " + target.type + " \"" + target.name + "\" cannot be an overlay: use a top-level FRAME");
    }
    const position = String(o.position || "CENTER").toUpperCase();
    if (OVERLAY_POSITIONS.indexOf(position) === -1) throw new Error("bridge.openOverlay: position must be one of " + OVERLAY_POSITIONS.join(", "));
    let bg = { type: "NONE" };
    if (o.dim !== undefined && o.dim !== false && o.dim !== null) {
      let color = { r: 0, g: 0, b: 0, a: 0.4 };
      if (typeof o.dim === "number") color.a = o.dim;
      else if (typeof o.dim === "string") {
        const m = /^#?([0-9a-f]{6})(?:@([\d.]+))?$/i.exec(o.dim.trim());
        if (!m) throw new Error("bridge.openOverlay: dim must be true, an alpha 0..1, or \"#000000@0.4\"");
        color = { r: parseInt(m[1].slice(0, 2), 16) / 255, g: parseInt(m[1].slice(2, 4), 16) / 255, b: parseInt(m[1].slice(4, 6), 16) / 255, a: m[2] ? Number(m[2]) : 1 };
      }
      bg = { type: "SOLID_COLOR", color: color };
    }
    let transition = o.transition;
    if (transition === undefined) transition = position.indexOf("BOTTOM") === 0 ? "MOVE_IN/BOTTOM" : position.indexOf("TOP") === 0 ? "MOVE_IN/TOP" : "DISSOLVE";
    const res = await api.setReaction(node, { trigger: o.trigger, to: target, nav: "OVERLAY", transition: transition, replace: o.replace });
    // The overlay look lives on the FRAME and the Plugin API exposes it read-only
    // ("no setter for property", bench T3 15.10): the link is set, the look is a
    // manual step for the user. Say so in the result instead of throwing, so the
    // agent reports it rather than probing the API for a setter.
    const want = { overlayPositionType: position, overlayBackground: bg, overlayBackgroundInteraction: o.closeOnOutside === false ? "NONE" : "CLOSE_ON_CLICK_OUTSIDE" };
    const manual = [];
    trackModification(target);
    for (const k of Object.keys(want)) {
      if (JSON.stringify(target[k]) === JSON.stringify(want[k])) continue;
      try { target[k] = want[k]; } catch (e) { manual.push(k); continue; }
      if (JSON.stringify(target[k]) !== JSON.stringify(want[k])) manual.push(k);
    }
    const look = position + ", dim " + (bg.type === "NONE" ? "none" : readHex(bg.color, bg.color.a)) + ", click outside " + (want.overlayBackgroundInteraction === "NONE" ? "does nothing" : "closes");
    // The server builds `done` and its overlay registry from this, not from the
    // script's text or the order of `modified` (review 4.2.7 #45 #46).
    if (activeCheckpoint) (activeCheckpoint.overlays = activeCheckpoint.overlays || []).push({ trigger: trig.id, overlay: target.id, manual: manual.length > 0 });
    if (!manual.length) return res + " (" + look + ")";
    return res + ". MANUAL STEP for the user: the Plugin API cannot set the overlay look (read-only), so in Figma select frame \"" + target.name +
      "\" > Prototype panel > Overlay and set: " + look + ". Do not search for another way; tell the user.";
  };

  // CLOSE action on `node` (a close button / scrim inside an overlay).
  api.closeOverlay = async function (node, opts) {
    const o = opts || {};
    return api.setReaction(node, { trigger: o.trigger, action: "CLOSE", replace: o.replace });
  };

  // --- cheap reads: facts as short text / flat maps instead of raw dumps ----
  api.summarize = function (refs, opts) { return summarizeNodes(refs, opts); };
  api.inspect = function (refs, props) { return inspectNodes(refs, props); };
  api.find = function (query, opts) { return findNodes(query, opts); };
  api.check = function (specs, opts) { return checkNodes(specs, opts); };
  api.compare = function (ref, targets, opts) { return compareNodes(ref, targets, opts); };
  api.like = function (refs, roots, opts) { return likeNodes(refs, roots, opts); };
  api.hex = function (color, opacity) { return readHex(color, opacity); };
  api.context = function (ref) {
    const n = readNode(ref);
    if (!n) throw new Error("bridge.context: node " + ref + " does not exist");
    return contextOf(n, api.store.get("conventions", null));
  };

  // --- self-description, so an agent can ask instead of guessing -----------
  api.info = function () {
    return {
      executionModel:
        "Each figma_execute_code call runs as a fresh async function body. Top-level " +
        "const/let/var/function declarations do NOT survive into the next call. " +
        "Top-level await and return are supported; import/export are not.",
      evalWarning:
        "eval() is a bound function in the Figma sandbox, so every eval is an INDIRECT eval: " +
        "it cannot read the caller's locals and its declarations vanish. Never build helpers " +
        "with eval — use bridge.define / bridge.require.",
      persistence: {
        "bridge.state": "in-memory object, survives calls, cleared on plugin reload",
        "bridge.store": "JSON key/value inside the .fig document, survives everything. Key \"conventions\": breakpoints, working section, grid steps — write it once, bridge.context() returns it",
        "bridge.define/require": "reusable code modules stored in the document",
        "globalThis": "shared and persists between calls, but prefer bridge.state"
      },
      checkpoints:
        "bridge.checkpoint(label) opens a rollback journal; every figma.create*() call made " +
        "while it is open is recorded automatically. bridge.snapshot(node) records an existing " +
        "node's common properties (x, y, size, fills, characters, opacity, visible) before you " +
        "mutate it. cp.commit() closes it; bridge.rollback(id | \"last\") undoes creations and " +
        "restores snapshotted properties. Deletions are never recoverable. The journal lives in " +
        "memory only — it is cleared when the plugin reloads.",
      cheapReads: {
        "bridge.summarize(idOrNode | ids, { depth: 2, maxChildren: 15, text: 40, view })":
          "indented outline, one line per node: TYPE \"name\" #id WxH @x,y [V gap8 pad16 fill/hug a:start/center] size:fill/hug abs fill:#FFF stroke:#E8EAF0/0,1,1,1 r0,0,3,3 shadow:0,4/20 #000@0.1 font \"text…\" (non-defaults only; children:N = more below the depth); view:\"map\" = only TYPE \"name\" #id WxH @x,y children:N (cheapest page overview); view:\"table\" = per table: columns (header, width, sizing, cell contents) + row/cell ids; view:\"flow\" = prototype links under the ids: screen, source, trigger, action, target, transition + the overlay settings of overlay targets",
        "bridge.context(idOrNode)":
          "{ node, ancestors, siblings: [{w,n}], pageWidths: top-6 frame widths (breakpoints), components: [{ set, used, props }] used inside the node, conventions } — read this before building next to existing design",
        "bridge.inspect(ids, [props])":
          "{ id: { prop: value } | \"MISSING\" }; props also accept fill, stroke, text, font, layout, padding, parent, children, main, variant, props, absolute, reactions (prototype links as short strings), connector ({ start, end } ids)",
        "bridge.find(query | RegExp, { root, type, limit: 20, text })": "[{ id, name, type }] by name under root (default: current page); text:true searches TEXT characters and returns [{ id, name, type, text, frame }]",
        "bridge.compare(refId, targetIds, { depth: 8 })":
          "text diff of each target against the reference, children matched by name: layout, align, sizing, fill, stroke (+per-side weights), radius, effects, clip, font, component/variant; geometry and text content are skipped. \"identical\" when done — use it to verify a \"make these like that one\" change",
        "bridge.like(refIds, rootIds, { limit: 30 })":
          "finds every copy of each reference under rootIds (default: the reference's top section) — instances of the same component set, or same type+name, or same child names — and compares each with it: per copy its frame and diffs, repeated diff sets collapsed, identical copies on one line",
        "bridge.check(specs, { tolerance: 0.5 })":
          "specs { id: { width: 320, fill: \"#FFFFFF\", text: /Submit/, layout: \"V gap8 pad16\" } } -> { pass, fail: [{ id, key, want, got }], missing }",
        "bridge.state.lastResult": "full value of the previous call's return, even when the server shrank what you saw"
      },
      macros: {
        "bridge.setProps(instance, { Name: value })": "sets component properties by readable name (\"Label\" matches \"Label#12:3\", case-insensitive); INSTANCE_SWAP takes a component node or id; unknown name -> error listing the real properties and variants; returns the instance",
        "await bridge.setText(root, { layerNameOrId: \"text\" })": "loads every font of the node, sets characters on TEXT layers found by id or exact name under root; unknown layer -> error listing text layers; returns { set: [ids] }. Use it to replace text instead of `characters =`: it KEEPS font styles by words - font, size, colour, decoration, letter spacing (first word keeps its style, the tail from the first space keeps its own; with more styles word by word, extra words take the last). Also bridge.setText(textNodeOrId, \"new text\") for one TEXT node",
        "await bridge.replaceWithInstance(target, component, { props, text, keepSize: false, remove: true })": "puts an instance of COMPONENT / COMPONENT_SET (default variant) / INSTANCE / id into target's slot (same index, position or AutoLayout sizing), applies props/text, removes target; returns the instance",
        "bridge.shift(nodesOrIds, { dx: 0, dy: 0 })": "moves nodes by an offset; returns the count",
        "bridge.moveInto(nodesOrIds, container, { layout: \"none\" | \"row\" | \"column\", gap: 100, padding: 0 })": "reparents nodes; none keeps their canvas position, row/column lays them out; returns ids",
        "bridge.fitSection(section, { padding: 100 })": "resizes a SECTION/FRAME to its children's bbox + padding, children keep their canvas position; returns the section",
        "await bridge.setReaction(node, { trigger: 'ON_CLICK', to: frameId, nav: 'NAVIGATE', transition: 'MOVE_IN/LEFT' })": "adds one prototype link (replaces a reaction with the same trigger; replace: 'all' | 'none'); action: 'BACK' | 'CLOSE' | { type: 'URL', url } instead of to/nav; transition null = instant, 'DISSOLVE', 'SMART_ANIMATE', 'PUSH/LEFT/0.4' or { type, direction, duration, easing }; returns a summary line",
        "await bridge.openOverlay(node, overlayFrame, { position: 'BOTTOM_CENTER', dim: 0.4, closeOnOutside: true })": "link that opens overlayFrame over the screen; transition defaults to sliding in from the edge. The overlay look (position, dim, click outside) is READ-ONLY in the Plugin API: the result says which part is a MANUAL STEP for the user (Prototype panel) - report it, do not probe the API",
        "await bridge.closeOverlay(node)": "CLOSE action on a node inside an overlay",
        "bridge.componentize(node)": "figma.createComponentFromNode that keeps AutoLayout sizing and resize behaviour; use it instead of createComponentFromNode",
        "note": "existing nodes these change are snapshotted into the open checkpoint; an unknown bridge.<name> throws with the list of real helpers"
      },
      reactions: {
        read: "figma_inspect { node_ids: [section or screens], view: 'flow' } = every prototype link (source, trigger, action, target, transition) + overlay settings, one call. Never findAll over the page for reactions.",
        write: "bridge.setReaction / openOverlay / closeOverlay build the valid shape. Raw form: node.reactions = [{ trigger, actions: [action] }] (setReactionsAsync in dynamic-page files); the key is `actions` (array), legacy `action` is read-only.",
        trigger: "{ type: 'ON_CLICK' | 'ON_HOVER' | 'ON_PRESS' | 'ON_DRAG' } | { type: 'AFTER_TIMEOUT', timeout: seconds } | { type: 'MOUSE_ENTER' | 'MOUSE_LEAVE' | 'MOUSE_UP' | 'MOUSE_DOWN', delay } | { type: 'ON_KEY_DOWN', device, keyCodes }",
        action: "{ type: 'NODE', destinationId, navigation: 'NAVIGATE' | 'SWAP' | 'OVERLAY' | 'SCROLL_TO' | 'CHANGE_TO', transition: Transition | null, resetVideoPosition: false } | { type: 'BACK' } | { type: 'CLOSE' } | { type: 'URL', url, openInNewTab } | { type: 'SET_VARIABLE', variableId, variableValue } | { type: 'SET_VARIABLE_MODE', ... } | { type: 'CONDITIONAL', conditionalBlocks }. NODE needs `transition` present (null = instant) and no other keys.",
        transition: "{ type: 'DISSOLVE' | 'SMART_ANIMATE' | 'SCROLL_ANIMATE', easing: { type: 'EASE_OUT' }, duration: 0.3 } | { type: 'MOVE_IN' | 'MOVE_OUT' | 'PUSH' | 'SLIDE_IN' | 'SLIDE_OUT', direction: 'LEFT' | 'RIGHT' | 'TOP' | 'BOTTOM', matchLayers: false, easing, duration } (duration in seconds)",
        overlayLook: "overlayPositionType ('CENTER' | 'TOP_LEFT' | 'TOP_CENTER' | 'TOP_RIGHT' | 'BOTTOM_LEFT' | 'BOTTOM_CENTER' | 'BOTTOM_RIGHT' | 'MANUAL'), overlayBackground ({ type: 'NONE' } | { type: 'SOLID_COLOR', color: { r, g, b, a } }), overlayBackgroundInteraction ('NONE' | 'CLOSE_ON_CLICK_OUTSIDE') are properties of the overlay FRAME (the navigation target), NOT keys of the action: putting them in the action fails with 'Unrecognized key(s)'."
      },
      injected: ["figma", "ensureFont", "bridge", "getFreePosition", "notify", "log", "progress"],
      modules: api.list(),
      storeKeys: api.store.keys(),
      checkpointCount: CHECKPOINTS.length,
      editorType: figma.editorType,
      pluginApiVersion: typeof figma.apiVersion !== "undefined" ? figma.apiVersion : "n/a"
    };
  };

  // ==========================================================================
  // Checkpoint Journal — best-effort undo for what an agent just did.
  // --------------------------------------------------------------------------
  // The Plugin API has no programmatic undo, so this journal tracks it by
  // construction instead of trying to snapshot the whole document (which would
  // be both slow and huge on a real file):
  //   - CREATED nodes are caught automatically: while a checkpoint is open, the
  //     `figma` reference handed to the sandbox is a thin Proxy that records the
  //     id of anything returned by figma.create*() / createNodeFromSvg() /
  //     createComponentFromNode(). Rollback removes them.
  //   - MODIFIED nodes are only tracked when something explicitly calls
  //     bridge.snapshot(node) before mutating it (the bridge's own tool handlers
  //     — insert_component_instance, insert_svg, set_variables_mode — do this on
  //     the nodes they touch). Rollback restores the snapshotted properties.
  //   - REMOVED nodes are never recoverable and are not tracked; there is
  //     nothing to roll back to.
  // This covers "the agent generated junk and I want it gone" and "the agent
  // reskinned an existing node and broke it" — the two cases that actually come
  // up — without pretending to be a full undo stack.
  // ==========================================================================
  api.checkpoint = function (label) {
    return beginCheckpoint(label);
  };

  api.rollback = function (id) {
    return rollbackCheckpoint(id);
  };

  api.checkpoints = function () {
    return CHECKPOINTS.map(cp => ({
      id: cp.id,
      label: cp.label,
      createdAt: cp.createdAt,
      created: cp.created.length,
      modified: cp.modified.length,
      committed: cp.committed,
      rolledBack: !!cp.rolledBack
    }));
  };

  api.snapshot = function (node) {
    return trackModification(node);
  };

  // Reading a helper that does not exist used to yield undefined and a cryptic
  // "bridge.foo is not a function" one line later. Fail at the call instead,
  // naming what does exist. Symbols and probe keys used by promises/serializers
  // must stay undefined or awaiting/serializing the bridge would break.
  proxy = new Proxy(api, {
    get(target, key, receiver) {
      if (typeof key !== "string" || key in target || BRIDGE_PROBE_KEYS.indexOf(key) !== -1) {
        return Reflect.get(target, key, receiver);
      }
      return function () {
        throw new Error("bridge." + key + " does not exist. Available: " + Object.keys(target).sort().join(", "));
      };
    }
  });
  return proxy;
}
