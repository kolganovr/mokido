// Concatenates figma-plugin-src/*.js (in the order below) into figma-plugin/code.js.
// Parts are plain slices of one file in one scope: no wrappers, no imports.
//   node scripts/build-plugin.mjs           write figma-plugin/code.js
//   node scripts/build-plugin.mjs --check   write nothing, exit 1 if code.js differs from the build
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "figma-plugin-src");
const OUT = path.join(ROOT, "figma-plugin", "code.js");

export const PARTS = [
  "boot", "storage", "checkpoints", "node-format", "outline", "tables", "inspect",
  "compare", "find-check", "text-context", "bridge-api", "errors", "transfer",
  "svg-text", "placement", "components", "capture-lint", "canvas-read", "messages",
].map((n) => n + ".js");

const toLF = (b) => Buffer.from(b.toString("utf8").replace(/\r\n/g, "\n"), "utf8");

export function build() {
  return Buffer.concat(PARTS.map((p) => fs.readFileSync(path.join(SRC, p))));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const built = build();
  if (process.argv.includes("--check")) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT) : Buffer.alloc(0);
    if (!toLF(built).equals(toLF(cur))) {
      console.error("figma-plugin/code.js differs from figma-plugin-src/ build. Run: node scripts/build-plugin.mjs");
      process.exit(1);
    }
    console.log("code.js matches the build");
  } else {
    fs.writeFileSync(OUT, built);
    console.log(`wrote figma-plugin/code.js (${built.length} bytes, ${PARTS.length} parts)`);
  }
}
