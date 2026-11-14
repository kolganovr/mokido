
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

  if (msg.type === 'HTML_TREE') {
    htmlBridgeOnTree(msg);
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
    await onExecute(msg);
  }

  // ==========================================
  // 2. High-Performance Canvas Screenshot
  // ==========================================
  else if (msg.type === 'SCREENSHOT') {
    await onScreenshot(msg);
  }

  // ==========================================
  // 3. Design System: Find Components & Sets
  // ==========================================
  else if (msg.type === 'FIND_COMPONENTS') {
    await onFindComponents(msg);
  }

  // ==========================================
  // 4. Design System: Insert Component Instance
  // ==========================================
  else if (msg.type === 'INSERT_COMPONENT_INSTANCE') {
    await onInsertComponentInstance(msg);
  }

  // ==========================================
  // 5. Design System: Get Variables & Tokens
  // ==========================================
  else if (msg.type === 'GET_VARIABLES') {
    await onGetVariables(msg);
  }

  // ==========================================
  // 6. Design System: Set Variables Mode
  // ==========================================
  else if (msg.type === 'SET_VARIABLES_MODE') {
    await onSetVariablesMode(msg);
  }

  // ==========================================
  // 7. Direct SVG & Vector Import
  // ==========================================
  else if (msg.type === 'INSERT_SVG') {
    await onInsertSvg(msg);
  }

  // ==========================================
  // 8. Canvas Layout & Smart Bounds
  // ==========================================
  else if (msg.type === 'GET_CANVAS_LAYOUT') {
    await onGetCanvasLayout(msg);
  }

  // ==========================================
  // 9. Read Canvas — live-document optimizer input (figma_read_canvas)
  // ==========================================
  else if (msg.type === 'READ_CANVAS') {
    await onReadCanvas(msg);
  }

  // ==========================================
  // 10. Checkpoint Journal — rollback & listing (figma_rollback)
  // ==========================================
  else if (msg.type === 'ROLLBACK') {
    await onRollback(msg);
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
