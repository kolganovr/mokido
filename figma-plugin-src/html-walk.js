// html-walk.js (T-077, F8.1): обходчик DOM -> промежуточное дерево (формат dom.json из planning/tools/html/SPEC.md).
// Без import/export и зависимостей; работает от переданного doc (document скрытого iframe или страницы), а не от
// глобального document. Встраивается в ui.html окна плагина (не в code.js). Префикс функций: htmlWalk*.
// Упрощения те же, что у мерила render.py: declared без специфичности (последнее объявление, inline сильнее),
// без !important, nesting, псевдоэлементов, @layer; @media берётся по matchMedia, @supports без проверки условия.

var HTML_WALK_WL = [
  "width", "height", "min-width", "max-width", "min-height", "max-height", "flex", "flex-grow", "flex-shrink",
  "flex-basis", "align-self", "color", "background", "background-color", "border", "border-color",
  "border-top", "border-right", "border-bottom", "border-left",
  "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "border-radius",
  "gap", "row-gap", "column-gap", "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "font-size", "font", "box-shadow", "grid-column", "grid-row", "grid-template-columns", "left", "right", "top", "bottom", "inset"
];
var HTML_WALK_SKIP = { HEAD: 1, STYLE: 1, SCRIPT: 1, META: 1, LINK: 1, TITLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };

function htmlWalkR2(v) { return Math.round(v * 100) / 100; }
function htmlWalkPx(v) { var f = parseFloat(v); return isNaN(f) ? 0 : htmlWalkR2(f); }
function htmlWalkHex2(n) { return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0"); }

// computed color: "rgb(r, g, b)" | "rgba(r, g, b, a)" | "rgb(r g b / a)"
function htmlWalkColor(s) {
  if (!s || s === "transparent") return { hex: "#00000000", a: 0 };
  var m = s.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/);
  if (!m) return { hex: s, a: 1 };
  var a = 1;
  if (m[4] !== undefined) a = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return { hex: "#" + htmlWalkHex2(+m[1]) + htmlWalkHex2(+m[2]) + htmlWalkHex2(+m[3]) + htmlWalkHex2(a * 255), a: a };
}

function htmlWalkDeclared(c, el) {
  var out = {};
  var win = c.win;
  var apply = function (st) {
    for (var i = 0; i < c.wl.length; i++) {
      var v = st.getPropertyValue(c.wl[i]);
      if (v && v.trim()) out[c.wl[i]] = v.trim();
    }
  };
  var walk = function (rules) {
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      if (rule.type === 1) { try { if (el.matches(rule.selectorText)) apply(rule.style); } catch (e) {} }
      else if (rule.type === 4) { try { if (win.matchMedia(rule.media.mediaText).matches) walk(rule.cssRules); } catch (e) {} }
      else if (rule.type === 12) { walk(rule.cssRules); }
    }
  };
  var sheets = c.doc.styleSheets;
  for (var i = 0; i < sheets.length; i++) {
    var rules;
    try { rules = sheets[i].cssRules; } catch (e) { continue; }
    walk(rules);
  }
  if (el.style) apply(el.style);
  return out;
}

