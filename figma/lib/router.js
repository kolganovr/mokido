const { optimizeFigmaData } = require("../optimizer");
const { TIMEOUTS, ECONOMY } = require("./config");
const { parseFigmaUrlOrKey, figmaApiRequest } = require("./rest");
const { normalizeNodeIds, toJson } = require("./hints");
const { DIFF_OFF_NOTE, shieldParams, withFontMemo, stripFontMemo } = require("./script-prep");
const { state } = require("./state");
const { readJobSnapshot, takeLate, errorLocation } = require("./jobs");
const { attachLate, noteIssued, jobStatusError, jobStatusSnap } = require("./late");
const { listTargets, sendCommandToPlugin, proxyToMaster } = require("./dispatch");
const { budgetOptions, similarHint } = require("./budget");
const { collectImages, renderPluginResponse, captureOptions, buildErrorEnvelope, checkAgentSyntax, applyLineOffset, jsonResult, applyTokenBudget, budgetBytesFromTokens } = require("./result");
const { buildInspectCode } = require("./inspect-code");
const { SLOW_CALL_HINT, rewriteComponentize, fontLoadLint } = require("./classify");
const { OVERLAY_LINKED, linkedOverlay, unlinkCheckpoint, callFile, OVERLAY_HEADER_RE, OVERLAY_HEADER_DONE } = require("./overlay");
const { macroGuard, readGuard, guardRefusal, resetReadStreak } = require("./guards");
const { postWrite } = require("./post-write");

