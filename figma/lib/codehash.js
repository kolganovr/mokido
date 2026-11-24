// Fingerprint of the server code (T-099). /status reports it so install.mjs
// --update can tell a master started before the update (old code in memory)
// from one running the files now on disk, even when the version is the same.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function listJs(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") listJs(full, base, out);
    } else if (entry.name.endsWith(".js")) {
      out.push(path.relative(base, full).split(path.sep).join("/"));
    }
  }
  return out;
}

/** 12 hex chars: sha256 over (relative path, content) of every .js under figma/. "" on failure. */
function computeCodeHash(figmaDir) {
  try {
    const h = crypto.createHash("sha256");
    for (const rel of listJs(figmaDir, figmaDir, []).sort()) {
      h.update(rel + "\0");
      h.update(fs.readFileSync(path.join(figmaDir, rel)));
      h.update("\0");
    }
    return h.digest("hex").slice(0, 12);
  } catch {
    return "";
  }
}

module.exports = { computeCodeHash };
