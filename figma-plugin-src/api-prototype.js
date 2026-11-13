
function installBridgePrototype(api, ctx) {
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
}
