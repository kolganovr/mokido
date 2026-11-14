figma.showUI(__html__, { width: 360, height: 240, themeColors: true });

let autoZoomEnabled = true;
let smartPlacementEnabled = true;

// Toast batching: a burst of calls (bulk generation, a multi-step flow) used to
// fire one figma.notify() per call — at 20+ calls that buries the canvas in
// toasts. The first few in any 4s window still get their own toast (so a
// single action still feels immediate); anything after that relies on the
// HUD log stream instead, which already receives every RESULT regardless.
const recentActionTimestamps = [];
function allowCanvasToast() {
  const now = Date.now();
  while (recentActionTimestamps.length && now - recentActionTimestamps[0] > 4000) recentActionTimestamps.shift();
  recentActionTimestamps.push(now);
  return recentActionTimestamps.length <= 3;
}

// Pure JS Base64 encoder for Figma sandbox (QuickJS / V8 safe without btoa)
function bytesToBase64(bytes) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  let i = 0;
  const l = bytes.length;
  while (i < l) {
    const a = bytes[i++];
    const b = i < l ? bytes[i++] : NaN;
    const c = i < l ? bytes[i++] : NaN;
    result += chars[a >> 2];
    result += chars[((a & 3) << 4) | (isNaN(b) ? 0 : (b >> 4))];
    result += isNaN(b) ? '=' : chars[((b & 15) << 2) | (isNaN(c) ? 0 : (c >> 6))];
    result += isNaN(c) ? '=' : chars[c & 63];
  }
  return result;
}

// A loaded font stays loaded for the plugin's life: load each family|style once.
// A repeated load of a loaded font can wait 20-270 s for a canvas frame while
// Figma is in the background (bench H5, T12), so a load still pending after
// FONT_LOAD_TIMEOUT_MS is taken as done; a font that really is missing fails
// at the write with the unloaded-font hint.
// The loads that did not finish in time are remembered in FONT_TIMEOUTS
// (key -> font) so a later "unloaded font" write error can name them
// (enrichBridgeError). Slightly under the server prelude's own 5 s, so this
// timer fires first and the record exists before the prelude lets the script go on.
const LOADED_FONTS = new Set();
const FONT_TIMEOUTS = new Map();
const FONT_LOAD_TIMEOUT_MS = 4900;
async function loadFontOnce(font) {
  const key = font.family + "|" + font.style;
  if (LOADED_FONTS.has(key)) return;
  let timer;
  let timedOut = false;
  const late = new Promise(resolve => { timer = setTimeout(() => { timedOut = true; resolve(); }, FONT_LOAD_TIMEOUT_MS); });
  const load = Promise.resolve(figma.loadFontAsync(font));
  try { await Promise.race([load, late]); } finally { clearTimeout(timer); }
  if (timedOut) {
    FONT_TIMEOUTS.set(key, font);
    load.then(() => { FONT_TIMEOUTS.delete(key); }, () => {});
  }
  LOADED_FONTS.add(key);
}

// Auto-load fonts safely with fallback chain
async function ensureFont(family = "Inter", style = "Regular") {
  try {
    await loadFontOnce({ family, style });
  } catch (e) {
    try {
      await loadFontOnce({ family: "Inter", style: "Regular" });
    } catch (e2) {
      try {
        await loadFontOnce({ family: "Roboto", style: "Regular" });
      } catch (e3) {}
    }
  }
}
