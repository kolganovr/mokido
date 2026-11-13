const SERVER_ERROR_HINTS = [
  {
    // Not a bare "bridge": "bridge.foo is not a function" is a script error, not an
    // offline plugin (Argon audit 16.10, #15).
    test: /timeout|not connected|8765|bridge (?:is )?(?:offline|not running|unreachable)|no figma plugin/i,
    code: "BRIDGE_OFFLINE",
    hint: "The Figma plugin did not answer. Ask the user to open Figma DESKTOP (not the browser) and launch the Mokido plugin (Ctrl+Alt+P / Cmd+Option+P) until the status shows CONNECTED, then retry."
  },
  {
    test: /FIGMA_PERSONAL_ACCESS_TOKEN|401|403|Unauthorized/i,
    code: "REST_TOKEN_MISSING",
    hint: "REST tools need FIGMA_PERSONAL_ACCESS_TOKEN in the MCP server environment. Live tools (figma_execute_code, figma_screenshot, ...) work without a token — prefer them when the file is open in Figma Desktop."
  },
  {
    test: /Unknown tool/i,
    code: "UNKNOWN_TOOL",
    hint: "Call tools/list to see the tools this bridge actually exposes."
  }
];

// node_ids is declared as a comma-separated string, but models (and the older
// README) reach for an array often enough that rejecting one is pure friction —
// and it used to blow up on `.trim is not a function` deep inside the plugin.
function normalizeNodeIds(value) {
  if (value == null) return null;
  const raw = Array.isArray(value) ? value.join(",") : String(value);
  const ids = raw.split(",").map(s => s.trim().replace(/-/g, ":")).filter(Boolean);
  return ids.length > 0 ? ids.join(",") : null;
}

function classifyServerCode(message) {
  for (const rule of SERVER_ERROR_HINTS) {
    if (rule.test.test(message)) return rule.code;
  }
  return null;
}

function withServerHint(message) {
  if (/\bHINT:/.test(message)) return message; // plugin already explained it
  for (const rule of SERVER_ERROR_HINTS) {
    if (rule.test.test(message)) return message + "\n\nHINT: " + rule.hint;
  }
  return message;
}

// Tool output is compact JSON. Pretty-printing (indent 2) spent a newline and
// indentation tokens on every key of every result, and results stay in the
// agent's context for the rest of the session.
function toJson(value) {
  return JSON.stringify(value);
}

module.exports = { normalizeNodeIds, classifyServerCode, withServerHint, toJson };
