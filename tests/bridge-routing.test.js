// Black-box contract for target routing (which connected Figma file gets a
// command) and master/proxy switching (a second process on the same bridge port
// proxies to the first; takes the port over when the first dies). Run:
//   node tests/bridge-routing.test.js
//
// Real figma/index.js processes (stdio MCP) + fake plugins over a real
// WebSocket, ports 18809-18819 only. Pins today's behaviour, not "correct"
// behaviour. Needs Node >= 22 (global WebSocket). No dependencies.
const H = require("./helpers/server-harness");
const { sleep, startServer, waitMaster, waitClients, waitFor, bridgeStatus, startFakePlugin } = H;

let failures = 0;
let checks = 0;
function check(name, cond, extra) {
  checks++;
  if (cond) return;
  failures++;
  console.log("  FAIL " + name + (extra !== undefined ? "  -> " + (typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 700) : ""));
}

const servers = [];
const plugins = [];

async function boot(port) {
  const s = startServer({ port });
  servers.push(s);
  await s.initialize();
  return s;
}
async function bootMaster(port) {
  const s = await boot(port);
  await waitMaster(s);
  return s;
}
// A fake plugin whose every command is answered with "from <name>".
async function plug(server, name) {
  const p = startFakePlugin({ port: server.port, token: server.token, fileName: name, handler: () => ({ result: "from " + name }) });
  plugins.push(p);
  await p.opened;
  return p;
}
const connected = (server, n) => waitClients(server, n);

function body(res) {
  const t = res && res.content && res.content[0] && res.content[0].text;
  try { return JSON.parse(t); } catch (e) { return { raw: t }; }
}
// One figma_execute_code call -> { err, ok, result, code, error }
async function exec(server, target) {
  const args = { code: "return 1;" };
  if (target !== undefined) args.target = target;
  const res = await server.tool("figma_execute_code", args);
  const b = body(res);
  return { err: !!res.isError, ok: b.ok, result: b.result, code: b.code, error: b.error || b.raw };
}
async function targets(server) { return body(await server.tool("figma_list_targets", {})); }
const names = (b) => (b.targets || []).map((t) => t.fileName).sort();
const pingFrom = (p) => p.ws.send(JSON.stringify({ type: "PING" }));
const focusFrom = (p, name) => p.ws.send(JSON.stringify({ type: "CLIENT_FOCUS", fileName: name }));
async function waitPlugin(server, pred, what) {
  await waitFor(async () => pred((await bridgeStatus(server)).targets), 4000, what);
}
const closePlugin = (p) => p.close();
async function killAndWait(s) {
  const exited = new Promise((res) => s.child.once("exit", res));
  s.child.kill();
  await exited;
}

