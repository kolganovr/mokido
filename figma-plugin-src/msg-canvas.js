async function onGetCanvasLayout(msg) {
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

async function onReadCanvas(msg) {
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

async function onRollback(msg) {
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
