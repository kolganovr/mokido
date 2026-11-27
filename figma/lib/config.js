const path = require("path");

const FIGMA_TOKEN = process.env.FIGMA_PERSONAL_ACCESS_TOKEN || process.env.FIGMA_API_KEY || "";

// ==========================================
// Figma Live Plugin Bridge (HTTP + WebSocket Server)
// ==========================================
const BRIDGE_PORT = parseInt(process.env.FIGMA_BRIDGE_PORT, 10) || 8765;

// ------------------------------------------------------------------
// Access control.
//
// /execute takes an arbitrary JS string and runs it inside the user's open
// Figma document. Bound to loopback that is still reachable by ANY web page the
// user happens to have open, so without these two gates a visited site could
// read, rewrite or delete their design (and open a WebSocket to impersonate the
// plugin). Two independent checks:
//
//   1. Origin allowlist — a browser cannot forge Origin, so a page on evil.com
//      is rejected outright. Figma's plugin iframe sends "null" or figma.com.
//   2. Shared token — install.mjs generates one, puts it in the MCP config env
//      and bakes the same value into the installed plugin UI. This also covers
//      the sandboxed-iframe case, where a hostile page can also present "null".
//
// With no token configured (running straight from a clone) the Origin gate
// still applies and a warning is printed, so the bridge degrades rather than
// silently becoming wide open.
// ------------------------------------------------------------------
const BRIDGE_TOKEN = (process.env.FIGMA_BRIDGE_TOKEN || "").trim();
const ALLOWED_ORIGINS = new Set(["null", "https://www.figma.com", "https://figma.com"]);

// A single frame must not be able to exhaust memory before we can reject it.
const MAX_WS_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_HTTP_BODY_BYTES = 64 * 1024 * 1024;

// One place instead of four different literals (40000 / 45000 / 30000 / 35000)
// scattered across handleCallTool. `escalate` is how long a synchronous
// figma_execute_code call is allowed to block before it is handed back to the
// agent as a background job instead of failing outright — see the Job Ledger
// below and SERVER_VERSION.
function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// `escalate` went 30s -> 45s: every escalation costs the agent at least one
// extra figma_job_status turn, and each turn re-reads the WHOLE conversation.
// 45s still sits under the ~60s tool-call timeout of the strictest MCP clients.
const TIMEOUTS = {
  fast: envNumber("FIGMA_MCP_TIMEOUT_FAST_MS", 15000),
  normal: envNumber("FIGMA_MCP_TIMEOUT_MS", 45000),
  heavy: envNumber("FIGMA_MCP_TIMEOUT_HEAVY_MS", 120000),
  escalate: envNumber("FIGMA_MCP_ESCALATE_MS", 45000)
};
const SERVER_VERSION = "4.4.0";

// ------------------------------------------------------------------
// Token economy. In an agent loop the price of a tool call is not its own
// output — it is the whole context re-read on the NEXT turn, and everything a
// call returns stays in that context until the session ends. So the defaults
// below optimise for: fewer turns (long-poll jobs, wait out a plugin reload),
// smaller images (tokens scale with pixels, not bytes), and bounded text.
// Every knob is overridable per call and per install (env).
// ------------------------------------------------------------------
const ECONOMY = {
  scale: envNumber("FIGMA_MCP_SCALE", 1),                        // screenshot scale when the caller passes none
  maxPx: envNumber("FIGMA_MCP_MAX_PX", 1024),                    // longest image side; ~1k tokens at 1024x1024
  maxImages: envNumber("FIGMA_MCP_MAX_IMAGES", 4),               // images per tool response (the plugin sends up to 4 downscaled ones)
  // Text budget for a whole tool response, in UTF-8 BYTES — not chars: some
  // clients spill any tool output over ~4 KB into a file the model then has to
  // open with a second tool call (Antigravity does, measured at ~4.1 KB), and
  // Cyrillic/CJK text is 2-3 bytes per char, so a 6000-char cap spilled
  // constantly. 3500 stays under that with room for the envelope.
  maxOutputBytes: envNumber("FIGMA_MCP_MAX_OUTPUT_BYTES", envNumber("FIGMA_MCP_MAX_OUTPUT_CHARS", 3500)),
  // Hard ceiling for a REQUESTED max_output_bytes: a model that saw a cut and
  // asked for 5000 got a reply over Antigravity's ~4.1 KB spill limit, which
  // was written to a file (an extra turn). Applies to max_output_bytes: 0 too.
  // Without the env var it is on for every client except the ones known not
  // to spill (see clientSpillsOutput); 0 in the env = never, N = always N.
  outputCeiling: envNumber("FIGMA_MCP_MAX_OUTPUT_CEILING", 3900),
  outputCeilingFromEnv: Number.isFinite(Number(process.env.FIGMA_MCP_MAX_OUTPUT_CEILING)) && process.env.FIGMA_MCP_MAX_OUTPUT_CEILING !== "",
  jobWaitMs: envNumber("FIGMA_MCP_JOB_WAIT_MS", 45000),          // how long figma_job_status blocks by default
  jobWaitMaxMs: 55000,                                           // keep under ~60s client tool timeouts
  reconnectGraceMs: envNumber("FIGMA_MCP_RECONNECT_GRACE_MS", 8000), // wait for a reloading plugin instead of failing
  stalledAfterMs: envNumber("FIGMA_MCP_STALLED_MS", 120000),     // no progress for this long => report as stalled
  jobExpireMs: envNumber("FIGMA_MCP_JOB_EXPIRE_MS", 30 * 60 * 1000) // a job nobody waits for, silent this long => JOB_EXPIRED (0 = never)
};

// Who started a command. Proxies send it to the master so a late result goes
// back to the process (agent) that ran it, not to whoever calls next.
const ORIGIN_ID = "o_" + require("crypto").randomBytes(6).toString("hex");

// Paths: FIGMA_DIR is the figma/ folder, PACKAGE_ROOT the package root above it.
const FIGMA_DIR = path.join(__dirname, "..");
const PACKAGE_ROOT = path.join(FIGMA_DIR, "..");
// Build label of an installed copy (T-140): "4.5.0-dev.58+b4ffd0c" between releases, else SERVER_VERSION.
const SERVER_BUILD = require("./buildinfo").readBuild(PACKAGE_ROOT) || SERVER_VERSION;

module.exports = { FIGMA_TOKEN, BRIDGE_PORT, BRIDGE_TOKEN, ALLOWED_ORIGINS, MAX_WS_MESSAGE_BYTES, MAX_HTTP_BODY_BYTES, TIMEOUTS, SERVER_VERSION, SERVER_BUILD, ECONOMY, ORIGIN_ID, envNumber, FIGMA_DIR, PACKAGE_ROOT };
