async function onExecute(msg) {
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

async function onScreenshot(msg) {
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
