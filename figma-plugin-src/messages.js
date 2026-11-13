
// Set by the Control tab's Pause button. Gated centrally below rather than in
// each handler, so pausing genuinely stops every write-type message the same
// way instead of needing to be threaded through each one individually.
let executionPaused = false;
const PAUSABLE_TYPES = new Set([
  'EXECUTE', 'INSERT_COMPONENT_INSTANCE', 'INSERT_SVG', 'SET_VARIABLES_MODE'
]);

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'SET_PAUSED') {
    executionPaused = msg.value === true;
    figma.ui.postMessage({ type: 'PAUSED_STATE', paused: executionPaused });
    return;
  }

  if (executionPaused && PAUSABLE_TYPES.has(msg.type || 'EXECUTE')) {
    figma.ui.postMessage({
      type: 'RESULT',
      id: msg.id,
      success: false,
      description: msg.description || 'AI Command',
      error: 'Paused by the user in the Mokido plugin. Ask them to press Resume there.',
      code: 'EXECUTION_PAUSED',
      startTime: msg.startTime
    });
    return;
  }

  if (msg.type === 'JUMP_TO_NODE') {
    try {
      const node = figma.getNodeById(msg.nodeId);
      if (node && 'x' in node) {
        figma.currentPage.selection = [node];
        figma.viewport.scrollAndZoomIntoView([node]);
      }
    } catch (e) {}
    return;
  }

  if (msg.type === 'SET_AUTO_ZOOM') {
    autoZoomEnabled = msg.value === true;
    return;
  }

  if (msg.type === 'SET_SMART_PLACEMENT') {
    smartPlacementEnabled = msg.value === true;
    return;
  }

  if (msg.type === 'RESIZE_WINDOW') {
    figma.ui.resize(msg.width, msg.height);
    return;
  }

  if (msg.type === 'SAVE_SETTINGS') {
    try {
      await figma.clientStorage.setAsync('antigravity_settings', msg.settings);
    } catch (e) {}
    return;
  }

  if (msg.type === 'LOAD_SETTINGS') {
    try {
      const settings = await figma.clientStorage.getAsync('antigravity_settings') || {};
      figma.ui.postMessage({ type: 'SETTINGS_LOADED', settings });
    } catch (e) {
      figma.ui.postMessage({ type: 'SETTINGS_LOADED', settings: {} });
    }
    return;
  }

  // ==========================================
  // 1. Generic JS Sandbox Execution
  // ==========================================
  if (msg.type === 'EXECUTE') {
    const {
      id, code, description, capture, scale = 1, max_px, autoZoom = true, startTime,
      capture_node_ids, diff
    } = msg;
    const actionLabel = description || "AI Command Execution";
    const execStart = Date.now();

    let runningToast = null;
    if (allowCanvasToast()) {
      try { runningToast = figma.notify(`${actionLabel}...`, { timeout: 30000 }); } catch (e) {}
    }

    const logToUi = (text) => {
      figma.ui.postMessage({ type: 'LOG', text: String(text) });
    };

    const notifyCanvas = (text, opts) => {
      try {
        return figma.notify(text, opts);
      } catch (e) {
        return null;
      }
    };

    const reportProgress = (step, of, note) => {
      try {
        figma.ui.postMessage({ type: 'PROGRESS', id, step, of, note: note ? String(note) : undefined, ts: Date.now() });
      } catch (e) {}
    };

    // Every figma.create*() call the sandboxed code makes is journaled here so
    // rollback and the default capture target both know what this call did,
    // without requiring the agent to opt in. See "Checkpoint Journal" above.
    const cp = beginCheckpoint(actionLabel);
    const trackingFigma = createTrackingFigma();

    let beforeShot = null;
    let beforeShotNote = null;
    if (diff === true && Array.isArray(capture_node_ids) && capture_node_ids.length > 0) {
      const before = capture_node_ids.map(nid => figma.getNodeById(nid)).filter(Boolean);
      if (before.length > 0) {
        // The first export of a page Figma has not rendered yet took 45-85 s
        // (bench 15.10): that pushed a trivial write past the escalation limit
        // and cost the agent a figma_job_status turn. The "before" image is a
        // nice-to-have; never let it hold the write.
        const shot = await Promise.race([
          exportCaptureTargets(before, scale, max_px),
          new Promise(resolve => setTimeout(() => resolve(null), BEFORE_SHOT_TIMEOUT_MS))
        ]);
        if (shot && shot.images.length > 0) beforeShot = shot.images[0];
        else if (!shot) beforeShotNote = "diff: the \"before\" screenshot took over " + (BEFORE_SHOT_TIMEOUT_MS / 1000) + " s (Figma still rendering), skipped; the change itself ran.";
      }
    }

    try {
      await ensureFont("Inter", "Regular");
      await ensureFont("Inter", "Medium");
      await ensureFont("Inter", "Bold");

      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
      // No wrapper newline/indent: keeps reported error line numbers aligned
      // with the code the agent actually sent.
      const bridgeApi = createBridgeApi();
      const fn = new AsyncFunction(...EXECUTE_PARAM_NAMES, code);

      const result = await fn(
        trackingFigma, ensureFont, notifyCanvas, logToUi,
        getFreeCanvasPosition, getFreeCanvasPosition, bridgeApi, reportProgress
      );

      const cpResult = cp.commit();

      // The server may shrink an oversized result before it reaches the model;
      // keeping the full value here lets the next call filter it instead of
      // re-running (and re-paying for) the whole traversal.
      BRIDGE_STATE.lastResult = result;

      const selection = figma.currentPage.selection;
      if (selection.length > 0) {
        for (const selNode of selection) {
          if (smartPlacementEnabled && selNode.parent === figma.currentPage && selNode.x === 0 && selNode.y === 0) {
            autoPositionIfColliding(selNode, 80);
          }
        }
        if (autoZoom && autoZoomEnabled) {
          figma.viewport.scrollAndZoomIntoView(selection);
        }
      }

      let screenshot = null;
      let screenshots = null;
      let targetName = null;
      let targetId = null;
      let captureNote = null;

      if (capture) {
        const targets = resolveCaptureTargets(capture_node_ids, cpResult.created, cpResult.modified, selection);
        if (targets.length > 0) {
          const shot = await exportCaptureTargets(targets, scale, max_px);
          targetName = shot.targetName;
          targetId = shot.targetId;
          captureNote = shot.note;
          if (shot.images.length === 1) {
            screenshot = shot.images[0].base64;
          } else if (shot.images.length > 1) {
            screenshots = shot.images.map(img => ({ base64: img.base64, label: img.label }));
          }
        } else {
          // Never auto-export figma.currentPage: on a real file that is the
          // entire canvas, which is both enormous and almost never what the
          // agent meant to look at.
          captureNote =
            "Nothing was created, modified, selected, or passed via capture_node_ids, so no screenshot was taken " +
            "(capturing the whole page is disabled). Pass capture_node_ids, or select a node before returning.";
        }
      }

      const warnings = lintNodes(
        (capture_node_ids || []).map(nid => figma.getNodeById(nid)).filter(Boolean)
          .concat(cpResult.created.map(nid => figma.getNodeById(nid)).filter(Boolean))
          .concat(cpResult.modified.map(nid => figma.getNodeById(nid)).filter(Boolean))
      );

      if (runningToast) runningToast.cancel();
      if (allowCanvasToast()) {
        if (capture && (screenshot || screenshots)) {
          figma.notify(`${actionLabel} + capture sent to AI`, { timeout: 3000 });
        } else {
          figma.notify(`${actionLabel} — done!`, { timeout: 2500 });
        }
      }

      // The mutation already happened, so nothing below may turn into a failure
      // envelope: an untransferable value (figma.mixed, nodes, ...) degrades to a
      // placeholder and the call still reports success.
      let safeResult = result;
      let transferNote = null;
      try {
        safeResult = sanitizeForTransfer(result);
      } catch (sanErr) {
        safeResult = "[unserializable result]";
        transferNote = "Result could not be sanitized: " + ((sanErr && sanErr.message) || String(sanErr));
      }
      const envelope = {
        type: 'RESULT',
        id: id,
        success: true,
        description: actionLabel,
        result: safeResult !== undefined ? safeResult : "Execution finished successfully",
        resultStashed: result !== undefined,
        screenshot: screenshot,
        screenshots: screenshots,
        beforeScreenshot: beforeShot ? beforeShot.base64 : null,
        captureNote: [beforeShotNote, captureNote, transferNote].filter(Boolean).join(' ') || null,
        targetName: targetName,
        targetId: targetId,
        checkpointId: cpResult.checkpoint_id,
        created: cpResult.created,
        modified: cpResult.modified,
        overlays: cpResult.overlays && cpResult.overlays.length ? cpResult.overlays : undefined,
        warnings: warnings,
        durationMs: Date.now() - execStart,
        startTime: startTime
      };
      try {
        figma.ui.postMessage(envelope);
      } catch (postErr) {
        envelope.result = "[unserializable result]";
        envelope.captureNote = [captureNote, `Result could not be transferred (${(postErr && postErr.message) || String(postErr)}); the canvas changes above did apply.`].filter(Boolean).join(' ');
        figma.ui.postMessage(envelope);
      }
    } catch (err) {
      cp.commit(); // whatever WAS created before the throw is still on canvas and rollback-eligible
      if (runningToast) runningToast.cancel();
      const enriched = enrichBridgeError(err);
      try { figma.notify(`Error: ${enriched.message}`, { error: true, timeout: 6000 }); } catch (e) {}

      // Where in the agent's code it failed (best effort — the stack format is engine-dependent).
      let loc = null;
      try {
        const AsyncFn = Object.getPrototypeOf(async function(){}).constructor;
        loc = locateErrorInCode(err && err.stack, code, await getAnonCalibration(AsyncFn));
      } catch (locErr) {}
      const atText = loc ? `\n  at line ${loc.line}: ${loc.at}` : '';

      const failure = {
        type: 'RESULT',
        id: id,
        success: false,
        description: actionLabel,
        error: enriched.hint ? `${enriched.message}${atText}\n\nHINT: ${enriched.hint}` : enriched.message + atText,
        code: enriched.code,
        durationMs: Date.now() - execStart,
        startTime: startTime
      };
      if (loc) { failure.line = loc.line; failure.column = loc.column; failure.at = loc.at; }
      figma.ui.postMessage(failure);
    }
  }

  // ==========================================
  // 2. High-Performance Canvas Screenshot
  // ==========================================
  else if (msg.type === 'SCREENSHOT') {
    const { id, nodeIds, scale = 1, max_px, description = "Screenshot capture", autoZoom = true, startTime } = msg;

    let targets = [];
    if (nodeIds && typeof nodeIds === 'string' && nodeIds.trim().length > 0) {
      const ids = nodeIds.split(',').map(s => s.trim().replace(/-/g, ":"));
      for (const nid of ids) {
        const node = figma.getNodeById(nid);
        if (node) targets.push(node);
      }
    }

    if (targets.length === 0) {
      targets = figma.currentPage.selection.length > 0 ? figma.currentPage.selection : [figma.currentPage];
    }

    if (autoZoom && autoZoomEnabled && targets.length > 0) {
      figma.viewport.scrollAndZoomIntoView(targets);
    }

    figma.notify(`Capturing screenshot (${targets.map(t => t.name).join(', ')})...`, { timeout: 2500 });

    try {
      const screenshots = [];
      for (const target of targets) {
        const shot = await captureSafe(target, scale, max_px);
        screenshots.push({
          id: target.id,
          name: target.name || "Node",
          base64: shot.base64,
          error: shot.error || undefined
        });
      }

      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: true,
        description: description,
        result: `Captured ${screenshots.length} node(s)`,
        screenshots: screenshots,
        startTime: startTime
      });
    } catch (err) {
      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: false,
        description: description,
        error: err.message || String(err),
        startTime: startTime
      });
    }
  }

  // ==========================================
  // 3. Design System: Find Components & Sets
  // ==========================================
  else if (msg.type === 'FIND_COMPONENTS') {
    const { id, query = '', page_name, include_variants = true, limit = 30, refresh_index, startTime } = msg;
    const actionLabel = `Find Components${query ? ` ("${query}")` : ''}`;

    try {
      // Candidate lookup goes through the Component Index (cached, tokenized,
      // ranked) instead of a page.findAll() on every call — see "Component
      // Index" above. Only the small, already-ranked candidate set below still
      // touches the live nodes, to build the exact same variants/properties
      // detail the old implementation returned.
      const candidates = searchComponentIndex(query, {
        pageName: page_name,
        limit: Math.max(limit, 60), // search wider than the final cap so per-candidate detail extraction can still legitimately drop a few (e.g. description-based matches this index doesn't rank) — trimmed to `limit` below
        forceRefresh: refresh_index === true
      });

      const q = query.trim().toLowerCase();
      const results = [];

      for (const entry of candidates) {
        const node = figma.getNodeById(entry.id);
        if (!node) continue; // stale index entry (deleted since last rebuild) — skip rather than error

        const name = node.name || '';
        const desc = node.description || '';
        const isComponentSet = node.type === 'COMPONENT_SET';

        let variantsMap = null;
        let propDefinitions = null;

        if (isComponentSet) {
          variantsMap = {};
          const defs = node.componentPropertyDefinitions || {};
          for (const [pName, def] of Object.entries(defs)) {
            if (def.type === 'VARIANT' && Array.isArray(def.variantOptions)) {
              variantsMap[pName] = def.variantOptions;
            } else {
              if (!propDefinitions) propDefinitions = {};
              propDefinitions[pName] = { type: def.type, defaultValue: def.defaultValue };
            }
          }

          if (Object.keys(variantsMap).length === 0 && node.children) {
            for (const child of node.children) {
              if (child.type === 'COMPONENT' && child.variantProperties) {
                for (const [k, v] of Object.entries(child.variantProperties)) {
                  if (!variantsMap[k]) variantsMap[k] = [];
                  if (!variantsMap[k].includes(v)) variantsMap[k].push(v);
                }
              }
            }
          }
        } else if (node.componentPropertyDefinitions) {
          propDefinitions = {};
          for (const [pName, def] of Object.entries(node.componentPropertyDefinitions)) {
            propDefinitions[pName] = { type: def.type, defaultValue: def.defaultValue };
          }
        }

        // The index already ranked by name/token match; a query can still hit
        // through the description or a variant VALUE the index doesn't see —
        // re-check those here so nothing the old substring search found is lost.
        let matches = true;
        if (q) {
          const inIndex = entry.tokens.some(t => t.indexOf(q) !== -1) || (entry.name || '').toLowerCase().indexOf(q) !== -1;
          const inDesc = desc.toLowerCase().indexOf(q) !== -1;
          let inVariants = false;
          if (variantsMap) {
            for (const [k, vals] of Object.entries(variantsMap)) {
              if (k.toLowerCase().indexOf(q) !== -1 || vals.some(v => String(v).toLowerCase().indexOf(q) !== -1)) {
                inVariants = true;
                break;
              }
            }
          }
          matches = inIndex || inDesc || inVariants;
        }
        if (!matches) continue;

        const item = {
          id: node.id,
          name,
          type: node.type,
          key: node.key,
          page: entry.pageName,
          description: desc || undefined
        };
        if (include_variants && isComponentSet && variantsMap) item.variants = variantsMap;
        if (propDefinitions) item.properties = propDefinitions;

        results.push(item);
        if (results.length >= limit) break;
      }

      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: true,
        description: actionLabel,
        result: results,
        startTime: startTime
      });
    } catch (err) {
      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: false,
        description: actionLabel,
        error: err.message || String(err),
        startTime: startTime
      });
    }
  }

  // ==========================================
  // 4. Design System: Insert Component Instance
  // ==========================================
  else if (msg.type === 'INSERT_COMPONENT_INSTANCE') {
    const {
      id,
      component_name,
      component_id,
      properties = {},
      text_overrides = {},
      target_parent_id,
      position,
      capture = false,
      scale = 1,
      max_px,
      startTime
    } = msg;

    const actionLabel = `Insert Component "${component_name || component_id}"`;
    const cp = beginCheckpoint(actionLabel);
    let runningToast = null;
    if (allowCanvasToast()) {
      try { runningToast = figma.notify(`Inserting component...`, { timeout: 15000 }); } catch (e) {}
    }

    try {
      await ensureFont("Inter", "Regular");
      await ensureFont("Inter", "Medium");
      await ensureFont("Inter", "Bold");

      // Non-fatal problems surfaced in the result instead of vanishing into an
      // empty catch: a "success" response used to look identical whether every
      // requested property/override actually landed or none of them did.
      const propertyWarnings = [];

      // 1. Locate Master Component / Component Set
      let master = null;
      if (component_id) {
        master = figma.getNodeById(component_id.replace(/-/g, ":"));
      }

      if (!master && component_name) {
        const qName = component_name.trim().toLowerCase();
        for (const page of figma.root.children) {
          const candidates = page.findAll(n =>
            (n.type === 'COMPONENT_SET' || n.type === 'COMPONENT') &&
            (n.name.toLowerCase() === qName || n.name.toLowerCase().includes(qName))
          );
          if (candidates.length > 0) {
            // Prioritize exact match, then component sets, then components
            candidates.sort((a, b) => {
              const aExact = a.name.toLowerCase() === qName ? 2 : 0;
              const bExact = b.name.toLowerCase() === qName ? 2 : 0;
              const aSet = a.type === 'COMPONENT_SET' ? 1 : 0;
              const bSet = b.type === 'COMPONENT_SET' ? 1 : 0;
              return (bExact + bSet) - (aExact + aSet);
            });
            master = candidates[0];
            break;
          }
        }
      }

      if (!master) {
        throw new Error(`Component "${component_name || component_id}" was not found in document.`);
      }

      // 2. Resolve Variant and Instantiate
      let instance = null;
      if (master.type === 'COMPONENT') {
        instance = master.createInstance();
      } else if (master.type === 'COMPONENT_SET') {
        let bestChild = null;
        if (properties && Object.keys(properties).length > 0) {
          // Only a key that is an ACTUAL variant property name on this set can
          // decide a match. Component properties (text, boolean, instance-swap)
          // share the same `properties` object but are applied later via
          // instance.setProperties — treating THEM as unmatched variant keys
          // used to make every request with one "match" nothing and silently
          // fall through to master.children[0], the wrong instance.
          const variantKeyNames = new Set();
          for (const child of master.children) {
            if (child.type === 'COMPONENT' && child.variantProperties) {
              Object.keys(child.variantProperties).forEach(k => variantKeyNames.add(k.toLowerCase()));
            }
          }

          for (const child of master.children) {
            if (child.type === 'COMPONENT' && child.variantProperties) {
              let match = true;
              for (const [k, v] of Object.entries(properties)) {
                const kLower = k.toLowerCase();
                if (!variantKeyNames.has(kLower)) continue; // a component property, not a variant axis

                const childValKey = Object.keys(child.variantProperties).find(
                  ck => ck.toLowerCase() === kLower
                );
                // The key IS a variant axis on this set but this child lacks it,
                // or its value differs — either way this child does not match.
                if (!childValKey || String(child.variantProperties[childValKey]).toLowerCase() !== String(v).toLowerCase()) {
                  match = false;
                  break;
                }
              }
              if (match) {
                bestChild = child;
                break;
              }
            }
          }

          if (!bestChild) {
            const requestedAxes = Object.keys(properties).filter(k => variantKeyNames.has(k.toLowerCase()));
            if (requestedAxes.length > 0) {
              throw new Error(
                `No variant of ComponentSet "${master.name}" matches ${JSON.stringify(properties)}. ` +
                `Known variant properties: ${[...variantKeyNames].join(', ') || '(none)'}.`
              );
            }
          }
        }

        if (!bestChild) {
          bestChild = master.defaultVariant || master.children[0];
        }

        if (!bestChild || bestChild.type !== 'COMPONENT') {
          throw new Error(`Failed to resolve valid variant in ComponentSet "${master.name}"`);
        }

        instance = bestChild.createInstance();

        // Apply remaining properties via setProperties. Failures used to be
        // swallowed silently — the agent saw a "success" result with a screenshot
        // of an instance whose requested properties were never actually applied.
        if (properties && Object.keys(properties).length > 0) {
          try {
            instance.setProperties(properties);
          } catch (pe) {
            propertyWarnings.push(`setProperties(${JSON.stringify(properties)}) failed: ${pe.message || pe}`);
          }
        }
      } else {
        throw new Error(`Target node "${master.name}" is of type "${master.type}", not a COMPONENT or COMPONENT_SET.`);
      }
      recordCreated(instance);

      // 3. Apply Text Overrides
      const appliedViaProperty = [];
      if (text_overrides && typeof text_overrides === 'object' && Object.keys(text_overrides).length > 0) {
        // Try Component Property Text Overrides first
        for (const [k, v] of Object.entries(text_overrides)) {
          try {
            instance.setProperties({ [k]: String(v) });
            appliedViaProperty.push(k);
          } catch (e) {}
        }
        // Direct nested text layer traversal for whatever wasn't a component property
        const appliedViaLayer = await applyTextOverrides(instance, text_overrides);
        const requested = Object.keys(text_overrides);
        const applied = new Set([...appliedViaProperty, ...appliedViaLayer]);
        const missed = requested.filter(k => !applied.has(k));
        if (missed.length > 0) {
          propertyWarnings.push(`text_overrides not applied (no matching text layer or property): ${missed.join(', ')}`);
        }
      }

      // 4. Attach to Target Container
      let parent = null;
      if (target_parent_id) {
        parent = figma.getNodeById(target_parent_id.replace(/-/g, ":"));
      }

      if (!parent) {
        const curSel = figma.currentPage.selection;
        if (curSel.length > 0 && curSel[0].type === 'FRAME') {
          parent = curSel[0];
        } else {
          parent = figma.currentPage;
        }
      }

      if (position && typeof position.index === 'number' && parent.insertChild) {
        parent.insertChild(position.index, instance);
      } else {
        parent.appendChild(instance);
      }

      if (position && typeof position.x === 'number' && typeof position.y === 'number') {
        instance.x = position.x;
        instance.y = position.y;
      } else if (parent === figma.currentPage) {
        autoPositionIfColliding(instance, 80);
      }

      // 5. Focus & Selection
      figma.currentPage.selection = [instance];
      if (autoZoomEnabled) {
        figma.viewport.scrollAndZoomIntoView([instance]);
      }

      // 6. Screenshot Capture
      let screenshot = null;
      let captureNote = null;
      if (capture) {
        const shot = await captureSafe(instance, scale, max_px);
        screenshot = shot.base64;
        captureNote = shot.error;
      }

      const cpResult = cp.commit();
      const warnings = lintNodes([instance]).concat(propertyWarnings);

      if (runningToast) runningToast.cancel();
      if (allowCanvasToast()) {
        figma.notify(`Inserted ${instance.name}${capture && screenshot ? ' + capture' : ''}`, { timeout: 3000 });
      }

      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: true,
        description: actionLabel,
        result: {
          instanceId: instance.id,
          name: instance.name,
          masterComponentId: master.id,
          masterName: master.name,
          parentContainer: parent.name || parent.id,
          width: instance.width,
          height: instance.height,
          variantProperties: instance.variantProperties || undefined,
          warnings: propertyWarnings.length > 0 ? propertyWarnings : undefined
        },
        screenshot: screenshot,
        captureNote: captureNote,
        targetName: instance.name,
        targetId: instance.id,
        checkpointId: cpResult.checkpoint_id,
        created: cpResult.created,
        modified: cpResult.modified,
        warnings: warnings,
        startTime: startTime
      });
    } catch (err) {
      cp.commit();
      if (runningToast) runningToast.cancel();
      const enriched = enrichBridgeError(err);
      try { figma.notify(`Error: ${enriched.message}`, { error: true, timeout: 6000 }); } catch (e) {}

      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: false,
        description: actionLabel,
        error: enriched.hint ? `${enriched.message}\n\nHINT: ${enriched.hint}` : enriched.message,
        code: enriched.code,
        startTime: startTime
      });
    }
  }

  // ==========================================
  // 5. Design System: Get Variables & Tokens
  // ==========================================
  else if (msg.type === 'GET_VARIABLES') {
    const { id, collection_name, limit = 300, startTime } = msg;
    const actionLabel = `Get Variables${collection_name ? ` ("${collection_name}")` : ''}`;

    try {
      const collections = await figma.variables.getLocalVariableCollectionsAsync();
      const variables = await figma.variables.getLocalVariablesAsync();

      const qColl = collection_name ? collection_name.trim().toLowerCase() : '';
      const filteredCollections = qColl
        ? collections.filter(c => c.name.toLowerCase() === qColl || c.name.toLowerCase().includes(qColl))
        : collections;

      const collData = [];
      const tokensData = [];
      // Unbounded on a large design-token file (hundreds of tokens x every mode)
      // used to flood the response; cap it like figma_find_components does.
      const maxTokens = typeof limit === 'number' && limit > 0 ? limit : 300;
      let truncated = false;

      outer:
      for (const col of filteredCollections) {
        collData.push({
          id: col.id,
          name: col.name,
          defaultModeId: col.defaultModeId,
          modes: col.modes.map(m => ({ modeId: m.modeId, name: m.name }))
        });

        // Collect variables belonging to this collection
        const colVars = variables.filter(v => v.variableCollectionId === col.id);
        for (const v of colVars) {
          if (tokensData.length >= maxTokens) { truncated = true; break outer; }
          const valuesByMode = {};
          for (const mode of col.modes) {
            valuesByMode[mode.name] = v.valuesByMode[mode.modeId];
          }
          tokensData.push({
            id: v.id,
            name: v.name,
            resolvedType: v.resolvedType,
            collectionName: col.name,
            description: v.description || undefined,
            valuesByMode: valuesByMode
          });
        }
      }

      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: true,
        description: actionLabel,
        result: {
          collections: collData,
          tokens: tokensData,
          truncated: truncated || undefined,
          truncatedNote: truncated
            ? `Showing the first ${maxTokens} tokens. Pass a narrower "collection_name" or a higher "limit" to see more.`
            : undefined
        },
        startTime: startTime
      });
    } catch (err) {
      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: false,
        description: actionLabel,
        error: err.message || String(err),
        startTime: startTime
      });
    }
  }

  // ==========================================
  // 6. Design System: Set Variables Mode
  // ==========================================
  else if (msg.type === 'SET_VARIABLES_MODE') {
    const { id, collection_name, mode_name, target_id, capture = false, scale = 1, max_px, startTime } = msg;
    const actionLabel = `Set Variable Mode "${mode_name}" on "${collection_name}"`;

    try {
      const collections = await figma.variables.getLocalVariableCollectionsAsync();
      const qColl = (collection_name || '').trim().toLowerCase();
      const qMode = (mode_name || '').trim().toLowerCase();

      const col = collections.find(c => c.name.toLowerCase() === qColl || c.name.toLowerCase().includes(qColl));
      if (!col) {
        throw new Error(`Variable collection "${collection_name}" not found.`);
      }

      const targetMode = col.modes.find(m => m.name.toLowerCase() === qMode || m.name.toLowerCase().includes(qMode));
      if (!targetMode) {
        const availableModes = col.modes.map(m => m.name).join(', ');
        throw new Error(`Mode "${mode_name}" not found in collection "${col.name}". Available modes: ${availableModes}`);
      }

      let targetNode = null;
      if (target_id) {
        targetNode = figma.getNodeById(target_id.replace(/-/g, ":"));
      }

      if (!targetNode) {
        const curSel = figma.currentPage.selection;
        targetNode = curSel.length > 0 ? curSel[0] : figma.currentPage;
      }

      targetNode.setExplicitVariableModeForCollection(col, targetMode.modeId);

      let screenshot = null;
      let captureNote = null;
      if (capture) {
        const shot = await captureSafe(targetNode, scale, max_px);
        screenshot = shot.base64;
        captureNote = shot.error;
      }

      figma.notify(`Theme switched to "${targetMode.name}" on ${targetNode.name}`, { timeout: 3000 });

      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: true,
        description: actionLabel,
        result: `Successfully set mode "${targetMode.name}" (${targetMode.modeId}) for collection "${col.name}" on "${targetNode.name}"`,
        screenshot: screenshot,
        captureNote: captureNote,
        targetName: targetNode.name,
        targetId: targetNode.id,
        startTime: startTime
      });
    } catch (err) {
      figma.notify(`Error: ${err.message || String(err)}`, { error: true, timeout: 6000 });

      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: false,
        description: actionLabel,
        error: err.message || String(err),
        startTime: startTime
      });
    }
  }

  // ==========================================
  // 7. Direct SVG & Vector Import
  // ==========================================
  else if (msg.type === 'INSERT_SVG') {
    const {
      id,
      svg_code,
      name,
      width,
      height,
      fill_override,
      stroke_override,
      color_override,
      target_parent_id,
      position,
      as_component = false,
      capture = false,
      scale = 2.0,
      max_px,
      startTime
    } = msg;

    const actionLabel = `Insert SVG "${name || 'Vector'}"`;
    const cp = beginCheckpoint(actionLabel);
    let runningToast = null;
    if (allowCanvasToast()) {
      try { runningToast = figma.notify(`Inserting vector SVG...`, { timeout: 15000 }); } catch (e) {}
    }

    try {
      if (!svg_code || typeof svg_code !== 'string' || !svg_code.includes('<svg')) {
        throw new Error("Invalid or empty svg_code. Must be a valid <svg ...>...</svg> XML string.");
      }

      // 1. Create node from SVG
      const rawNode = figma.createNodeFromSvg(svg_code);
      rawNode.name = name || "SVG Vector";
      recordCreated(rawNode);

      // 2. Proportional Scaling
      const origW = rawNode.width;
      const origH = rawNode.height;
      if ((width && width !== origW) || (height && height !== origH)) {
        const targetW = width || ((origW / origH) * height);
        const targetH = height || ((origH / origW) * width);
        applyScaleConstraints(rawNode);
        rawNode.resize(targetW, targetH);
      }

      // 3. Color Overrides
      const fillColor = parseColor(fill_override);
      const strokeColor = parseColor(stroke_override);
      const universalColor = parseColor(color_override);

      if (fillColor || strokeColor || universalColor) {
        applyVectorColors(rawNode, { fillColor, strokeColor, universalColor });
      }

      // 4. Wrap as Component if requested
      let finalNode = rawNode;
      if (as_component) {
        const comp = figma.createComponent();
        comp.name = name || "Icon / " + (rawNode.name || "Vector");
        comp.resize(rawNode.width, rawNode.height);
        for (const child of [...rawNode.children]) {
          comp.appendChild(child);
        }
        rawNode.remove();
        finalNode = comp;
        recordCreated(finalNode);
      }

      // 5. Attach to Target Container
      let parent = null;
      if (target_parent_id) {
        parent = figma.getNodeById(target_parent_id.replace(/-/g, ":"));
      }

      if (!parent) {
        const curSel = figma.currentPage.selection;
        if (curSel.length > 0 && curSel[0].type === 'FRAME') {
          parent = curSel[0];
        } else {
          parent = figma.currentPage;
        }
      }

      if (position && typeof position.index === 'number' && parent.insertChild) {
        parent.insertChild(position.index, finalNode);
      } else {
        parent.appendChild(finalNode);
      }

      if (position && typeof position.x === 'number' && typeof position.y === 'number') {
        finalNode.x = position.x;
        finalNode.y = position.y;
      } else if (parent === figma.currentPage) {
        autoPositionIfColliding(finalNode, 60);
      }

      // 6. Viewport Focus & Capture
      figma.currentPage.selection = [finalNode];
      if (autoZoomEnabled) {
        figma.viewport.scrollAndZoomIntoView([finalNode]);
      }

      let screenshot = null;
      let captureNote = null;
      if (capture) {
        const shot = await captureSafe(finalNode, scale, max_px);
        screenshot = shot.base64;
        captureNote = shot.error;
      }

      const cpResult = cp.commit();
      const warnings = lintNodes([finalNode]);

      if (runningToast) runningToast.cancel();
      if (allowCanvasToast()) {
        figma.notify(`Vector inserted: ${finalNode.name}${capture && screenshot ? ' + capture' : ''}`, { timeout: 3000 });
      }

      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: true,
        description: actionLabel,
        result: {
          nodeId: finalNode.id,
          name: finalNode.name,
          type: finalNode.type,
          width: finalNode.width,
          height: finalNode.height,
          parentContainer: parent.name || parent.id
        },
        screenshot: screenshot,
        captureNote: captureNote,
        targetName: finalNode.name,
        targetId: finalNode.id,
        checkpointId: cpResult.checkpoint_id,
        created: cpResult.created,
        modified: cpResult.modified,
        warnings: warnings,
        startTime: startTime
      });
    } catch (err) {
      cp.commit();
      if (runningToast) runningToast.cancel();
      const enriched = enrichBridgeError(err);
      try { figma.notify(`Error: ${enriched.message}`, { error: true, timeout: 6000 }); } catch (e) {}

      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: false,
        description: actionLabel,
        error: enriched.hint ? `${enriched.message}\n\nHINT: ${enriched.hint}` : enriched.message,
        code: enriched.code,
        startTime: startTime
      });
    }
  }

  // ==========================================
  // 8. Canvas Layout & Smart Bounds
  // ==========================================
  else if (msg.type === 'GET_CANVAS_LAYOUT') {
    const { id, direction = 'RIGHT', gap = 80, limit = 200, layout, columns, startTime } = msg;
    const actionLabel = "Get Canvas Layout";

    try {
      const page = figma.currentPage;
      const topNodes = page.children.filter(n => n.visible !== false);
      // Bounds are computed over EVERY node so the suggested position stays
      // correct even on a page with hundreds of artboards; only the listing
      // sent back to the model is capped.
      const maxListed = typeof limit === 'number' && limit > 0 ? limit : 200;

      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      const artboards = [];

      for (const n of topNodes) {
        if (n.x < minX) minX = n.x;
        if (n.x + n.width > maxX) maxX = n.x + n.width;
        if (n.y < minY) minY = n.y;
        if (n.y + n.height > maxY) maxY = n.y + n.height;

        if (artboards.length < maxListed) {
          artboards.push({
            id: n.id,
            name: n.name,
            type: n.type,
            x: Math.round(n.x),
            y: Math.round(n.y),
            width: Math.round(n.width),
            height: Math.round(n.height)
          });
        }
      }

      const suggestedPos = getFreeCanvasPosition(400, 800, { direction, gap, layout, columns });

      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: true,
        description: actionLabel,
        result: {
          pageName: page.name,
          totalArtboards: topNodes.length,
          artboards: artboards,
          truncated: topNodes.length > artboards.length || undefined,
          canvasBounds: topNodes.length > 0 ? {
            minX: Math.round(minX),
            maxX: Math.round(maxX),
            minY: Math.round(minY),
            maxY: Math.round(maxY)
          } : null,
          suggestedNextPosition: suggestedPos
        },
        startTime: startTime
      });
    } catch (err) {
      figma.ui.postMessage({
        type: 'RESULT',
        id: id,
        success: false,
        description: actionLabel,
        error: err.message || String(err),
        startTime: startTime
      });
    }
  }

  // ==========================================
  // 9. Read Canvas — live-document optimizer input (figma_read_canvas)
  // ==========================================
  else if (msg.type === 'READ_CANVAS') {
    const { id, node_ids, depth, include_hidden, startTime } = msg;
    const actionLabel = "Read Canvas";

    try {
      const result = readCanvasTree({
        node_ids: node_ids ? String(node_ids).split(',').map(s => s.trim()).filter(Boolean) : null,
        depth,
        include_hidden
      });
      figma.ui.postMessage({ type: 'RESULT', id, success: true, description: actionLabel, result, startTime });
    } catch (err) {
      const enriched = enrichBridgeError(err);
      figma.ui.postMessage({
        type: 'RESULT', id, success: false, description: actionLabel,
        error: enriched.hint ? `${enriched.message}\n\nHINT: ${enriched.hint}` : enriched.message,
        code: enriched.code,
        startTime
      });
    }
  }

  // ==========================================
  // 10. Checkpoint Journal — rollback & listing (figma_rollback)
  // ==========================================
  else if (msg.type === 'ROLLBACK') {
    const { id, checkpoint_id, startTime } = msg;
    const actionLabel = `Rollback ${checkpoint_id || 'last'}`;

    try {
      const result = rollbackCheckpoint(checkpoint_id || 'last');
      if (autoZoomEnabled) {
        try {
          const restoredNodes = result.restored.map(nid => figma.getNodeById(nid)).filter(Boolean);
          if (restoredNodes.length > 0) figma.viewport.scrollAndZoomIntoView(restoredNodes);
        } catch (e) {}
      }
      figma.notify(`Rolled back "${result.label}" (${result.removed.length} removed, ${result.restored.length} restored)`, { timeout: 3500 });
      figma.ui.postMessage({ type: 'RESULT', id, success: true, description: actionLabel, result, startTime });
    } catch (err) {
      figma.ui.postMessage({
        type: 'RESULT', id, success: false, description: actionLabel,
        error: err.message || String(err), startTime
      });
    }
  }

  else if (msg.type === 'LIST_CHECKPOINTS') {
    const { id, startTime } = msg;
    try {
      const result = createBridgeApi().checkpoints();
      figma.ui.postMessage({ type: 'RESULT', id, success: true, description: "List Checkpoints", result, startTime });
    } catch (err) {
      figma.ui.postMessage({ type: 'RESULT', id, success: false, description: "List Checkpoints", error: err.message || String(err), startTime });
    }
  }

  // ==========================================
  // 11. Target Router — document identity, requested by the UI so it can
  //     report fileKey/fileName/pageName/pluginVersion on CLIENT_READY /
  //     CLIENT_FOCUS. figma.* is only reachable from this sandbox, not ui.html.
  // ==========================================
  else if (msg.type === 'GET_DOC_INFO') {
    try {
      figma.ui.postMessage({
        type: 'DOC_INFO',
        fileKey: (typeof figma.fileKey !== 'undefined' ? figma.fileKey : null),
        fileName: figma.root.name,
        pageName: figma.currentPage.name,
        pageId: figma.currentPage.id
      });
    } catch (e) {}
  }
};

// Keep the UI's document-identity payload (used for Target Router focus
// routing) fresh across page switches without waiting for a poll.
if (typeof figma.on === 'function') {
  try {
    figma.on('currentpagechange', () => {
      figma.ui.postMessage({ type: 'PAGE_CHANGED', pageName: figma.currentPage.name, pageId: figma.currentPage.id });
    });
  } catch (e) {}
}
