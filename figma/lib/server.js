const crypto = require("crypto");
const http = require("http");
const { BRIDGE_PORT, ALLOWED_ORIGINS, MAX_WS_MESSAGE_BYTES, MAX_HTTP_BODY_BYTES, SERVER_VERSION, TIMEOUTS, ECONOMY } = require("./config");
const { state, wsClients, pendingCommands, wakeClientWaiters } = require("./state");
const { isAuthorized, isOriginAllowed } = require("./auth");
const { jobs, settleCommand, errorLocation, failCommandsOfClient, readJobSnapshot, takeLate } = require("./jobs");
const { tryBecomeMaster, attachServer } = require("./master");
const { sendCommandToPlugin, listTargets } = require("./dispatch");
const { logExit, logRole } = require("./journal");

// Encode unmasked text frame (Server -> Client) as per RFC 6455
function encodeWsFrame(data) {
  const payload = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data), "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function handleWsUpgrade(req, socket, head) {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  if (!isAuthorized(req)) {
    // Refuse before the handshake so a hostile page never gets a live socket.
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  const responseHeaders = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n"
  ].join("\r\n");

  socket.write(responseHeaders);

  const client = {
    id: "ws_" + Math.random().toString(36).substring(2, 9),
    socket,
    lastSeen: Date.now(),
    buffer: Buffer.alloc(0),
    // Reassembly state for fragmented messages (FIN=0 + continuation frames).
    fragments: [],
    fragmentOpcode: 0,
    fragmentBytes: 0,
    // Target Router identity — filled in by CLIENT_READY/CLIENT_FOCUS once the
    // plugin reports it. Defaults to focused=true so a single connected
    // document (the overwhelmingly common case) needs no handshake to route.
    focused: true,
    fileKey: null,
    fileName: null,
    pageName: null,
    pluginVersion: null,
    send(msg) {
      try {
        if (socket.writable) {
          socket.write(encodeWsFrame(msg));
        }
      } catch (e) {}
    }
  };

  wsClients.add(client);
  state.lastPluginPing = Date.now();

  // Flush everything queued while nothing was connected (0ms dispatch).
  while (pendingCommands.length > 0) {
    const queued = pendingCommands.shift();
    const job = jobs.get(queued.id);
    if (job && job.status === "running") job.clientId = client.id;
    client.send(queued);
  }
  wakeClientWaiters();

  socket.on("data", (chunk) => {
    client.lastSeen = Date.now();
    state.lastPluginPing = Date.now();
    client.buffer = Buffer.concat([client.buffer, chunk]);

    while (client.buffer.length >= 2) {
      const byte0 = client.buffer[0];
      const byte1 = client.buffer[1];
      const isFinal = (byte0 & 0x80) !== 0;
      const opcode = byte0 & 0x0f;
      const isMasked = (byte1 & 0x80) !== 0;
      let payloadLen = byte1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (client.buffer.length < 4) break;
        payloadLen = client.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (client.buffer.length < 10) break;
        payloadLen = Number(client.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      if (payloadLen > MAX_WS_MESSAGE_BYTES) {
        console.error(`[Mokido] Dropping oversized WebSocket frame (${payloadLen} bytes).`);
        socket.destroy();
        cleanupClient();
        return;
      }

      let maskKey = null;
      if (isMasked) {
        if (client.buffer.length < offset + 4) break;
        maskKey = client.buffer.slice(offset, offset + 4);
        offset += 4;
      }

      if (client.buffer.length < offset + payloadLen) {
        break; // Wait for full frame
      }

      const payload = client.buffer.slice(offset, offset + payloadLen);
      client.buffer = client.buffer.slice(offset + payloadLen);

      if (maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i % 4];
        }
      }

      if (opcode === 0x8) {
        // Close frame
        socket.end();
        cleanupClient();
        break;
      } else if (opcode === 0x9) {
        // Ping frame -> reply with Pong
        if (socket.writable) {
          socket.write(Buffer.from([0x8a, 0x00]));
        }
      } else if (opcode === 0xa) {
        // Pong — liveness only, already recorded via lastSeen above.
      } else if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
        // Data frame. A large screenshot can arrive split across a FIN=0 frame
        // plus continuation frames; treating each fragment as a whole message
        // silently dropped it and the tool call timed out 40s later.
        if (opcode !== 0x0) {
          client.fragments = [];
          client.fragmentBytes = 0;
          client.fragmentOpcode = opcode;
        }

        client.fragments.push(payload);
        client.fragmentBytes += payload.length;

        if (client.fragmentBytes > MAX_WS_MESSAGE_BYTES) {
          console.error(`[Mokido] Dropping oversized fragmented message (${client.fragmentBytes} bytes).`);
          socket.destroy();
          cleanupClient();
          return;
        }

        if (isFinal) {
          const full = client.fragments.length === 1 ? client.fragments[0] : Buffer.concat(client.fragments);
          client.fragments = [];
          client.fragmentBytes = 0;
          if (client.fragmentOpcode === 0x1) {
            try {
              handleClientMessage(client, JSON.parse(full.toString("utf8")));
            } catch (err) {}
          }
        }
      }
    }
  });

  const cleanupClient = () => {
    if (!wsClients.has(client)) return; // close/end/error can all fire for one socket
    wsClients.delete(client);
    failCommandsOfClient(client.id);
  };
  socket.on("close", cleanupClient);
  socket.on("end", cleanupClient);
  socket.on("error", cleanupClient);
}

