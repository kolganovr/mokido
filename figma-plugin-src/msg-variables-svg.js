async function onGetVariables(msg) {
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

async function onSetVariablesMode(msg) {
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

async function onInsertSvg(msg) {
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
