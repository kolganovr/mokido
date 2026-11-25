// Tests for figma-plugin-src/html-bridge.js (T-077, F8.4): bridge.fromHtml in the sandbox, end to end WITHOUT a browser:
// the "plugin window" is a fake that answers HTML_WALK with a recorded dom.json tree (tests/fixtures/html), then the real
// html-map.js + html-build.js (on the strict stub) build the nodes. Run: node tests/html-bridge.test.js
// Limits: the window side (hidden iframe + htmlWalk in ui.html) is only checked live (F8.0/8.5); the stub does not lay out Auto Layout.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { createHtmlStub } = require("./helpers/html-build-stub");

const SRC = path.join(__dirname, "..", "figma-plugin-src");
let failures = 0, checks = 0;
function check(name, cond, extra) {
  checks++;
  if (cond) return;
  failures++;
  console.log("  FAIL " + name + (extra !== undefined ? "  -> " + (typeof extra === "string" ? extra : JSON.stringify(extra)).slice(0, 500) : ""));
}
const tree = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "html", n + ".dom.json"), "utf8"));
const TREES = { 1440: tree("01_login_form@1440"), 390: tree("05_mobile_profile@390") };

function setup(answer) {
  const stub = createHtmlStub({});
  const sent = [];
  const created = [];
  const ctx = vm.createContext({ figma: stub.figma, console, setTimeout, clearTimeout, Promise });
  ctx.activeCheckpoint = { created };
  ctx.getFreeCanvasPosition = (w, h) => ({ x: 5000, y: 100 });
  stub.figma.ui = {
    postMessage(m) {
      sent.push(m);
      if (m.type !== "HTML_WALK") return;
      const a = answer(m);
      if (a) setTimeout(() => ctx.htmlBridgeOnTree(Object.assign({ type: "HTML_TREE", reqId: m.reqId }, a)), 0);
    }
  };
  for (const f of ["html-map.js", "html-grid.js", "html-img.js", "html-build.js", "html-bridge.js"]) vm.runInContext(fs.readFileSync(path.join(SRC, f), "utf8"), ctx);
  return { stub, ctx, sent, created };
}
const plain = (x) => JSON.parse(JSON.stringify(x));
const rejects = async (p) => { try { await p; return null; } catch (e) { return String(e.message || e); } };

