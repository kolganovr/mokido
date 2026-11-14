// Boundary tests for figma/lib/router.js (T-088): each check pins an edge that a one-token
// breakage of the router (flipped condition, wrong default, swapped operand) used to survive.
// Run: node tests/boundary.test.js
//
// Real figma/index.js processes (stdio MCP) + fake plugins over a real WebSocket, ports 18860-18869.
// No dependencies, Node >= 22. The plugin-side macro boundaries live in tests/bridge-runtime.test.js
// ("macro boundaries (T-088)").
const H = require("./helpers/server-harness");
const { sleep, startServer, waitMaster, waitClients, startFakePlugin } = H;

let failures = 0;
let checks = 0;
function check(name, cond, extra) {
  checks++;
  if (cond) return;
  failures++;
  console.log("  FAIL " + name + (extra !== undefined ? "  -> " + (typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 700) : ""));
}

const text = (res) => (res && res.content && res.content[0] && res.content[0].text) || "";
const allText = (res) => ((res && res.content) || []).map((c) => c.text || "").join("\n");

// An outline whose three "Select" copies differ in style: similarHint names them (#1:2 #1:3 #1:6).
const SIM = [
  'FRAME "Filters / 1280" #1:1 1280x400 @0,0 [V gap24 pad32 fixed/fixed] fill:#F9FAFB',
  '  FRAME "Select" #1:2 280x44 @0,0 [H gap8 pad10,14,10,14 fixed/fixed] fill:#FFFFFF stroke:#D0D5DD/1 r8 shadow:0,1/2 #101828@0.05 children:2',
  '  FRAME "Select" #1:3 280x44 @296,0 [H gap8 pad10,14,10,14 fixed/fixed] fill:#FFFFFF stroke:#D0D5DD/1 r4 children:2',
  '  FRAME "Select" #1:6 340x40 @32,153 [H gap8 pad8,12,8,12 fixed/fixed] fill:#FFFFFF stroke:#D0D5DD/1 r8 shadow:0,1/2 #101828@0.05 children:2'
].join("\n");
// find hits are printed at indent 0
const FIND = [
  'FRAME "Card" #2:1 300x120 @0,0 [V gap8 pad16 fixed/fixed] fill:#FFFFFF stroke:#D0D5DD/1 r8 children:3',
  'FRAME "Card" #2:2 300x120 @320,0 [V gap8 pad16 fixed/fixed] fill:#FFFFFF stroke:#D0D5DD/1 r4 children:3',
  'FRAME "Card" #2:3 300x120 @640,0 [V gap12 pad16 fixed/fixed] fill:#FFFFFF stroke:#D0D5DD/1 r8 children:3'
].join("\n");

const CARD_DOC = {
  id: "1:1", name: "Card", type: "FRAME",
  absoluteBoundingBox: { x: 0, y: 0, width: 320, height: 120 },
  layoutMode: "VERTICAL", itemSpacing: 12, paddingTop: 16, paddingRight: 16, paddingBottom: 16, paddingLeft: 16, cornerRadius: 12,
  fills: [{ type: "SOLID", visible: true, color: { r: 1, g: 1, b: 1 } }],
  children: [{ id: "1:2", name: "Title", type: "TEXT", absoluteBoundingBox: { x: 16, y: 16, width: 288, height: 24 }, characters: "Hello", style: { fontFamily: "Inter", fontWeight: 700, fontSize: 16, textAlignHorizontal: "LEFT" } }]
};
const R = (body) => ({ status: 200, body });
const REST_ROUTES = {
  "GET /files/AbC123?depth=2": R({ name: "F", document: { id: "0:0", name: "Document", type: "DOCUMENT", children: [{ id: "0:1", name: "Page 1", type: "CANVAS", children: [CARD_DOC] }] } }),
  "GET /files/AbC123/nodes?ids=1%3A1&depth=3": R({ name: "F", nodes: { "1:1": { document: CARD_DOC } } })
};

