const { BRIDGE_PORT, BRIDGE_TOKEN } = require("./config");
const { state } = require("./state");

// server.js hands the HTTP server over right after creating it, so this module
// never has to import server.js (that would be a require cycle).
const holder = { server: null };
function attachServer(bridgeServer) {
  holder.server = bridgeServer;
}

// Multiple agents (Antigravity, Claude Desktop, Cursor, ...) each spawn their own
// copy of this server; the first one to bind :8765 owns the plugin socket and the
// rest proxy to it. When the owner exits, one of the proxies has to be able to
// take the port over — previously `isBridgeMaster` was latched to false forever,
// so every surviving agent stayed permanently broken until it was restarted.
function tryBecomeMaster() {
  if (state.isBridgeMaster || state.listenAttemptInFlight) return;
  state.listenAttemptInFlight = true;
  try {
    holder.server.listen(BRIDGE_PORT, "127.0.0.1", () => {
      state.isBridgeMaster = true;
      state.listenAttemptInFlight = false;
      if (!BRIDGE_TOKEN) {
        console.error(
          "[Mokido] WARNING: no FIGMA_BRIDGE_TOKEN configured. " +
          "Only the Origin allowlist is protecting :8765 — re-run install.mjs to provision a token."
        );
      }
    });
  } catch (e) {
    state.listenAttemptInFlight = false;
  }
}

module.exports = { tryBecomeMaster, attachServer };
