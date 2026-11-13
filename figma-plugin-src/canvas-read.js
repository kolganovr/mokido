
// ==========================================================================
// Live Canvas → REST-shape adapter (figma_read_canvas)
// --------------------------------------------------------------------------
// Produces the same node shape the Figma REST API returns (absoluteBoundingBox,
// layoutMode, fills, style{...}, ...) so the EXISTING optimizer/pruner/
// serializer pipeline in figma/optimizer (written for REST responses) works
// unmodified on live canvas data. Two independent caps bound a single call:
// `maxDepth` (from the request, hard-clamped to 12) and a total node budget
// (4000) so a single `figma_read_canvas` on a huge page cannot block the UI
// thread indefinitely or blow up the WebSocket frame.
// ==========================================================================
const STYLE_WEIGHT_MAP = {
  thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300,
  regular: 400, normal: 400, medium: 500, semibold: 600, demibold: 600,
  bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900
};

function styleNameToWeight(styleName) {
  if (!styleName) return undefined;
  const cleaned = String(styleName).toLowerCase().replace(/italic/g, '').trim().replace(/\s+/g, '');
  return STYLE_WEIGHT_MAP[cleaned];
}

function liveNodeToRestShape(node, depth, maxDepth, includeHidden, budget) {
  if (!node || budget.count >= budget.max) return null;
  if (node.visible === false && !includeHidden) return null;
  budget.count++;

  const bbox = node.absoluteBoundingBox || { x: node.x || 0, y: node.y || 0, width: node.width || 0, height: node.height || 0 };
  const out = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible !== false,
    absoluteBoundingBox: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height }
  };

  if (depth > maxDepth) { out.truncated = true; return out; }

  try {
    if ('layoutMode' in node && node.layoutMode && node.layoutMode !== 'NONE') {
      out.layoutMode = node.layoutMode;
      if (typeof node.itemSpacing === 'number') out.itemSpacing = node.itemSpacing;
      if (typeof node.paddingTop === 'number') out.paddingTop = node.paddingTop;
      if (typeof node.paddingRight === 'number') out.paddingRight = node.paddingRight;
      if (typeof node.paddingBottom === 'number') out.paddingBottom = node.paddingBottom;
      if (typeof node.paddingLeft === 'number') out.paddingLeft = node.paddingLeft;
      if (node.counterAxisAlignItems) out.counterAxisAlignItems = node.counterAxisAlignItems;
      if (node.primaryAxisAlignItems) out.primaryAxisAlignItems = node.primaryAxisAlignItems;
      if (node.layoutWrap === 'WRAP') out.layoutWrap = 'WRAP';
    }
    if (node.layoutSizingHorizontal && node.layoutSizingHorizontal !== figma.mixed) out.layoutSizingHorizontal = node.layoutSizingHorizontal;
    if (node.layoutSizingVertical && node.layoutSizingVertical !== figma.mixed) out.layoutSizingVertical = node.layoutSizingVertical;
    if (node.layoutPositioning === 'ABSOLUTE') out.layoutPositioning = 'ABSOLUTE';

    if ('fills' in node && node.fills !== figma.mixed && Array.isArray(node.fills)) out.fills = node.fills;
    if ('strokes' in node && node.strokes !== figma.mixed && Array.isArray(node.strokes) && node.strokes.length) {
      out.strokes = node.strokes;
      if (typeof node.strokeWeight === 'number') out.strokeWeight = node.strokeWeight;
    }
    if (typeof node.cornerRadius === 'number') out.cornerRadius = node.cornerRadius;
    else if (Array.isArray(node.rectangleCornerRadii)) out.rectangleCornerRadii = node.rectangleCornerRadii;
    if (typeof node.opacity === 'number') out.opacity = node.opacity;
    if (node.clipsContent === true) out.clipsContent = true;

    if (node.type === 'TEXT') {
      out.characters = node.characters || '';
      const fontName = node.fontName !== figma.mixed ? node.fontName : null;
      out.style = {
        fontFamily: fontName ? fontName.family : undefined,
        fontWeight: styleNameToWeight(fontName && fontName.style),
        fontSize: node.fontSize !== figma.mixed ? node.fontSize : undefined,
        lineHeightPx: (node.lineHeight && node.lineHeight !== figma.mixed && node.lineHeight.unit === 'PIXELS') ? node.lineHeight.value : undefined,
        letterSpacing: (node.letterSpacing && node.letterSpacing !== figma.mixed && node.letterSpacing.unit === 'PIXELS') ? node.letterSpacing.value : undefined,
        textAlignHorizontal: node.textAlignHorizontal
      };
    }

    if (node.type === 'INSTANCE') {
      if (node.mainComponent) out.componentId = node.mainComponent.id;
      if (node.variantProperties) out.variantProperties = node.variantProperties;
    }
    if (node.componentProperties && Object.keys(node.componentProperties).length) out.componentProperties = node.componentProperties;
  } catch (e) {
    // A single unreadable property (rare host-object edge case) must not sink
    // the whole subtree — the node still comes back with whatever we got.
  }

  if ('children' in node && Array.isArray(node.children) && node.children.length) {
    const kids = [];
    for (const child of node.children) {
      if (budget.count >= budget.max) { out.truncated = true; break; }
      const k = liveNodeToRestShape(child, depth + 1, maxDepth, includeHidden, budget);
      if (k) kids.push(k);
    }
    if (kids.length) out.children = kids;
  }

  return out;
}

function readCanvasTree(options) {
  const maxDepth = Number.isFinite(options.depth) && options.depth > 0 ? Math.min(options.depth, 12) : 6;
  const includeHidden = options.include_hidden === true;
  const budget = { count: 0, max: 4000 };

  let roots;
  if (Array.isArray(options.node_ids) && options.node_ids.length > 0) {
    roots = options.node_ids.map(id => figma.getNodeById(id)).filter(Boolean);
  } else {
    roots = figma.currentPage.children.filter(n => n.visible !== false || includeHidden);
  }

  const children = roots.map(n => liveNodeToRestShape(n, 0, maxDepth, includeHidden, budget)).filter(Boolean);

  return {
    document: { id: figma.currentPage.id, name: figma.currentPage.name, type: 'CANVAS', children },
    name: figma.root.name,
    truncatedTop: budget.count >= budget.max
  };
}