function htmlWalkTokens(declared) {
  var t = {};
  Object.keys(declared).forEach(function (k) {
    var names = [];
    var re = /var\(\s*(--[\w-]+)/g, m;
    while ((m = re.exec(declared[k])) !== null) names.push(m[1]);
    if (!names.length) return;
    var key = k;
    if (k === "background") key = "background-color";
    if (k === "border" || /^border-(top|right|bottom|left)(-color)?$/.test(k)) key = "border-color";
    t[key] = names.length === 1 ? names[0] : names;
  });
  return t;
}

function htmlWalkStyle(cs, rect, isText) {
  var bgc = htmlWalkColor(cs.backgroundColor);
  var bw = [htmlWalkPx(cs.borderTopWidth), htmlWalkPx(cs.borderRightWidth), htmlWalkPx(cs.borderBottomWidth), htmlWalkPx(cs.borderLeftWidth)];
  var half = Math.min(rect.w, rect.h) / 2;
  var rad = function (v) {
    var f = parseFloat(v); if (isNaN(f)) f = 0;
    if (String(v).includes("%")) f = f / 100 * Math.min(rect.w, rect.h);
    return htmlWalkR2(Math.min(f, half));
  };
  var bi = cs.backgroundImage;
  var bgImage = null;
  if (bi && bi !== "none") bgImage = bi.includes("gradient") ? "gradient" : (bi.includes("url(") ? "url" : bi);
  var fs = htmlWalkPx(cs.fontSize);
  var lh = cs.lineHeight === "normal" ? htmlWalkR2(fs * 1.21) : htmlWalkPx(cs.lineHeight);
  var ff = (cs.fontFamily.split(",")[0] || "").trim().replace(/^["']|["']$/g, "");
  var hasBorder = bw.some(function (x) { return x > 0; });
  // T-103: truncated text: -webkit-line-clamp N, or one line with an ellipsis (nowrap + text-overflow); 0 = not truncated
  var lc = parseInt(cs.webkitLineClamp || cs.lineClamp, 10) || 0;
  var clamp = lc > 0 ? lc : (cs.whiteSpace === "nowrap" && cs.textOverflow === "ellipsis" ? 1 : 0);
  // цвет рамки: первой стороны (top, right, bottom, left) с ненулевой толщиной
  var sideColors = [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor];
  var bc = sideColors[Math.max(0, bw.findIndex(function (x) { return x > 0; }))];
  return {
    bg: (isText || bgc.a === 0) ? null : bgc.hex,
    color: htmlWalkColor(cs.color).hex,
    borderColor: (isText || !hasBorder) ? null : htmlWalkColor(bc).hex,
    borderWidth: isText ? [0, 0, 0, 0] : bw,
    radius: isText ? [0, 0, 0, 0] : [rad(cs.borderTopLeftRadius), rad(cs.borderTopRightRadius), rad(cs.borderBottomRightRadius), rad(cs.borderBottomLeftRadius)],
    fontFamily: ff, fontSize: fs, fontWeight: parseInt(cs.fontWeight) || 400, lineHeight: lh, clamp: clamp,
    opacity: parseFloat(cs.opacity),
    boxShadow: (isText || cs.boxShadow === "none") ? null : cs.boxShadow,
    bgImage: isText ? null : bgImage
  };
}

// overflow: "visible" if neither axis clips, else the clipping value ("hidden", "auto", "scroll", "clip"); "x y" if they differ
function htmlWalkOverflow(cs) {
  var x = cs.overflowX, y = cs.overflowY;
  if (x === y) return x;
  return x + " " + y;
}

// svg markup with explicit pixel size from the rect (createNodeFromSvg needs width/height) and the xmlns attribute
function htmlWalkSvg(el, rect) {
  var s = el.outerHTML;
  var head = s.match(/^<svg\b[^>]*>/i);
  if (!head) return s;
  var h = head[0], nh = h;
  var setAttr = function (name, val) {
    var re = new RegExp("\\s" + name + "\\s*=\\s*(\"[^\"]*\"|'[^']*')", "i");
    if (re.test(nh)) nh = nh.replace(re, " " + name + '="' + val + '"'); else nh = nh.replace(/^<svg/i, "<svg " + name + '="' + val + '"');
  };
  if (!/\sxmlns\s*=/i.test(nh)) nh = nh.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  setAttr("width", rect.w);
  setAttr("height", rect.h);
  return nh + s.slice(h.length);
}

function htmlWalkRect(c, r) {
  return { x: htmlWalkR2(r.left + c.sx), y: htmlWalkR2(r.top + c.sy), w: htmlWalkR2(r.width), h: htmlWalkR2(r.height) };
}

function htmlWalkEl(c, el, parentId, ancDecl, ancTok) {
  if (HTML_WALK_SKIP[el.tagName]) return;
  var cs = c.win.getComputedStyle(el);
  if (cs.display === "none") return;
  var br = el.getBoundingClientRect();
  var isContents = cs.display === "contents";
  var visHidden = cs.visibility === "hidden";
  var zero = br.width === 0 && br.height === 0;
  var myId = parentId;
  var declared = htmlWalkDeclared(c, el);
  var tokens = htmlWalkTokens(declared);
  var myDecl = Object.assign({}, ancDecl);
  var myTok = Object.assign({}, ancTok);
  ["color", "font-size"].forEach(function (k) { if (declared[k]) myDecl[k] = declared[k]; });
  if (tokens["color"]) myTok["color"] = tokens["color"]; else if (declared["color"]) delete myTok["color"];
  if (!isContents && !visHidden && !zero) {
    var rect = htmlWalkRect(c, br);
    var isSvg = el.tagName.toLowerCase() === "svg";
    var isImg = el.tagName === "IMG";
    if (isSvg || isImg) {
      ["width", "height"].forEach(function (a) {
        if (!declared[a] && el.getAttribute(a) && /^[\d.]+(px)?$/.test(el.getAttribute(a))) declared[a] = parseFloat(el.getAttribute(a)) + "px";
      });
    }
    var disp = cs.display;
    var isFlex = disp === "flex" || disp === "inline-flex";
    var isGrid = disp === "grid" || disp === "inline-grid";
    var dir = cs.flexDirection.startsWith("column") ? "column" : "row";
    var gcol = htmlWalkPx(cs.columnGap), grow = htmlWalkPx(cs.rowGap);
    var node = {
      id: c.nodes.length, parent: parentId, tag: el.tagName.toLowerCase(),
      classes: Array.prototype.slice.call(el.classList),
      name: el.getAttribute("data-name"),
      component: el.getAttribute("data-component"),
      variant: el.getAttribute("data-variant"),
      prop: el.getAttribute("data-prop"),
      in_component: !!(el.parentElement && el.parentElement.closest("[data-component]")),
      rect: rect, text: null, display: disp,
      position: cs.position, overflow: htmlWalkOverflow(cs),
      flex: isFlex ? { dir: dir, wrap: cs.flexWrap !== "nowrap", gap: dir === "row" ? gcol : grow, justify: cs.justifyContent, align: cs.alignItems } : null,
      grid: isGrid ? { cols: cs.gridTemplateColumns, rowGap: grow, colGap: gcol } : null,
      padding: [htmlWalkPx(cs.paddingTop), htmlWalkPx(cs.paddingRight), htmlWalkPx(cs.paddingBottom), htmlWalkPx(cs.paddingLeft)],
      style: htmlWalkStyle(cs, rect, false),
      declared: declared, tokens: tokens
    };
    if (isSvg) node.svg = htmlWalkSvg(el, rect);
    if (isImg) {
      node.src = el.currentSrc || el.getAttribute("src") || null;
      node.alt = el.getAttribute("alt") || null; // T-135: layer name
      node.objectFit = cs.objectFit || null; // T-135: how an svg source is fitted into the box
    }
    c.nodes.push(node);
    myId = node.id;
    if (isSvg) return;
  }
  for (var i = 0; i < el.childNodes.length; i++) {
    var ch = el.childNodes[i];
    if (ch.nodeType === 3) {
      if (visHidden) continue;
      var txt = ch.textContent.replace(/\s+/g, " ").trim();
      if (!txt) continue;
      var range = c.doc.createRange(); range.selectNodeContents(ch);
      var tr = range.getBoundingClientRect();
      if (tr.width === 0 && tr.height === 0) continue;
      var trect = htmlWalkRect(c, tr);
      var pstyle = htmlWalkStyle(cs, trect, true);
      var decl = {}; if (myDecl["color"]) decl["color"] = myDecl["color"]; if (myDecl["font-size"]) decl["font-size"] = myDecl["font-size"];
      var tok = {}; if (myTok["color"]) tok["color"] = myTok["color"];
      c.nodes.push({
        id: c.nodes.length, parent: myId, tag: "#text", classes: [], name: null, component: null, variant: null,
        in_component: !!el.closest("[data-component]"),
        rect: trect, text: txt, display: "text", flex: null, grid: null, padding: [0, 0, 0, 0],
        style: pstyle, declared: decl, tokens: tok
      });
    } else if (ch.nodeType === 1) {
      htmlWalkEl(c, ch, myId, myDecl, myTok);
    }
  }
}

// ---- вывод производных полей (expect_sizing, significant)
function htmlWalkNum(tok) {
  return /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(tok) ? parseFloat(tok) : null;
}

// Разбор flex в {grow, basis}: 1, "1 1 0%", none, auto, "0 0 200px"
function htmlWalkParseFlex(value) {
  var v = (value || "").trim();
  if (!v) return { grow: null, basis: null };
  if (v === "none") return { grow: 0, basis: "auto" };
  if (v === "auto") return { grow: 1, basis: "auto" };
  if (v === "initial") return { grow: 0, basis: "auto" };
  var toks = v.split(/\s+/);
  var grow = htmlWalkNum(toks[0]);
  var basis = null;
  if (toks.length >= 3) basis = toks[2];
  else if (toks.length === 2 && htmlWalkNum(toks[1]) === null) basis = toks[1];
  else if (toks.length === 1 && grow === null) basis = toks[0];
  if (grow !== null && toks.length === 1) basis = "0%"; // flex: N = N 1 0%
  return { grow: grow, basis: basis };
}

// класс объявленного размера: FILL (100%), HUG (content-слова), FIXED (любая другая длина/var/calc), null (нет/auto)
function htmlWalkSizeKind(val) {
  if (val === null || val === undefined) return null;
  var v = val.trim().toLowerCase();
  if (v === "" || v === "auto" || v === "initial" || v === "unset" || v === "inherit" || v === "normal") return null;
  if (v === "100%" || v === "-webkit-fill-available" || v === "stretch") return "FILL";
  if (v === "min-content" || v === "max-content" || v === "fit-content" || v.indexOf("fit-content(") === 0) return "HUG";
  return "FIXED";
}

// Ожидаемый sizing узла в Figma (FILL/HUG/FIXED по h и v). Эвристика (SPEC.md):
// flex-родитель, главная ось: flex-grow > 0 -> FILL; иначе объявлен размер или flex-basis -> FIXED (100% -> FILL); иначе HUG.
// flex-родитель, поперечная ось: объявлен размер -> FIXED (100% -> FILL); иначе align-self, иначе align-items родителя:
//   stretch/normal -> FILL, остальное -> HUG.
// не flex: по горизонтали блок без ширины -> FILL, inline-* -> HUG, объявленная ширина -> FIXED; по вертикали высота -> FIXED, иначе HUG.
// position absolute/fixed (вне потока): объявленный размер (100% -> FILL) или HUG (shrink-to-fit); flex-родитель не растягивает.
// svg/img: FIXED, если не объявлено 100%/flex-grow. #text: HUG/HUG.
function htmlWalkExpectSizing(node, parent) {
  if (node.tag === "#text") return { h: "HUG", v: "HUG" };
  var d = node.declared || {};
  var replaced = node.tag === "svg" || node.tag === "img";
  var declKind = function (axis) {
    var k = htmlWalkSizeKind(d[axis === "h" ? "width" : "height"]);
    if (k === null && replaced) return "FIXED";
    return k;
  };
  var out = {};
  // out of flow (position absolute/fixed): no flex stretch or grow; declared size (100% -> FILL) or FIXED
  if (node.position === "absolute" || node.position === "fixed") {
    out.h = declKind("h") || "FIXED";
    out.v = declKind("v") || "FIXED";
    return out;
  }
  var pf = parent ? parent.flex : null;
  if (pf) {
    var main = pf.dir === "row" ? "h" : "v";
    var grow = null;
    if (d["flex-grow"] !== undefined && d["flex-grow"] !== "") grow = htmlWalkNum(d["flex-grow"].split(/\s+/)[0]);
    var pfx = htmlWalkParseFlex(d["flex"]);
    if (pfx.grow !== null) grow = pfx.grow;
    if (!grow) grow = 0;
    ["h", "v"].forEach(function (axis) {
      var k = declKind(axis);
      if (axis === main) {
        if (grow > 0) out[axis] = "FILL";
        else if (k) out[axis] = k;
        else {
          var bk = htmlWalkSizeKind(d["flex-basis"] || pfx.basis);
          out[axis] = (bk && pfx.basis !== "0%") ? bk : "HUG";
        }
      } else if (k) {
        out[axis] = k;
      } else {
        var a = (d["align-self"] || "").trim().toLowerCase();
        if (!a || a === "auto") a = (pf.align || "normal").trim().toLowerCase();
        out[axis] = (a === "stretch" || a === "normal") ? "FILL" : "HUG";
      }
    });
    return out;
  }
  var kh = declKind("h");
  out.h = kh ? kh : ((node.display || "").indexOf("inline") === 0 ? "HUG" : "FILL");
  var kv = declKind("v");
  out.v = kv ? kv : "HUG";
  return out;
}

function htmlWalkAlpha(hexstr) {
  if (!hexstr || hexstr.charAt(0) !== "#" || hexstr.length < 9) return hexstr ? 1 : 0;
  return parseInt(hexstr.slice(7, 9), 16) / 255;
}

// significant (SPEC.md): текст/svg/img/корень компонента/видимая отрисовка/flex-grid с 2+ значимыми детьми/
// узел с padding и значимыми детьми. Внутри компонента всегда false. Дети имеют id больше родителя: идём с конца.
function htmlWalkSignificant(nodes) {
  var kids = {};
  nodes.forEach(function (n) { kids[n.id] = []; });
  nodes.forEach(function (n) { if (n.parent !== null) kids[n.parent].push(n.id); });
  var sig = {};
  for (var i = nodes.length - 1; i >= 0; i--) {
    var n = nodes[i];
    if (n.in_component) { sig[n.id] = false; continue; }
    var st = n.style;
    var base = n.tag === "#text" || n.tag === "svg" || n.tag === "img" || !!n.component;
    var paint = false;
    if (n.tag !== "#text") {
      paint = (st.bg !== null && htmlWalkAlpha(st.bg) > 0) ||
        (st.borderWidth.some(function (w) { return w > 0; }) && htmlWalkAlpha(st.borderColor) > 0) ||
        !!st.boxShadow || !!st.bgImage;
    }
    var sk = kids[n.id].filter(function (k) { return sig[k]; }).length;
    var cont = !!(n.flex || n.grid) && sk >= 2;
    var padd = n.padding.some(function (p) { return p > 0; }) && sk >= 1;
    sig[n.id] = !!(base || paint || cont || padd);
  }
  return sig;
}

// htmlWalk(doc, opts) -> {etalon, viewport, page, nodes}. opts: {etalon, viewport, wl}
function htmlWalk(doc, opts) {
  opts = opts || {};
  var win = doc.defaultView;
  var c = { doc: doc, win: win, wl: opts.wl || HTML_WALK_WL, sx: win.scrollX, sy: win.scrollY, nodes: [] };
  htmlWalkEl(c, doc.body, null, {}, {});
  var de = doc.documentElement;
  var nodes = c.nodes;
  var byid = {};
  nodes.forEach(function (n) { byid[n.id] = n; });
  var sig = htmlWalkSignificant(nodes);
  nodes.forEach(function (n) {
    n.expect_sizing = htmlWalkExpectSizing(n, n.parent === null ? null : byid[n.parent]);
    n.significant = sig[n.id];
  });
  return {
    etalon: opts.etalon === undefined ? null : opts.etalon,
    viewport: opts.viewport === undefined ? null : opts.viewport,
    page: { w: Math.max(de.scrollWidth, win.innerWidth), h: Math.max(de.scrollHeight, win.innerHeight) },
    nodes: nodes
  };
}
