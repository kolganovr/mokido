// Golden-master contract for figma/index.js: what the MCP server ANSWERS to every
// tool call, and what it SENDS to the Figma plugin to get that answer. Run:
//   node tests/golden-tools.test.js
//   UPDATE_GOLDEN=1 node tests/golden-tools.test.js     (re-record the fixtures)
//
// It pins today's behaviour, not "correct" behaviour: when index.js is split
// into modules, any change in a reply, a hint's wording, a generated script or
// a command's payload shows up as a FAIL naming the scenario and the first
// differing path. Expected values live in tests/fixtures/golden-tools/*.json.
//
// Real server processes (stdio JSON-RPC) on ports 18801-18820, fake plugins over
// a real WebSocket, api.figma.com replaced by tests/helpers/fetch-stub.js (no
// network). Only the non-deterministic is normalised: the server version,
// command / client ids, ports, absolute paths, "N s ago" and a few timing keys.
// Needs Node >= 22 (global WebSocket).
const fs = require("fs");
const os = require("os");
const path = require("path");
const H = require("./helpers/server-harness");
const { sleep, startServer, waitMaster, waitClients, waitFor, bridgeStatus, startFakePlugin, HANG, ROOT } = H;

const FIX_DIR = path.join(__dirname, "fixtures", "golden-tools");
const UPDATE = process.env.UPDATE_GOLDEN === "1";
const TOKEN = "golden-test-token";

let failures = 0;
let checks = 0;
function check(name, cond, extra) {
  checks++;
  if (cond) return;
  failures++;
  console.log("  FAIL " + name + (extra !== undefined ? "  -> " + (typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 700) : ""));
}

// ---------------------------------------------------------------- normalising
let SERVER_VERSION = null;
const NUMERIC_KEYS = new Set(["lastSeenMsAgo", "lastPing", "pid", "elapsed_ms", "waited_ms", "ts"]);
const ROOT_VARIANTS = (() => {
  const r = path.resolve(ROOT);
  return [r, r.replace(/\\/g, "/"), r.replace(/\\/g, "\\\\")].sort((a, b) => b.length - a.length);
})();

function normString(s) {
  if (SERVER_VERSION) s = s.split(SERVER_VERSION).join("<version>");
  for (const v of ROOT_VARIANTS) {
    let i;
    while ((i = s.toLowerCase().indexOf(v.toLowerCase())) !== -1) s = s.slice(0, i) + "<root>" + s.slice(i + v.length);
  }
  // paths under <root> read the same on every OS (Windows recorded backslashes, CI on Linux sees slashes)
  s = s.replace(/<root>[A-Za-z0-9_.\- \\/]*/g, (m) => m.split("\\").join("/"));
  return s
    .replace(/cmd_[a-z0-9]+/g, "<cmd_id>")
    .replace(/ws_[a-z0-9]+/g, "<ws_id>")
    .replace(/127\.0\.0\.1:188\d\d/g, "127.0.0.1:<port>")
    .replace(/\b188\d\d\b/g, "<port>")
    .replace(/\b\d+s ago\b/g, "<N>s ago");
}
function norm(v, key) {
  if (typeof v === "string") return normString(v);
  if (typeof v === "number") return NUMERIC_KEYS.has(key) ? "<n>" : v;
  if (Array.isArray(v)) return v.map((x) => norm(x));
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) if (v[k] !== undefined) o[k] = norm(v[k], k);
    return o;
  }
  return v;
}

function describeText(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { parsed = undefined; }
  if (parsed !== undefined && parsed !== null && typeof parsed === "object") {
    return { type: "text", compact_json: JSON.stringify(parsed) === text, json: norm(parsed) };
  }
  const n = normString(text);
  return { type: "text", text: n.indexOf("\n") === -1 ? n : n.split("\n") };
}
function describeResult(res) {
  if (res.rpcError) return { rpcError: norm(res.rpcError) };
  const out = {};
  if (res.isError === true) out.isError = true;
  out.content = (res.content || []).map((p) => p.type === "text" ? describeText(p.text) : { type: p.type, mimeType: p.mimeType, data: p.data });
  const extra = Object.keys(res).filter((k) => k !== "content" && k !== "isError");
  for (const k of extra) out[k] = norm(res[k]);
  return out;
}
function describeSent(cmds) {
  return cmds.map((c) => {
    const o = {};
    for (const k of Object.keys(c)) {
      if (k === "id" || c[k] === undefined) continue;
      o[k] = k === "code" && typeof c[k] === "string" ? normString(c[k]).split("\n") : norm(c[k], k);
    }
    return o;
  });
}

// ---------------------------------------------------------------- fixtures
const seen = new Set();
let recorded = 0;

function firstDiff(a, b, p) {
  p = p || "$";
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || (a === null) !== (b === null)) {
    return `${p}: expected ${short(a)} but got ${short(b)}`;
  }
  if (typeof a === "string") {
    if (a === b) return null;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return `${p}: strings differ at char ${i}: expected "${a.slice(Math.max(0, i - 25), i + 45)}" but got "${b.slice(Math.max(0, i - 25), i + 45)}"`;
  }
  if (a === null || typeof a !== "object") return a === b ? null : `${p}: expected ${short(a)} but got ${short(b)}`;
  if (Array.isArray(a)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= a.length) return `${p}[${i}]: unexpected extra element ${short(b[i])}`;
      if (i >= b.length) return `${p}[${i}]: missing element ${short(a[i])}`;
      const d = firstDiff(a[i], b[i], `${p}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  for (const k of kb) if (!(k in a)) return `${p}.${k}: unexpected new field ${short(b[k])}`;
  for (const k of ka) if (!(k in b)) return `${p}.${k}: field is gone (was ${short(a[k])})`;
  for (const k of ka) {
    const d = firstDiff(a[k], b[k], `${p}.${k}`);
    if (d) return d;
  }
  if (ka.join("|") !== kb.join("|")) return `${p}: same fields, different ORDER: expected ${ka.join(",")} but got ${kb.join(",")}`;
  return null;
}
function short(v) {
  const s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v);
  return s === undefined ? "undefined" : s.length > 90 ? s.slice(0, 90) + "..." : s;
}

function golden(name, actual) {
  if (seen.has(name)) { check(`${name}: scenario name is unique`, false); return; }
  seen.add(name);
  const file = path.join(FIX_DIR, name + ".json");
  const normalized = JSON.parse(JSON.stringify(actual));
  if (UPDATE) {
    fs.writeFileSync(file, JSON.stringify(normalized, null, 2) + "\n");
    recorded++;
    return;
  }
  if (!fs.existsSync(file)) { check(`${name}: has a fixture`, false, "run UPDATE_GOLDEN=1 node tests/golden-tools.test.js"); return; }
  const expected = JSON.parse(fs.readFileSync(file, "utf8"));
  const diff = firstDiff(expected, normalized);
  check(`${name}`, diff === null, diff);
}

// ---------------------------------------------------------------- scenario plumbing
function fakePng(w, h) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b.toString("base64");
}
function treeOutline(lines, nested) {
  const pattern = nested ? [1, 2, 3, 3] : [1];
  const out = [];
  for (let i = 0; i < lines; i++) {
    const level = i === 0 ? 0 : pattern[(i - 1) % pattern.length];
    const body = `FRAME "Node ${i}" #9:${i} 320x200 @0,${i * 10} [V gap8 pad16] fill:#FFFFFF r8`;
    out.push("  ".repeat(level) + body.padEnd(100 - 2 * level, "."));
  }
  return out.join("\n");
}
const OUTLINE_ONE = 'FRAME "Card" #1:2 320x200 @0,0 [V gap8 pad16] fill:#FFFFFF r8';
const OUTLINE_SIMILAR = [
  'FRAME "Section" #1:1 1440x900 @0,0',
  '  FRAME "Dropdown" #1:10 320x48 @0,0 [H gap8 pad12] fill:#FFFFFF r8',
  '  FRAME "Dropdown" #1:11 320x48 @0,60 [H gap8 pad12] fill:#F5F0FF r8',
  '  FRAME "Dropdown" #1:12 320x48 @0,120 [H gap8 pad12] fill:#E0E0E0 r8'
].join("\n");

