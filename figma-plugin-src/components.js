
// ==========================================================================
// Component Index — cached, tokenized search over COMPONENT / COMPONENT_SET
// nodes, replacing a full page.findAll() on every figma_find_components call.
// --------------------------------------------------------------------------
// A cold build still walks every page once (unavoidable — nothing indexes
// this for us), but every SEARCH after that is O(matches) instead of
// O(document size). The index is invalidated on any create/delete/rename
// document change and otherwise treated as valid for COMPONENT_INDEX_TTL_MS,
// so a search is never more than that far behind reality even if a change
// event is somehow missed.
// ==========================================================================
let componentIndex = null;
let componentIndexBuiltAt = 0;
const COMPONENT_INDEX_TTL_MS = 60000;

function tokenizeName(name) {
  return String(name || '').toLowerCase().split(/[\s_\-/]+/).filter(Boolean);
}

function buildComponentIndex() {
  const index = new Map();
  for (const page of figma.root.children) {
    let nodes = [];
    try {
      nodes = page.findAll(n => n.type === 'COMPONENT_SET' || (n.type === 'COMPONENT' && n.parent && n.parent.type !== 'COMPONENT_SET'));
    } catch (e) { continue; }
    for (const node of nodes) {
      index.set(node.id, {
        id: node.id,
        name: node.name || '',
        type: node.type,
        pageId: page.id,
        pageName: page.name,
        tokens: tokenizeName(node.name)
      });
    }
  }
  componentIndex = index;
  componentIndexBuiltAt = Date.now();
  return index;
}

function ensureComponentIndex(forceRefresh) {
  if (forceRefresh || !componentIndex || Date.now() - componentIndexBuiltAt > COMPONENT_INDEX_TTL_MS) {
    buildComponentIndex();
  }
  return componentIndex;
}

if (typeof figma.on === 'function') {
  try {
    figma.on('documentchange', (event) => {
      const relevant = (event.documentChanges || []).some(c =>
        c.type === 'CREATE' || c.type === 'DELETE' ||
        (c.type === 'PROPERTY_CHANGE' && Array.isArray(c.properties) && c.properties.indexOf('name') !== -1)
      );
      if (relevant) componentIndex = null; // cheap invalidation; next search rebuilds
    });
  } catch (e) {}
}

// Bounded edit distance — returns max+1 (a sentinel "too far") as soon as the
// budget is provably exceeded, so a wildly different token costs O(len) not
// O(len^2) the way a naive full DP table would for every candidate.
function levenshteinAtMost(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const lb = b.length;
  let prev = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const curr = new Array(lb + 1);
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[lb];
}

// Ranked search: exact name > name prefix > any token prefix > every query
// token matches some name token by prefix > fuzzy (edit distance <= 2).
function searchComponentIndex(query, options) {
  options = options || {};
  const index = ensureComponentIndex(options.forceRefresh);
  const q = String(query || '').trim().toLowerCase();
  const qTokens = tokenizeName(q);
  let entries = Array.from(index.values());
  if (options.pageName) {
    const pn = options.pageName.toLowerCase();
    entries = entries.filter(e => e.pageName.toLowerCase() === pn);
  }
  if (!q) return entries.slice(0, options.limit || 30);

  const scored = [];
  for (const e of entries) {
    const nameLower = e.name.toLowerCase();
    let score = -1;
    if (nameLower === q) score = 100;
    else if (nameLower.startsWith(q)) score = 80;
    else if (e.tokens.some(t => t.startsWith(q))) score = 60;
    else if (qTokens.length > 0 && qTokens.every(qt => e.tokens.some(t => t.startsWith(qt)))) score = 50;
    else {
      let fuzzyHit = false;
      for (const qt of qTokens) {
        if (fuzzyHit) break;
        for (const t of e.tokens) {
          if (Math.abs(t.length - qt.length) <= 2 && levenshteinAtMost(qt, t, 2) <= 2) { fuzzyHit = true; break; }
        }
      }
      if (fuzzyHit) score = 20;
    }
    if (score >= 0) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name));
  return scored.slice(0, options.limit || 30).map(s => s.e);
}
