const { BRIDGE_PORT, BRIDGE_TOKEN, ECONOMY, ORIGIN_ID } = require("./config");
const { state, wsClients, pendingCommands, waitForClient } = require("./state");
const { recentlyRejectedPlugin, wrongPluginCopyMessage } = require("./auth");
const { jobs, touchJob, findBusyJob, quietMs, errorLocation } = require("./jobs");
const { tryBecomeMaster } = require("./master");
const { stripFontMemoCode } = require("./script-prep");

// Target Router — picks WHICH connected Figma document a command goes to.
// `targetFileName`, when given, filters to clients reporting that fileName and
// throws TARGET_NOT_FOUND if none match. Otherwise: the single connected
// client wins outright; among several, the focused one wins; several
// simultaneously "focused" (a focus message crossed in flight) breaks the tie
// by recency; several connected and NONE focused is genuinely ambiguous and
// throws AMBIGUOUS_TARGET rather than silently guessing wrong, which is what
// sorting by lastSeen alone used to do (a PING updates lastSeen too, so it
// wasn't even reliably tracking real focus).
function listTargets() {
  return Array.from(wsClients).map(c => ({
    id: c.id,
    fileName: c.fileName || null,
    pageName: c.pageName || null,
    pluginVersion: c.pluginVersion || null,
    focused: !!c.focused,
    lastSeenMsAgo: Date.now() - c.lastSeen
  }));
}

function pickTargetClient(targetFileName) {
  const clients = Array.from(wsClients);
  if (clients.length === 0) return null;

  let pool = clients;
  if (targetFileName) {
    const wanted = String(targetFileName).toLowerCase();
    const matched = clients.filter(c => (c.fileName || "").toLowerCase() === wanted);
    if (matched.length === 0) {
      const available = clients.map(c => c.fileName || "(unnamed)").join(", ") || "(none connected)";
      const err = new Error(`No connected Figma document named "${targetFileName}". Currently open: ${available}. Call figma_list_targets to check.`);
      err.code = "TARGET_NOT_FOUND";
      throw err;
    }
    pool = matched;
  }

  if (pool.length === 1) return pool[0];

  const focused = pool.filter(c => c.focused);
  if (focused.length === 1) return focused[0];
  if (focused.length > 1) return focused.sort((a, b) => b.lastSeen - a.lastSeen)[0];

  if (!targetFileName) {
    const err = new Error(
      `${pool.length} Figma documents are connected and none is focused (${pool.map(c => c.fileName || "(unnamed)").join(", ")}). ` +
      `Click into the intended Figma window, or pass target: "<fileName>" — see figma_list_targets.`
    );
    err.code = "AMBIGUOUS_TARGET";
    throw err;
  }
  return pool.sort((a, b) => b.lastSeen - a.lastSeen)[0];
}

