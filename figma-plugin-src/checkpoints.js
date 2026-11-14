
// --- Checkpoint Journal state ----------------------------------------------
const CHECKPOINTS = [];   // in-memory only — cleared on plugin reload, see api.info().checkpoints
const CHECKPOINTS_MAX = 50; // bound memory on a long-running session
let activeCheckpoint = null;
let checkpointSeq = 0;

function beginCheckpoint(label) {
  ensureCloneTrackingInstalled();
  checkpointSeq += 1;
  const cp = {
    id: "cp_" + Date.now().toString(36) + "_" + checkpointSeq,
    label: label || "Unlabeled action",
    createdAt: Date.now(),
    created: [],     // node ids, in creation order
    modified: [],    // [{ id, ...snapshotted props }]
    committed: false,
    rolledBack: false
  };
  CHECKPOINTS.push(cp);
  if (CHECKPOINTS.length > CHECKPOINTS_MAX) CHECKPOINTS.shift();
  activeCheckpoint = cp;
  return {
    id: cp.id,
    commit() {
      cp.committed = true;
      if (activeCheckpoint === cp) activeCheckpoint = null;
      // A read journals nothing: drop it, so reads neither push real write
      // checkpoints out of the 50-slot ring nor become rollback "last".
      if (cp.created.length === 0 && cp.modified.length === 0) {
        const at = CHECKPOINTS.indexOf(cp);
        if (at !== -1) CHECKPOINTS.splice(at, 1);
        return { checkpoint_id: null, created: [], modified: [] };
      }
      return { checkpoint_id: cp.id, created: cp.created.slice(), modified: cp.modified.map(m => m.id), overlays: (cp.overlays || []).slice() };
    }
  };
}

function snapshotNodeProps(node) {
  const snap = { id: node.id };
  try {
    if ("x" in node) snap.x = node.x;
    if ("y" in node) snap.y = node.y;
    if ("width" in node && "height" in node && typeof node.resize === "function") {
      snap.width = node.width;
      snap.height = node.height;
    }
    if ("fills" in node && node.fills !== figma.mixed) snap.fills = JSON.parse(JSON.stringify(node.fills));
    if (node.type === "TEXT" && "characters" in node) snap.characters = node.characters;
    if ("opacity" in node) snap.opacity = node.opacity;
    if ("visible" in node) snap.visible = node.visible;
    if ("cornerRadius" in node && node.cornerRadius !== figma.mixed) snap.cornerRadius = node.cornerRadius;
    if (Array.isArray(node.reactions)) snap.reactions = JSON.parse(JSON.stringify(node.reactions));
    if ("overlayPositionType" in node) {
      snap.overlayPositionType = node.overlayPositionType;
      snap.overlayBackground = JSON.parse(JSON.stringify(node.overlayBackground || { type: "NONE" }));
      snap.overlayBackgroundInteraction = node.overlayBackgroundInteraction;
    }
  } catch (e) {
    // A property that refuses to read (mixed values, locked nodes) just means
    // less gets restored for that node — never fails the checkpoint itself.
  }
  return snap;
}

// For the plugin's OWN write handlers (insert_component_instance, insert_svg —
// they build nodes directly rather than through the tracked sandbox Proxy) to
// register what they made with whatever checkpoint the caller opened around them.
function recordCreated(node) {
  if (activeCheckpoint && node && node.id) activeCheckpoint.created.push(node.id);
  return node;
}

function trackModification(node) {
  if (!activeCheckpoint || !node || !node.id) return node;
  if (activeCheckpoint.modified.some(m => m.id === node.id)) return node; // first snapshot wins per checkpoint
  activeCheckpoint.modified.push(snapshotNodeProps(node));
  return node;
}

