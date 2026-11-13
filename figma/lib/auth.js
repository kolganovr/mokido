const path = require("path");
const { BRIDGE_PORT, BRIDGE_TOKEN, ALLOWED_ORIGINS, PACKAGE_ROOT } = require("./config");

function isOriginAllowed(req) {
  const origin = req.headers["origin"];
  // Non-browser callers (our own proxy fetch, curl) send no Origin at all.
  if (!origin) return true;
  return ALLOWED_ORIGINS.has(origin.toLowerCase());
}

function hasValidToken(req) {
  if (!BRIDGE_TOKEN) return true;
  const headerToken = req.headers["x-bridge-token"];
  if (typeof headerToken === "string" && headerToken === BRIDGE_TOKEN) return true;
  try {
    const url = new URL(req.url, `http://127.0.0.1:${BRIDGE_PORT}`);
    return url.searchParams.get("token") === BRIDGE_TOKEN;
  } catch (e) {
    return false;
  }
}

function isAuthorized(req) {
  if (!isOriginAllowed(req)) return false;
  if (hasValidToken(req)) return true;
  noteRejectedPlugin(req);
  return false;
}

// ------------------------------------------------------------------
// Wrong plugin copy. Figma runs whichever manifest.json the user imported;
// only the copies install.mjs writes carry the bridge token, so a plugin that
// passes the Origin gate but brings no/another token is almost always the
// repository checkout imported by hand. Agents that only see "not connected"
// have "fixed" that by writing the token into the repo's ui.html — so the
// rejection is remembered and the connect error names the real fix.
// ------------------------------------------------------------------
const INSTALLED_PLUGIN_MANIFEST = path.join(PACKAGE_ROOT, "figma-plugin", "manifest.json");
let lastRejectedPlugin = null; // { at, tokenless }
let lastRejectLogAt = 0;

function presentedToken(req) {
  const header = req.headers && req.headers["x-bridge-token"];
  if (typeof header === "string" && header) return header;
  try {
    return new URL(req.url, `http://127.0.0.1:${BRIDGE_PORT}`).searchParams.get("token") || "";
  } catch (e) {
    return "";
  }
}

function noteRejectedPlugin(req) {
  const tokenless = !presentedToken(req);
  lastRejectedPlugin = { at: Date.now(), tokenless };
  if (Date.now() - lastRejectLogAt > 60000) {
    lastRejectLogAt = Date.now();
    console.error("[Mokido] " + wrongPluginCopyMessage(lastRejectedPlugin));
  }
}

function wrongPluginCopyMessage(rejected) {
  const ago = Math.max(0, Math.round((Date.now() - rejected.at) / 1000));
  return `A Figma plugin tried to connect ${ago}s ago and was REJECTED: it brought ` +
    (rejected.tokenless ? "no bridge token" : "a different bridge token") +
    ", so Figma is running a plugin copy install.mjs did not produce (typically this repository's figma-plugin/ imported directly" +
    (rejected.tokenless ? "" : ", or a copy from an older install") +
    `).\n\nHINT: the user fixes it once: Figma → Plugins → Development → Import plugin from manifest… → ${INSTALLED_PLUGIN_MANIFEST}, then remove the old entry (named "Antigravity Bridge" before 4.3.0, or a duplicate "Mokido"). ` +
    "Do NOT write the token into ui.html or any other source file — it would leak into the repository.";
}

function recentlyRejectedPlugin() {
  return lastRejectedPlugin && Date.now() - lastRejectedPlugin.at < 10 * 60 * 1000 ? lastRejectedPlugin : null;
}

module.exports = { isOriginAllowed, isAuthorized, wrongPluginCopyMessage, recentlyRejectedPlugin };