// `options.target` routes to a specific connected document (Target Router).
// `options.escalateMs`, when set and shorter than timeoutMs, converts a call
// that is STILL running at that point into a background job instead of
// blocking (or eventually rejecting) the caller — see the Job Ledger above
// and figma_job_status. Every other call site keeps today's plain
// resolve/reject-on-timeout behaviour by simply not passing it.
async function sendCommandToPlugin(payload, timeoutMs = 45000, options = {}) {
  if (!state.isBridgeMaster) {
    return proxyToMaster("/execute", {
      method: "POST",
      body: { ...payload, timeoutMs, origin: ORIGIN_ID, ...(options.escalateMs ? { escalateMs: options.escalateMs } : {}) },
      // The master enforces timeoutMs/escalateMs itself; this is only the
      // outer bound, so a slow-but-healthy call is not cut short by the hop.
      timeoutMs: (options.escalateMs ? Math.min(options.escalateMs, timeoutMs) : timeoutMs) + 5000
    });
  }

  let targetClient = pickTargetClient(payload.target);

  // A plugin that was connected recently is most likely reloading
  // (Ctrl+Alt+P, Figma tab switch, a server restart). Waiting a few seconds
  // for it to come back is far cheaper than failing: a failure costs the
  // agent a turn to read the error, and usually a list_targets + retry turn.
  if (!targetClient && wsClients.size === 0 && state.lastPluginPing > 0 &&
      (Date.now() - state.lastPluginPing) < 10 * 60 * 1000 && ECONOMY.reconnectGraceMs > 0) {
    await waitForClient(ECONOMY.reconnectGraceMs);
    targetClient = pickTargetClient(payload.target);
  }

  // Fail-Fast: with zero WS clients AND no recent /poll heartbeat, no plugin
  // is realistically going to show up before the hard timeout — queuing the
  // command and waiting the full 45s (until the caller gives up) just makes
  // every live tool call look hung. Bail immediately with an actionable error
  // instead. A poll-based client that pinged inside the last 60s still gets
  // the benefit of the doubt and the command is queued normally.
  if (!targetClient && (Date.now() - state.lastPluginPing) >= 60000) {
    const rejected = recentlyRejectedPlugin();
    if (rejected) {
      const err = new Error("No Figma plugin is connected to the bridge. " + wrongPluginCopyMessage(rejected));
      err.code = "PLUGIN_TOKEN_REJECTED";
      throw err;
    }
    const err = new Error(
      "No Figma plugin is connected to the bridge. Ask the user to open Figma DESKTOP (not the browser) and launch the Mokido plugin (Ctrl+Alt+P / Cmd+Option+P) until the status shows CONNECTED, then retry."
    );
    err.code = "NO_CONNECTED_CLIENTS";
    throw err;
  }

  const cmdPayload = { ...payload };
  delete cmdPayload.target;

  return new Promise((resolve, reject) => {
    const id = "cmd_" + Math.random().toString(36).substring(2, 9);
    const cmd = { id, ...cmdPayload };
    const clientId = targetClient ? targetClient.id : null;
    let escalateTimer = null;

    // Ledger entry from the very start: elapsed_ms used to count from the
    // moment of escalation, and "what else is running on this plugin" (see
    // findBusyJob) needs in-flight commands, not just escalated ones.
    // target: the file the command went to, so figma_job_status (no target of
    // its own) re-reads a long write in that file, not the focused one (review 4.2.7 #44).
    // origin: who runs it (a proxy passes its own id, an old proxy none => null).
    const origin = options.origin !== undefined ? options.origin : ORIGIN_ID;
    const startedAt = touchJob(id, { clientId, origin, kind: cmdPayload.type || "EXECUTE", description: cmdPayload.description || null,
      target: (targetClient && targetClient.fileName) || payload.target || null,
      script: typeof cmdPayload.code === "string" && cmdPayload.code.length < 60000 ? stripFontMemoCode(cmdPayload.code) : null }).createdAt;

    const hardTimer = setTimeout(() => {
      state.commandResolvers.delete(id);
      const queuedAt = pendingCommands.findIndex(c => c.id === id);
      if (queuedAt !== -1) pendingCommands.splice(queuedAt, 1);
      // Never sent (still queued): nothing can answer. Sent: keep the record, the
      // plugin may still answer and then the result is told as a late one.
      if (queuedAt !== -1) jobs.delete(id); else touchJob(id, { detached: "timeout" });
      const busy = findBusyJob(clientId, id, startedAt);
      let err;
      if (busy && quietMs(busy) > ECONOMY.stalledAfterMs) {
        err = new Error(
          `Timed out after ${Math.round(timeoutMs / 1000)}s: the plugin is not responding, ${busy.id} has been silent for ${Math.round(quietMs(busy) / 1000)}s. ` +
          "Stop now and ask the user to look at Figma (close or reload the plugin, Ctrl+Alt+P); do not retry and do not poll."
        );
        err.code = "PLUGIN_BUSY";
      } else if (busy) {
        err = new Error(
          `Timed out after ${Math.round(timeoutMs / 1000)}s: the plugin is still busy with ${busy.id}` +
          `${busy.description ? ` ("${busy.description}")` : ""}, running for ${Math.round((Date.now() - busy.createdAt) / 1000)}s. ` +
          `Figma runs plugin code on a single thread, so retrying now will time out again — ` +
          `wait for it with figma_job_status({ job_id: "${busy.id}" }) first.`
        );
        err.code = "PLUGIN_BUSY";
      } else {
        err = new Error("Timeout waiting for Figma Plugin response. Ensure Figma is active and Mokido plugin is running.");
        err.code = "BRIDGE_OFFLINE";
      }
      reject(err);
    }, timeoutMs);

    if (options.escalateMs && options.escalateMs < timeoutMs) {
      escalateTimer = setTimeout(() => {
        if (!state.commandResolvers.has(id)) return; // already settled through the normal path
        state.commandResolvers.delete(id);
        clearTimeout(hardTimer);
        touchJob(id, { detached: "escalated" });
        resolve({ __escalated: true, job_id: id, elapsed_ms: options.escalateMs });
      }, options.escalateMs);
    }

    state.commandResolvers.set(id, (response) => {
      clearTimeout(hardTimer);
      if (escalateTimer) clearTimeout(escalateTimer);
      if (response.success) {
        // which file it ran in (not rendered): the overlay registry is per file (review 4.2.7 #47)
        if (targetClient && response && typeof response === "object") response.__file = targetClient.fileName || null;
        resolve(response);
      } else {
        const err = new Error(response.error || "Execution failed in Figma sandbox");
        if (response.code) err.code = response.code;
        Object.assign(err, errorLocation(response));
        reject(err);
      }
    });

    // 1. Direct WebSocket Push (0ms latency)
    if (targetClient) {
      targetClient.send(cmd);
    } else {
      // 2. Queue for incoming WebSocket connection or HTTP long-poll
      pendingCommands.push(cmd);
    }
  });
}