// What the fake plugin answers when a scenario gives no reply (and for every
// follow-up command, e.g. the after-write re-read the server sends on its own).
function defaultReply(cmd) {
  const type = cmd.type || "EXECUTE";
  if (type === "EXECUTE" && /^const a = /.test(cmd.code || "")) {
    const spec = JSON.parse(/^const a = (.*);$/m.exec(cmd.code)[1]);
    if (spec.view === "flow") return { result: { flow: "FLOW #21:2062 ON_CLICK -> OVERLAY #21:2086\nOVERLAY SETTINGS (frame properties of the overlay target, not part of the action)\n  position BOTTOM_CENTER" }, resultStashed: true, durationMs: 3 };
    return { result: { outline: OUTLINE_ONE }, resultStashed: true, durationMs: 3 };
  }
  return { result: "ok", durationMs: 3 };
}

async function bootGroup(port, { env, plugins, fetchRoutes, withFetchLog } = {}) {
  const fetchLog = withFetchLog ? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "golden-fetch-")), "log.jsonl") : undefined;
  const server = startServer({ port, env, fetchRoutes, fetchLog });
  const g = { server, port, plugins: [], fetchLog, fetchRead: 0 };
  const init = await server.initialize();
  if (!SERVER_VERSION) SERVER_VERSION = init.result.serverInfo.version;
  g.init = init;
  await waitMaster(server);
  for (const spec of plugins === undefined ? [{ name: "Golden File" }] : plugins) {
    const p = startFakePlugin({ port, token: TOKEN, fileName: spec.name });
    await p.opened;
    const want = g.plugins.length + 1;
    await waitClients(server, want);
    const t0 = Date.now();
    while (p.acks.length < 1 && Date.now() - t0 < 4000) await sleep(10);
    g.plugins.push({ name: spec.name, plugin: p });
  }
  g.stop = async () => {
    for (const x of g.plugins) x.plugin.close();
    await server.stop();
  };
  return g;
}

function wrapReply(reply) {
  return (cmd, n) => {
    if (n === 0 && reply !== undefined && reply !== null) return typeof reply === "function" ? reply(cmd) : reply;
    return defaultReply(cmd);
  };
}

// One scenario = one tool call: record the call, what reached the plugin(s)
// and the full reply. `opt.server` lets a scenario go through another process
// (the proxy); `opt.fetchLog` adds the REST requests the server made.
async function rec(g, name, tool, args, reply, opt) {
  opt = opt || {};
  for (const x of g.plugins) { x.plugin.received.length = 0; x.plugin.handler = wrapReply(reply); }
  const server = opt.server || g.server;
  const res = await server.tool(tool, args);
  const record = { call: { tool, arguments: args === undefined ? null : norm(args) } };
  if (g.plugins.length === 1) record.sent_to_plugin = describeSent(g.plugins[0].plugin.received);
  else {
    record.sent_to_plugin = {};
    for (const x of g.plugins) if (x.plugin.received.length) record.sent_to_plugin[x.name] = describeSent(x.plugin.received);
  }
  if (opt.fetchLog && g.fetchLog) {
    const lines = fs.existsSync(g.fetchLog) ? fs.readFileSync(g.fetchLog, "utf8").split("\n").filter(Boolean) : [];
    record.rest_requests = lines.slice(g.fetchRead).map((l) => norm(JSON.parse(l)));
    g.fetchRead = lines.length;
  }
  record.reply = describeResult(res);
  golden(name, record);
  return res;
}

async function recHttp(g, name, req) {
  const url = `http://127.0.0.1:${g.port}${req.path}`;
  const res = await fetch(url, { method: req.method || "GET", headers: req.headers || {}, body: req.body });
  const text = await res.text();
  const headers = {};
  for (const h of ["content-type", "access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers", "vary"]) {
    if (res.headers.get(h) !== null) headers[h] = res.headers.get(h);
  }
  golden(name, { request: { method: req.method || "GET", path: normString(req.path), headers: req.headers || {}, body: req.body === undefined ? null : req.body }, status: res.status, headers, body: describeText(text) });
}

// Poll (not sleep) until a job id the server printed can be read from a reply.
const jobIdOf = (res) => { try { return JSON.parse(res.content[0].text).job_id; } catch (e) { return null; } };

// ---------------------------------------------------------------- the REST fixtures
const CARD_DOC = {
  id: "1:1", name: "Card", type: "FRAME",
  absoluteBoundingBox: { x: 0, y: 0, width: 320, height: 120 },
  layoutMode: "VERTICAL", itemSpacing: 12, paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16, cornerRadius: 12,
  fills: [{ type: "SOLID", visible: true, color: { r: 1, g: 1, b: 1 } }],
  children: [
    { id: "1:2", name: "Title", type: "TEXT", absoluteBoundingBox: { x: 16, y: 16, width: 288, height: 24 }, characters: "Hello", style: { fontFamily: "Inter", fontWeight: 700, fontSize: 16, textAlignHorizontal: "LEFT" }, fills: [{ type: "SOLID", visible: true, color: { r: 0.1, g: 0.1, b: 0.1 } }] },
    { id: "1:3", name: "Hidden Layer", type: "TEXT", visible: false, absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 }, characters: "secret" },
    { id: "1:5", name: "Footer", type: "FRAME", absoluteBoundingBox: { x: 16, y: 80, width: 288, height: 24 }, children: [
      { id: "1:6", name: "Description", type: "TEXT", absoluteBoundingBox: { x: 16, y: 80, width: 288, height: 24 }, characters: "A longer paragraph of body copy nested two levels deep, which a shallow depth cuts away.", style: { fontFamily: "Inter", fontWeight: 400, fontSize: 13, textAlignHorizontal: "LEFT" } }
    ] }
  ]
};
const FILE_BODY = { name: "Golden file", lastModified: "2026-01-01T00:00:00Z", document: { id: "0:0", name: "Document", type: "DOCUMENT", children: [{ id: "0:1", name: "Page 1", type: "CANVAS", children: [CARD_DOC] }] } };
const NODES_BODY = { name: "Golden file", nodes: { "1:1": { document: CARD_DOC } } };
const R = (body, status) => ({ status: status || 200, body });
const REST_ROUTES = {
  "GET /me": R({ id: "u1", handle: "tester", email: "tester@example.com" }),
  "GET /files/AbC123?depth=2": R(FILE_BODY),
  "GET /files/AbC123?depth=1": R(FILE_BODY),
  "GET /files/AbC123/nodes?ids=1%3A1&depth=3": R(NODES_BODY),
  "GET /files/AbC123/nodes?ids=1%3A1%2C1%3A2&depth=1": R(NODES_BODY),
  "GET /images/AbC123?ids=1%3A1&format=png&scale=2": R({ err: null, images: { "1:1": "https://example.test/1.png" } }),
  "GET /images/AbC123?ids=1%3A1%2C1%3A2&format=svg&scale=1": R({ err: null, images: { "1:1": "https://example.test/1.svg", "1:2": "https://example.test/2.svg" } }),
  "GET /files/AbC123/images": R({ meta: { images: { ref1: "https://example.test/fill.png" } } }),
  "GET /files/AbC123/styles": R({ meta: { styles: [{ key: "s1", name: "Brand/Primary", style_type: "FILL" }] } }),
  "GET /files/AbC123/components": R({ meta: { components: [{ key: "c1", name: "Button", node_id: "5:5" }] } }),
  "GET /files/AbC123/comments": R({ comments: [{ id: "10", message: "Looks good", user: { handle: "tester" } }] }),
  "POST /files/AbC123/comments": R({ id: "11", message: "Nice", client_meta: { node_id: "1:2" } }),
  "GET /files/Gone404/comments": R({ status: 404, err: "Not found" }, 404)
};