function handleClientMessage(client, data) {
  if (!data) return;
  client.lastSeen = Date.now();
  state.lastPluginPing = Date.now();

  if (data.type === "PING") {
    client.send({ type: "PONG" });
    return;
  }

  // Target Router — every other connected client loses focus the moment one
  // reports it, so "the window the user is looking at" is always at most one
  // client, matching what the plugin's own focus/blur listeners see.
  if (data.type === "CLIENT_FOCUS" || data.type === "CLIENT_READY") {
    for (const c of wsClients) c.focused = false;
    client.focused = true;
    if (data.fileKey !== undefined) client.fileKey = data.fileKey;
    if (data.fileName !== undefined) client.fileName = data.fileName;
    if (data.pageName !== undefined) client.pageName = data.pageName;
    if (data.pluginVersion !== undefined) client.pluginVersion = data.pluginVersion;
    // The plugin finds itself in GET /status targets by this id (other_target state).
    if (data.type === "CLIENT_READY") client.send({ type: "CLIENT_ACK", clientId: client.id });
    return;
  }

  if (data.type === "PAGE_CHANGED") {
    if (data.pageName !== undefined) client.pageName = data.pageName;
    return;
  }

  if (data.type === "PROGRESS" && data.id) {
    const job = jobs.get(data.id);
    if (!job) return; // unknown id (journal lost, or a read already forgotten): nothing to attach it to
    job.progress.push({ step: data.step, of: data.of, note: data.note, ts: data.ts || Date.now() });
    if (job.progress.length > 50) job.progress.shift();
    return;
  }

  if (data.id) {
    // Goes to the blocked caller if there still is one, otherwise into the job
    // ledger — a call that already escalated past TIMEOUTS.escalate has
    // nothing left in commandResolvers, but figma_job_status needs to see it.
    settleCommand(data, client);
  }
}

// Reads a request body with a hard ceiling, so a hostile or runaway client
// cannot grow an unbounded string in memory.
function readBody(req, limit = MAX_HTTP_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`Request body exceeds ${limit} bytes`));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const bridgeServer = http.createServer((req, res) => {
  // CORS is echoed back only for origins we actually trust — "*" turned every
  // page the user visits into a client of /execute.
  const origin = req.headers["origin"];
  if (origin && ALLOWED_ORIGINS.has(origin.toLowerCase())) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Bridge-Token");

  if (req.method === "OPTIONS") {
    res.writeHead(isOriginAllowed(req) ? 204 : 403);
    return res.end();
  }

  // The query string now carries ?token=, so route on the pathname alone.
  let pathname = req.url || "/";
  const queryStart = pathname.indexOf("?");
  if (queryStart !== -1) pathname = pathname.substring(0, queryStart);

  if (!isAuthorized(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      error: "Forbidden: the Figma bridge only accepts requests from the Mokido plugin. " +
             "If you are the plugin, make sure install.mjs baked the matching bridge token into it."
    }));
  }

  // HTTP Long-Polling Fallback
  if (pathname === "/poll" && req.method === "GET") {
    state.lastPluginPing = Date.now();
    if (pendingCommands.length > 0) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(pendingCommands.shift()));
    }

    let idleTimer = null;
    const checkInterval = setInterval(() => {
      if (pendingCommands.length > 0) {
        clearInterval(checkInterval);
        clearTimeout(idleTimer);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(pendingCommands.shift()));
      }
    }, 100);

    idleTimer = setTimeout(() => {
      clearInterval(checkInterval);
      if (!res.writableEnded) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "idle" }));
      }
    }, 10000);

    // A client that hangs up mid-poll must not leave the interval spinning.
    req.on("close", () => {
      clearInterval(checkInterval);
      clearTimeout(idleTimer);
    });
    return;
  }

  if (pathname === "/result" && req.method === "POST") {
    readBody(req).then((body) => {
      try {
        const data = JSON.parse(body);
        // Same path as a WebSocket result: this used to bypass the job ledger,
        // so an escalated job from an HTTP-polling plugin never finished.
        if (data && data.id) settleCommand(data);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ received: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch((err) => {
      if (res.writableEnded) return;
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  if (pathname === "/execute" && req.method === "POST") {
    readBody(req).then(async (body) => {
      let origin = null;
      try {
        const payload = JSON.parse(body);
        const timeoutMs = payload.timeoutMs || 45000;
        const escalateMs = payload.escalateMs;
        origin = typeof payload.origin === "string" && payload.origin ? payload.origin : null; // old proxies send none
        delete payload.timeoutMs;
        delete payload.escalateMs;
        delete payload.origin;
        // A proxy's call escalates here, in the master that owns the job
        // ledger, so its figma_job_status (forwarded to /job) can find it.
        const result = await sendCommandToPlugin(payload, timeoutMs, { origin, ...(escalateMs ? { escalateMs } : {}) });
        const late = takeLate(origin);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(late ? { ...result, __late: late } : result));
      } catch (err) {
        const late = takeLate(origin);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: err.message, code: err.code || null, ...errorLocation(err), ...(late ? { __late: late } : {}) }));
      }
    }).catch((err) => {
      if (res.writableEnded) return;
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    });
    return;
  }

  // Job long-poll for proxies: the ledger only exists in the master process.
  if (pathname === "/job" && req.method === "GET") {
    const url = new URL(req.url, `http://127.0.0.1:${BRIDGE_PORT}`);
    const jobId = url.searchParams.get("id");
    const jobOrigin = url.searchParams.get("origin") || null;
    readJobSnapshot(jobId, Number(url.searchParams.get("wait_ms")) || 0)
      .then((snap) => {
        if (res.writableEnded) return;
        const late = takeLate(jobOrigin, jobId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(late ? { ...snap, __late: late } : snap));
      })
      .catch((err) => {
        if (res.writableEnded) return;
        const late = takeLate(jobOrigin, jobId);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message, ...(late ? { __late: late } : {}) }));
      });
    return;
  }

  if (pathname === "/status") {
    const isOnline = wsClients.size > 0 || (Date.now() - state.lastPluginPing) < 60000;
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      connected: isOnline,
      wsClients: wsClients.size,
      lastPing: state.lastPluginPing,
      serverVersion: SERVER_VERSION,
      pid: process.pid,
      targets: listTargets(),
      // The plugin's "long task" / "looks stuck" states use the same thresholds as the server.
      limits: { escalateMs: TIMEOUTS.escalate, stalledAfterMs: ECONOMY.stalledAfterMs }
    }));
  }

  res.writeHead(404);
  res.end();
});
attachServer(bridgeServer);
bridgeServer.on("listening", () => logRole("master"));