(async () => {
  // 1. one width, free canvas position
  {
    const t = setup((m) => ({ tree: TREES[m.width] }));
    const r = plain(await t.ctx.htmlBridgeFromHtml("<div>hi</div>", { name: "Login" }));
    check("request: HTML_WALK with html, width 1440, height 900", t.sent.length === 1 && t.sent[0].type === "HTML_WALK" && t.sent[0].html === "<div>hi</div>" && t.sent[0].width === 1440 && t.sent[0].height === 900, t.sent);
    check("ok with one root named Login at the free position", r.ok === true && r.roots.length === 1 && r.roots[0].name === "Login" && r.roots[0].x === 5000 && r.roots[0].y === 100, r);
    check("report has counters", r.layers > 20 && /% of \d+ frames$/.test(r.auto_layout) && typeof r.absolute_fallback === "number" && /^\d+\/\d+$/.test(r.boxes_within_1px), r);
    check("root id journaled for rollback / default capture", t.created.length === 1 && t.created[0] === r.roots[0].id, t.created);
    check("root exists in the document with the plan size", (() => { const n = t.stub.figma.getNodeById(r.roots[0].id); return !!n && n.name === "Login" && n.width === r.roots[0].w; })(), r.roots);
    check("report stays under 3500 bytes", Buffer.byteLength(JSON.stringify(r)) <= 3500, Buffer.byteLength(JSON.stringify(r)));
    check("at most 10 warnings, none of them 'absolute'", (r.warnings || []).length <= 10 && !(r.warnings || []).some((w) => /^absolute /.test(w)), r.warnings);
  }
  // 2. two widths side by side, names get the width
  {
    const t = setup((m) => ({ tree: TREES[m.width] }));
    const r = plain(await t.ctx.htmlBridgeFromHtml("<div/>", { widths: [1440, 390], name: "Page", x: 0, y: 0 }));
    check("two roots, one HTML_WALK per width", r.ok && r.roots.length === 2 && t.sent.length === 2 && t.sent[1].width === 390, r);
    check("names carry the width", r.roots[0].name === "Page@1440" && r.roots[1].name === "Page@390", r.roots);
    check("second frame is to the right with a gap", r.roots[1].x === r.roots[0].x + 1440 + 80, r.roots);
    check("order as in widths, left to right, gap 80", r.roots[0].w === 1440 && r.roots[1].x - (r.roots[0].x + r.roots[0].w) === 80, r.roots);
    check("each width: own walk with that width, own root, height from that page tree", t.sent[0].width === 1440 && t.sent[1].width === 390 && r.roots[0].h === TREES[1440].page.h && r.roots[1].h === TREES[390].page.h && r.roots[0].id !== r.roots[1].id, [r.roots.map((q) => q.h), TREES[1440].page, TREES[390].page]);
    check("two widths: response <= 1500 B, one counter line per root", Buffer.byteLength(JSON.stringify(r)) <= 1500 && r.per_root.length === 2, Buffer.byteLength(JSON.stringify(r)));
    console.log("  info: two-width response " + Buffer.byteLength(JSON.stringify(r)) + " B");
    const rev = setup((m) => ({ tree: TREES[m.width] }));
    const rr = plain(await rev.ctx.htmlBridgeFromHtml("<div/>", { widths: [390, 1440], name: "P", x: 0, y: 0 }));
    check("reversed widths keep the given order", rr.roots[0].name === "P@390" && rr.roots[1].name === "P@1440" && rr.roots[1].x === 390 + 80, rr.roots);
    const five = setup((m) => ({ tree: TREES[1440] }));
    const e5 = await rejects(five.ctx.htmlBridgeFromHtml("<div/>", { widths: [320, 390, 768, 1024, 1440] }));
    check("more than 4 widths: clear error, no walk", /at most 4 widths/.test(e5 || "") && five.sent.length === 0, e5);
    const four = setup((m) => ({ tree: TREES[1440] }));
    const r4 = plain(await four.ctx.htmlBridgeFromHtml("<div/>", { widths: [320, 390, 768, 1024], x: 0, y: 0 }));
    check("exactly 4 widths allowed", r4.ok && r4.roots.length === 4, r4.ok);
    // display:none: the walker drops the node, so a tree without it gives no layer; names of the shared nodes stay equal
    const walkSrc = fs.readFileSync(path.join(SRC, "html-walk.js"), "utf8");
    check("walker skips display:none elements (no hidden layers)", /cs\.display === "none"\) return;/.test(walkSrc));
    const full = JSON.parse(JSON.stringify(TREES[1440]));
    const cut = JSON.parse(JSON.stringify(full));
    const parents = new Set(cut.nodes.map((n) => n.parent));
    const victim = cut.nodes.filter((n) => n.parent != null && !parents.has(n.id) && !n.text).pop() || cut.nodes.filter((n) => n.parent != null && !parents.has(n.id)).pop();
    const removed = !!victim;
    if (victim) cut.nodes = cut.nodes.filter((n) => n.id !== victim.id);
    const ta = setup((m) => ({ tree: m.width === 1440 ? full : cut }));
    const rt = plain(await ta.ctx.htmlBridgeFromHtml("<div/>", { widths: [1440, 390], name: "H", x: 0, y: 0 }));
    const layersOf = (id) => { const out = []; (function w(n) { out.push(n.name); (n.children || []).forEach(w); })(ta.stub.figma.getNodeById(id)); return out; };
    const la = layersOf(rt.roots[0].id).slice(1), lb = layersOf(rt.roots[1].id).slice(1);
    check("hidden element on the narrow width: fewer layers, the rest named the same", removed && lb.length < la.length && lb.every((n) => la.includes(n)), [la.length, lb.length]);
  }
  // 3. parent by id
  {
    const t = setup((m) => ({ tree: TREES[1440] }));
    const host = t.stub.figma.createFrame();
    const r = plain(await t.ctx.htmlBridgeFromHtml("<div/>", { parent: host.id }));
    check("built into the parent frame", r.ok && host.children.length === 1 && host.children[0].id === r.roots[0].id, r);
  }
  // 4. errors
  {
    const t = setup((m) => ({ error: "iframe blocked" }));
    check("window error is surfaced", /^HTML_WALK_FAILED: iframe blocked/.test(await rejects(t.ctx.htmlBridgeFromHtml("<div/>", {})) || ""));
    const t2 = setup(() => null);
    vm.runInContext("HTML_BRIDGE_TIMEOUT_MS = 40", t2.ctx);
    const e2 = await rejects(t2.ctx.htmlBridgeFromHtml("<div/>", {}));
    check("no answer from the window: HTML_WALK_TIMEOUT naming the open window", /^HTML_WALK_TIMEOUT: .*window/.test(e2 || ""), e2);
    check("late answer after the timeout is ignored", (() => { t2.ctx.htmlBridgeOnTree({ reqId: t2.sent[0].reqId, tree: TREES[1440] }); return true; })());
    check("empty html rejected", /non-empty string/.test(await rejects(t.ctx.htmlBridgeFromHtml("  ", {})) || ""));
    check("bad width rejected", /width must be 100\.\.8000/.test(await rejects(t.ctx.htmlBridgeFromHtml("<p/>", { width: 20 })) || ""));
    check("unknown parent rejected", /not a node that can hold children/.test(await rejects(t.ctx.htmlBridgeFromHtml("<p/>", { parent: "99:99" })) || ""));
    check("no walk request for invalid input", t.sent.length === 1, t.sent.length);
  }
  // 5. message routing and macro wiring in the sources
  {
    const msgs = fs.readFileSync(path.join(SRC, "messages.js"), "utf8");
    check("messages.js routes HTML_TREE to htmlBridgeOnTree and does not pause it", /msg\.type === 'HTML_TREE'[\s\S]{0,60}htmlBridgeOnTree\(msg\)/.test(msgs) && !/PAUSABLE_TYPES = new Set\([^)]*HTML_TREE/.test(msgs));
    check("api-macros exposes bridge.fromHtml", /api\.fromHtml = function \(html, opts\)[\s\S]{0,80}htmlBridgeFromHtml\(html, opts\)/.test(fs.readFileSync(path.join(SRC, "api-macros.js"), "utf8")));
    const ui = fs.readFileSync(path.join(__dirname, "..", "figma-plugin", "ui.html"), "utf8");
    check("ui.html answers HTML_WALK with HTML_TREE and embeds the walker", /msg\.type === 'HTML_WALK'/.test(ui) && /type: 'HTML_TREE'/.test(ui) && /function htmlWalk\(doc, opts\)/.test(ui) && /sandbox', 'allow-same-origin'/.test(ui));
    check("T-103: the walker reports line clamp / nowrap+ellipsis as style.clamp", /webkitLineClamp/.test(ui) && /textOverflow === "ellipsis"/.test(ui) && /lineHeight: lh, clamp: clamp/.test(ui));
    check("T-100: ui.html hides the iframe scrollbar and keeps the iframe height", /scrollbar-width:none/.test(ui) && /::-webkit-scrollbar\{display:none\}/.test(ui) && /height:' \+ h \+ 'px/.test(ui));
  }
  console.log(failures ? "FAILURES: " + failures + " of " + checks : "ALL PASS (" + checks + " checks passed)");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log("CRASH", e); process.exit(1); });