async function routeTool(name, args = {}) {
  try {
    switch (name) {
      case "figma_execute_code": {
        const desc = args.description || "Execute JS Code";
        const capture = args.capture === true;
        const wantsAsync = args.async === true;
        const normalizedCaptureIds = normalizeNodeIds(args.capture_node_ids);

        // A syntax error costs a plugin round trip and comes back without a
        // line number: catch it here (throws SCRIPT_SYNTAX_ERROR + line/at).
        checkAgentSyntax(args.code);

        const rewrite = rewriteComponentize(args.code);
        const code = rewrite.code;
        const macro = macroGuard(code, callFile(args.target));
        if (macro) return { isError: macro.type === "overlay", content: [{ type: "text", text: toJson(macro.body) }] };
        const guard = readGuard(code);
        if (guard && guard.type === "heavy") return guardRefusal(guard);
        if (guard && guard.type === "refuse") return guardRefusal(guard);
        if (guard) {
          // 2nd read in a row: answer with what figma_inspect returns for it.
          const inspected = await sendCommandToPlugin({
            code: buildInspectCode({ ...guard.args, target: args.target }),
            description: "Inspect",
            target: args.target
          }, TIMEOUTS.normal);
          return renderPluginResponse(
            { result: applyLineOffset(inspected.result, guard.args.offset), resultStashed: inspected.resultStashed },
            null,
            {
              ...budgetOptions(args),
              lead: { redirected: `Hand-written read #${guard.n} in a row: your script was NOT run; below is ${guard.call}, which reads the same nodes. Read with figma_inspect (offset=K pages); use figma_execute_code only to change things.` }
            }
          );
        }

        const response = await sendCommandToPlugin({
          code: withFontMemo(shieldParams(code)),
          description: desc,
          capture: capture,
          capture_node_ids: normalizedCaptureIds ? normalizedCaptureIds.split(",") : null,
          diff: false, // H5: see DIFF_OFF_NOTE
          ...captureOptions(args),
          target: args.target
        }, TIMEOUTS.heavy, { escalateMs: wantsAsync ? 50 : TIMEOUTS.escalate });
        stripFontMemo(response);

        if (response.__escalated) {
          noteIssued(response.job_id);
          return {
            content: [{
              type: "text",
              text: toJson({
                ok: true,
                status: "running",
                job_id: response.job_id,
                note: `Still running in Figma after ${Math.round(response.elapsed_ms / 1000)}s. Call figma_job_status({ job_id: "${response.job_id}" }) once — it waits for the result.`,
                hint: SLOW_CALL_HINT
              })
            }]
          };
        }

        const lead = await postWrite(code, response, {
          target: args.target,
          lint: [rewrite.lint, args.diff === true ? DIFF_OFF_NOTE : null, fontLoadLint(code)]
        });
        return renderPluginResponse(response, null, { ...budgetOptions(args), lead });
      }

      case "figma_inspect": {
        resetReadStreak();
        const response = await sendCommandToPlugin({
          code: buildInspectCode(args),
          description: "Inspect",
          target: args.target
        }, TIMEOUTS.normal);
        // A read has nothing to roll back or lint — keep only what was read.
        const plain = !args.compare && !args.like && !args.props && !args.check && (!args.view || args.view === "outline");
        const similar = plain && response.result ? similarHint(response.result.outline) : null;
        // a flow re-read after bridge.openOverlay: say the look is the manual step, not a miss
        if (response.result && typeof response.result.flow === "string" && OVERLAY_LINKED.size &&
            [...OVERLAY_LINKED.values()].some(v => linkedOverlay(response.__file || args.target, v.overlay) === v && response.result.flow.indexOf("#" + v.overlay + ":") !== -1)) {
          response.result.flow = response.result.flow.replace(OVERLAY_HEADER_RE, OVERLAY_HEADER_DONE);
        }
        return renderPluginResponse(
          { result: applyLineOffset(response.result, args.offset), resultStashed: response.resultStashed },
          null,
          { ...budgetOptions(args), kind: plain ? "inspect" : "inspect-list", lead: similar ? { similar: similar } : null }
        );
      }

      case "figma_job_status": {
        const waitMs = args.wait_ms != null && Number.isFinite(Number(args.wait_ms)) ? Number(args.wait_ms) : ECONOMY.jobWaitMs;
        let snap;
        try {
          snap = state.isBridgeMaster
            ? await readJobSnapshot(args.job_id, waitMs)
            : await proxyToMaster(`/job?id=${encodeURIComponent(args.job_id || "")}&wait_ms=${Math.round(waitMs)}`, {
                timeoutMs: Math.min(waitMs, ECONOMY.jobWaitMaxMs) + 10000
              });
        } catch (e) {
          snap = jobStatusError(e, args.job_id);
          if (!snap) throw e;
        }
        snap = jobStatusSnap(snap, args.job_id);
        if (snap.code === "JOB_STATE_UNKNOWN") return { content: [{ type: "text", text: toJson(snap) }] };

        if (snap.status === "done") {
          // a write that ran long gets the same reply as one that did not (h13 T6: job_status, then a verify turn)
          let lead = null;
          try {
            if (snap.script) lead = await postWrite(snap.script, snap.response, { target: snap.target || undefined, file: snap.target || null });
          } catch (e) { lead = null; }
          return renderPluginResponse(snap.response, { status: "done", job_id: snap.job_id, ...(snap.late ? { late: true } : {}) }, { ...budgetOptions(args), lead });
        }
        if (snap.ok === false) {
          return {
            isError: true,
            content: [{ type: "text", text: toJson(snap.code === "JOB_NOT_FOUND" ? snap : { ...buildErrorEnvelope({ message: snap.error, code: snap.code, ...errorLocation(snap) }), job_id: snap.job_id, ...(snap.late ? { late: true } : {}) }) }]
          };
        }
        return { content: [{ type: "text", text: toJson(snap) }] };
      }

      case "figma_read_canvas": {
        const nodeIds = normalizeNodeIds(args.node_ids || args.node_id || args.nodeIds || args.nodeId || args.ids);
        const format = args.format || "jsx";
        const requestedDepth = Number.isFinite(args.depth) ? args.depth : 6;
        const includeHidden = args.include_hidden === true;
        const budgetBytes = budgetBytesFromTokens(args.budget_tokens);

        const response = await sendCommandToPlugin({
          type: "READ_CANVAS",
          node_ids: nodeIds,
          depth: requestedDepth,
          include_hidden: includeHidden,
          target: args.target
        }, TIMEOUTS.normal);

        const rawData = response.result;
        let output = applyTokenBudget(rawData, { format, includeHidden, maxDepth: requestedDepth, budgetBytes });
        if (rawData && rawData.truncatedTop) {
          output += `\n\n<!-- canvas traversal capped at 4000 nodes; some siblings were not sent. Narrow with node_ids. -->`;
        }

        return { content: [{ type: "text", text: output }] };
      }

      case "figma_rollback": {
        const response = await sendCommandToPlugin({
          type: "ROLLBACK",
          checkpoint_id: args.checkpoint_id || "last",
          target: args.target
        }, TIMEOUTS.normal);
        // the links that write made are gone from the canvas: forget them (review 4.2.7 #47)
        unlinkCheckpoint(response && response.result && response.result.checkpoint_id);
        return { content: [{ type: "text", text: toJson({ ok: true, ...response.result }) }] };
      }

      case "figma_list_targets": {
        // A proxy has no plugin sockets of its own — the master does.
        let targets = listTargets();
        if (!state.isBridgeMaster) {
          try {
            const status = await proxyToMaster("/status", { timeoutMs: 5000 });
            if (status && Array.isArray(status.targets)) targets = status.targets;
          } catch (e) {}
        }
        // Session 9672b93e: an empty list sent the model grepping the server
        // source for 8 turns. Nothing is broken — the plugin just isn't running.
        const body = { ok: true, targets };
        if (!targets.length) body.hint = "No Figma file is connected. Ask the user to open the file in Figma DESKTOP and run the Mokido plugin (Ctrl+Alt+P / Cmd+Option+P) until it shows CONNECTED, then call figma_list_targets again. Nothing to debug in the server.";
        return { content: [{ type: "text", text: toJson(body) }] };
      }

      case "figma_screenshot": {
        const desc = args.description || "Figma Screenshot";
        // Models reach for node_id / nodeId often enough; ignoring the alias
        // silently captured the SELECTION instead — a wasted image and turn.
        const nodeIds = normalizeNodeIds(args.node_ids || args.node_id || args.nodeIds || args.nodeId || args.ids);
        const response = await sendCommandToPlugin({
          type: "SCREENSHOT",
          nodeIds,
          ...captureOptions(args),
          description: desc,
          target: args.target
        }, TIMEOUTS.normal);

        const images = collectImages(response);
        const body = { ok: true, result: response.result || "Captured", images: images.meta };
        if (images.skipped) body.images_skipped = `${images.skipped} more image(s) not sent (max ${ECONOMY.maxImages} per call).`;
        if (images.errors.length) body.image_errors = images.errors;
        return { content: [{ type: "text", text: toJson(body) }, ...images.parts] };
      }


      case "figma_get_selection": {
        // Runs as plugin-sandbox JS (not Node), so it inlines its own compact
        // fill formatter rather than reaching for figma/optimizer/styles.js —
        // that module only exists on the server side of the WebSocket.
        // Compact by design: a solid fill becomes one hex string instead of
        // the full paint object (gradient stops, boundVariables, matrices),
        // and text is previewed rather than dumped in full. Parent/page and
        // AutoLayout context are included since "what is this inside of" is
        // usually the actual question behind checking a selection.
        const code = `
          function hex(c) {
            const b = (n) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0').toUpperCase();
            return '#' + b(c.r) + b(c.g) + b(c.b);
          }
          function fillsSummary(fills) {
            if (!fills || fills === figma.mixed || !Array.isArray(fills) || fills.length === 0) return null;
            return fills.filter(f => f.visible !== false).map(f => f.type === 'SOLID' ? hex(f.color) : f.type).join('; ') || null;
          }
          const selection = figma.currentPage.selection;
          return selection.map(node => ({
            id: node.id,
            name: node.name,
            type: node.type,
            width: Math.round(node.width || 0),
            height: Math.round(node.height || 0),
            x: Math.round(node.x || 0),
            y: Math.round(node.y || 0),
            page: figma.currentPage.name,
            parentId: node.parent ? node.parent.id : null,
            parentName: node.parent ? node.parent.name : null,
            layoutMode: ('layoutMode' in node && node.layoutMode !== 'NONE') ? node.layoutMode : undefined,
            fills: fillsSummary(node.fills),
            characters: node.type === 'TEXT' ? String(node.characters || '').slice(0, 200) : undefined
          }));
        `;
        const response = await sendCommandToPlugin({ code, description: "Get Selected Nodes", target: args.target }, TIMEOUTS.normal);
        return jsonResult(response.result, args);
      }

      case "figma_create_ui_card": {
        // Every user-supplied string below is spliced into generated JS source.
        // Escaping only double quotes let a backslash ("C:\Users\x") or a newline
        // produce a SyntaxError — and a trailing backslash escape the closing
        // quote. JSON.stringify emits a complete, correctly escaped JS literal.
        const jsStr = (value) => JSON.stringify(String(value == null ? "" : value));

        const hexToRgb = (hex) => {
          let c = String(hex || "").trim().replace("#", "");
          if (c.length === 3) c = c.split("").map(x => x + x).join("");
          if (!/^[0-9a-fA-F]{6}$/.test(c)) {
            throw new Error(`Invalid hex color "${hex}". Use a 3- or 6-digit hex value such as "#F5F0FF".`);
          }
          const num = parseInt(c, 16);
          return { r: ((num >> 16) & 255) / 255, g: ((num >> 8) & 255) / 255, b: (num & 255) / 255 };
        };

        const title = args.title || "Figma AI Bridge";
        const subtitle = args.subtitle || "Real-time two-way bridge between AI assistants and Figma canvas.";
        const badgeText = args.badge_text || "✨ Live Bridge";
        const buttonText = args.button_text || "Explore Features →";
        const bgColor = args.bg_color || "#F5F0FF";
        // Numbers are interpolated bare into the generated source, so coerce
        // rather than trusting the client to have honoured the schema.
        const width = Number.isFinite(Number(args.width)) && Number(args.width) > 0
          ? Math.round(Number(args.width))
          : 400;

        const rgb = hexToRgb(bgColor);

        const code = `
          const card = figma.createFrame();
          card.name = "UI Card - " + ${jsStr(title)};
          card.layoutMode = "VERTICAL";
          card.primaryAxisSizingMode = "AUTO";
          card.counterAxisSizingMode = "FIXED";
          card.resize(${width}, 100);
          card.paddingTop = 28;
          card.paddingBottom = 28;
          card.paddingLeft = 28;
          card.paddingRight = 28;
          card.itemSpacing = 16;
          card.cornerRadius = 20;
          card.clipsContent = true;
          card.fills = [{ type: 'SOLID', color: { r: ${rgb.r}, g: ${rgb.g}, b: ${rgb.b} } }];
          card.effects = [{
            type: 'DROP_SHADOW',
            color: { r: 0.1, g: 0.05, b: 0.2, a: 0.08 },
            offset: { x: 0, y: 10 },
            radius: 24,
            spread: 0,
            visible: true,
            blendMode: 'NORMAL'
          }];

          ${badgeText ? `
          const badge = figma.createFrame();
          badge.name = "Badge";
          badge.layoutMode = "HORIZONTAL";
          badge.primaryAxisSizingMode = "AUTO";
          badge.counterAxisSizingMode = "AUTO";
          badge.paddingTop = 4;
          badge.paddingBottom = 4;
          badge.paddingLeft = 10;
          badge.paddingRight = 10;
          badge.cornerRadius = 100;
          badge.clipsContent = true;
          badge.fills = [{ type: 'SOLID', color: { r: 0.90, g: 0.84, b: 0.98 } }];

          const badgeTextNode = figma.createText();
          badgeTextNode.characters = ${jsStr(badgeText)};
          badgeTextNode.fontSize = 11;
          badgeTextNode.fontName = { family: "Inter", style: "Medium" };
          badgeTextNode.fills = [{ type: 'SOLID', color: { r: 0.45, g: 0.25, b: 0.75 } }];
          badge.appendChild(badgeTextNode);
          card.appendChild(badge);
          ` : ""}

          const titleText = figma.createText();
          titleText.characters = ${jsStr(title)};
          titleText.fontSize = 22;
          titleText.fontName = { family: "Inter", style: "Bold" };
          titleText.fills = [{ type: 'SOLID', color: { r: 0.15, g: 0.12, b: 0.25 } }];
          card.appendChild(titleText);

          ${subtitle ? `
          const subText = figma.createText();
          subText.characters = ${jsStr(subtitle)};
          subText.fontSize = 14;
          subText.fontName = { family: "Inter", style: "Regular" };
          subText.fills = [{ type: 'SOLID', color: { r: 0.45, g: 0.42, b: 0.55 } }];
          subText.layoutAlign = "STRETCH";
          card.appendChild(subText);
          ` : ""}

          ${buttonText ? `
          const btn = figma.createFrame();
          btn.name = "Action Button";
          btn.layoutMode = "HORIZONTAL";
          btn.primaryAxisSizingMode = "FIXED";
          btn.counterAxisSizingMode = "AUTO";
          btn.primaryAxisAlignItems = "CENTER";
          btn.counterAxisAlignItems = "CENTER";
          btn.layoutAlign = "STRETCH";
          btn.paddingTop = 12;
          btn.paddingBottom = 12;
          btn.paddingLeft = 0;
          btn.paddingRight = 0;
          btn.cornerRadius = 12;
          btn.clipsContent = true;
          btn.fills = [{ type: 'SOLID', color: { r: 0.55, g: 0.40, b: 0.95 } }];

          const btnText = figma.createText();
          btnText.characters = ${jsStr(buttonText)};
          btnText.fontSize = 14;
          btnText.fontName = { family: "Inter", style: "Medium" };
          btnText.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
          btn.appendChild(btnText);
          card.appendChild(btn);
          ` : ""}

          figma.currentPage.appendChild(card);
          const freePos = getFreePosition(${width}, 200, { gap: 80 });
          card.x = freePos.x;
          card.y = freePos.y;
          figma.currentPage.selection = [card];
          figma.viewport.scrollAndZoomIntoView([card]);
          return "Created UI Card with ID: " + card.id;
        `;

        const response = await sendCommandToPlugin({
          code,
          description: `Create card "${title}"`,
          capture: true,
          ...captureOptions(args)
        });

        const content = [];
        content.push({ type: "text", text: String(response.result) });
        if (response.screenshot) {
          const cleanB64 = response.screenshot.replace(/^data:image\/\w+;base64,/, "");
          content.push({
            type: "image",
            data: cleanB64,
            mimeType: "image/png"
          });
        }

        return { content };
      }

      // Design System Tools
      case "figma_find_components": {
        const response = await sendCommandToPlugin({
          type: "FIND_COMPONENTS",
          query: args.query || "",
          page_name: args.page_name,
          include_variants: args.include_variants !== false,
          limit: args.limit || 30,
          refresh_index: args.refresh_index === true,
          target: args.target
        }, TIMEOUTS.fast);

        return jsonResult(response.result, args);
      }

      case "figma_insert_component_instance": {
        // Capture is opt-in: the auto-lint `warnings` catch the mechanical
        // defects, and an image per inserted instance adds up fast.
        const capture = args.capture === true;
        const response = await sendCommandToPlugin({
          type: "INSERT_COMPONENT_INSTANCE",
          component_name: args.component_name,
          component_id: args.component_id,
          properties: args.properties || {},
          text_overrides: args.text_overrides || {},
          target_parent_id: args.target_parent_id,
          position: args.position,
          capture: capture,
          ...captureOptions(args),
          target: args.target
        }, TIMEOUTS.normal);

        return renderPluginResponse(response);
      }

      case "figma_get_variables": {
        const response = await sendCommandToPlugin({
          type: "GET_VARIABLES",
          collection_name: args.collection_name,
          limit: args.limit || 300,
          target: args.target
        }, TIMEOUTS.fast);

        return jsonResult(response.result, args);
      }

      case "figma_set_variables_mode": {
        const capture = args.capture === true;
        const response = await sendCommandToPlugin({
          type: "SET_VARIABLES_MODE",
          collection_name: args.collection_name,
          mode_name: args.mode_name,
          target_id: args.target_id,
          capture: capture,
          ...captureOptions(args),
          target: args.target
        }, TIMEOUTS.normal);

        return renderPluginResponse(response);
      }

      case "figma_insert_svg": {
        const capture = args.capture === true;
        const response = await sendCommandToPlugin({
          type: "INSERT_SVG",
          svg_code: args.svg_code,
          name: args.name,
          width: args.width,
          height: args.height,
          fill_override: args.fill_override,
          stroke_override: args.stroke_override,
          color_override: args.color_override,
          target_parent_id: args.target_parent_id,
          position: args.position,
          as_component: args.as_component === true,
          capture: capture,
          // Icons are tiny, so they keep a 2x default; max_px still bounds it.
          ...captureOptions(args, 2),
          target: args.target
        }, TIMEOUTS.normal);

        return renderPluginResponse(response);
      }

      case "figma_get_canvas_layout": {
        const response = await sendCommandToPlugin({
          type: "GET_CANVAS_LAYOUT",
          direction: args.direction || "RIGHT",
          gap: args.gap || 80,
          limit: args.limit || 200,
          layout: args.layout,
          columns: args.columns,
          target: args.target
        }, TIMEOUTS.fast);

        return jsonResult(response.result, args);
      }

      // REST API
      case "get_me": {
        const data = await figmaApiRequest("/me");
        return { content: [{ type: "text", text: toJson(data) }] };
      }
      case "get_file": {
        const { fileKey } = parseFigmaUrlOrKey(args.file_key);
        const depth = args.depth || 2;
        const data = await figmaApiRequest(`/files/${encodeURIComponent(fileKey)}?depth=${depth}`);
        const format = args.format || "jsx";
        const simplify = args.simplify !== false;
        const maxDepth = args.max_depth || 25;
        const includeHidden = args.include_hidden === true;
        const output = (simplify && format !== "raw" && Number.isFinite(args.budget_tokens))
          ? applyTokenBudget(data, { format, includeHidden, maxDepth, budgetBytes: budgetBytesFromTokens(args.budget_tokens) })
          : optimizeFigmaData(data, { format, simplify, maxDepth, includeHidden });
        return { content: [{ type: "text", text: output }] };
      }
      case "get_node": {
        const parsed = parseFigmaUrlOrKey(args.file_key);
        const fileKey = parsed.fileKey;
        const nodeIds = normalizeNodeIds(args.node_ids) || normalizeNodeIds(parsed.nodeId);
        if (!nodeIds) throw new Error("No node_ids provided.");
        const depth = args.depth || 3;
        const data = await figmaApiRequest(`/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeIds)}&depth=${depth}`);
        const format = args.format || "jsx";
        const simplify = args.simplify !== false;
        const maxDepth = args.max_depth || 25;
        const includeHidden = args.include_hidden === true;
        const output = (simplify && format !== "raw" && Number.isFinite(args.budget_tokens))
          ? applyTokenBudget(data, { format, includeHidden, maxDepth, budgetBytes: budgetBytesFromTokens(args.budget_tokens) })
          : optimizeFigmaData(data, { format, simplify, maxDepth, includeHidden });
        return { content: [{ type: "text", text: output }] };
      }
      case "get_image": {
        const parsed = parseFigmaUrlOrKey(args.file_key);
        const fileKey = parsed.fileKey;
        const nodeIds = normalizeNodeIds(args.node_ids) || normalizeNodeIds(parsed.nodeId);
        if (!nodeIds) throw new Error("No node_ids provided.");
        const format = args.format || "png";
        const scale = args.scale || 2;
        const data = await figmaApiRequest(`/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(nodeIds)}&format=${format}&scale=${scale}`);
        return { content: [{ type: "text", text: toJson(data) }] };
      }
      case "get_image_fills": {
        const { fileKey } = parseFigmaUrlOrKey(args.file_key);
        const data = await figmaApiRequest(`/files/${encodeURIComponent(fileKey)}/images`);
        return { content: [{ type: "text", text: toJson(data) }] };
      }
      case "get_styles": {
        const { fileKey } = parseFigmaUrlOrKey(args.file_key);
        const data = await figmaApiRequest(`/files/${encodeURIComponent(fileKey)}/styles`);
        return { content: [{ type: "text", text: toJson(data) }] };
      }
      case "get_components": {
        const { fileKey } = parseFigmaUrlOrKey(args.file_key);
        const data = await figmaApiRequest(`/files/${encodeURIComponent(fileKey)}/components`);
        return { content: [{ type: "text", text: toJson(data) }] };
      }
      case "get_comments": {
        const { fileKey } = parseFigmaUrlOrKey(args.file_key);
        const data = await figmaApiRequest(`/files/${encodeURIComponent(fileKey)}/comments`);
        return { content: [{ type: "text", text: toJson(data) }] };
      }
      case "post_comment": {
        const parsed = parseFigmaUrlOrKey(args.file_key);
        const fileKey = parsed.fileKey;
        const body = { message: args.message };
        if (args.node_id) body.client_meta = { node_id: args.node_id.replace(/-/g, ":") };
        const data = await figmaApiRequest(`/files/${encodeURIComponent(fileKey)}/comments`, {
          method: "POST",
          body: JSON.stringify(body)
        });
        return { content: [{ type: "text", text: toJson(data) }] };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: toJson(buildErrorEnvelope(error)) }]
    };
  }
}

// The one entry point: the routed answer plus, when a job finished after nobody was
// waiting, the late_result block as its first content item (see late.js).
async function handleCallTool(name, args = {}) {
  return attachLate(await routeTool(name, args), name, args, takeLate);
}

module.exports = { handleCallTool };
