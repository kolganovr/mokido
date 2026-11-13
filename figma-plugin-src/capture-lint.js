
// ==========================================================================
// Smart Capture — resolves WHAT to screenshot without touching the user's
// selection, and frames tightly instead of exporting a whole container.
// ==========================================================================
function ancestorChain(node) {
  const chain = [];
  let n = node;
  while (n) { chain.push(n); n = n.parent; }
  return chain;
}

// Deepest node that contains every given node somewhere in its subtree, or
// null if they share nothing but the page.
function findCommonAncestor(nodes) {
  if (nodes.length === 0) return null;
  if (nodes.length === 1) return nodes[0];
  let common = ancestorChain(nodes[0]);
  for (let i = 1; i < nodes.length && common.length > 0; i++) {
    const idsInChain = new Set(ancestorChain(nodes[i]).map(n => n.id));
    common = common.filter(n => idsInChain.has(n.id));
  }
  return common[0] || null;
}

// capture_node_ids wins; otherwise whatever this call's checkpoint created or
// modified; otherwise the user's current selection (last resort, so a call
// with no other signal still behaves like the old default) — but selection is
// never MUTATED to make a capture possible, only read.
function resolveCaptureTargets(captureNodeIds, checkpointCreated, checkpointModified, selection) {
  if (Array.isArray(captureNodeIds) && captureNodeIds.length > 0) {
    return captureNodeIds.map(id => figma.getNodeById(id)).filter(Boolean);
  }
  const journalIds = [].concat(checkpointCreated || [], checkpointModified || []);
  if (journalIds.length > 0) {
    const seen = new Set();
    return journalIds.map(id => figma.getNodeById(id)).filter(n => n && !seen.has(n.id) && seen.add(n.id));
  }
  if (selection && selection.length > 0) return selection.slice();
  return [];
}

// Degrades in order: (1) single node → direct export, (2) multiple nodes that
// share a real frame → export that frame ONLY when it is not much bigger than
// the targets themselves (area <= 3x the sum of their areas — otherwise the
// crop is mostly unrelated pixels), (3) otherwise up to 4 nodes individually,
// each at maxPx / sqrt(n) so the whole set costs about one image.
const CAPTURE_MAX_INDIVIDUAL = 4;
const BEFORE_SHOT_TIMEOUT_MS = 5000;
const CAPTURE_MIN_EACH_PX = 384;
const CAPTURE_ANCESTOR_AREA_FACTOR = 3;

function nodeArea(n) {
  return (Number(n && n.width) || 0) * (Number(n && n.height) || 0);
}

async function exportCaptureTargets(nodes, scale, maxPx) {
  const cleaned = (nodes || []).filter(n => n && typeof n.exportAsync === 'function');
  if (cleaned.length === 0) {
    return { images: [], note: null, targetName: null, targetId: null };
  }

  if (cleaned.length === 1) {
    const n = cleaned[0];
    const shot = await captureSafe(n, scale, maxPx);
    return {
      images: shot.base64 ? [{ base64: shot.base64, label: n.name || n.type }] : [],
      note: shot.error,
      targetName: n.name || n.type,
      targetId: n.id
    };
  }

  const ancestor = findCommonAncestor(cleaned);
  if (ancestor && ancestor.type !== 'PAGE' && ancestor.type !== 'DOCUMENT' && typeof ancestor.exportAsync === 'function') {
    const targetsArea = cleaned.reduce((sum, n) => sum + nodeArea(n), 0);
    if (nodeArea(ancestor) <= CAPTURE_ANCESTOR_AREA_FACTOR * targetsArea) {
      const shot = await captureSafe(ancestor, scale, maxPx);
      if (shot.base64) {
        return {
          images: [{ base64: shot.base64, label: ancestor.name || ancestor.type }],
          note: shot.error,
          targetName: ancestor.name || ancestor.type,
          targetId: ancestor.id,
          framed: 'common-ancestor'
        };
      }
    }
  }

  const capped = cleaned.slice(0, CAPTURE_MAX_INDIVIDUAL);
  const budget = Number.isFinite(maxPx) && maxPx > 0 ? maxPx : DEFAULT_CAPTURE_MAX_PX;
  const eachPx = Math.max(CAPTURE_MIN_EACH_PX, Math.round(budget / Math.sqrt(capped.length)));
  const images = [];
  const notes = [];
  for (const n of capped) {
    const shot = await captureSafe(n, scale, eachPx);
    if (shot.base64) images.push({ base64: shot.base64, label: n.name || n.type });
    if (shot.error) notes.push(`${n.name || n.id}: ${shot.error}`);
  }
  const note = [
    cleaned.length > capped.length
      ? `Captured ${capped.length} of ${cleaned.length} affected nodes individually (no compact shared frame to export).`
      : null,
    notes.length ? notes.join(' | ') : null
  ].filter(Boolean).join(' ') || null;

  return {
    images,
    note,
    targetName: capped.map(n => n.name || n.type).join(', '),
    targetId: capped.map(n => n.id).join(',')
  };
}