function restoreNodeProps(node, snap) {
  try {
    if ("width" in snap && "height" in snap && typeof node.resize === "function") node.resize(snap.width, snap.height);
    if ("x" in snap) node.x = snap.x;
    if ("y" in snap) node.y = snap.y;
    if ("fills" in snap) node.fills = snap.fills;
    if ("characters" in snap && node.type === "TEXT") node.characters = snap.characters; // best-effort: font may need reloading
    if ("opacity" in snap) node.opacity = snap.opacity;
    if ("visible" in snap) node.visible = snap.visible;
    if ("cornerRadius" in snap) node.cornerRadius = snap.cornerRadius;
    if ("reactions" in snap) node.reactions = snap.reactions;
    if ("overlayPositionType" in snap) {
      // Read-only in the Plugin API: try each, never let it abort the restore.
      for (const k of ["overlayPositionType", "overlayBackground", "overlayBackgroundInteraction"]) {
        try { if (JSON.stringify(node[k]) !== JSON.stringify(snap[k])) node[k] = snap[k]; } catch (e) {}
      }
    }
  } catch (e) {
    // Best-effort restore — a single unrestorable property must not abort the rest of the rollback.
  }
}

function rollbackCheckpoint(id) {
  const cp = id === "last"
    ? CHECKPOINTS.slice().reverse().find(c => c.committed && !c.rolledBack)
    : CHECKPOINTS.find(c => c.id === id);

  if (!cp) {
    throw new Error(
      `No rollback-eligible checkpoint found for "${id}". Use bridge.checkpoints() to list committed checkpoints.`
    );
  }
  if (cp.rolledBack) {
    throw new Error(`Checkpoint "${cp.id}" ("${cp.label}") was already rolled back.`);
  }

  const removed = [];
  const restored = [];
  const missing = [];

  // Undo creations. Order doesn't matter for correctness — node.remove() takes
  // its whole subtree with it, so removing a still-present descendant after its
  // ancestor was already removed is simply a no-op via the getNodeById miss.
  for (let i = cp.created.length - 1; i >= 0; i--) {
    const node = figma.getNodeById(cp.created[i]);
    if (node && typeof node.remove === "function") {
      try { node.remove(); removed.push(cp.created[i]); } catch (e) { missing.push(cp.created[i]); }
    }
  }

  for (const snap of cp.modified) {
    const node = figma.getNodeById(snap.id);
    if (node) { restoreNodeProps(node, snap); restored.push(snap.id); }
    else missing.push(snap.id);
  }

  cp.rolledBack = true;
  return { checkpoint_id: cp.id, label: cp.label, removed, restored, missing };
}

// Node-creating methods worth auto-tracking. Kept to an explicit allowlist
// rather than "every function on figma" so this Proxy changes behaviour for
// nothing except "a checkpoint is open and you made a new node."
const TRACKED_CREATORS = new Set([
  "createFrame", "createRectangle", "createEllipse", "createPolygon", "createStar",
  "createVector", "createText", "createLine", "createComponent", "createComponentFromNode",
  "createNodeFromSvg", "createBooleanOperation", "createSlice", "createConnector",
  "createSticky", "createShapeWithText", "createPage",
  // Combinators — each takes existing nodes and returns ONE new node (GROUP,
  // BOOLEAN_OPERATION, or COMPONENT_SET) that owns them from then on. Missing
  // these meant grouping/flattening/boolean-op'ing during a checkpoint looked
  // like it created nothing, so rollback had nothing to remove.
  "group", "flatten", "union", "subtract", "intersect", "exclude", "combineAsVariants"
]);

// clone() and createInstance() are METHODS ON A NODE, not on `figma` itself —
// "duplicate this template" and "instantiate that component" (the two most
// common ways AI-authored figma_execute_code actually "creates a card") both
// go through here, completely bypassing createTrackingFigma's wrapper above,
// which only ever sees figma.create*() factory calls. A checkpoint around
// either pattern silently recorded nothing, so Undo Last AI Action ran and
// reported "removed 0, restored 0" even though a node was genuinely added.
//
// Node prototypes are shared per node type for the whole plugin session, so
// patching a type's prototype once — reached via a throwaway node created
// and removed before any real checkpoint exists — makes clone()/
// createInstance() traceable everywhere afterward, regardless of how the
// caller obtained the node reference (getNodeById, findOne, selection, ...).
const PATCHED_CLONE_PROTOS = new WeakSet();
function patchCreationMethodsOnPrototype(node) {
  if (!node) return;
  const proto = Object.getPrototypeOf(node);
  if (!proto || PATCHED_CLONE_PROTOS.has(proto)) return;
  PATCHED_CLONE_PROTOS.add(proto);

  for (const methodName of ["clone", "createInstance"]) {
    const original = proto[methodName];
    if (typeof original !== "function") continue;
    proto[methodName] = function (...args) {
      const result = original.apply(this, args);
      if (activeCheckpoint && result && typeof result === "object" && typeof result.id === "string") {
        activeCheckpoint.created.push(result.id);
      }
      return result;
    };
  }
}