const servers = [];
const plugins = [];
async function boot(port, opts) {
  const s = startServer({ port, ...(opts || {}) });
  servers.push(s);
  await s.initialize();
  await waitMaster(s);
  return s;
}
async function plug(server, fileName, handler) {
  const p = startFakePlugin({ port: server.port, token: server.token, fileName, handler });
  plugins.push(p);
  await p.opened;
  return p;
}
// The spec figma_inspect sends to the plugin: `const a = {...};`
const specOf = (cmd) => { const m = /^const a = (.*);$/m.exec((cmd && cmd.code) || ""); return m ? JSON.parse(m[1]) : null; };

// ---------------------------------------------------------------- figma_inspect: when a similar-copies hint is added
async function inspectHints() {
  const s = await boot(18860);
  const p = await plug(s, "Hints");
  await waitClients(s, 1);
  let reply = null;
  p.handler = () => ({ result: reply, resultStashed: true });
  // only the `similar` hint of the reply: the result itself echoes the ids of whatever the plugin returned
  const call = async (args, result) => {
    reply = result;
    const t = allText(await s.tool("figma_inspect", args));
    try { return String(JSON.parse(t).similar || ""); } catch (e) { return "NOT JSON: " + t.slice(0, 200); }
  };

  // control: a plain read of an outline with three differently styled copies gets the hint
  const plain = await call({ node_ids: ["1:1"] }, { outline: SIM });
  check("inspect plain outline: hint names the 3 copies", /3 nodes/.test(plain) && /#1:2 #1:3 #1:6/.test(plain), plain);

  // find hits sit at indent 0: they are read as hits (topLevel), not as an outline root
  const found = await call({ find: "Card" }, { found: FIND });
  check("inspect find: 3 alike hits -> hint naming them", /3 nodes/.test(found) && /#2:1 #2:2 #2:3/.test(found) && /compare/.test(found), found);

  // without `find`, a `found` field in the reply is ignored: the outline is what gets the hint
  const noFind = await call({ node_ids: ["1:1"] }, { outline: SIM, found: FIND });
  check("inspect without find: hint comes from the outline, not from `found`", /#1:2 #1:3 #1:6/.test(noFind) && !/#2:1/.test(noFind), noFind);

  // find_text: a text search never builds the hint from `found`
  const byText = await call({ find: "Card", find_text: "Hello" }, { outline: SIM, found: FIND });
  check("inspect find + find_text: hint comes from the outline, not from `found`", /#1:2 #1:3 #1:6/.test(byText) && !/#2:1/.test(byText), byText);

  // a read that is not a plain outline read never gets the hint, whichever single option makes it so
  const variants = [
    ["compare", { node_ids: ["1:3"], compare: "1:2" }],
    ["like", { like: "1:2", node_ids: ["1:1"] }],
    ["props", { node_ids: ["1:2"], props: ["font"] }],
    ["check", { node_ids: ["1:2"], check: { "1:2": { width: 320 } } }],
    ["view map", { view: "map" }],
    ["view table", { node_ids: ["1:1"], view: "table" }]
  ];
  for (const [name, args] of variants) {
    const out = await call(args, { outline: SIM });
    check("inspect " + name + ": no similar hint", !/3 nodes/.test(out) && !/#1:2 #1:3 #1:6/.test(out), out);
  }
  const outlineView = await call({ node_ids: ["1:1"], view: "outline" }, { outline: SIM });
  check("inspect view outline still counts as a plain read", /3 nodes/.test(outlineView), outlineView);
}

// ---------------------------------------------------------------- REST: simplify is on unless explicitly off
async function restSimplify() {
  const s = await boot(18861, { env: { FIGMA_PERSONAL_ACCESS_TOKEN: "test", FIGMA_MCP_LEGACY_TOOLS: "1" }, fetchRoutes: REST_ROUTES });
  const nodeDefault = text(await s.tool("get_node", { file_key: "AbC123", node_ids: ["1:1"] }));
  const nodeTrue = text(await s.tool("get_node", { file_key: "AbC123", node_ids: ["1:1"], simplify: true }));
  const nodeFalse = text(await s.tool("get_node", { file_key: "AbC123", node_ids: ["1:1"], simplify: false }));
  check("get_node: default is the optimized layout", /<Frame id="1:1"/.test(nodeDefault), nodeDefault);
  check("get_node: simplify true is the same as the default", nodeTrue === nodeDefault, nodeTrue);
  check("get_node: simplify false is the raw JSON", nodeFalse.startsWith("{") && /"nodes"/.test(nodeFalse) && nodeFalse !== nodeDefault, nodeFalse);
  const fileDefault = text(await s.tool("get_file", { file_key: "AbC123" }));
  const fileTrue = text(await s.tool("get_file", { file_key: "AbC123", simplify: true }));
  const fileFalse = text(await s.tool("get_file", { file_key: "AbC123", simplify: false }));
  check("get_file: default is the optimized layout", /<Frame id="1:1"/.test(fileDefault), fileDefault);
  check("get_file: simplify true is the same as the default", fileTrue === fileDefault, fileTrue);
  check("get_file: simplify false is the raw JSON", fileFalse.startsWith("{") && fileFalse !== fileDefault, fileFalse);
}

// ---------------------------------------------------------------- overlay note on a flow read is per file
async function overlayPerFile() {
  const s = await boot(18862);
  const HEADER = "OVERLAY SETTINGS (frame properties of the overlay target, not part of the action)";
  const flow = (trigger, overlay) => "#" + trigger + " ON_CLICK -> OVERLAY #" + overlay + ": BOTTOM_CENTER\n" + HEADER + "\n  position CENTER";
  const handlerFor = (trigger, overlay) => (cmd) => {
    const spec = specOf(cmd);
    if (spec && spec.view === "flow") return { result: { flow: flow(trigger, overlay) }, resultStashed: true };
    if (/openOverlay/.test(cmd.code || "")) {
      return { result: "#" + trigger + " ON_CLICK -> OVERLAY #" + overlay + ". MANUAL STEP for the user: ...", modified: [trigger, overlay], checkpointId: "cp_" + overlay, overlays: [{ trigger, overlay, manual: true }] };
    }
    return { result: "ok" };
  };
  const alpha = await plug(s, "Alpha File", handlerFor("21:2062", "21:2086"));
  await waitClients(s, 1);
  await s.tool("figma_execute_code", { code: "await bridge.openOverlay('21:2062', '21:2086', { position: 'BOTTOM_CENTER', dim: 0.4, closeOnOutside: true });", target: "Alpha File" });
  alpha.close();
  await H.waitFor(async () => (await H.bridgeStatus(s)).wsClients === 0, 4000, "alpha gone");

  const beta = await plug(s, "Beta File", handlerFor("21:2062", "21:2086"));
  await waitClients(s, 1);
  const other = text(await s.tool("figma_inspect", { node_ids: ["21:2062"], view: "flow" }));
  check("flow read in another file: the overlay linked in Alpha does not rewrite the note", other.indexOf(HEADER) !== -1 && other.indexOf("MANUAL STEP") === -1, other);

  // same overlay linked in the file that is read: the note is rewritten
  await s.tool("figma_execute_code", { code: "await bridge.openOverlay('21:2062', '21:2086', { position: 'BOTTOM_CENTER', dim: 0.4, closeOnOutside: true });" });
  const same = text(await s.tool("figma_inspect", { node_ids: ["21:2062"], view: "flow" }));
  check("flow read in the file that linked the overlay: the note says the look is the manual step", same.indexOf(HEADER) === -1 && /MANUAL STEP/.test(same), same);
  beta.close();
}

async function main() {
  // inspectHints and overlayPerFile drive the server with the global WebSocket client (Node 22+); Node 18 has none
  const steps = typeof WebSocket === "function" ? [inspectHints, restSimplify, overlayPerFile] : [restSimplify];
  if (steps.length < 3) console.log("  skip inspectHints, overlayPerFile: no global WebSocket on Node " + process.versions.node);
  for (const step of steps) {
    try { await step(); }
    catch (e) { failures++; console.log("  FAIL " + step.name + " crashed: " + (e && e.stack || e)); }
    for (const p of plugins.splice(0)) p.close();
    await Promise.all(servers.splice(0).map((x) => x.stop()));
    await sleep(100);
  }
  console.log((checks - failures) + " checks passed");
  console.log(failures === 0 ? "ALL PASS" : failures + " FAILURES");
  process.exitCode = failures ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
