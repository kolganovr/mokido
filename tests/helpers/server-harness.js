// Shared harness for tests that talk to a REAL figma/index.js process: spawns
// the server (stdio JSON-RPC), connects fake Figma plugins over a real
// WebSocket, and gives the test a small client. No dependencies, Node >= 22.
//
// Ports: callers pass their own (golden-tools uses 18801-18820). Never 8765,
// a live bridge on this machine must not be touched.
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const SERVER_PATH = path.join(ROOT, "figma", "index.js");
const FETCH_STUB = path.join(__dirname, "fetch-stub.js").replace(/\\/g, "/");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE_ENV = {
  FIGMA_BRIDGE_TOKEN: "golden-test-token",
  FIGMA_PERSONAL_ACCESS_TOKEN: "",
  FIGMA_API_KEY: "",
  FIGMA_MCP_LEGACY_TOOLS: "",
  FIGMA_MCP_NO_UPDATE_CHECK: "1",
  FIGMA_MCP_ESCALATE_MS: "400",
  FIGMA_MCP_TIMEOUT_MS: "4000",
  FIGMA_MCP_TIMEOUT_FAST_MS: "4000",
  FIGMA_MCP_TIMEOUT_HEAVY_MS: "6000",
  FIGMA_MCP_RECONNECT_GRACE_MS: "300",
  FIGMA_MCP_JOB_WAIT_MS: "5000"
};

// opts: { port, env, fetchRoutes (object for fetch-stub), fetchLog (file path) }
function startServer(opts) {
  const port = opts.port;
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^FIGMA_/i.test(k)) delete env[k]; // an ambient setting must never leak into a golden
  Object.assign(env, BASE_ENV, { FIGMA_BRIDGE_PORT: String(port) }, opts.env || {});
  // The coverage tool injects its own --require through NODE_OPTIONS: keep it, add ours.
  const inherited = process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + " " : "";
  env.NODE_OPTIONS = inherited + '--require "' + FETCH_STUB + '"';
  env.FETCH_STUB_ROUTES = JSON.stringify(opts.fetchRoutes || {});
  if (opts.fetchLog) env.FETCH_STUB_LOG = opts.fetchLog;

  const child = spawn(process.execPath, [SERVER_PATH], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  const stderrWaiters = [];
  child.stderr.on("data", (d) => {
    stderr += d.toString("utf8");
    for (let i = stderrWaiters.length - 1; i >= 0; i--) {
      if (stderrWaiters[i].re.test(stderr)) { stderrWaiters[i].resolve(); stderrWaiters.splice(i, 1); }
    }
  });
  child.stdin.on("error", () => {});

  let buffer = "";
  const pending = new Map();
  let nextId = 1;
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; }
      const waiter = pending.get(msg.id);
      if (waiter) { pending.delete(msg.id); waiter(msg); }
    }
  });

  function call(method, params, timeoutMs = 25000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timed out waiting for ${method}`)); }, timeoutMs);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  // Same request, LSP-style Content-Length framing instead of one line.
  function callFramed(method, params, timeoutMs = 25000) {
    const id = nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timed out waiting for framed ${method}`)); }, timeoutMs);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write("Content-Length: " + Buffer.byteLength(body) + "\r\n\r\n" + body);
    });
  }

  const initialize = () => call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "golden-test", version: "0" } });
  const list = () => call("tools/list", {});
  // The raw `result` of tools/call: { content: [...], isError? }
  async function tool(name, args) {
    const res = await call("tools/call", { name, arguments: args === undefined ? {} : args });
    if (res.error) return { rpcError: res.error };
    return res.result;
  }

  function waitStderr(re, ms = 8000) {
    if (re.test(stderr)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("stderr never matched " + re)), ms);
      stderrWaiters.push({ re, resolve: () => { clearTimeout(timer); resolve(); } });
    });
  }

  // ending stdin is the graceful path (the same one a disconnecting MCP client
  // takes); kill() is a timed fallback. Resolves on real exit so the port is free.
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) return resolve();
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    child.once("exit", finish);
    try { child.stdin.end(); } catch (e) {}
    const fallback = setTimeout(() => { try { child.kill(); } catch (e) {} }, 800);
    child.once("exit", () => clearTimeout(fallback));
    setTimeout(() => { try { child.kill("SIGKILL"); } catch (e) {} finish(); }, 4000);
  });

  return { child, port, token: env.FIGMA_BRIDGE_TOKEN, call, callFramed, initialize, list, tool, stop, waitStderr, stderr: () => stderr };
}

// Resolves once the server answers on its bridge port, i.e. it is the master.
async function waitMaster(server, ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${server.port}/status?token=${server.token}`);
      if (r.ok) return;
    } catch (e) {}
    await sleep(40);
  }
  throw new Error("bridge never came up on " + server.port);
}

async function waitFor(fn, ms = 4000, what = "condition") {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return;
    await sleep(20);
  }
  throw new Error("timed out waiting for " + what);
}

async function bridgeStatus(server) {
  const r = await fetch(`http://127.0.0.1:${server.port}/status?token=${server.token}`);
  return r.json();
}

async function waitClients(server, n, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await bridgeStatus(server)).wsClients === n) return;
    await sleep(30);
  }
  throw new Error("wsClients never reached " + n);
}

// A plugin stand-in: connects like ui.html does. `handler(cmd, n)` decides the
// reply for each command carrying an id; it may return
//   an object  -> merged into { type: "RESULT", success: true, id }
//   a Promise of one, or null/undefined -> { result: "ok" }
//   plugin.HANG -> never answers
// Every command received is recorded in `received` (id included).
const HANG = Symbol("hang");
function startFakePlugin({ port, token, fileName, handler, pluginVersion }) {
  const received = [];
  const acks = [];
  const plugin = { received, acks, HANG, handler: handler || null };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
  const reply = (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "RESULT", success: true, ...msg }));
  ws.onmessage = async (event) => {
    const cmd = JSON.parse(event.data);
    if (cmd.type === "CLIENT_ACK") { acks.push(cmd.clientId); return; }
    if (!cmd.id) return;
    const n = received.length;
    received.push(cmd);
    let out = plugin.handler ? plugin.handler(cmd, n) : null;
    if (out && typeof out.then === "function") out = await out;
    if (out === HANG) return;
    return reply({ id: cmd.id, ...(out && typeof out === "object" ? out : { result: "ok" }) });
  };
  plugin.opened = new Promise((resolve, reject) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "CLIENT_READY", fileName: fileName || "Golden File", pageName: "Page 1", pluginVersion: pluginVersion || "9.9.9" }));
      resolve();
    };
    ws.onerror = reject;
  });
  plugin.ws = ws;
  plugin.close = () => { try { ws.close(); } catch (e) {} };
  return plugin;
}

module.exports = { ROOT, SERVER_PATH, sleep, startServer, waitMaster, bridgeStatus, waitClients, waitFor, startFakePlugin, HANG };
