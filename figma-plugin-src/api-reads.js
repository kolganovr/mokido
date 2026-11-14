
function installBridgeReads(api, ctx) {
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
        "await bridge.fromHtml(html, { width: 1440, widths: [1440, 390], height: 900, parent, name, x, y })": "builds a screen from one HTML string (flex -> Auto Layout, text, fills, borders, shadows, svg); the plugin window must be open; returns { roots: [{ id, w, h }], layers, auto_layout, absolute_fallback, boxes_within_1px, warnings }. Prefer the figma_html tool",
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
}
