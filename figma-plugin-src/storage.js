
// ==========================================================================
// Bridge Runtime — persistent state, code modules, actionable error hints
// --------------------------------------------------------------------------
// WHY THIS EXISTS
// Every figma_execute_code call is compiled into a FRESH AsyncFunction, so
// top-level const/let/var/function declarations die with the call. And `eval`
// inside the Figma plugin sandbox is a BOUND function, which by spec makes
// every eval() an INDIRECT eval: it cannot see the caller's locals and its
// declarations never reach the caller or globalThis. So the classic "stash
// source in pluginData, eval it next call" trick silently produces nothing.
// `new Function(...)` bodies, in contrast, are ordinary function scopes where
// declarations behave normally, and they share the same globalThis. The module
// loader below is built on that.
// ==========================================================================

const BRIDGE_STATE = {};          // survives calls, cleared on plugin reload
const BRIDGE_MODULES = {};        // name -> compiled exports (in-memory cache)
const BRIDGE_KEY = "abridge:";    // pluginData namespace on figma.root
const BRIDGE_CHUNK = 60000;       // BYTES per entry; pluginData caps around 100KB

// Figma measures the pluginData limit in BYTES, but chunking used to slice by
// JS string length. A module or store value written in Cyrillic is ~2 bytes per
// character, so a "60000-char" chunk was really 120KB and setPluginData threw.
// These helpers split on the real UTF-8 budget, never inside a surrogate pair.
function utf8CharBytes(code) {
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  return 3;
}

function chunkByUtf8Bytes(str, maxBytes) {
  const parts = [];
  let start = 0;
  let bytes = 0;

  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    let size = utf8CharBytes(code);
    let isPair = false;

    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        size = 4;      // one astral code point encoded from two JS chars
        isPair = true;
      }
    }

    // Cut BEFORE the current character so a pair is never torn apart.
    if (bytes + size > maxBytes && i > start) {
      parts.push(str.slice(start, i));
      start = i;
      bytes = 0;
    }

    bytes += size;
    if (isPair) i++;
  }

  parts.push(str.slice(start));
  return parts;
}

function bridgeWrite(key, value) {
  const str = String(value == null ? "" : value);
  const full = BRIDGE_KEY + key;
  // wipe any previous chunk tail before rewriting
  const prev = parseInt(figma.root.getPluginData(full + ":n") || "0", 10);
  for (let i = 0; i < prev; i++) figma.root.setPluginData(full + ":" + i, "");

  const parts = chunkByUtf8Bytes(str, BRIDGE_CHUNK);

  if (parts.length <= 1) {
    figma.root.setPluginData(full, str);
    figma.root.setPluginData(full + ":n", "");
    return str.length;
  }

  parts.forEach((p, i) => figma.root.setPluginData(full + ":" + i, p));
  figma.root.setPluginData(full, "");
  figma.root.setPluginData(full + ":n", String(parts.length));
  return str.length;
}

function bridgeRead(key) {
  const full = BRIDGE_KEY + key;
  const n = parseInt(figma.root.getPluginData(full + ":n") || "0", 10);
  if (!n) return figma.root.getPluginData(full);
  let out = "";
  for (let i = 0; i < n; i++) out += figma.root.getPluginData(full + ":" + i);
  return out;
}

function bridgeIndex(kind) {
  try {
    const raw = bridgeRead("index:" + kind);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

function bridgeIndexAdd(kind, name) {
  const list = bridgeIndex(kind);
  if (list.indexOf(name) === -1) {
    list.push(name);
    bridgeWrite("index:" + kind, JSON.stringify(list));
  }
}

function bridgeIndexRemove(kind, name) {
  bridgeWrite("index:" + kind, JSON.stringify(bridgeIndex(kind).filter(n => n !== name)));
}

function bridgeCompile(name, source, bridgeApi) {
  // Ordinary function scope: `function foo(){}` and `const x = 1` inside
  // `source` are real declarations here, unlike anything declared via eval().
  let factory;
  try {
    factory = new Function(
      "exports", "module", "figma", "ensureFont", "bridge",
      source + "\n;return module.exports;"
    );
  } catch (err) {
    throw new Error(
      "Module \"" + name + "\" failed to compile: " + err.message +
      ". The module body is a SYNCHRONOUS function body — top-level await is not allowed; " +
      "export an async function instead."
    );
  }
  const mod = { exports: {} };
  const exported = factory(mod.exports, mod, figma, ensureFont, bridgeApi);
  const empty = !exported ||
    (typeof exported !== "function" &&
     (typeof exported !== "object" || Object.keys(exported).length === 0));
  if (empty) {
    throw new Error(
      "Module \"" + name + "\" exported nothing. End the module source with " +
      "module.exports = { ... } listing the helpers you want back."
    );
  }
  BRIDGE_MODULES[name] = exported;
  return exported;
}
