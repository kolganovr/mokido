}

// Helper to safely apply text overrides to nested text layers inside an instance.
// Matching is deliberately narrow: the old rule also accepted
// `nodeName.includes(targetKey)` for EVERY node, so one {"Label": "..."} override
// rewrote every layer whose name merely contained "label".
async function applyTextOverrides(container, overrides) {
  if (!overrides || typeof overrides !== 'object') return [];
  const textNodes = container.findAll ? container.findAll(n => n.type === 'TEXT') : [];
  const applied = [];

  for (const [key, val] of Object.entries(overrides)) {
    const targetKey = key.trim().toLowerCase();

    const byName = textNodes.filter(n => (n.name || '').trim().toLowerCase() === targetKey);
    const byChars = textNodes.filter(n => (n.characters || '').trim().toLowerCase() === targetKey);
    const byPartialName = textNodes.filter(n => (n.name || '').trim().toLowerCase().includes(targetKey));

    // Exact name wins; exact current text next; a fuzzy name match is only a
    // last resort and only when it is UNambiguous.
    let target = byName[0] || byChars[0] || null;
    if (!target && byPartialName.length === 1) target = byPartialName[0];
    if (!target) continue;

    try {
      await loadFontsForTextNode(target);
      target.characters = String(val);
      applied.push(key);
    } catch (e) {
      // Leave this override unapplied; the caller reports what did land.
    }
  }

  return applied;
}

// Color parser for Hex, RGB, and named colors
function parseColor(colorStr) {
  if (!colorStr || typeof colorStr !== 'string') return null;
  const str = colorStr.trim().toLowerCase();
  
  if (str === 'white') return { r: 1, g: 1, b: 1 };
  if (str === 'black') return { r: 0, g: 0, b: 0 };
  if (str === 'transparent') return null;

  if (str.startsWith('#')) {
    let hex = str.slice(1);
    if (hex.length === 3) hex = hex.split('').map(x => x + x).join('');
    // Validate before parsing: "#zzzzzz" used to yield {r: NaN, ...} and Figma
    // threw an opaque error several frames later instead of here.
    if (!/^[0-9a-f]{6}$/.test(hex.substring(0, 6)) || hex.length < 6) {
      throw new Error(`Invalid hex color "${colorStr}". Expected 3 or 6 hex digits, e.g. "#6366F1".`);
    }
    return {
      r: parseInt(hex.substring(0, 2), 16) / 255,
      g: parseInt(hex.substring(2, 4), 16) / 255,
      b: parseInt(hex.substring(4, 6), 16) / 255
    };
  }

  const rgbMatch = str.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgbMatch) {
    const clamp = (n) => Math.max(0, Math.min(255, n)) / 255;
    return {
      r: clamp(parseInt(rgbMatch[1], 10)),
      g: clamp(parseInt(rgbMatch[2], 10)),
      b: clamp(parseInt(rgbMatch[3], 10))
    };
  }

  throw new Error(`Unrecognised color "${colorStr}". Use hex ("#6366F1"), rgb(r, g, b), "white", "black" or "transparent".`);
}

function applyScaleConstraints(node) {
  if ('constraints' in node) {
    node.constraints = { horizontal: 'SCALE', vertical: 'SCALE' };
  }
  if ('children' in node) {
    for (const child of node.children) {
      applyScaleConstraints(child);
    }
  }
}

function applyVectorColors(container, { fillColor, strokeColor, universalColor }) {
  const nodes = container.findAll ? container.findAll(n => 'fills' in n || 'strokes' in n) : [];
  const allNodes = [container, ...nodes];

  for (const n of allNodes) {
    const targetFill = universalColor || fillColor;
    if (targetFill && 'fills' in n && Array.isArray(n.fills) && n.fills.length > 0) {
      n.fills = [{ type: 'SOLID', color: targetFill }];
    }

    const targetStroke = universalColor || strokeColor;
    if (targetStroke && 'strokes' in n && Array.isArray(n.strokes) && n.strokes.length > 0) {
      n.strokes = [{ type: 'SOLID', color: targetStroke }];
    }
  }
}
