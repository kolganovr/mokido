// html-img.js (T-135): an <img> whose source is an SVG becomes a vector (figma.createNodeFromSvg), not an IMAGE fill
// (figma.createImage takes PNG/JPEG/GIF only: "Image type is unsupported"). The vector is fitted into the img box by object-fit.
// Part of the plugin scope (no import/export); prefix htmlImg*. Raster sources stay in html-build.js (IMAGE paint).
// Entry: htmlImgSvg(p, ctx) -> node | null (not an svg source, caller goes on) | false (svg source that failed, warned).

// svg text of a data: URI (base64 or url-encoded; a raw unescaped one is taken as is), or null when the source is not a data svg
function htmlImgDataSvg(src) {
  const m = /^data:([^,]*?)(;base64)?,([\s\S]*)$/i.exec(String(src || ""));
  if (!m || !/svg/i.test(m[1])) return null;
  if (m[2]) {
    const bin = Array.from(figma.base64Decode(m[3]), (c) => String.fromCharCode(c)).join("");
    try { return decodeURIComponent(escape(bin)); } catch (e) { return bin; }
  }
  try { return decodeURIComponent(m[3]); } catch (e) { return m[3]; }
}
function htmlImgAttr(head, name) {
  const m = new RegExp("\\s" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')", "i").exec(head);
  return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
}
// intrinsic size of the svg: viewBox, else numeric width/height; null when neither is usable
function htmlImgIntrinsic(svg) {
  const hm = /<svg\b[^>]*>/i.exec(svg);
  if (!hm) return null;
  const vb = String(htmlImgAttr(hm[0], "viewBox") || "").trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) return { w: vb[2], h: vb[3] };
  const aw = htmlImgAttr(hm[0], "width"), ah = htmlImgAttr(hm[0], "height");
  const w = parseFloat(aw), h = parseFloat(ah);
  return w > 0 && h > 0 && !/%/.test(aw + ah) ? { w: w, h: h } : null;
}
// the root tag gets the given attributes (replaced or added) and an xmlns
function htmlImgSetAttrs(svg, attrs) {
  const hm = /<svg\b[^>]*>/i.exec(svg);
  if (!hm) return svg;
  let head = hm[0];
  if (!/\sxmlns\s*=/i.test(head)) head = head.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  for (const k of Object.keys(attrs)) {
    const re = new RegExp("\\s" + k + "\\s*=\\s*(\"[^\"]*\"|'[^']*')", "i");
    head = re.test(head) ? head.replace(re, " " + k + '="' + attrs[k] + '"') : head.replace(/^<svg/i, "<svg " + k + '="' + attrs[k] + '"');
  }
  return svg.slice(0, hm.index) + head + svg.slice(hm.index + hm[0].length);
}
// object-fit: size of the picture inside the box. cover: by the bigger scale, contain: by the smaller, none: as is, scale-down: contain but never up;
// fill (the default): stretched to the box.
function htmlImgFit(fit, iw, ih, bw, bh) {
  const f = String(fit || "fill").trim().toLowerCase().split(/\s+/)[0];
  const k = f === "cover" ? Math.max(bw / iw, bh / ih) : f === "contain" ? Math.min(bw / iw, bh / ih) : f === "scale-down" ? Math.min(1, bw / iw, bh / ih) : f === "none" ? 1 : null;
  if (k === null) return { w: bw, h: bh, stretch: true };
  return { w: iw * k, h: ih * k, stretch: false };
}
function htmlImgSvg(p, ctx) {
  let svg = null;
  try { svg = htmlImgDataSvg(p.build && p.build.img); } catch (e) { htmlBuildWarn(ctx, p, "img_failed", "svg data uri: " + htmlBuildErr(e)); return false; }
  if (svg === null) return null;
  const bw = Math.max(p.w || 0, 0.01), bh = Math.max(p.h || 0, 0.01);
  const r2 = (v) => Math.round(v * 100) / 100;
  let v = null;
  try {
    const it = htmlImgIntrinsic(svg) || { w: bw, h: bh };
    const f = htmlImgFit(p.build && p.build.fit, it.w, it.h, bw, bh);
    const attrs = { width: r2(f.w), height: r2(f.h) };
    if (f.stretch && Math.abs(it.w / it.h - bw / bh) > 0.01) attrs.preserveAspectRatio = "none";
    v = figma.createNodeFromSvg(htmlImgSetAttrs(svg, attrs));
    if (Math.abs(f.w - bw) <= 0.5 && Math.abs(f.h - bh) <= 0.5) return v;
    // cover overflows the box, contain leaves bands: the vector sits centered in a clipping frame of the img box
    const box = figma.createFrame();
    box.fills = [];
    box.clipsContent = true;
    box.resize(bw, bh);
    box.appendChild(v);
    v.x = (bw - f.w) / 2;
    v.y = (bh - f.h) / 2;
    return box;
  } catch (e) {
    try { if (v) v.remove(); } catch (e2) { /* nothing to clean */ }
    htmlBuildWarn(ctx, p, "img_failed", "svg: " + htmlBuildErr(e));
    return false;
  }
}