// ================================================================ groups
async function groupMain() {
  console.log("\n== live + REST tools on one server (token, legacy on, one plugin) ==");
  const g = await bootGroup(18801, { env: { FIGMA_PERSONAL_ACCESS_TOKEN: "test", FIGMA_MCP_LEGACY_TOOLS: "1" }, fetchRoutes: REST_ROUTES, withFetchLog: true });
  try {
    golden("protocol--initialize", { result: norm(g.init.result) });
    const ping = await g.server.call("ping", {});
    golden("protocol--ping", norm(ping.result));
    const unk = await g.server.call("resources/list", {});
    golden("protocol--unknown-method", { error: norm(unk.error) });

    // ---- figma_execute_code
    await rec(g, "execute_code--write-named-id", "figma_execute_code",
      { code: "const n = figma.getNodeById('1:2'); n.opacity = 0.5; return 'ok';", description: "Dim the card" },
      { result: { done: true }, resultStashed: true, checkpointId: "cp_1", modified: ["1:2"], durationMs: 12 });
    await rec(g, "execute_code--write-new-ids-from-result", "figma_execute_code",
      { code: "const f = figma.createFrame(); f.name = 'A'; return { id: f.id };" },
      { result: { id: "5:1" }, created: ["5:1"], checkpointId: "cp_2", durationMs: 7, warnings: ["frame has no fill"] });
    const png = fakePng(800, 600);
    await rec(g, "execute_code--capture-options", "figma_execute_code",
      { code: "figma.getNodeById('1:2').x = 5;", capture: true, capture_node_ids: ["1:2", "1:3"], scale: 2, max_px: 512, description: "Move" },
      { result: "moved", modified: ["1:2"], screenshot: "data:image/png;base64," + png, targetName: "Card", captureNote: "Nothing was created, modified or captured, so no screenshot." });
    await rec(g, "execute_code--syntax-error", "figma_execute_code", { code: "const x = ;\nreturn x;" });
    await rec(g, "execute_code--no-code", "figma_execute_code", {});
    await rec(g, "execute_code--read-first-nudge", "figma_execute_code",
      { code: "const n = figma.getNodeById('1:2'); return n.name;" }, { result: "Title", durationMs: 4 });
    await rec(g, "execute_code--read-second-redirected-to-inspect", "figma_execute_code",
      { code: "const n = figma.getNodeById('1:2'); return n.name;" }, { result: { outline: OUTLINE_SIMILAR }, resultStashed: true });
    await rec(g, "execute_code--read-third-refused", "figma_execute_code",
      { code: "const n = figma.getNodeById('1:2'); return n.name;" });
    await rec(g, "execute_code--page-scan-blocked", "figma_execute_code",
      { code: "return figma.currentPage.findAll(n => n.type === 'TEXT').length;" });
    await rec(g, "execute_code--reactions-scan-blocked", "figma_execute_code",
      { code: "const hits = []; for (const n of figma.currentPage.findAllWithCriteria({ types: ['FRAME'] })) if (n.reactions.length) hits.push(n.id); return hits;" });
    await rec(g, "execute_code--run-anyway-lifts-guards", "figma_execute_code",
      { code: "/* run-anyway */ return figma.currentPage.findAll(n => n.type === 'TEXT').length;" }, { result: 3 });
    await rec(g, "execute_code--macro-peek-signature", "figma_execute_code",
      { code: "return bridge.setText.toString();" });
    await rec(g, "execute_code--macro-peek-all", "figma_execute_code",
      { code: "return Object.keys(bridge);" });
    await rec(g, "execute_code--overlay-look-by-hand-refused", "figma_execute_code",
      { code: "const n = figma.getNodeById('21:2086'); n.overlayPositionType = 'BOTTOM_CENTER'; n.overlayBackground = { type: 'SOLID_COLOR', color: { r: 0, g: 0, b: 0, a: 0.4 } };" });
    await rec(g, "execute_code--raw-overlay-reaction-refused", "figma_execute_code",
      { code: "const t = figma.getNodeById('21:2062'); await t.setReactionsAsync([{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: '21:2086', navigation: 'OVERLAY' }] }]);" });
    await rec(g, "execute_code--open-overlay-macro-done", "figma_execute_code",
      { code: "await bridge.openOverlay('21:2062', '21:2086', { position: 'BOTTOM_CENTER', dim: 0.4, closeOnOutside: true });" },
      { result: "#21:2062 ON_CLICK -> OVERLAY #21:2086. MANUAL STEP for the user: ...", resultStashed: true, modified: ["21:9", "21:2062", "21:2086"], checkpointId: "cp_ov", overlays: [{ trigger: "21:2062", overlay: "21:2086", manual: true }] });
    await rec(g, "execute_code--open-overlay-literal-ids-no-plugin-list", "figma_execute_code",
      { code: "await bridge.openOverlay('31:1', '31:2', { position: 'CENTER', dim: 0.5 });" },
      { result: "#31:1 ON_CLICK -> OVERLAY #31:2 (CENTER, dim #000000@0.5, click outside does nothing)", modified: ["31:1", "31:2"] });
    await rec(g, "execute_code--open-overlay-ids-in-variables", "figma_execute_code",
      { code: "const [t, o] = ['x', 'y'].map(n => figma.createFrame()); await bridge.openOverlay(t, o, { position: 'TOP_LEFT' });" },
      { result: "linked", modified: ["41:1", "41:2"], created: ["41:1", "41:2"] });
    await rec(g, "execute_code--open-overlay-look-set-flag", "figma_execute_code",
      { code: "await bridge.openOverlay('51:1', '51:2', { position: 'CENTER' });" },
      { result: "done", modified: ["51:1", "51:2"], overlays: [{ trigger: "51:1", overlay: "51:2", manual: false }] });
    await rec(g, "execute_code--overlay-look-after-look-set-link", "figma_execute_code",
      { code: "const o = figma.getNodeById('51:2'); o.overlayPositionType = 'CENTER';" });
    await rec(g, "execute_code--overlay-look-after-link-already-done", "figma_execute_code",
      { code: "const o = figma.getNodeById('21:2086'); o.overlayPositionType = 'CENTER';" });
    await rec(g, "execute_code--componentize-rewrite-lint", "figma_execute_code",
      { code: "const c = figma.createComponentFromNode(figma.getNodeById('1:2')); return c.id;" },
      { result: "6:1", created: ["6:1"] });
    await rec(g, "execute_code--font-memo-prelude", "figma_execute_code",
      { code: "await ensureFont('Inter', 'Bold'); const t = figma.createText(); t.fontName = { family: 'Inter', style: 'Bold' }; t.characters = 'Hi'; return t.id;" },
      { result: "7:1", created: ["7:1"] });
    await rec(g, "execute_code--param-name-shield", "figma_execute_code",
      { code: "const log = []; log.push(1); figma.createFrame(); return log;" }, { result: [1], created: ["8:1"] });
    await rec(g, "execute_code--diff-true-ignored", "figma_execute_code",
      { code: "figma.createRectangle(); return 1;", diff: true }, { result: 1, created: ["8:2"] });
    await rec(g, "execute_code--write-with-whole-page-scan-lint", "figma_execute_code",
      { code: "for (const n of figma.currentPage.findAll(n => n.type === 'TEXT')) { n.name = 'x'; } return 1;" }, { result: 1, modified: ["2:2"] });
    await rec(g, "execute_code--plugin-error-with-location", "figma_execute_code",
      { code: "foo(1);" }, { success: false, error: "ReferenceError: foo is not defined", code: "SCRIPT_RUNTIME_ERROR", line: 7, column: 3, at: "foo(1);" });
    await rec(g, "execute_code--plugin-error-plain", "figma_execute_code",
      { code: "return 1;" }, { success: false, error: "Execution failed in sandbox" });
    const union = [
      "Setting reactions failed validation:",
      "Expected reactions[0].actions[0] to be one of the following, but none matched:",
      "  Multiple issues at reactions[0].actions[0]:",
      "    Invalid literal value, expected \"NODE\" at reactions[0].actions[0].type",
      "    Required value missing at reactions[0].actions[0].transition",
      "  Multiple issues at reactions[0].actions[0]:",
      "    Invalid enum value, expected 'BACK' | 'CLOSE' at reactions[0].actions[0].type",
      "  Multiple issues at reactions[0].actions[0]:",
      "    Invalid literal value, expected \"URL\" at reactions[0].actions[0].type",
      "    Required value missing at reactions[0].actions[0].url",
      "  Multiple issues at reactions[0].actions[0]:",
      "    Invalid literal value, expected \"SET_VARIABLE\" at reactions[0].actions[0].type",
      "    Required value missing at reactions[0].actions[0].variableId",
      "    Required value missing at reactions[0].actions[0].variableValue",
      "  Multiple issues at reactions[0].actions[0]:",
      "    Invalid literal value, expected \"UPDATE_MEDIA_RUNTIME\" at reactions[0].actions[0].type",
      "    Required value missing at reactions[0].actions[0].mediaAction",
      "  at line 3",
      "HINT: see the docs"
    ].join("\n");
    await rec(g, "execute_code--validation-error-union-compressed", "figma_execute_code",
      { code: "return 1;" }, { success: false, error: union });
    await rec(g, "execute_code--validation-error-transition-and-overlay-keys", "figma_execute_code",
      { code: "return 1;" }, { success: false, error: "Setting reactions failed validation: Required value missing at actions[0].transition; unknown key 'overlayPositionType'" });
    await rec(g, "execute_code--validation-error-inside-result", "figma_execute_code",
      { code: "return 1;" }, { result: { caught: "x failed validation: Required value missing at actions[0].transition" } });
    await rec(g, "execute_code--big-result-shrunk", "figma_execute_code",
      { code: "return bridge.state.big;" },
      { result: { rows: Array.from({ length: 400 }, (_, i) => ({ id: "1:" + i, name: "Row " + i, fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }] })) }, resultStashed: true, durationMs: 9 });
    await rec(g, "execute_code--big-result-budget-zero-capped", "figma_execute_code",
      { code: "return bridge.state.big;", max_output_bytes: 0 },
      { result: { rows: Array.from({ length: 400 }, (_, i) => ({ id: "1:" + i, name: "Row " + i })) }, resultStashed: true });
    await rec(g, "execute_code--big-result-budget-small", "figma_execute_code",
      { code: "return bridge.state.big;", max_output_bytes: 1200 },
      { result: { rows: Array.from({ length: 120 }, (_, i) => ({ id: "2:" + i, name: "Строка таблицы " + i })) }, resultStashed: true, created: Array.from({ length: 80 }, (_, i) => "3:" + i), checkpointId: "cp_3" });

    // ---- long writes become jobs
    const slow = (ms, out) => async () => { await sleep(ms); return out; };
    const r1 = await rec(g, "execute_code--async-escalates-to-job", "figma_execute_code",
      { code: "figma.getNodeById('1:2').opacity = 0.4; return 1;", async: true, description: "Slow write" },
      async (cmd) => {
        g.plugins[0].plugin.ws.send(JSON.stringify({ type: "PROGRESS", id: cmd.id, step: 1, of: 3, note: "working", ts: 5 }));
        await sleep(500);
        return { result: { done: true }, resultStashed: true, modified: ["1:2"], checkpointId: "cp_job" };
      });
    const jobId = jobIdOf(r1);
    check("an async call returns a job id", !!jobId, r1);
    await rec(g, "job_status--still-running", "figma_job_status", { job_id: jobId, wait_ms: 30 });
    await rec(g, "job_status--done-renders-like-a-write", "figma_job_status", { job_id: jobId, wait_ms: 4000 });
    await rec(g, "job_status--forgotten-after-read", "figma_job_status", { job_id: jobId, wait_ms: 10 });
    await rec(g, "job_status--unknown-job", "figma_job_status", { job_id: "cmd_nope" });
    await rec(g, "job_status--no-job-id", "figma_job_status", { wait_ms: 10 });
    const r2 = await rec(g, "execute_code--async-job-that-fails", "figma_execute_code",
      { code: "return 1;", async: true }, async () => { await sleep(300); return { success: false, error: "ReferenceError: x is not defined", code: "SCRIPT_RUNTIME_ERROR", line: 2, at: "x" }; });
    await rec(g, "job_status--failed-job", "figma_job_status", { job_id: jobIdOf(r2), wait_ms: 4000 });
    const r3 = await rec(g, "execute_code--async-read-job", "figma_execute_code",
      { code: "return 1;", async: true }, slow(300, { result: "late", durationMs: 300 }));
    await rec(g, "job_status--done-read-default-wait", "figma_job_status", { job_id: jobIdOf(r3) });

    // ---- figma_inspect
    await rec(g, "inspect--outline-two-ids-similar-hint", "figma_inspect", { node_ids: ["1:1", "1:2"], depth: 1 },
      { result: { outline: OUTLINE_SIMILAR }, resultStashed: true, durationMs: 5 });
    await rec(g, "inspect--outline-no-args", "figma_inspect", {}, { result: { outline: OUTLINE_ONE }, resultStashed: true });
    await rec(g, "execute_code--read-after-inspect-reset-nudge", "figma_execute_code",
      { code: "const n = figma.getNodeById('1:3'); return n.characters;" }, { result: "Hi" });
    await rec(g, "execute_code--stash-slice-redirected-to-last-read", "figma_execute_code",
      { code: "return bridge.state.lastResult.rows.slice(0, 5);" });
    await rec(g, "execute_code--stash-slice-refused-next", "figma_execute_code",
      { code: "return bridge.state.lastResult.rows.slice(5, 10);" });
    await rec(g, "inspect--find-by-name-and-type", "figma_inspect", { find: "Dropdown", find_type: "frame", limit: 5, node_ids: ["1:1"] },
      { result: { found: "3 matches", outline: OUTLINE_SIMILAR } });
    await rec(g, "inspect--find-text", "figma_inspect", { find_text: "Hello" }, { result: { found: "no matches on page \"Page 1\"", other_pages: "\"Page 2\": 1 (matches; switch page to use them)" } });
    await rec(g, "inspect--props", "figma_inspect", { node_ids: ["1:2"], props: ["font", "text"] },
      { result: { props: { "1:2": { font: "Inter Bold 16", text: "Hello" } } } });
    await rec(g, "inspect--compare", "figma_inspect", { node_ids: ["1:3", "1:4"], compare: "1:2" },
      { result: { compare: "1:3: width 300 vs 320\n1:4: fill #000000 vs #FFFFFF\nREF 1:2 width 320 fill #FFFFFF" } });
    await rec(g, "inspect--like", "figma_inspect", { like: "1:2", node_ids: ["1:1"] },
      { result: { like: "1:10 differs: fill #F5F0FF vs #FFFFFF\nREF 1:2 fill #FFFFFF" } });
    await rec(g, "inspect--view-table", "figma_inspect", { node_ids: ["1:1"], view: "table" },
      { result: { outline: "TABLE #1:1\n  header: Name | Status" } });
    await rec(g, "inspect--view-map", "figma_inspect", { view: "map" }, { result: { outline: "SECTION \"Main\" #1:1" } });
    await rec(g, "inspect--view-flow-after-overlay-link", "figma_inspect", { node_ids: ["21:2062"], view: "flow" },
      { result: { flow: "#21:2062 ON_CLICK -> OVERLAY #21:2086: BOTTOM_CENTER\nOVERLAY SETTINGS (frame properties of the overlay target, not part of the action)\n  position CENTER" } });
    await rec(g, "inspect--check-and-context", "figma_inspect", { node_ids: ["1:2"], context: true, check: { "1:2": { width: 320 } } },
      { result: { check: "PASS 1:2 width", context: "parent 1:1" } });
    await rec(g, "inspect--offset-pages-the-outline", "figma_inspect", { node_ids: ["80:0"], offset: 20 },
      { result: { outline: treeOutline(80, false) }, resultStashed: true });
    await rec(g, "inspect--budget-small-nested", "figma_inspect", { node_ids: ["70:0"], max_output_bytes: 1500 },
      { result: { outline: treeOutline(70, true) }, resultStashed: true });
    await rec(g, "inspect--plugin-error", "figma_inspect", { node_ids: ["9:9"] },
      { success: false, error: "Node 9:9 not found", code: "NODE_NOT_FOUND" });

    // ---- figma_read_canvas
    await rec(g, "read_canvas--jsx-default", "figma_read_canvas", { node_ids: ["1:1"] }, { result: { document: CARD_DOC } });
    await rec(g, "read_canvas--aliases-tree-hidden", "figma_read_canvas", { node_id: "1:1", format: "tree", include_hidden: true, depth: 2 }, { result: { document: CARD_DOC } });
    await rec(g, "read_canvas--json-budget-tokens", "figma_read_canvas", { nodeIds: "1:1,1:2", format: "json", budget_tokens: 100 }, { result: { document: CARD_DOC } });
    await rec(g, "read_canvas--depth-fallback-and-cut", "figma_read_canvas", { ids: ["1:1"], budget_tokens: 5 }, { result: { document: CARD_DOC } });
    await rec(g, "read_canvas--truncated-top-note", "figma_read_canvas", {}, { result: { document: CARD_DOC, truncatedTop: true } });
    await rec(g, "read_canvas--plugin-error", "figma_read_canvas", { node_ids: ["9:9"] }, { success: false, error: "No such node", code: "NODE_NOT_FOUND" });

    // ---- figma_rollback
    await rec(g, "rollback--last", "figma_rollback", {},
      { result: { checkpoint_id: "cp_ov", label: "openOverlay", removed: [], restored: ["21:2062"], missing: [] } });
    await rec(g, "rollback--explicit-checkpoint", "figma_rollback", { checkpoint_id: "cp_1" },
      { result: { checkpoint_id: "cp_1", label: "x", removed: ["5:1"], restored: [], missing: ["5:2"] } });
    await rec(g, "rollback--plugin-error", "figma_rollback", { checkpoint_id: "cp_gone" }, { success: false, error: "Checkpoint cp_gone not found", code: "CHECKPOINT_NOT_FOUND" });
    await rec(g, "execute_code--overlay-look-after-rollback-not-linked", "figma_execute_code",
      { code: "const o = figma.getNodeById('21:2086'); o.overlayPositionType = 'CENTER';" });

    // ---- figma_list_targets, figma_screenshot, figma_get_selection
    const pws = g.plugins[0].plugin.ws;
    pws.send(JSON.stringify({ type: "PING" }));
    pws.send(JSON.stringify({ type: "CLIENT_FOCUS", fileName: "Golden File", fileKey: "key1", pageName: "Page 1", pluginVersion: "9.9.9" }));
    pws.send(JSON.stringify({ type: "PAGE_CHANGED", pageName: "Page 2" }));
    await waitFor(async () => (await bridgeStatus(g.server)).targets[0].pageName === "Page 2", 4000, "PAGE_CHANGED");
    await rec(g, "list_targets--one-plugin", "figma_list_targets", {});
    const shots = (n) => ({ result: `Captured ${n} node(s)`, screenshots: Array.from({ length: n }, (_, i) => ({ id: "9:" + (i + 1), name: "Frame " + (i + 1), base64: fakePng(800 + i, 600) })) });
    await rec(g, "screenshot--default", "figma_screenshot", {}, shots(1));
    await rec(g, "screenshot--ids-options-and-image-cap", "figma_screenshot", { node_id: "9:1", scale: 2, max_px: 256, description: "Look" }, shots(6));
    await rec(g, "screenshot--alias-nodeIds-with-errors", "figma_screenshot", { nodeIds: "9:1,9:2" },
      { result: "Captured 1", screenshots: [{ id: "9:1", name: "Ok", base64: fakePng(10, 10) }, { id: "9:2", name: "Bad", error: "node is hidden" }] });
    await rec(g, "screenshot--no-result-text", "figma_screenshot", { ids: ["9:3"] }, { screenshots: [] });
    await rec(g, "screenshot--plugin-error", "figma_screenshot", { node_ids: ["9:9"] }, { success: false, error: "Selection is empty", code: "EMPTY_SELECTION" });
    await rec(g, "get_selection--two-nodes", "figma_get_selection", {},
      { result: [{ id: "1:2", name: "Title", type: "TEXT", width: 288, height: 24, x: 16, y: 16, page: "Page 1", parentId: "1:1", parentName: "Card", fills: "#1A1A1A", characters: "Hello" }, { id: "1:1", name: "Card", type: "FRAME", width: 320, height: 120, x: 0, y: 0, page: "Page 1", parentId: "0:1", parentName: "Page 1", layoutMode: "VERTICAL", fills: "#FFFFFF" }] });
    await rec(g, "get_selection--empty-with-budget", "figma_get_selection", { max_output_bytes: 800 }, { result: [] });

    // ---- design-system and variables tools
    await rec(g, "find_components--query", "figma_find_components", { query: "Button", page_name: "Components", include_variants: false, limit: 5, refresh_index: true },
      { result: { components: [{ id: "5:5", name: "Button", variants: 4 }] } });
    await rec(g, "find_components--defaults", "figma_find_components", {}, { result: { components: [] } });
    await rec(g, "find_components--plugin-error", "figma_find_components", { query: "x" }, { success: false, error: "Index not ready", code: "INDEX_NOT_READY" });
    await rec(g, "insert_component_instance--by-name", "figma_insert_component_instance",
      { component_name: "Button", properties: { Label: "Go" }, text_overrides: { title: "Hi" }, target_parent_id: "1:1", position: { x: 10, y: 20 } },
      { result: "Inserted 6:6", created: ["6:6"], checkpointId: "cp_i", warnings: ["text overflows"] });
    await rec(g, "insert_component_instance--capture-by-id", "figma_insert_component_instance",
      { component_id: "5:5", capture: true, scale: 2, max_px: 300 },
      { result: "Inserted 6:7", created: ["6:7"], screenshot: png });
    await rec(g, "insert_component_instance--plugin-error", "figma_insert_component_instance", { component_name: "Nope" }, { success: false, error: "No component named Nope", code: "COMPONENT_NOT_FOUND" });
    await rec(g, "get_variables--collection", "figma_get_variables", { collection_name: "Brand", limit: 10 },
      { result: { collections: [{ name: "Brand", modes: ["Light", "Dark"], variables: [{ name: "primary", values: { Light: "#8C66F2", Dark: "#B49CFF" } }] }] } });
    await rec(g, "get_variables--defaults-budget", "figma_get_variables", { max_output_bytes: 700 },
      { result: { collections: Array.from({ length: 30 }, (_, i) => ({ name: "Collection " + i, modes: ["Light", "Dark"], variables: 12 })) } });
    await rec(g, "set_variables_mode--apply", "figma_set_variables_mode", { collection_name: "Brand", mode_name: "Dark", target_id: "1:1", capture: true },
      { result: "Mode Dark set on 1:1", modified: ["1:1"], screenshot: png });
    await rec(g, "set_variables_mode--plugin-error", "figma_set_variables_mode", { collection_name: "Nope", mode_name: "Dark" }, { success: false, error: "Collection Nope not found", code: "COLLECTION_NOT_FOUND" });
    await rec(g, "insert_svg--full-options", "figma_insert_svg",
      { svg_code: "<svg viewBox=\"0 0 24 24\"><path d=\"M0 0h24v24H0z\"/></svg>", name: "ic_box", width: 32, height: 32, fill_override: "#111111", stroke_override: "#222222", color_override: "#333333", target_parent_id: "1:1", position: { x: 1, y: 2 }, as_component: true, capture: true, scale: 3 },
      { result: "Inserted icon 6:8", created: ["6:8"], screenshot: png });
    await rec(g, "insert_svg--minimal", "figma_insert_svg", { svg_code: "<svg/>" }, { result: "Inserted 6:9", created: ["6:9"] });
    await rec(g, "insert_svg--plugin-error", "figma_insert_svg", { svg_code: "not svg" }, { success: false, error: "Invalid SVG", code: "INVALID_SVG" });
    await rec(g, "get_canvas_layout--args", "figma_get_canvas_layout", { direction: "DOWN", gap: 40, limit: 50, layout: "grid", columns: 3 },
      { result: { free: { x: 0, y: 1200 }, frames: [{ id: "1:1", x: 0, y: 0, w: 320, h: 120 }] } });
    await rec(g, "get_canvas_layout--defaults", "figma_get_canvas_layout", {}, { result: { free: { x: 1400, y: 0 } } });
    await rec(g, "get_canvas_layout--plugin-error", "figma_get_canvas_layout", {}, { success: false, error: "Page is empty", code: "EMPTY_PAGE" });

    // ---- figma_html: a thin wrapper, the code it sends (bridge.fromHtml + JSON args) is the contract
    const htmlReply = { result: { ok: true, roots: [{ id: "9:1", name: "Landing", w: 1440, h: 900, x: 0, y: 0 }], layers: 12, auto_layout: "80% of 5 frames", absolute_fallback: 0, boxes_within_1px: "11/12", warning_counts: {}, warnings: ["font_fallback 9:4: Inter Black missing"] }, created: ["9:1"], checkpointId: "cp_h" };
    await rec(g, "html--inline-full-options", "figma_html",
      { html: "<div style=\"display:flex\">Тест \"q\"</div>", widths: [1440, 390], height: 800, name: "Landing", parent: "1:1", x: 10, y: 20, capture: true, max_output_bytes: 2000 }, htmlReply);
    await rec(g, "html--from-path", "figma_html", { path: path.join(__dirname, "fixtures", "html-page", "page.html").split(path.sep).join("/") }, htmlReply);
    await rec(g, "html--plugin-error", "figma_html", { html: "<p>x</p>" }, { success: false, error: "HTML_WALK_TIMEOUT: the Mokido plugin window did not return the layout in 20 s.", code: "HTML_WALK_TIMEOUT" });
    await rec(g, "html--no-input", "figma_html", {});
    await rec(g, "html--both-inputs", "figma_html", { html: "<p>x</p>", path: "page.html" });
    await rec(g, "html--missing-file", "figma_html", { path: path.join(__dirname, "fixtures", "html-page", "nope.html").split(path.sep).join("/") });

    // ---- legacy figma_create_ui_card (generated script is the contract)
    await rec(g, "create_ui_card--defaults", "figma_create_ui_card", {}, { result: "Created UI Card with ID: 7:7", screenshot: "data:image/png;base64," + png });
    await rec(g, "create_ui_card--custom-escapes", "figma_create_ui_card",
      { title: "C:\\Users\\x \"quoted\"\nline", subtitle: "", badge_text: "", button_text: "Go", bg_color: "#abc", width: 512.4, scale: 2, max_px: 400 },
      { result: "Created UI Card with ID: 7:8" });
    await rec(g, "create_ui_card--bad-width-falls-back", "figma_create_ui_card", { width: -5, bg_color: "112233" }, { result: "Created UI Card with ID: 7:9" });
    await rec(g, "create_ui_card--invalid-hex", "figma_create_ui_card", { bg_color: "#12" });
    await rec(g, "create_ui_card--plugin-error", "figma_create_ui_card", {}, { success: false, error: "Font Inter Medium is missing", code: "FONT_MISSING" });

    // ---- unknown tool
    await rec(g, "default--unknown-tool", "figma_does_not_exist", { a: 1 });
    await rec(g, "default--unknown-tool-no-arguments", "nope", undefined);

    // ---- REST
    const F = { fetchLog: true };
    await rec(g, "rest--get_me", "get_me", {}, undefined, F);
    await rec(g, "rest--get_file-default-jsx", "get_file", { file_key: "AbC123" }, undefined, F);
    await rec(g, "rest--get_file-url-tree-depth-1", "get_file", { file_key: "https://www.figma.com/design/AbC123/My-File?node-id=1-1", depth: 1, format: "tree", include_hidden: true, max_depth: 3 }, undefined, F);
    await rec(g, "rest--get_file-raw", "get_file", { file_key: "AbC123", format: "raw" }, undefined, F);
    await rec(g, "rest--get_file-unsimplified", "get_file", { file_key: "AbC123", simplify: false }, undefined, F);
    await rec(g, "rest--get_file-budget-tokens", "get_file", { file_key: "AbC123", budget_tokens: 110 }, undefined, F);
    await rec(g, "rest--get_file-budget-ignored-for-raw", "get_file", { file_key: "AbC123", budget_tokens: 40, format: "raw" }, undefined, F);
    await rec(g, "rest--get_file-no-key", "get_file", {}, undefined, F);
    await rec(g, "rest--get_node-url-node-id", "get_node", { file_key: "https://www.figma.com/file/AbC123/x?node-id=1%3A1" }, undefined, F);
    await rec(g, "rest--get_node-ids-depth-json", "get_node", { file_key: "AbC123", node_ids: ["1:1", "1-2"], depth: 1, format: "json", budget_tokens: 100 }, undefined, F);
    await rec(g, "rest--get_node-no-node-ids", "get_node", { file_key: "AbC123" }, undefined, F);
    await rec(g, "rest--get_image-url-default", "get_image", { file_key: "https://www.figma.com/design/AbC123/x?node-id=1-1" }, undefined, F);
    await rec(g, "rest--get_image-svg-scale", "get_image", { file_key: "AbC123", node_ids: ["1:1", "1:2"], format: "svg", scale: 1 }, undefined, F);
    await rec(g, "rest--get_image-no-node-ids", "get_image", { file_key: "AbC123" }, undefined, F);
    await rec(g, "rest--get_image_fills", "get_image_fills", { file_key: "AbC123" }, undefined, F);
    await rec(g, "rest--get_styles", "get_styles", { file_key: "AbC123" }, undefined, F);
    await rec(g, "rest--get_components", "get_components", { file_key: "AbC123" }, undefined, F);
    await rec(g, "rest--get_comments", "get_comments", { file_key: "AbC123" }, undefined, F);
    await rec(g, "rest--get_comments-api-error-404", "get_comments", { file_key: "Gone404" }, undefined, F);
    await rec(g, "rest--get_comments-unrouted-404-body", "get_comments", { file_key: "Unknown" }, undefined, F);
    await rec(g, "rest--post_comment-with-node", "post_comment", { file_key: "AbC123", message: "Nice", node_id: "1-2" }, undefined, F);
    await rec(g, "rest--post_comment-plain", "post_comment", { file_key: "AbC123", message: "Nice" }, undefined, F);

    // ---- the HTTP surface of the bridge, same process
    console.log("  (http)");
    await recHttp(g, "http--status", { path: `/status?token=${TOKEN}` });
    await recHttp(g, "http--no-token-forbidden", { path: "/status" });
    await recHttp(g, "http--wrong-origin-forbidden", { path: `/status?token=${TOKEN}`, headers: { Origin: "https://evil.example" } });
    await recHttp(g, "http--token-in-header-and-figma-origin", { path: "/status", headers: { "X-Bridge-Token": TOKEN, Origin: "https://www.figma.com" } });
    await recHttp(g, "http--options-allowed-origin", { path: "/execute", method: "OPTIONS", headers: { Origin: "https://www.figma.com" } });
    await recHttp(g, "http--options-bad-origin", { path: "/execute", method: "OPTIONS", headers: { Origin: "https://evil.example" } });
    await recHttp(g, "http--unknown-path-404", { path: `/nothing?token=${TOKEN}` });
    await recHttp(g, "http--result-bad-json-400", { path: `/result?token=${TOKEN}`, method: "POST", body: "{not json" });
    await recHttp(g, "http--result-accepted", { path: `/result?token=${TOKEN}`, method: "POST", body: JSON.stringify({ id: "cmd_unknown", success: true }) });
    await recHttp(g, "http--execute-bad-json-500", { path: `/execute?token=${TOKEN}`, method: "POST", body: "{nope" });
    g.plugins[0].plugin.received.length = 0;
    g.plugins[0].plugin.handler = () => ({ result: { direct: true }, durationMs: 1 });
    await recHttp(g, "http--execute-direct", { path: `/execute?token=${TOKEN}`, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "GET_VARIABLES", limit: 1, timeoutMs: 3000 }) });
    golden("http--execute-direct-sent-to-plugin", { sent_to_plugin: describeSent(g.plugins[0].plugin.received) });
    g.plugins[0].plugin.handler = () => ({ success: false, error: "boom", code: "BOOM", line: 3 });
    await recHttp(g, "http--execute-plugin-failure-500", { path: `/execute?token=${TOKEN}`, method: "POST", body: JSON.stringify({ type: "GET_VARIABLES" }) });
    await recHttp(g, "http--job-unknown", { path: `/job?token=${TOKEN}&id=cmd_none&wait_ms=0` });
    golden("http--ws-status-after", { status: norm(await (await fetch(`http://127.0.0.1:${g.port}/status?token=${TOKEN}`)).json()) });
  } finally {
    await g.stop();
  }
}