// One hop to the process that owns :8765 (see tryBecomeMaster). A zombie
// master (still bound but wedged — stale after `install.mjs --update`, or a
// crashed event loop) never refuses the connection, it just hangs. The old
// guard capped EVERY proxied call at 10s, which also killed healthy long
// calls and made the proxy "take over" a port that was never free — two
// wasted agent turns per heavy call. Now a /status probe at the 10s mark
// decides: answered => master alive, keep waiting; silent => zombie, abort.
// The master piggybacks a late-result block on its replies (`__late`); a proxy
// moves it to state.lateInbox so the router wrapper can show it to the model.
function foldLate(data) {
  if (data && typeof data === "object" && data.__late) {
    state.lateInbox.push(data.__late);
    delete data.__late;
  }
}

async function proxyToMaster(pathname, { method = "GET", body, timeoutMs = 45000 } = {}) {
  // /job tells the master whose late results to hand back (the router builds the path).
  if (pathname.indexOf("/job?") === 0) pathname += "&origin=" + encodeURIComponent(ORIGIN_ID);
  const controller = new AbortController();
  let zombie = false;
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
  const probeTimer = setTimeout(async () => {
    try {
      const probe = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/status`, {
        headers: BRIDGE_TOKEN ? { "X-Bridge-Token": BRIDGE_TOKEN } : {},
        signal: AbortSignal.timeout(2500)
      });
      if (!probe.ok) throw new Error("status " + probe.status);
    } catch (e) {
      zombie = true;
      controller.abort();
    }
  }, Math.min(10000, timeoutMs));

  try {
    const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}${pathname}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(BRIDGE_TOKEN ? { "X-Bridge-Token": BRIDGE_TOKEN } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    if (!res.ok) {
      const errText = await res.text();
      let detail = errText;
      let code = null;
      let loc = {};
      try {
        const parsed = JSON.parse(errText);
        detail = parsed.error || errText;
        code = parsed.code || null;
        loc = errorLocation(parsed);
        foldLate(parsed);
      } catch (e) {}
      // A 500 from /execute is the master relaying a real tool failure
      // (NO_CONNECTED_CLIENTS, a sandbox error...) — pass it through as-is.
      if (res.status === 403 && /only accepts requests from the Mokido plugin/.test(String(detail))) {
        const e = new Error("The main Mokido instance on :" + BRIDGE_PORT + " requires FIGMA_BRIDGE_TOKEN and this one " +
          (BRIDGE_TOKEN ? "sent a different token" : "has none") + ". HINT: set the same FIGMA_BRIDGE_TOKEN in the env of every MCP client (or remove it everywhere), then restart them.");
        e.code = "BRIDGE_TOKEN_REQUIRED";
        throw e;
      }
      const err = new Error(res.status === 500 ? detail : `Bridge proxy error (HTTP ${res.status}): ${detail}`);
      if (code) err.code = code;
      Object.assign(err, loc);
      throw err;
    }
    const data = await res.json();
    foldLate(data);
    if (pathname !== "/execute" || data.success || data.__escalated) return data;
    const err = new Error(data.error || "Execution failed in Figma sandbox");
    if (data.code) err.code = data.code;
    Object.assign(err, errorLocation(data));
    throw err;
  } catch (err) {
    // The owner of :8765 is gone, or alive but wedged — claim the port
    // ourselves so the NEXT call succeeds instead of failing forever.
    const cause = err && err.cause ? err.cause.code : null;
    const aborted = err && err.name === "AbortError";
    if (zombie || cause === "ECONNREFUSED" || cause === "ECONNRESET" || /fetch failed/i.test(err.message || "")) {
      tryBecomeMaster();
      const wrapped = new Error(
        zombie
          ? "The bridge instance that owned :8765 stopped responding. This server is taking the port over — retry the call."
          : "The bridge instance that owned :8765 is no longer running. This server is taking the port over — retry the call."
      );
      wrapped.code = "BRIDGE_OFFLINE";
      throw wrapped;
    }
    if (aborted) {
      const wrapped = new Error("Timeout waiting for Figma Plugin response. Ensure Figma is active and Mokido plugin is running.");
      wrapped.code = "BRIDGE_OFFLINE";
      throw wrapped;
    }
    throw err;
  } finally {
    clearTimeout(abortTimer);
    clearTimeout(probeTimer);
  }
}

module.exports = { listTargets, pickTargetClient, sendCommandToPlugin, proxyToMaster };