// ==========================================================================
// Auto-lint — cheap, mechanical checks over the nodes a call just touched.
// Not a design critique; only things that are unambiguously a defect and
// nearly free to detect from properties already in hand.
// ==========================================================================
function relativeLuminance(color) {
  const chan = (c) => { const v = c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); return v; };
  return 0.2126 * chan(color.r) + 0.7152 * chan(color.g) + 0.0722 * chan(color.b);
}

function contrastRatio(c1, c2) {
  const l1 = relativeLuminance(c1) + 0.05;
  const l2 = relativeLuminance(c2) + 0.05;
  return l1 > l2 ? l1 / l2 : l2 / l1;
}

function findSolidFillColor(node) {
  if (!node || !Array.isArray(node.fills)) return null;
  const solid = node.fills.find(f => f && f.type === 'SOLID' && f.visible !== false);
  return solid ? solid.color : null;
}

function lintNodes(nodes) {
  const warnings = [];
  const seen = new Set();
  for (const node of nodes) {
    if (!node || seen.has(node.id)) continue;
    seen.add(node.id);

    if (node.type === 'TEXT') {
      try {
        if (typeof node.textAutoResize !== 'undefined' && node.textAutoResize === 'NONE') {
          // Fixed-size text: Figma reports overflow via .exportAsync only, but a
          // cheap proxy is available for horizontal truncation-prone single lines.
          if (node.textTruncation === 'ENDING') {
            warnings.push(`Text "${(node.characters || node.name || '').slice(0, 40)}" is truncated (ends with an ellipsis) — widen the node or its container.`);
          }
        }
        const parentFill = node.parent && findSolidFillColor(node.parent);
        const textFill = findSolidFillColor(node);
        if (parentFill && textFill) {
          const ratio = contrastRatio(parentFill, textFill);
          if (ratio < 4.5) {
            warnings.push(`Text "${(node.characters || node.name || '').slice(0, 40)}" has ~${ratio.toFixed(1)}:1 contrast against its parent fill (WCAG AA wants 4.5:1).`);
          }
        }
      } catch (e) {}
    }

    if (typeof node.width === 'number' && typeof node.height === 'number' && (node.width === 0 || node.height === 0)) {
      warnings.push(`"${node.name || node.type}" has a zero dimension (${Math.round(node.width)}x${Math.round(node.height)}) — likely unintended.`);
    }

    try {
      if (node.parent && 'layoutMode' in node.parent && node.parent.layoutMode !== 'NONE') {
        if (node.parent.primaryAxisSizingMode === 'AUTO' && typeof node.layoutGrow === 'number' && node.layoutGrow > 0) {
          warnings.push(`"${node.name || node.type}" has layoutGrow set inside a hugging (AUTO) parent — grow has no effect there.`);
        }
      }
    } catch (e) {}
  }
  return warnings.slice(0, 10); // cap — this rides along in every response, keep it cheap to read
}