let cloneTrackingInstalled = false;
function ensureCloneTrackingInstalled() {
  if (cloneTrackingInstalled) return;
  cloneTrackingInstalled = true;

  // Runs with no checkpoint open (this is called once, before the first ever
  // beginCheckpoint()), so nothing here is journaled — each throwaway node
  // exists only long enough to read+patch its prototype, then is removed
  // immediately. Each factory is independent: one missing/renamed method on
  // a future Plugin API must not stop the others from getting patched.
  const makeAndPatch = (factory) => {
    let node = null;
    try {
      node = factory();
      patchCreationMethodsOnPrototype(node);
    } catch (e) {
      // best-effort — a Plugin API surface change here must never block real checkpoints
    } finally {
      try { if (node && !node.removed) node.remove(); } catch (e) {}
    }
    return node;
  };

  makeAndPatch(() => figma.createRectangle());
  makeAndPatch(() => figma.createEllipse());
  makeAndPatch(() => figma.createText());
  makeAndPatch(() => figma.createVector());
  makeAndPatch(() => figma.createLine());
  makeAndPatch(() => figma.createStar());
  makeAndPatch(() => figma.createPolygon());

  // Frame, component and instance are handled by hand: the instance needs a
  // live (not-yet-removed) component to instantiate from, and the group
  // needs a live rectangle to hold — makeAndPatch's immediate-removal
  // wouldn't leave either in a usable state for the next step.
  let frame = null, component = null, instance = null, rectForGroup = null, group = null;
  try {
    frame = figma.createFrame();
    patchCreationMethodsOnPrototype(frame);

    component = figma.createComponent();
    patchCreationMethodsOnPrototype(component);

    instance = component.createInstance();
    patchCreationMethodsOnPrototype(instance);

    rectForGroup = figma.createRectangle();
    group = figma.group([rectForGroup], figma.currentPage);
    patchCreationMethodsOnPrototype(group);
  } catch (e) {
    // best-effort — see above
  } finally {
    try { if (frame && !frame.removed) frame.remove(); } catch (e) {}
    try { if (instance && !instance.removed) instance.remove(); } catch (e) {}
    try { if (component && !component.removed) component.remove(); } catch (e) {}
    // group.remove() also removes rectForGroup, which it still owns.
    try { if (group && !group.removed) group.remove(); } catch (e) {}
  }
}

// Wraps creator functions during an open checkpoint so creations are journaled,
// while all property lookups (currentPage, viewport, root, etc.) delegate
// cleanly through the prototype chain to `figma` without triggering ES6 Proxy
// get-trap invariant violations on native host objects.
function createTrackingFigma() {
  try {
    const tracking = Object.create(figma);
    for (const name of TRACKED_CREATORS) {
      if (typeof figma[name] === "function") {
        tracking[name] = function (...args) {
          const result = figma[name].apply(figma, args);
          if (activeCheckpoint && result && typeof result === "object" && typeof result.id === "string") {
            activeCheckpoint.created.push(result.id);
          }
          return result;
        };
      }
    }
    // Direct loadFontAsync calls from the script share loadFontOnce: same
    // timeout, same bookkeeping. A wrong argument fails at once.
    if (typeof loadFontOnce === "function") tracking.loadFontAsync = async function (font) {
      if (!font || typeof font.family !== "string" || typeof font.style !== "string") {
        throw new Error("FONT_BAD_ARGS: loadFontAsync expects { family: string, style: string }");
      }
      await loadFontOnce(font);
    };
    return tracking;
  } catch (e) {
    return figma;
  }
}