async function groupBare() {
  console.log("\n== no plugin, no REST token (default config) ==");
  const g = await bootGroup(18802, { plugins: [] });
  try {
    golden("protocol--framed-ping", { result: norm((await g.server.callFramed("ping", {})).result) });
    golden("protocol--framed-tools-call", { result: describeResult((await g.server.callFramed("tools/call", { name: "figma_list_targets", arguments: {} })).result) });
    golden("protocol--tools-call-without-params", { result: describeResult((await g.server.call("tools/call", undefined)).result) });
    await rec(g, "bare--list_targets-empty-hint", "figma_list_targets", {});
    await rec(g, "bare--execute_code-no-client", "figma_execute_code", { code: "return 1;" });
    await rec(g, "bare--inspect-no-client", "figma_inspect", { node_ids: ["1:1"] });
    await rec(g, "bare--get_variables-no-client", "figma_get_variables", {});
    await rec(g, "bare--rest-without-token", "get_file", { file_key: "AbC123" });
    await rec(g, "bare--rest-me-without-token", "get_me", {});
    // a plugin that brings a wrong token is remembered and named in the next error
    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${g.port}/?token=wrong`);
      ws.onerror = () => resolve();
      ws.onclose = () => resolve();
      ws.onopen = () => { ws.close(); resolve(); };
    });
    await g.server.waitStderr(/REJECTED/);
    await rec(g, "bare--execute_code-after-rejected-plugin", "figma_execute_code", { code: "return 1;" });
  } finally {
    await g.stop();
  }
}

async function groupTargets() {
  console.log("\n== target routing, three documents ==");
  const g = await bootGroup(18803, { plugins: [{ name: "Alpha" }, { name: "Beta" }, { name: "Gamma" }], env: { FIGMA_MCP_TIMEOUT_FAST_MS: "700" } });
  try {
    // Gamma connected last, so it holds the focus
    await rec(g, "targets--list-three", "figma_list_targets", {});
    await rec(g, "targets--focused-wins-without-target", "figma_get_variables", {});
    await rec(g, "targets--by-name-case-insensitive", "figma_get_variables", { target: "bEtA", collection_name: "X" });
    await rec(g, "targets--execute-code-goes-to-target", "figma_execute_code", { code: "return 1;", target: "Alpha" });
    await rec(g, "targets--unknown-name", "figma_get_variables", { target: "Delta" });
    await rec(g, "targets--screenshot-target", "figma_screenshot", { node_ids: ["1:1"], target: "Beta" }, { result: "Captured 1", screenshots: [{ id: "1:1", name: "A", base64: fakePng(5, 5) }] });
    await rec(g, "targets--inspect-target", "figma_inspect", { node_ids: ["1:1"], target: "Alpha" });
    await rec(g, "targets--timeout-when-plugin-silent", "figma_get_variables", { target: "Beta" }, () => HANG);
    // the focused plugin leaves: Alpha and Beta are both unfocused now
    g.plugins[2].plugin.close();
    await waitClients(g.server, 2);
    await rec(g, "targets--ambiguous-none-focused", "figma_get_variables", {});
    await rec(g, "targets--ambiguous-resolved-by-name", "figma_get_variables", { target: "Alpha" });
    await rec(g, "targets--list-two", "figma_list_targets", {});
    // a long write on Alpha that never answers: the next call to Alpha is told what blocks it
    await rec(g, "targets--long-write-becomes-job", "figma_execute_code", { code: "return 1;", async: true, target: "Alpha" }, () => HANG);
    await rec(g, "targets--timeout-names-the-busy-job", "figma_get_variables", { target: "Alpha" }, () => HANG);
    // a plugin that disconnects with a command in flight
    const delta = startFakePlugin({ port: 18803, token: TOKEN, fileName: "Delta" });
    await delta.opened;
    await waitClients(g.server, 3);
    await waitFor(() => delta.acks.length > 0, 4000, "Delta ack");
    g.plugins.push({ name: "Delta", plugin: delta });
    await rec(g, "targets--plugin-disconnects-mid-call", "figma_get_variables", { target: "Delta" }, () => { delta.close(); return HANG; });
  } finally {
    await g.stop();
  }
}

async function groupProxy() {
  console.log("\n== a second server on the same port is a proxy ==");
  const g = await bootGroup(18804, { env: { FIGMA_PERSONAL_ACCESS_TOKEN: "test" }, fetchRoutes: REST_ROUTES });
  const proxy = startServer({ port: 18804, env: { FIGMA_PERSONAL_ACCESS_TOKEN: "test" }, fetchRoutes: REST_ROUTES });
  try {
    await proxy.initialize();
    await proxy.waitStderr(/already in use/);
    const o = { server: proxy };
    await rec(g, "proxy--execute_code-write", "figma_execute_code", { code: "figma.getNodeById('1:2').opacity = 0.5;", description: "via proxy" },
      { result: { done: true }, modified: ["1:2"], checkpointId: "cp_p", durationMs: 8 }, o);
    await rec(g, "proxy--inspect", "figma_inspect", { node_ids: ["1:1"] }, { result: { outline: OUTLINE_ONE }, resultStashed: true }, o);
    await rec(g, "proxy--screenshot", "figma_screenshot", { node_ids: ["1:1"] }, { result: "Captured 1", screenshots: [{ id: "1:1", name: "A", base64: fakePng(5, 5) }] }, o);
    await rec(g, "proxy--list_targets-from-master", "figma_list_targets", {}, undefined, o);
    await rec(g, "proxy--plugin-error-relayed", "figma_get_variables", {}, { success: false, error: "Collection list failed", code: "VARIABLES_FAILED", line: 4 }, o);
    await rec(g, "proxy--unknown-target-relayed", "figma_get_variables", { target: "Nope" }, undefined, o);
    await rec(g, "proxy--syntax-error-caught-locally", "figma_execute_code", { code: "const = 1;" }, undefined, o);
    const j = await rec(g, "proxy--async-job-created", "figma_execute_code", { code: "figma.getNodeById('1:2').x = 1;", async: true },
      async () => { await sleep(400); return { result: "slow done", modified: ["1:2"], durationMs: 400 }; }, o);
    await rec(g, "proxy--job_status-through-master", "figma_job_status", { job_id: jobIdOf(j), wait_ms: 4000 }, undefined, o);
    await rec(g, "proxy--job_status-unknown-job", "figma_job_status", { job_id: "cmd_zzz", wait_ms: 10 }, undefined, o);
    await rec(g, "proxy--rest-from-proxy", "get_comments", { file_key: "AbC123" }, undefined, o);
    // the master exits: the proxy says so, then takes the port over
    await g.stop();
    await rec(g, "proxy--master-gone-error", "figma_get_variables", {}, undefined, o);
    await waitMaster(proxy);
    await rec(g, "proxy--after-takeover-is-master-without-plugin", "figma_list_targets", {}, undefined, o);
    await rec(g, "proxy--after-takeover-no-plugin-error", "figma_get_variables", {}, undefined, o);
  } finally {
    await proxy.stop();
    await g.stop();
  }
}

async function groupPoll() {
  console.log("\n== a plugin that long-polls over HTTP ==");
  const g = await bootGroup(18805, { plugins: [] });
  try {
    const pollUrl = `http://127.0.0.1:${g.port}/poll?token=${TOKEN}`;
    const poll = fetch(pollUrl).then((r) => r.json());
    const t0 = Date.now();
    while (!(await (await fetch(`http://127.0.0.1:${g.port}/status?token=${TOKEN}`)).json()).connected && Date.now() - t0 < 4000) await sleep(20);
    const tool = g.server.tool("figma_execute_code", { code: "return 41 + 1;", description: "polled" });
    const cmd = await poll;
    golden("poll--command-handed-to-http-plugin", { command: norm({ ...cmd, id: "cmd_x" }) });
    const posted = await fetch(`http://127.0.0.1:${g.port}/result?token=${TOKEN}`, { method: "POST", body: JSON.stringify({ id: cmd.id, success: true, result: 42, durationMs: 2 }) });
    check("POST /result is accepted", posted.status === 200, posted.status);
    golden("poll--reply-after-http-result", { reply: describeResult(await tool) });
  } finally {
    await g.stop();
  }
}

