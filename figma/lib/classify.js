const SLOW_CALL_HINT = "Slow call: if it searched the whole page (findAll / find without root), scope it to a section next time.";

// ------------------------------------------------------------------
// Read nudge. Antigravity/Gemini Flash never sees server instructions and
// rarely opens figma_inspect's schema, but it always reads a tool response.
// 4.2.1 showed a generic one-time tip; in session e6524905 the model got it on
// the very first read, ignored it, and wrote ~69 more read scripts (+15 calls
// slicing bridge.state.lastResult, because the truncation note told it to).
// What a model does act on is a concrete next call. So every hand-written read
// of figma_execute_code gets, as the FIRST field of the reply, the
// figma_inspect call that reads the same nodes — ids, find query and props
// lifted from the script itself — plus a running count of wasted turns.
// ------------------------------------------------------------------
const TREE_WALK_RE = /\.(findAll|findAllWithCriteria|findOne|findChildren)\s*\(|\.children\b|function\s+walk\b|const\s+walk\s*=/;

const NODE_READ_RE = /getNodeById(Async)?\s*\(|currentPage\b|\.(findAll|findAllWithCriteria|findOne|findChildren)\s*\(|\.children\b|\.parent\b/;

const STASH_RE = /bridge\s*\.\s*state\s*\.\s*lastResult/;

// Reads through the bridge's own helpers are already cheap — not nagged.
const CHEAP_READ_RE = /bridge\s*\.\s*(summarize|inspect|find|check|context)\s*\(/;

const WRITE_PROPS = [
  "x", "y", "characters", "fills", "strokes", "strokeWeight", "strokeAlign", "visible", "opacity", "name",
  "layoutMode", "layoutWrap", "itemSpacing", "counterAxisSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "horizontalPadding", "verticalPadding", "layoutSizingHorizontal", "layoutSizingVertical", "layoutGrow", "layoutAlign",
  "layoutPositioning", "primaryAxisAlignItems", "counterAxisAlignItems", "primaryAxisSizingMode", "counterAxisSizingMode",
  "cornerRadius", "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius", "fontName", "fontSize",
  "lineHeight", "letterSpacing", "textAutoResize", "textAlignHorizontal", "textAlignVertical", "textCase", "textDecoration",
  "constraints", "rotation", "effects", "clipsContent", "locked", "selection", "mainComponent", "reactions", "itemReverseZIndex",
  "minWidth", "maxWidth", "minHeight", "maxHeight", "fillStyleId", "strokeStyleId", "textStyleId", "effectStyleId", "isMask",
  "blendMode", "currentPage", "expanded", "description", "relativeTransform"
];

const CANVAS_WRITE_RE = new RegExp(
  "figma\\s*\\.\\s*(create|group|ungroup|flatten|union|subtract|intersect|exclude|combineAsVariants|setCurrentPageAsync)|" +
  "\\.(remove|appendChild|insertChild|resize|resizeWithoutConstraints|rescale|swapComponent|createInstance|clone|detachInstance|" +
  "resetOverrides|insertCharacters|deleteCharacters|scrollAndZoomIntoView)\\s*\\(|\\.set[A-Z]\\w*\\s*\\(|" +
  "bridge\\s*\\.\\s*(replaceWithInstance|setProps|setText|shift|moveInto|fitSection|componentize|setReaction|openOverlay|closeOverlay|setPosition|define|snapshot|checkpoint)\\s*\\(|" +
  "\\.(" + WRITE_PROPS.join("|") + ")\\s*(=(?!=)|\\+=|-=)"
);

const WHAT_YOU_GET = {
  outline: 'one line per node: TYPE "name" #id WxH @x,y [layout] fill font "text" →component variant',
  table: "per table: header, each column's title, width, sizing, cell texts and component variant counts, row/cell ids",
  map: "canvas map: sections, frames, breakpoints",
  props: "{ id: { prop: value } } for each node",
  like: "like:'<ref id>' finds the copies of a correct node under node_ids and lists how each differs, then REF lines with the reference's exact values",
  compare: "compare:'<ref id>' lists how each node_id differs from the reference, then REF lines with its exact values to copy into the write"
};

const CAPS_NOTE = 'figma_inspect also does: find / find_text (search names / text under node_ids), props:[...] (exact values: ' +
  '"font", "text", "layout", "padding", "props" = componentProperties, "variant", "main", "reactions", or any raw property), ' +
  'context:true (parent sections, breakpoints, component variants), view:"map" (canvas map), view:"table" (per table: headers, widths, ' +
  'cell contents and variant counts per column, row/cell ids), check (pass/fail), ' + WHAT_YOU_GET.like + ', ' + WHAT_YOU_GET.compare + '.';

// Script property -> figma_inspect props name. Geometry, names, types, text,
// fonts, layout, fills and instance variants are already on every outline
// line, so only these make a props read worth suggesting.
const PROP_HINTS = [
  [/\bcomponentProperties\b/, "props"], [/\bvariantProperties\b/, "variant"], [/\bmainComponent\b/, "main"],
  [/\b(fontName|fontSize|getStyledTextSegments|getRange\w+)\b/, "font"], [/\bcharacters\b/, "text"],
  [/\b(layoutMode|itemSpacing|primaryAxis\w*|counterAxis\w*)\b/, "layout"], [/\bpadding(Top|Right|Bottom|Left)\b/, "padding"],
  [/\breactions\b/, "reactions"], [/\babsolute(BoundingBox|Transform|RenderBounds)\b/, "absolute"],
  [/\blayoutSizingHorizontal\b/, "layoutSizingHorizontal"], [/\blayoutSizingVertical\b/, "layoutSizingVertical"],
  [/\blayoutGrow\b/, "layoutGrow"], [/\blayoutAlign\b/, "layoutAlign"], [/\bconstraints\b/, "constraints"],
  [/\bfills\b/, "fill"], [/\bstrokes\b/, "stroke"], [/\bcornerRadius\b/, "cornerRadius"], [/\bvisible\b/, "visible"]
];

// "header" / "заголов" alone is a page header, not a table one (T7 `const header = ...` got view:"table"):
// only row / cell / column words, which a table walk cannot do without, count.
const TABLE_HINT_RE = /\b(table|tables|row|rows|cell|cells|column|columns)\b|таблиц|строк|ячейк|колонк|столб/i;

const OUTLINE_COVERS =["font", "text", "layout", "fill", "stroke", "cornerRadius", "visible", "variant", "main"];

// A module from bridge.require(...) can change the canvas inside its methods, which the regexes cannot see.
// Not a read unless every method called on it (directly or via a variable) has a read name (get/read/find/...).
const REQUIRE_RE = /bridge\s*\.\s*require\s*\(/;
const REQUIRE_READISH_RE = /^(get|read|find|list|inspect|summari[sz]e|collect|scan|measure|count|check|is|has)(?![a-z])/;
function requireMayWrite(code) {
  if (!REQUIRE_RE.test(code)) return false;
  const names = []; // variables (and destructured methods) that hold the module
  const methods = []; // method names called straight on bridge.require(...)
  let m;
  const chainRe = /bridge\s*\.\s*require\s*\([^)]*\)\s*\.\s*([\w$]+)\s*\(/g;
  while ((m = chainRe.exec(code))) methods.push(m[1]);
  const varRe = /(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*(?:await\s+)?bridge\s*\.\s*require\s*\(/g;
  while ((m = varRe.exec(code))) {
    if (m[1][0] === "{") m[1].slice(1, -1).split(",").forEach(n => { n = n.split(":").pop().trim(); if (n) methods.push(n); });
    else names.push(m[1]);
  }
  for (const v of names) {
    const callRe = new RegExp("(?:^|" + /[^\w$.]/.source + ")" + v.replace(/\$/g, "[$]") + /\s*\.\s*([\w$]+)\s*\(/.source, "g");
    while ((m = callRe.exec(code))) methods.push(m[1]);
  }
  return !methods.length || methods.some(n => !REQUIRE_READISH_RE.test(n));
}

// -> "write" | "read" | "stash" | "cheap" | null
function classifyScript(code, response) {
  if (typeof code !== "string") return null;
  if (response && ((Array.isArray(response.created) && response.created.length) ||
                   (Array.isArray(response.modified) && response.modified.length))) return "write";
  if (CANVAS_WRITE_RE.test(code)) return "write";
  if (requireMayWrite(code)) return "write";
  const touchesNodes = NODE_READ_RE.test(code);
  // lastResult is plain data: `.children` on it is not a node read.
  if (STASH_RE.test(code) && !/getNodeById(Async)?\s*\(|currentPage\b/.test(code)) return "stash";
  if (CHEAP_READ_RE.test(code) && !TREE_WALK_RE.test(code)) return "cheap";
  return touchesNodes ? "read" : null;
}

// After a write the agent spends a turn re-reading what it changed (every T1
// run in bench 15.10 ended with an inspect props/compare of the same ids).
// Answer that read in the write's own reply: one outline line per node the
// code named by id, as they are now. Best-effort: any failure = no `after`.
const AFTER_WRITE_MAX_IDS = 12;

const AFTER_WRITE_BYTES = 1400;

const AFTER_WRITE_DEEP_IDS = 8; // up to this many nodes the after-write outline goes one level down

// Node ids in a write's result, in order, up to AFTER_WRITE_MAX_IDS.
function resultIds(result) {
  const text = typeof result === "string" ? result : JSON.stringify(result);
  const ids = [];
  const idRe = /["'`#](I?\d+:\d+(?:;\d+:\d+)*)\b/g;
  let m;
  while (text && (m = idRe.exec(text)) && ids.length < AFTER_WRITE_MAX_IDS * 2) {
    if (ids.indexOf(m[1]) === -1) ids.push(m[1]);
  }
  return ids;
}

// figma_inspect arguments that read what the script read.
function suggestInspect(code, fallbackIds) {
  const ids = [];
  const idRe = /["'`](I?\d+[:-]\d+(?:;\d+[:-]\d+)*)["'`]/g;
  let m;
  while ((m = idRe.exec(code)) && ids.length < 8) {
    const id = m[1].indexOf(";") === -1 ? m[1].replace("-", ":") : m[1];
    if (ids.indexOf(id) === -1) ids.push(id);
  }
  const args = {};
  if (ids.length) args.node_ids = ids;
  else if (fallbackIds && fallbackIds.length) args.node_ids = fallbackIds.slice(0, 8);

  const nameRes = [
    /\.name\s*===?\s*["'`]([^"'`\n]{2,60})["'`]/,
    /["'`]([^"'`\n]{2,60})["'`]\s*===?\s*[\w$.]*\.name\b/,
    /\.name\s*(?:\.\s*toLowerCase\s*\(\s*\))?\s*\.\s*(?:includes|startsWith|endsWith|indexOf)\s*\(\s*["'`]([^"'`\n]{2,60})["'`]/
  ];
  let nameAt = -1;
  for (const re of nameRes) {
    const hit = re.exec(code);
    if (hit) { args.find = hit[1]; nameAt = hit.index; break; }
  }
  // The type filter only counts when it sits in the SAME predicate as the
  // name (`n => n.name === 'checkbox' && n.type === 'INSTANCE'`); a TEXT test
  // elsewhere in the script would make find return nothing.
  if (args.find) {
    const near = code.slice(Math.max(0, nameAt - 60), nameAt + 90).split(/=>|;|\n/).filter(s => s.indexOf(args.find) !== -1).join(" ");
    const typeHit = /\.type\s*===?\s*["'`]([A-Z_]+)["'`]|["'`]([A-Z_]+)["'`]\s*===?\s*[\w$.]*\.type\b/.exec(near);
    if (typeHit) args.find_type = typeHit[1] || typeHit[2];
  }

  // Only props an outline line does NOT carry earn a props read: every line
  // already has geometry, layout, fill, stroke, radius, font, text, visibility
  // and an instance's component + variant.
  const props = [];
  for (const [re, prop] of PROP_HINTS) {
    if (re.test(code) && OUTLINE_COVERS.indexOf(prop) === -1 && props.indexOf(prop) === -1) props.push(prop);
  }
  // props are read off the listed / found nodes themselves, so they fit a
  // script that read them there — not one that walked further down.
  const walks = (code.match(/\.(findAll|findAllWithCriteria|findOne|findChildren)\s*\(|\.children\b/g) || []).length;
  if (props.length && (args.find ? walks <= 1 : walks === 0)) {
    args.props = props.slice(0, 6);
    return args;
  }
  if (!args.node_ids) return args.find ? args : { view: "map" };
  // A walk into rows / headers / cells: view:"table" gives headers, widths and
  // per-column contents (variant counts) for every listed screen at once —
  // in session e6524905 that was ~45 read scripts.
  if (walks && TABLE_HINT_RE.test(code)) return { node_ids: args.node_ids, view: "table" };
  let depth = walks >= 4 ? 3 : walks >= 2 ? 2 : 1;
  if (/\.(findAll|findAllWithCriteria|findOne)\s*\(/.test(code) && !args.find) depth = 3;
  if (args.find) depth = Math.max(1, Math.min(depth, 2));
  if (args.node_ids.length > 2) depth = Math.min(depth, 2);
  if (props.length === 0 && walks === 0 && !args.find) {
    // A flat read of the ids' own facts (font, text, layout...): their lines.
    args.depth = 0;
    return args;
  }
  args.depth = depth;
  return args;
}

// ------------------------------------------------------------------
// Read guard (4.2.5). Session packs from Antigravity/Gemini Flash showed the
// nudge above is read and ignored: the script still ran, returned its result,
// and the model went on to read #54 in a row (60-64% of the input tokens of
// two prototype sessions). So the NUDGE stays for the first read, but from the
// next consecutive hand-written read on the script is NOT run: the 2nd read
// gets the result of the figma_inspect call it should have made, the 3rd and
// later get a refusal without a result. A figma_inspect call or any write
// resets the streak. A page-wide findAll over a big file froze the plugin for
// 2-12 minutes (747 s once), so a READ that scans the whole page is refused
// up front, and the refusal names the scoped call.
// `/* run-anyway */` in the script lifts both guards (misread script, or a
// scan the user really wants).
// ------------------------------------------------------------------
const RUN_ANYWAY_RE = /\/[*/]\s*run-anyway\b/;

const PAGE_ALIAS_RE = /(?:const|let|var)\s+([\w$]+)\s*=\s*(?:await\s+)?figma\s*\.\s*(?:currentPage|root)\s*(?:;|,|\n|$)/g;

// "findAll" | "reactions" | null — does the script walk the whole page / file?
function pageWideScan(code) {
  if (typeof code !== "string") return null;
  const names = ["figma\\s*\\.\\s*(?:currentPage|root)"];
  PAGE_ALIAS_RE.lastIndex = 0;
  let m;
  while ((m = PAGE_ALIAS_RE.exec(code))) names.push(m[1].replace(/\$/g, "\\$"));
  const base = "(?:" + names.join("|") + ")";
  if (new RegExp(base + "\\s*\\.\\s*(?:findAll|findOne)\\s*\\(").test(code)) return "findAll";
  if (/\breactions\b/.test(code) && (
    new RegExp(base + "\\s*\\.\\s*findAllWithCriteria\\s*\\(").test(code) ||
    new RegExp("\\b(?:walk|visit|scan|traverse|recurse|collect)\\w*\\s*\\(\\s*" + base + "\\b").test(code) ||
    new RegExp("\\bof\\s+" + base + "\\s*\\.\\s*children\\b").test(code)
  )) return "reactions";
  return null;
}

const PAGE_SCAN_NOTE = "figma.currentPage.findAll / a walk of the whole page freezes the plugin for minutes on a big file (747 s seen). Scope it to a section: figma_inspect with node_ids, find / find_type (name search), or view:\"flow\" for prototype links; or findAll on a section node in a write script.";

// figma.createComponentFromNode forces every AutoLayout frame of the subtree to
// FIXED sizing; bridge.componentize restores it. Same call shape, so rewrite.
function rewriteComponentize(code) {
  if (typeof code !== "string" || !/figma\s*\.\s*createComponentFromNode\s*\(/.test(code)) return { code, lint: null };
  const n = (code.match(/figma\s*\.\s*createComponentFromNode\s*\(/g) || []).length;
  return {
    code: code.replace(/figma\s*\.\s*createComponentFromNode\s*\(/g, "bridge.componentize("),
    lint: `figma.createComponentFromNode was replaced by bridge.componentize (${n}×): the raw call turns AutoLayout frames in the subtree FIXED and breaks resizing. Write bridge.componentize(node) yourself next time.`
  };
}

// Font loads in a script that never edits text: the plugin and
// bridge.setText / insert_component_instance load fonts themselves, and a stray
// load can wait seconds for a canvas frame.
const FONT_CALL_RE = /\b(loadFontAsync|ensureFont)\b/;
const TEXT_EDIT_RE = /\b(characters|fontName|fontSize|createText|insertCharacters|deleteCharacters|setRange\w*|textStyleId|lineHeight|letterSpacing|paragraph\w*|textCase|textDecoration|textAutoResize|setText|setProps|setProperties)\b|\w*text\w*\s*\(|bridge\s*\.\s*require\b/i;
const FONT_LOAD_NOTE = "Font load without a text edit: drop it (bridge.setText and insert_component_instance load fonts themselves).";
function fontLoadLint(code) {
  return typeof code === "string" && FONT_CALL_RE.test(code) && !TEXT_EDIT_RE.test(code) ? FONT_LOAD_NOTE : null;
}

module.exports = { fontLoadLint, FONT_LOAD_NOTE, SLOW_CALL_HINT, NODE_READ_RE, WHAT_YOU_GET, CAPS_NOTE, classifyScript, AFTER_WRITE_MAX_IDS, AFTER_WRITE_BYTES, AFTER_WRITE_DEEP_IDS, resultIds, suggestInspect, RUN_ANYWAY_RE, pageWideScan, PAGE_SCAN_NOTE, rewriteComponentize };