// ------------------------------------------------------------ target routing
async function routing() {
  const m = await bootMaster(18809);

  const none = await exec(m);
  check("master, no plugin: error", none.err && none.ok === false, none);
  check("master, no plugin: code NO_CONNECTED_CLIENTS", none.code === "NO_CONNECTED_CLIENTS", none);
  check("master, no plugin: text tells to open Figma desktop", /No Figma plugin is connected to the bridge\. Ask the user to open Figma DESKTOP/.test(none.error || ""), none.error);
  const noneList = await targets(m);
  check("list_targets, no plugin: empty + hint", noneList.ok === true && noneList.targets.length === 0 && /No Figma file is connected/.test(noneList.hint || ""), noneList);

  const A = await plug(m, "Alpha");
  await connected(m, 1);
  let r = await exec(m);
  check("one plugin, no target: reaches it", !r.err && r.ok === true && r.result === "from Alpha", r);
  check("one plugin: received exactly one command", A.received.length === 1, A.received.length);
  r = await exec(m, "Alpha");
  check("one plugin, target by exact name: ok", !r.err && r.result === "from Alpha", r);

  r = await exec(m, "Nope");
  check("target missing: error", r.err && r.ok === false, r);
  check("target missing: code TARGET_NOT_FOUND", r.code === "TARGET_NOT_FOUND", r);
  check("target missing: text names target, open files, hint", r.error === 'No connected Figma document named "Nope". Currently open: Alpha. Call figma_list_targets to check.', r.error);
  check("target missing: nothing sent to plugin", A.received.length === 2, A.received.length);

  const B = await plug(m, "Beta");
  await connected(m, 2);
  const lt = await targets(m);
  check("list_targets: both files", JSON.stringify(names(lt)) === JSON.stringify(["Alpha", "Beta"]), lt);
  check("list_targets: entry shape", lt.targets.every((t) => typeof t.id === "string" && t.pageName === "Page 1" && t.pluginVersion === "9.9.9" && typeof t.focused === "boolean" && typeof t.lastSeenMsAgo === "number"), lt);
  check("list_targets: only the last-ready plugin is focused", lt.targets.filter((t) => t.focused).map((t) => t.fileName).join() === "Beta", lt);
  check("list_targets: no hint when files are connected", lt.hint === undefined, lt);

  const a0 = A.received.length, b0 = B.received.length;
  r = await exec(m, "Alpha");
  check("two plugins, target Alpha: answered by Alpha", r.result === "from Alpha", r);
  r = await exec(m, "Beta");
  check("two plugins, target Beta: answered by Beta", r.result === "from Beta", r);
  check("target Alpha went only to Alpha, Beta only to Beta", A.received.length === a0 + 1 && B.received.length === b0 + 1, [A.received.length - a0, B.received.length - b0]);
  check("target is stripped from the command sent to plugin", A.received.every((c) => c.target === undefined) && B.received.every((c) => c.target === undefined), A.received[0]);

  r = await exec(m, "aLPHA");
  check("target match is case-insensitive", r.result === "from Alpha", r);
  r = await exec(m, "Alp");
  check("target partial name does not match", r.err && r.code === "TARGET_NOT_FOUND", r);
  check("target not found lists all open files", /Currently open: (Alpha, Beta|Beta, Alpha)\./.test(r.error || ""), r.error);
  r = await exec(m, "Alpha ");
  check("target with trailing space does not match", r.err && r.code === "TARGET_NOT_FOUND", r);

  const b1 = B.received.length, a1 = A.received.length;
  r = await exec(m);
  check("two plugins, no target: focused (last ready) Beta answers", r.result === "from Beta", r);
  check("two plugins, no target: Alpha untouched", A.received.length === a1 && B.received.length === b1 + 1, [A.received.length - a1, B.received.length - b1]);
  focusFrom(A, "Alpha");
  await waitPlugin(m, (ts) => ts.some((t) => t.fileName === "Alpha" && t.focused) && ts.some((t) => t.fileName === "Beta" && !t.focused), "Alpha focus");
  r = await exec(m);
  check("two plugins, no target, after CLIENT_FOCUS from Alpha: Alpha answers", r.result === "from Alpha", r);
  r = await exec(m, "Beta");
  check("explicit target wins over focus", r.result === "from Beta", r);

  closePlugin(B);
  await connected(m, 1);
  const lt2 = await targets(m);
  check("after Beta leaves: list_targets shows only Alpha", JSON.stringify(names(lt2)) === '["Alpha"]', lt2);
  r = await exec(m);
  check("after Beta leaves: no target -> Alpha", r.result === "from Alpha", r);
  r = await exec(m, "Beta");
  check("after Beta leaves: target Beta -> TARGET_NOT_FOUND listing Alpha", r.code === "TARGET_NOT_FOUND" && /Currently open: Alpha\./.test(r.error || ""), r);
  r = await exec(m, "Alpha");
  check("after Beta leaves: target Alpha still ok", r.result === "from Alpha", r);
  closePlugin(A);
  await connected(m, 0);
  await m.stop();
}

// ------------------------------------- ambiguous focus and same-name documents
async function ambiguity() {
  const m = await bootMaster(18810);
  const A = await plug(m, "Dup");
  const A2 = await plug(m, "Dup");
  await connected(m, 2);

  let r = await exec(m, "Dup");
  check("two same-name files, target Dup: the focused (later) one answers", r.result === "from Dup" && A2.received.length === 1 && A.received.length === 0, [A.received.length, A2.received.length]);
  r = await exec(m);
  check("two same-name files, no target: focused one answers", r.result === "from Dup" && A2.received.length === 2 && A.received.length === 0, [A.received.length, A2.received.length]);

  const C = await plug(m, "Other");
  await connected(m, 3);
  closePlugin(C);
  await connected(m, 2);
  await waitPlugin(m, (ts) => ts.length === 2 && ts.every((t) => !t.focused), "nobody focused");
  r = await exec(m);
  check("two files, none focused, no target: error", r.err && r.ok === false, r);
  check("none focused, no target: code AMBIGUOUS_TARGET", r.code === "AMBIGUOUS_TARGET", r);
  check("none focused, no target: text lists files and how to fix", /^2 Figma documents are connected and none is focused \(Dup, Dup\)\. Click into the intended Figma window, or pass target: "<fileName>"/.test(r.error || ""), r.error);
  check("ambiguous: nothing was sent to any plugin", A.received.length === 0 && A2.received.length === 2, [A.received.length, A2.received.length]);

  const aBefore = A.received.length, a2Before = A2.received.length;
  await sleep(60);
  pingFrom(A);
  await sleep(60);
  r = await exec(m, "Dup");
  check("same name, none focused, target Dup: most recently active (pinged) one answers", r.result === "from Dup" && A.received.length === aBefore + 1 && A2.received.length === a2Before, [A.received.length - aBefore, A2.received.length - a2Before]);
  await sleep(60);
  pingFrom(A2);
  await sleep(60);
  r = await exec(m, "Dup");
  check("same name, none focused: after the other pings, it answers", r.result === "from Dup" && A2.received.length === a2Before + 1, [A.received.length - aBefore, A2.received.length - a2Before]);

  focusFrom(A, "Dup");
  await waitPlugin(m, (ts) => ts.filter((t) => t.focused).length === 1, "refocus");
  const before = A.received.length;
  r = await exec(m);
  check("after CLIENT_FOCUS ambiguity is gone, focused plugin answers", !r.err && A.received.length === before + 1, r);

  closePlugin(A); closePlugin(A2);
  await connected(m, 0);
  await m.stop();
}