async function groupListings() {
  console.log("\n== tools/list in the three configurations ==");
  const configs = [
    { name: "default", env: {}, port: 18806 },
    { name: "rest-token", env: { FIGMA_PERSONAL_ACCESS_TOKEN: "test" }, port: 18807 },
    { name: "legacy", env: { FIGMA_MCP_LEGACY_TOOLS: "1" }, port: 18808 }
  ];
  for (const c of configs) {
    const s = startServer({ port: c.port, env: c.env });
    try {
      const init = await s.initialize();
      if (!SERVER_VERSION) SERVER_VERSION = init.result.serverInfo.version;
      const list = await s.list();
      const tools = list.result.tools;
      golden("tools_list--" + c.name, { names: tools.map((t) => t.name), tools: norm(tools) });
    } finally {
      await s.stop();
    }
  }
}

async function main() {
  if (typeof WebSocket === "undefined") { console.log("SKIP: needs Node >= 22 (global WebSocket)"); return; }
  fs.mkdirSync(FIX_DIR, { recursive: true });
  const started = Date.now();
  await groupListings();
  await groupMain();
  await groupBare();
  await groupTargets();
  await groupProxy();
  await groupPoll();

  const files = fs.readdirSync(FIX_DIR).filter((f) => f.endsWith(".json"));
  const orphans = files.filter((f) => !seen.has(f.replace(/\.json$/, "")));
  if (UPDATE) {
    for (const f of orphans) fs.unlinkSync(path.join(FIX_DIR, f));
    console.log(`\nUPDATE_GOLDEN: wrote ${recorded} fixtures, removed ${orphans.length} orphan(s)`);
  } else {
    check("no fixture without a scenario", orphans.length === 0, orphans);
  }
  console.log(`\n${seen.size} scenarios, ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().then(() => {
  if (failures) { console.log(`\nFAILURES: ${failures} of ${checks} checks`); process.exit(1); }
  console.log(UPDATE ? "\nRECORDED" : `\nALL PASS (${checks} checks passed)`);
  process.exit(0);
}, (e) => { console.error("\nCRASH", e && e.stack || e); process.exit(2); });
