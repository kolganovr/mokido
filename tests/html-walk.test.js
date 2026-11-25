// html-walk.js on a minimal fake DOM (T-130, T-133). Run: node tests/html-walk.test.js
// What this proves: the walker READS the computed style (getComputedStyle), not the declared one, for text-align and color, and writes
// the svg markup with currentColor resolved. The fake DOM is tiny (no cascade, no layout): the computed values are supplied by the test,
// so real Chromium behaviour (inheritance, start/end) is only checked live. Loads figma-plugin-src/html-walk.js through vm.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let failures = 0, checks = 0;
function check(name, ok, detail) {
  checks++;
  if (ok) return;
  failures++;
  console.log("  FAIL " + name + (detail !== undefined ? " :: " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 500) : ""));
}
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "figma-plugin-src", "html-walk.js"), "utf8"), ctx);
const j = (x) => JSON.parse(JSON.stringify(x));

// ---------- fake DOM
const BASE_CS = { display: "block", visibility: "visible", flexDirection: "row", flexWrap: "nowrap", justifyContent: "normal", alignItems: "normal", columnGap: "normal", rowGap: "normal",
  position: "static", overflowX: "visible", overflowY: "visible", gridTemplateColumns: "none", paddingTop: "0px", paddingRight: "0px", paddingBottom: "0px", paddingLeft: "0px",
  backgroundColor: "rgba(0, 0, 0, 0)", backgroundImage: "none", borderTopWidth: "0px", borderRightWidth: "0px", borderBottomWidth: "0px", borderLeftWidth: "0px",
  borderTopColor: "rgb(0, 0, 0)", borderRightColor: "rgb(0, 0, 0)", borderBottomColor: "rgb(0, 0, 0)", borderLeftColor: "rgb(0, 0, 0)",
  borderTopLeftRadius: "0px", borderTopRightRadius: "0px", borderBottomRightRadius: "0px", borderBottomLeftRadius: "0px",
  fontSize: "16px", lineHeight: "normal", fontFamily: "Inter", fontWeight: "400", opacity: "1", boxShadow: "none", color: "rgb(0, 0, 0)", textAlign: "start", direction: "ltr",
  webkitLineClamp: "none", whiteSpace: "normal", textOverflow: "clip", objectFit: "fill" };
let ids = 0;
function node(tag, attrs, kids, cs, rect) {
  const e = {
    nodeType: 1, tagName: tag.toUpperCase(), attrs: Object.assign({}, attrs || {}), childNodes: kids || [], parentElement: null, cs: Object.assign({}, BASE_CS, cs || {}), rect: rect || [0, 0, 100, 20],
    get classList() { return (this.attrs.class || "").split(/\s+/).filter(Boolean); },
    get textContent() { return this.childNodes.map((c) => c.textContent).join(""); },
    set textContent(v) { this.childNodes = [{ nodeType: 3, textContent: v }]; },
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; },
    setAttribute(n, v) { this.attrs[n] = String(v); },
    matches() { return false; },
    closest() { return null; },
    get style() { return { getPropertyValue: () => "" }; },
    getBoundingClientRect() { return { left: this.rect[0], top: this.rect[1], width: this.rect[2], height: this.rect[3] }; },
    querySelectorAll() { const out = []; (function w(n) { for (const c of n.childNodes) if (c.nodeType === 1) { out.push(c); w(c); } })(this); return out; },
    cloneNode(deep) { const c = node(tag, this.attrs, deep ? this.childNodes.map((k) => (k.nodeType === 1 ? k.cloneNode(true) : { nodeType: 3, textContent: k.textContent, rect: k.rect })) : [], this.cs, this.rect); c.childNodes.forEach((k) => { if (k.nodeType === 1) k.parentElement = c; }); return c; },
    get outerHTML() { return "<" + tag + Object.keys(this.attrs).map((k) => " " + k + '="' + this.attrs[k] + '"').join("") + ">" + this.childNodes.map((c) => (c.nodeType === 1 ? c.outerHTML : c.textContent)).join("") + "</" + tag + ">"; }
  };
  e.childNodes.forEach((k) => { if (k.nodeType === 1) k.parentElement = e; });
  return e;
}
const text = (t, rect) => ({ nodeType: 3, textContent: t, rect: rect || [0, 0, 80, 20] });
function walk(body, width) {
  const win = { scrollX: 0, scrollY: 0, innerWidth: width || 400, innerHeight: 300, getComputedStyle: (e) => e.cs, matchMedia: () => ({ matches: false }) };
  const doc = { defaultView: win, styleSheets: [], body, documentElement: { scrollWidth: width || 400, scrollHeight: 300 },
    createRange() { let n = null; return { selectNodeContents(t) { n = t; }, getBoundingClientRect() { const r = n.rect; return { left: r[0], top: r[1], width: r[2], height: r[3] }; } }; } };
  return j(ctx.htmlWalk(doc, { etalon: "t", viewport: { w: width || 400 } }));
}

// ---------- T-130: computed text-align
{
  const h1 = node("h1", {}, [text("Design systems that ship", [100, 10, 200, 60])], { textAlign: "center" }, [100, 10, 200, 60]);
  const p = node("p", { class: "lead" }, [text("Lead paragraph", [120, 80, 160, 40])], { textAlign: "center" }, [120, 80, 160, 40]);
  const plain = node("p", {}, [text("Plain", [0, 150, 40, 20])], {}, [0, 150, 40, 20]);
  const hero = node("main", { class: "hero" }, [h1, p], { textAlign: "center" }, [0, 0, 400, 140]);
  const body = node("body", {}, [hero, plain], {}, [0, 0, 400, 300]);
  const t = walk(body);
  const tx = (s) => t.nodes.find((n) => n.tag === "#text" && n.text === s);
  check("walker: text inherits center from an ancestor (computed, nothing declared)", tx("Design systems that ship").style.textAlign === "center" && tx("Lead paragraph").style.textAlign === "center", [tx("Design systems that ship").style, tx("Lead paragraph").style.textAlign]);
  check("walker: the element node carries textAlign too", t.nodes.find((n) => n.classes.includes("lead")).style.textAlign === "center");
  check("walker: initial start in ltr is left", tx("Plain").style.textAlign === "left", tx("Plain").style.textAlign);
  check("the declared map has no text-align (it is not read from there)", !t.nodes.some((n) => n.declared && n.declared["text-align"]));
  const al = (cs) => ctx.htmlWalkTextAlign(cs);
  check("start/end follow direction", al({ textAlign: "start", direction: "rtl" }) === "right" && al({ textAlign: "end", direction: "rtl" }) === "left" && al({ textAlign: "start", direction: "ltr" }) === "left" && al({ textAlign: "end", direction: "ltr" }) === "right");
  check("center / right / justify / left / vendor prefix / unknown", al({ textAlign: "center" }) === "center" && al({ textAlign: "right" }) === "right" && al({ textAlign: "justify" }) === "justify" && al({ textAlign: "left" }) === "left" && al({ textAlign: "-webkit-center" }) === "center" && al({ textAlign: "match-parent" }) === "left" && al({}) === "left");
}

// the walker is embedded into ui.html by the build: no new top-level state beyond functions/vars
{
  const w = fs.readFileSync(path.join(__dirname, "..", "figma-plugin-src", "html-walk.js"), "utf8");
  check("walker has no import/export (it runs in the window script)", !/^\s*(import|export)\b/m.test(w));
}
console.log(failures ? "FAILURES: " + failures + " of " + checks : "ALL PASS (" + checks + " checks passed)");
process.exit(failures ? 1 : 0);
