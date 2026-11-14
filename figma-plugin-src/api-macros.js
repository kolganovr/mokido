
function installBridgeMacros(api, ctx) {
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

  // HTML -> Auto Layout frame in one call (T-077). The window lays the HTML out, html-map/html-build make the nodes.
  api.fromHtml = function (html, opts) {
    return htmlBridgeFromHtml(html, opts);
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
}
