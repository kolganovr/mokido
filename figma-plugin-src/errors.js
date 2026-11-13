
const BRIDGE_PROBE_KEYS = ["then", "toJSON", "constructor", "prototype", "$$typeof", "asymmetricMatch", "nodeType"];

// Rewrites raw sandbox/platform errors into messages that tell an agent what
// to do differently.
const BRIDGE_ERROR_HINTS = [
  {
    test: /cannot be overridden in an instance|relative-transform/i,
    code: "INSTANCE_TRANSFORM_LOCKED",
    hint: "Children of an INSTANCE cannot have x/y (and other override-forbidden props) set directly. " +
          "Position via AutoLayout on the parent (itemSpacing, primaryAxisAlignItems, counterAxisAlignItems), " +
          "or edit the master COMPONENT instead of the instance. bridge.setPosition(node, x, y) checks this for you."
  },
  {
    test: /unloaded font|font.*(not loaded|must be loaded)|loadFontAsync/i,
    code: "FONT_NOT_LOADED",
    hint: "Load the font first: await ensureFont(family, style) before touching characters / fontName / fontSize."
  },
  {
    test: /over the .* MB limit|too large after encoding/i,
    code: "CAPTURE_TOO_LARGE",
    hint: "Pass capture_node_ids for a specific node instead of capturing everything, or lower \"scale\"."
  },
  {
    test: /await is only valid|Unexpected token|Unexpected identifier|Invalid or unexpected|Unexpected end of input/i,
    code: "SCRIPT_SYNTAX_ERROR",
    hint: "Your code is compiled as an async function body: top-level await and return are allowed, " +
          "import/export are not. Check for unbalanced braces or quotes in the code string."
  },
  {
    test: /removed node|does not exist|has been removed/i,
    code: "STALE_NODE_ID",
    hint: "The node was deleted or replaced — createComponentFromNode, flatten and boolean ops return NEW nodes " +
          "with new ids. Keep the returned reference or re-fetch with figma.getNodeById."
  },
  {
    test: /in set_(width|height)|Cannot resize|fixed dimensions/i,
    code: "AUTOLAYOUT_HUG_RESIZE",
    hint: "AutoLayout frames ignore resize on axes set to AUTO (hug). Set primaryAxisSizingMode / " +
          "counterAxisSizingMode to \"FIXED\" before resizing, or resize the child that drives the layout."
  },
  {
    test: /pluginData|exceeds|too large/i,
    code: "PLUGINDATA_LIMIT",
    hint: "pluginData entries are capped around 100KB. bridge.store and bridge.define chunk automatically — " +
          "use them instead of raw figma.root.setPluginData for large payloads."
  },
  {
    test: /is not defined|is not a function|Cannot read propert/i,
    code: "SCOPE_LOST",
    hint: "Every call runs in a fresh scope, so helpers from a previous figma_execute_code call are gone, and " +
          "anything declared through eval() never existed at all. Persist reusable code with " +
          "bridge.define(\"kit\", \"...; module.exports = { helper }\") and reload it via bridge.require(\"kit\")."
  }
];

function enrichBridgeError(err) {
  const message = (err && err.message) ? err.message : String(err);
  for (const rule of BRIDGE_ERROR_HINTS) {
    if (rule.test.test(message)) return { message, hint: rule.hint, code: rule.code };
  }
  return { message, hint: null, code: null };
}

// --- error line numbers -----------------------------------------------------
// The agent's code runs as `new AsyncFunction(...EXECUTE_PARAM_NAMES, code)`.
// The engine adds a few wrapper lines above the body, and the stack format
// differs per engine (V8: "at f (<anonymous>:3:7)", QuickJS: "at <anonymous>
// (<input>:3)"), so the offset is CALIBRATED once at runtime with a probe that
// throws on body line 1, instead of being hard-coded.
const EXECUTE_PARAM_NAMES = ["figma", "ensureFont", "notify", "log", "getFreePosition", "getFreeCanvasPosition", "bridge", "progress"];

// Stack text -> [{ file, line, column }] for every "at ..." frame that ends in a position.
function parseStackFrames(stack) {
  const frames = [];
  String(stack || "").split("\n").forEach(raw => {
    if (!/^\s*at\s/.test(raw)) return;
    const m = /([^\s()]*?):(\d+)(?::(\d+))?\)?\s*$/.exec(raw);
    if (!m) return;
    frames.push({ file: m[1], line: parseInt(m[2], 10), column: m[3] ? parseInt(m[3], 10) : null });
  });
  return frames;
}

// From the probe's stack: which "file" token marks frames of the anonymous
// function, and how many wrapper lines sit above the body. null = unknown.
function calibrateFromProbeStack(stack) {
  const first = parseStackFrames(stack)[0];
  if (!first || !(first.line >= 1)) return null;
  return { file: first.file, offset: first.line - 1 };
}

// { line, column, at } for the first frame that belongs to the agent's code, or null.
function locateErrorInCode(stack, code, calibration) {
  if (!calibration || typeof code !== "string") return null;
  const lines = code.split("\n");
  const frames = parseStackFrames(stack);
  for (const f of frames) {
    if (f.file !== calibration.file) continue;
    const line = f.line - calibration.offset;
    if (line < 1 || line > lines.length) continue;      // a plugin frame that happens to share the token
    return { line: line, column: f.column, at: lines[line - 1].trim().slice(0, 160) };
  }
  return null;
}

let ANON_CALIBRATION;   // undefined = not measured yet, null = engine gave us nothing usable
async function getAnonCalibration(AsyncFunction) {
  if (ANON_CALIBRATION !== undefined) return ANON_CALIBRATION;
  ANON_CALIBRATION = null;
  try {
    const probe = new AsyncFunction(...EXECUTE_PARAM_NAMES, 'throw new Error("probe")');
    await probe();
  } catch (e) {
    try { ANON_CALIBRATION = calibrateFromProbeStack(e && e.stack); } catch (e2) {}
  }
  return ANON_CALIBRATION;
}
