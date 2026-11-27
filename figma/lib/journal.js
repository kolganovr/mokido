const fs = require("fs");
const os = require("os");
const path = require("path");
const { SERVER_BUILD, BRIDGE_TOKEN } = require("./config");
const { state } = require("./state");

// Process journal (ADR-002, T-008): a few lines per server process in a file, so
// the next "unable to establish connection" leaves a trace: start, role changes,
// why the process exited, and the stack of an uncaught error. Never written: script
// code, Figma file names, the bridge token. On by default; FIGMA_MCP_LOG_FILE=<path>
// moves it, FIGMA_MCP_LOG_FILE=0 turns it off. Writes are synchronous and every
// failure is swallowed: the journal must never take the server down.

const MAX_BYTES = 256 * 1024;
const KEEP_BYTES = 64 * 1024;   // tail kept when a start finds the file over MAX_BYTES
const PROCESS_BUDGET = 96 * 1024; // what one process may add
const STACK_MAX = 4000;

let active = false;
let file = null;
let written = 0;
let lastRole = null;

function journalPath() {
  const env = process.env.FIGMA_MCP_LOG_FILE;
  if (env === "0") return null;
  if (env && env.trim()) return env.trim();
  return path.join(os.tmpdir(), "mokido-server.log");
}

function roleName() {
  return state.isBridgeMaster ? "master" : "proxy";
}

function scrub(text) {
  let t = String(text == null ? "" : text);
  if (BRIDGE_TOKEN) t = t.split(BRIDGE_TOKEN).join("***");
  return t.length > STACK_MAX ? t.slice(0, STACK_MAX) + "..." : t;
}

function write(line) {
  if (!active || !file) return;
  try {
    if (written > PROCESS_BUDGET) return;
    const text = new Date().toISOString() + " pid=" + process.pid + " " + line.replace(/\r?\n/g, "\n    ") + "\n";
    written += Buffer.byteLength(text);
    fs.appendFileSync(file, text);
  } catch (e) {}
}

function trimToTail(p) {
  try {
    const size = fs.statSync(p).size;
    if (size <= MAX_BYTES) return;
    const fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(KEEP_BYTES);
    try { fs.readSync(fd, buf, 0, KEEP_BYTES, size - KEEP_BYTES); } finally { fs.closeSync(fd); }
    const text = buf.toString("utf8");
    const nl = text.indexOf("\n");
    fs.writeFileSync(p, nl === -1 ? text : text.slice(nl + 1));
  } catch (e) {}
}

// Reason lines. `reason` is a short fixed phrase (stdin closed, SIGTERM, ...).
function logExit(reason) {
  write("exit role=" + roleName() + " reason=" + scrub(reason));
}
function logRole(role) {
  if (role === lastRole) return;
  lastRole = role;
  write("role " + role);
}
function logError(kind, err) {
  const stack = err && err.stack ? err.stack : String(err);
  write(kind + " role=" + roleName() + "\n" + scrub(stack));
}

// Only for a process run as a server (require.main), never for a test that merely
// requires the facade.
function startJournal() {
  file = journalPath();
  if (!file) return false;
  active = true;
  trimToTail(file);
  write("start v" + SERVER_BUILD + " node=" + process.version);
  process.on("exit", (code) => write("process exit code=" + code));
  const crash = (kind) => (err) => {
    logError(kind, err);
    try { console.error(err && err.stack ? err.stack : err); } catch (e) {}
    process.exit(1);
  };
  process.on("uncaughtException", crash("uncaughtException"));
  process.on("unhandledRejection", crash("unhandledRejection"));
  // Test hook only: lets the suite prove a crash leaves a trace.
  const hook = process.env.FIGMA_MCP_TEST_CRASH;
  if (hook === "1") setTimeout(() => { throw new Error("test crash"); }, 300);
  else if (hook === "reject") setTimeout(() => { Promise.reject(new Error("test rejection")); }, 300);
  return true;
}

module.exports = { startJournal, logExit, logRole, logError, journalPath };
