
// --- result sanitizing --------------------------------------------------------
// figma.ui.postMessage structured-clones the envelope. figma.mixed is a Symbol
// (and nodes / functions are not cloneable either), so a perfectly good edit
// used to end in "Cannot unwrap symbol" AFTER the mutation ran — the agent saw
// an error and repeated the edit. This makes any return value transferable.
function sanitizeForTransfer(value) {
  const path = [];
  const walk = (v, depth) => {
    if (v === null || v === undefined) return v;
    const t = typeof v;
    if (t === "string" || t === "number" || t === "boolean") return v;
    if (t === "symbol") return "mixed";
    if (t === "bigint") return String(v);
    if (t === "function") return undefined;
    if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return "[bytes " + v.byteLength + "]";
    if (depth > 12) return "[deep]";
    if (path.indexOf(v) !== -1) return "[circular]";
    if (v instanceof Error) return String(v.name || "Error") + ": " + String(v.message);
    if (v instanceof Date) return v.toISOString();
    let isNode = false;
    try { isNode = typeof v.id === "string" && typeof v.type === "string" && "parent" in v; } catch (e) {}
    if (isNode) {
      const brief = {};
      ["id", "name", "type"].forEach(k => { try { brief[k] = v[k]; } catch (e) {} });
      return brief;
    }
    path.push(v);
    try {
      if (Array.isArray(v)) return v.map(x => { const r = walk(x, depth + 1); return r === undefined ? null : r; });
      if (v instanceof Set) return Array.from(v).map(x => { const r = walk(x, depth + 1); return r === undefined ? null : r; });
      const src = v instanceof Map ? Object.fromEntries(v) : v;
      const out = {};
      Object.keys(src).forEach(k => {
        let child;
        try { child = src[k]; } catch (e) { out[k] = "[unreadable]"; return; }
        const r = walk(child, depth + 1);
        if (r !== undefined) out[k] = r;
      });
      return out;
    } finally {
      path.pop();
    }
  };
  return walk(value, 0);
}

// Ceiling on what a single capture may render. A whole page at 1.5x on a real
// design file is tens of megapixels; base64-encoding that in the sandbox and
// pushing it into the model's context either timed out or flooded the window.
const MAX_CAPTURE_PIXELS = 4_000_000;   // ~2000x2000
const MAX_CAPTURE_BASE64 = 8 * 1024 * 1024;
// A model is billed for an image by its pixel area (~w*h/750 tokens), and the
// image stays in its context for the rest of the session. 1024px on the long
// side keeps a full screen legible at ~1k tokens; a caller can raise it.
const DEFAULT_CAPTURE_MAX_PX = 1024;

// Pure, so tests/bridge-runtime.test.js can pin it: the export scale that
// honours the requested scale, then the longest-side cap, then the pixel cap.
function computeCaptureScale(width, height, scale, maxPx) {
  let s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (w > 0 && h > 0) {
    const cap = Number.isFinite(maxPx) && maxPx > 0 ? maxPx : DEFAULT_CAPTURE_MAX_PX;
    const longest = Math.max(w, h);
    if (longest * s > cap) s = cap / longest;
    if (w * h * s * s > MAX_CAPTURE_PIXELS) s = Math.sqrt(MAX_CAPTURE_PIXELS / (w * h));
  }
  return Math.max(0.01, s);
}

async function exportNodeToPngBase64(node, scale = 1, maxPx = DEFAULT_CAPTURE_MAX_PX) {
  if (!node) return null;

  // Shrink instead of refusing: a smaller screenshot is still a useful one.
  const effectiveScale = computeCaptureScale(node.width, node.height, scale, maxPx);

  try {
    const bytes = await node.exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: effectiveScale }
    });
    const b64 = bytesToBase64(bytes);
    if (b64.length > MAX_CAPTURE_BASE64) {
      throw new Error(
        `Screenshot is ${Math.round(b64.length / 1048576)} MB after encoding, over the ${MAX_CAPTURE_BASE64 / 1048576} MB limit. ` +
        `Select a specific frame (or pass node_ids) instead of capturing the whole page, or lower "scale".`
      );
    }
    return b64;
  } catch (err) {
    // Surfaced by the caller rather than swallowed — a silent null looked
    // identical to "nothing was selected".
    throw new Error(`Screenshot failed for "${node.name || node.type}": ${err.message || String(err)}`);
  }
}

// A failed capture must never fail the canvas edit that already succeeded.
async function captureSafe(node, scale, maxPx) {
  try {
    return { base64: await exportNodeToPngBase64(node, scale, maxPx), error: null };
  } catch (err) {
    return { base64: null, error: err.message || String(err) };
  }