// ------------------------------------------------------- master / proxy mode
async function proxy() {
  const m = await bootMaster(18811);
  const p = await boot(18811);
  await p.waitStderr(/already in use\. Forwarding commands to existing bridge instance/);
  check("second process on the port reports it forwards to the existing bridge", /Forwarding commands/.test(p.stderr()), p.stderr());
  check("first process did not log a port conflict", !/already in use/.test(m.stderr()), m.stderr());
  const st = await bridgeStatus(m);
  check("port is held by the first process", st.pid === m.child.pid, [st.pid, m.child.pid]);

  const viaM = await exec(m), viaP = await exec(p);
  check("no plugin: proxy error code matches master", viaP.err && viaP.code === viaM.code && viaP.code === "NO_CONNECTED_CLIENTS", [viaM.code, viaP.code]);
  check("no plugin: proxy error text matches master", viaP.error === viaM.error, [viaM.error, viaP.error]);
  const pl0 = await targets(p);
  check("proxy list_targets with no plugin: empty + hint like master", pl0.ok && pl0.targets.length === 0 && /No Figma file is connected/.test(pl0.hint || ""), pl0);

  const A = await plug(m, "Alpha");
  await connected(m, 1);
  let r = await exec(p);
  check("via proxy, one plugin: reaches it, answer comes back", !r.err && r.ok === true && r.result === "from Alpha", r);
  check("via proxy: plugin received the command once", A.received.length === 1, A.received.length);
  r = await exec(p, "Alpha");
  check("via proxy, target Alpha ok", r.result === "from Alpha", r);
  r = await exec(p, "Nope");
  const rm = await exec(m, "Nope");
  check("via proxy, missing target: same code and text as master", r.err && r.code === "TARGET_NOT_FOUND" && r.error === rm.error, [r, rm]);
  check("via proxy, process stayed proxy: port still held by first process", (await bridgeStatus(m)).pid === m.child.pid, null);

  const B = await plug(m, "Beta");
  await connected(m, 2);
  const lm = await targets(m), lp = await targets(p);
  check("proxy list_targets shows both files, like master", JSON.stringify(names(lp)) === '["Alpha","Beta"]' && JSON.stringify(names(lm)) === JSON.stringify(names(lp)), [lm, lp]);
  check("proxy list_targets carries focus flags from master", lp.targets.filter((t) => t.focused).map((t) => t.fileName).join() === "Beta", lp);
  const a0 = A.received.length, b0 = B.received.length;
  r = await exec(p, "Alpha");
  check("via proxy, two plugins, target Alpha: Alpha answers", r.result === "from Alpha", r);
  r = await exec(p, "Beta");
  check("via proxy, two plugins, target Beta: Beta answers", r.result === "from Beta", r);
  r = await exec(p);
  check("via proxy, two plugins, no target: focused Beta answers", r.result === "from Beta", r);
  check("via proxy: right plugins got the right commands", A.received.length === a0 + 1 && B.received.length === b0 + 2, [A.received.length - a0, B.received.length - b0]);
  r = await exec(p, "alpha");
  check("via proxy: target is case-insensitive", r.result === "from Alpha", r);

  const C = await plug(m, "Gamma");
  await connected(m, 3);
  closePlugin(C);
  await connected(m, 2);
  await waitPlugin(m, (ts) => ts.length === 2 && ts.every((t) => !t.focused), "nobody focused");
  r = await exec(p);
  const rmAmb = await exec(m);
  check("via proxy, none focused: AMBIGUOUS_TARGET with master's text", r.err && r.code === "AMBIGUOUS_TARGET" && r.error === rmAmb.error, [r, rmAmb]);
  r = await exec(p, "Beta");
  check("via proxy, none focused, explicit target still works", r.result === "from Beta", r);

  closePlugin(A); closePlugin(B);
  await connected(m, 0);
  const lp2 = await targets(p);
  check("proxy list_targets after all plugins left: empty", lp2.targets.length === 0, lp2);

  await p.stop();
  await m.stop();
}

