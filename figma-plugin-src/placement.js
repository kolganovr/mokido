
// ==========================================================================
// Layout Packer — canvas placement engine
// --------------------------------------------------------------------------
// The previous version recomputed top-level bounds with a plain O(n) scan on
// EVERY candidate position (up to 200 attempts x n nodes) and did it AGAIN in
// autoPositionIfColliding for the same node a moment later. It also only ever
// stepped along one axis, so 20 generated screens turned into a mile-long
// ribbon instead of a page you could see at a reasonable zoom.
//
// This version computes bounds once per placement call, indexes existing
// top-level nodes into a 500px grid hash so a collision test is O(neighbours)
// instead of O(n), and adds a shelf-packing "grid" mode alongside the
// original single-axis "row" mode.
//
// Honest limit: "grid" mode packs new items into a virtual N-column grid and
// checks each candidate cell against real geometry — it does not attempt a
// general bin-packing solve around arbitrary pre-existing layouts. For the
// case it targets (an agent placing a run of similarly-sized generated
// screens) that is indistinguishable from optimal; for a page with wildly
// mixed existing content it degrades to "first free cell", never overlap.
// ==========================================================================
const COLLISION_CELL = 500;

function computeTopLevelBounds(excludeNode) {
  const nodes = figma.currentPage.children.filter(n =>
    n !== excludeNode && n.visible !== false && typeof n.x === 'number' && typeof n.width === 'number'
  );
  if (nodes.length === 0) return { nodes, minX: 0, minY: 0, maxX: 0, maxY: 0 };

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.x + n.width > maxX) maxX = n.x + n.width;
    if (n.y < minY) minY = n.y;
    if (n.y + n.height > maxY) maxY = n.y + n.height;
  }
  return { nodes, minX, minY, maxX, maxY };
}

function buildCollisionGrid(nodes) {
  const grid = new Map();
  const key = (cx, cy) => cx + ':' + cy;
  for (const n of nodes) {
    const x0 = Math.floor(n.x / COLLISION_CELL), x1 = Math.floor((n.x + n.width) / COLLISION_CELL);
    const y0 = Math.floor(n.y / COLLISION_CELL), y1 = Math.floor((n.y + n.height) / COLLISION_CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = key(cx, cy);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(n);
      }
    }
  }
  return {
    collides(x, y, w, h) {
      const x0 = Math.floor(x / COLLISION_CELL), x1 = Math.floor((x + w) / COLLISION_CELL);
      const y0 = Math.floor(y / COLLISION_CELL), y1 = Math.floor((y + h) / COLLISION_CELL);
      const seen = new Set();
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const bucket = grid.get(key(cx, cy));
          if (!bucket) continue;
          for (const o of bucket) {
            if (seen.has(o)) continue;
            seen.add(o);
            if (x < o.x + o.width && x + w > o.x && y < o.y + o.height && y + h > o.y) return true;
          }
        }
      }
      return false;
    }
  };
}

// Original single-axis placement ("row" along X, "column"/BOTTOM along Y),
// now bounds-shared and grid-indexed instead of doing its own O(n) scan.
function getFreeCanvasPositionRow(width = 400, height = 800, options = {}) {
  const gap = typeof options.gap === 'number' ? options.gap : 80;
  const direction = (options.direction || 'RIGHT').toUpperCase();
  const w = Number.isFinite(width) && width > 0 ? width : 400;
  const h = Number.isFinite(height) && height > 0 ? height : 800;

  const bounds = options.bounds || computeTopLevelBounds();
  const { nodes, minX, maxX, minY, maxY } = bounds;
  if (nodes.length === 0) return { x: 0, y: 0 };

  const grid = options.grid || buildCollisionGrid(nodes);
  const originX = isFinite(minX) ? minX : 0;
  const originY = isFinite(minY) ? minY : 0;
  const edgeX = isFinite(maxX) ? maxX : 0;
  const edgeY = isFinite(maxY) ? maxY : 0;

  let x = direction === 'BOTTOM' ? originX : edgeX + gap;
  let y = direction === 'BOTTOM' ? edgeY + gap : originY;

  for (let attempt = 0; attempt < 200 && grid.collides(x, y, w, h); attempt++) {
    if (direction === 'BOTTOM') y += h + gap;
    else x += w + gap;
  }
  return { x: Math.round(x), y: Math.round(y) };
}

// Shelf-packing placement: scans a virtual `columns`-wide grid row by row and
// returns the first cell whose real geometry is free, so a run of same-sized
// generated screens fills a compact rectangle instead of one long ribbon.
function getFreeCanvasPositionGrid(width = 400, height = 800, options = {}) {
  const gap = typeof options.gap === 'number' ? options.gap : 80;
  const columns = Math.max(1, Math.round(options.columns || 4));
  const w = Number.isFinite(width) && width > 0 ? width : 400;
  const h = Number.isFinite(height) && height > 0 ? height : 800;

  const bounds = options.bounds || computeTopLevelBounds();
  const { nodes, minX, minY } = bounds;
  if (nodes.length === 0) return { x: 0, y: 0 };

  const grid = options.grid || buildCollisionGrid(nodes);
  const originX = isFinite(minX) ? minX : 0;
  const originY = isFinite(minY) ? minY : 0;

  for (let row = 0; row < 200; row++) {
    const y = originY + row * (h + gap);
    for (let col = 0; col < columns; col++) {
      const x = originX + col * (w + gap);
      if (!grid.collides(x, y, w, h)) return { x: Math.round(x), y: Math.round(y) };
    }
  }
  // 200 rows x `columns` cells all occupied is pathological — fall back to
  // "past the edge" rather than looping forever.
  return getFreeCanvasPositionRow(width, height, { gap, direction: 'RIGHT', bounds, grid });
}

// Smart Canvas Placement Engine: Calculate free position on canvas avoiding
// overlaps. `layout: "grid"` shelf-packs; anything else keeps the original
// single-axis behaviour ("row" = RIGHT, "column"/"BOTTOM" = downward).
function getFreeCanvasPosition(width = 400, height = 800, options = {}) {
  const layout = String(options.layout || (options.direction === 'BOTTOM' ? 'row' : 'row')).toLowerCase();
  if (layout === 'grid') return getFreeCanvasPositionGrid(width, height, options);
  return getFreeCanvasPositionRow(width, height, options);
}

// Auto-position node if placed at default (0, 0) or overlapping other top-level nodes
function autoPositionIfColliding(node, gap = 80) {
  if (!node || node.parent !== figma.currentPage) return;
  const bounds = computeTopLevelBounds(node);
  if (bounds.nodes.length === 0) return;
  const grid = buildCollisionGrid(bounds.nodes);

  if ((node.x === 0 && node.y === 0) || grid.collides(node.x, node.y, node.width, node.height)) {
    const freePos = getFreeCanvasPositionRow(node.width, node.height, { gap, bounds, grid });
    node.x = freePos.x;
    node.y = freePos.y;
  }
}
