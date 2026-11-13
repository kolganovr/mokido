async function onFindComponents(msg) {
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

async function onInsertComponentInstance(msg) {
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