// ---------------------------------------------------------- master failover
async function failover() {
  const m = await bootMaster(18812);
  const p = await boot(18812);
  p.spawnedAt = Date.now() - 400; // boot() returns after the MCP handshake, ~when the watchdog was armed
  await p.waitStderr(/Forwarding commands to existing bridge/);
  const A = await plug(m, "Alpha");
  await connected(m, 1);
  let r = await exec(p);
  check("failover setup: call via proxy works", r.result === "from Alpha", r);

  // The idle watchdog (every 5 s since the proxy started) would also take the
  // port over; strike right after a tick so only the failing call can do it
  // within the next second and a half.
  const phase = () => (Date.now() - p.spawnedAt) % 5000;
  await waitFor(() => phase() > 700 && phase() < 1200, 6000, "watchdog phase");
  await killAndWait(m);
  closePlugin(A);
  await waitFor(async () => { try { await fetch(`http://127.0.0.1:${m.port}/status`); return false; } catch (e) { return true; } }, 4000, "port released");

  r = await exec(p);
  check("first call after master died: error", r.err && r.ok === false, r);
  check("first call after master died: code BRIDGE_OFFLINE", r.code === "BRIDGE_OFFLINE", r);
  check("first call after master died: text says port is taken over", (r.error || "").startsWith("The bridge instance that owned :8765 is no longer running. This server is taking the port over — retry the call."), r.error);

  await waitFor(async () => { try { return (await bridgeStatus(p)).pid === p.child.pid; } catch (e) { return false; } }, 1500, "old proxy owns the port right after the failed call (not via watchdog)");
  check("old proxy answers /status on the bridge port as master", (await bridgeStatus(p)).pid === p.child.pid, null);
  check("old proxy has no plugins yet", (await bridgeStatus(p)).wsClients === 0, null);
  r = await exec(p);
  check("as master with no plugin: NO_CONNECTED_CLIENTS (not a proxy error)", r.code === "NO_CONNECTED_CLIENTS", r);
  const lt0 = await targets(p);
  check("as master, list_targets is empty + hint", lt0.targets.length === 0 && !!lt0.hint, lt0);

  const A2 = await plug(p, "Alpha");
  const B2 = await plug(p, "Beta");
  await connected(p, 2);
  r = await exec(p);
  check("after failover, plugin reconnected: call through old proxy passes", !r.err && r.result === "from Beta", r);
  r = await exec(p, "Alpha");
  check("after failover, target Alpha reaches Alpha", r.result === "from Alpha" && A2.received.length === 1, r);
  const lt = await targets(p);
  check("after failover, list_targets shows both reconnected files", JSON.stringify(names(lt)) === '["Alpha","Beta"]', lt);

  const q = await boot(18812);
  await q.waitStderr(/Forwarding commands to existing bridge/);
  r = await exec(q, "Beta");
  check("a new process after failover proxies to the new master", r.result === "from Beta" && B2.received.length >= 1, r);
  check("new master still owns the port", (await bridgeStatus(q)).pid === p.child.pid, null);

  closePlugin(A2); closePlugin(B2);
  await q.stop();
  await p.stop();
}

// Master dies while the proxy is idle (no call made): the 5 s watchdog claims
// the port without any tool call.
async function watchdog() {
  const m = await bootMaster(18813);
  const p = await boot(18813);
  await p.waitStderr(/Forwarding commands to existing bridge/);
  await killAndWait(m);
  const t0 = Date.now();
  await waitFor(async () => { try { return (await bridgeStatus(p)).pid === p.child.pid; } catch (e) { return false; } }, 9000, "watchdog takeover");
  check("idle proxy claims the port by itself within the watchdog period", Date.now() - t0 < 9000, Date.now() - t0);
  const A = await plug(p, "Solo");
  await connected(p, 1);
  const r = await exec(p);
  check("after idle takeover, plugin call works", r.result === "from Solo", r);
  closePlugin(A);
  await p.stop();
}

(async () => {
  const t0 = Date.now();
  setTimeout(() => { console.log("  FAIL global timeout (60 s)"); process.exit(1); }, 60000).unref();
  try {
    await routing();
    await ambiguity();
    await proxy();
    await failover();
    await watchdog();
  } catch (e) {
    failures++;
    console.log("  FAIL scenario crashed  -> " + ((e && e.stack) || e));
  } finally {
    for (const p of plugins) { try { p.close(); } catch (e) {} }
    await Promise.all(servers.map((s) => s.stop()));
  }
  if (failures) { console.log(`FAILURES: ${failures} of ${checks} checks failed`); process.exit(1); }
  console.log(`ALL PASS (${checks} checks passed, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(0);
})();
