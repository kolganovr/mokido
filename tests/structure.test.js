// Structure test. Run: node tests/structure.test.js
//  (a) figma-plugin/code.js equals the build of figma-plugin-src/ (CRLF-normalized)
//  (b) no require cycles inside figma/
//  (c) no source file over 30 720 bytes (LF), except OVERSIZE_ALLOWED
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const LIMIT = 30720;
const OVERSIZE_ALLOWED = ["figma/index.js", "figma-plugin-src/bridge-api.js", "figma-plugin-src/messages.js"];

let failures = 0, checks = 0;
function check(name, ok, detail) {
  checks++;
  if (ok) return;
  failures++;
  console.log("  FAIL " + name + (detail ? " :: " + detail : ""));
}
const lf = (s) => s.replace(/\r\n/g, "\n");
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

// (a) build equals code.js
const chk = spawnSync(process.execPath, [path.join(ROOT, "scripts", "build-plugin.mjs"), "--check"], { encoding: "utf8" });
check("figma-plugin/code.js equals the build of figma-plugin-src/", chk.status === 0, (chk.stderr || "").trim());

// (b) require cycles in figma/
const figmaFiles = walk(path.join(ROOT, "figma"));
const graph = new Map();
for (const f of figmaFiles) {
  const src = fs.readFileSync(f, "utf8");
  const deps = [];
  for (const m of src.matchAll(/require\(\s*["'](\.[^"']*)["']\s*\)/g)) {
    let t = path.resolve(path.dirname(f), m[1]);
    if (fs.existsSync(t + ".js")) t += ".js";
    else if (fs.existsSync(path.join(t, "index.js"))) t = path.join(t, "index.js");
    if (fs.existsSync(t) && t.endsWith(".js")) deps.push(t);
  }
  graph.set(f, deps);
}
const state = new Map(); // 1 = in stack, 2 = done
let cycle = null;
function dfs(n, stack) {
  if (cycle) return;
  state.set(n, 1); stack.push(n);
  for (const d of graph.get(n) || []) {
    if (state.get(d) === 1) { cycle = stack.slice(stack.indexOf(d)).concat(d).map(rel).join(" -> "); return; }
    if (!state.has(d)) dfs(d, stack);
    if (cycle) return;
  }
  stack.pop(); state.set(n, 2);
}
for (const f of graph.keys()) if (!state.has(f)) dfs(f, []);
check("no require cycles in figma/", !cycle, cycle);

// (c) size limit
const sized = figmaFiles.filter((f) => !rel(f).startsWith("figma/optimizer/"))
  .concat(walk(path.join(ROOT, "figma-plugin-src")));
for (const f of sized) {
  const r = rel(f);
  const size = Buffer.byteLength(lf(fs.readFileSync(f, "utf8")), "utf8");
  if (OVERSIZE_ALLOWED.includes(r)) continue;
  check(r + " <= " + LIMIT + " bytes", size <= LIMIT, size + " bytes");
}
for (const r of OVERSIZE_ALLOWED) check(r + " exists (OVERSIZE_ALLOWED entry)", fs.existsSync(path.join(ROOT, r)));

console.log(failures === 0 ? "\nALL PASS (" + checks + " checks passed)" : "\n" + failures + " FAILURES");
process.exit(failures ? 1 : 0);
