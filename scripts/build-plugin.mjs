// Concatenates figma-plugin-src/*.js (in the order below) into figma-plugin/code.js, and embeds
// figma-plugin-src/html-walk.js (the DOM walker, it runs in the plugin window, not the sandbox) into figma-plugin/ui.html.
// Parts are plain slices of one file in one scope: no wrappers, no imports.
//   node scripts/build-plugin.mjs           write figma-plugin/code.js and the walker block of ui.html
//   node scripts/build-plugin.mjs --check   write nothing, exit 1 if code.js or ui.html differs from the build
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "figma-plugin-src");
const OUT = path.join(ROOT, "figma-plugin", "code.js");
const UI = path.join(ROOT, "figma-plugin", "ui.html");

export const PARTS = [
  "boot", "storage", "checkpoints", "node-format", "outline", "tables", "inspect",
  "compare", "find-check", "text-context", "api-store", "api-macros", "api-prototype", "api-reads", "errors", "transfer",
  "svg-text", "placement", "components", "capture-lint", "canvas-read", "html-map", "html-grid", "html-ds", "html-inst", "html-img", "html-build", "html-bridge",
  "msg-execute", "msg-components", "msg-variables-svg", "msg-canvas", "messages",
].map((n) => n + ".js");

const toLF = (b) => Buffer.from(b.toString("utf8").replace(/\r\n/g, "\n"), "utf8");

export function build() {
  return Buffer.concat(PARTS.map((p) => fs.readFileSync(path.join(SRC, p))));
}

// ui.html with the walker block (between <script id="html-walk"> and its closing tag) replaced by html-walk.js.
// Returns { current, next } in LF; the file keeps its own line endings when written.
export function buildUi() {
  const cur = fs.readFileSync(UI, "utf8");
  const lf = cur.replace(/\r\n/g, "\n");
  const walk = fs.readFileSync(path.join(SRC, "html-walk.js"), "utf8").replace(/\r\n/g, "\n").trimEnd();
  const re = /(<script id="html-walk">\n)[\s\S]*?(\n  <\/script>)/;
  if (!re.test(lf)) throw new Error('figma-plugin/ui.html has no <script id="html-walk"> block');
  return { crlf: cur.includes("\r\n"), current: lf, next: lf.replace(re, (m, a, b) => a + walk + b) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const built = build();
  const ui = buildUi();
  if (process.argv.includes("--check")) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT) : Buffer.alloc(0);
    let bad = false;
    if (!toLF(built).equals(toLF(cur))) {
      console.error("figma-plugin/code.js differs from figma-plugin-src/ build. Run: node scripts/build-plugin.mjs");
      bad = true;
    }
    if (ui.current !== ui.next) {
      console.error("figma-plugin/ui.html walker block differs from figma-plugin-src/html-walk.js. Run: node scripts/build-plugin.mjs");
      bad = true;
    }
    if (bad) process.exit(1);
    console.log("code.js and ui.html match the build");
  } else {
    fs.writeFileSync(OUT, built);
    fs.writeFileSync(UI, ui.crlf ? ui.next.replace(/\n/g, "\r\n") : ui.next);
    console.log(`wrote figma-plugin/code.js (${built.length} bytes, ${PARTS.length} parts) and the walker block of ui.html`);
  }
}