// Attach WebSocket Upgrade Handler
bridgeServer.on("upgrade", (req, socket, head) => {
  const upgradeHeader = (req.headers["upgrade"] || "").toLowerCase();
  if (upgradeHeader === "websocket") {
    handleWsUpgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});

bridgeServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    state.isBridgeMaster = false;
    state.listenAttemptInFlight = false;
    logRole("proxy");
    console.error(`[Mokido] Port ${BRIDGE_PORT} is already in use. Forwarding commands to existing bridge instance.`);
  } else {
    console.error(`[Mokido] Server error:`, err);
  }
});

// Side effects live here, not at module load, so tests can require() this
// file for its pure helpers without binding a port — see the bottom of file.
function startBridge() {
  tryBecomeMaster();

  // Cheap safety net for the case where the owner dies while this process is idle.
  const masterWatchdog = setInterval(tryBecomeMaster, 5000);
  if (masterWatchdog.unref) masterWatchdog.unref();

  let exiting = false;
  const cleanup = (reason) => {
    if (exiting) return;
    exiting = true;
    logExit(reason);
    try { bridgeServer.close(); } catch (e) {}
    process.exit(0);
  };
  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));
  process.stdin.on("end", () => cleanup("stdin closed"));
  process.stdin.on("close", () => cleanup("stdin closed"));

  // The server must not outlive its MCP session: an orphan keeps :8765 and the
  // plugin socket, so live sessions proxy into a dead one. stdin end covers the
  // normal case; this covers a parent that died while something else still holds
  // our stdin pipe open. POSIX re-parents orphans (ppid changes), Windows keeps
  // the stale ppid, so check both. FIGMA_MCP_PARENT_CHECK_MS=0 disables it.
  const parentPid = process.ppid;
  const parentCheckMs = parseInt(process.env.FIGMA_MCP_PARENT_CHECK_MS ?? "2000", 10);
  if (parentPid > 1 && parentCheckMs > 0) {
    const parentWatchdog = setInterval(() => {
      let gone = process.ppid !== parentPid;
      if (!gone) {
        try { process.kill(parentPid, 0); } catch (e) { gone = e.code === "ESRCH"; }
      }
      if (gone) {
        console.error(`[Mokido] Parent process ${parentPid} is gone, exiting.`);
        cleanup("parent process gone");
      }
    }, parentCheckMs);
    if (parentWatchdog.unref) parentWatchdog.unref();
  }
}

module.exports = { bridgeServer, startBridge };
