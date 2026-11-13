// ------------------------------------------------------------------
// Figma's reactions validator answers a wrong action with a union error of
// 3-6 KB: one block per action type, most of them irrelevant. In the Ula pack
// ~14 of them were read in full and followed by 12 web searches. Keep the
// branch whose `type` matched (else the one with the fewest issues) and
// say what is wrong with it.
// ------------------------------------------------------------------
const UNION_HEAD_RE = /^Expected (.+?) to be one of the following, but none matched:$/;
const OVERLAY_KEY_RE = /'overlay(?:PositionType|Background|BackgroundInteraction)'/;

function parseIndented(lines) {
  const root = { text: "", indent: -1, kids: [] };
  const stack = [root];
  lines.forEach(line => {
    if (!line.trim()) return;
    const indent = line.length - line.replace(/^ +/, "").length;
    const node = { text: line.trim(), indent, kids: [] };
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    stack[stack.length - 1].kids.push(node);
    stack.push(node);
  });
  return root;
}

function leafTexts(node, out) {
  if (!node.kids.length) { if (!/^… \+\d+ deeper/.test(node.text)) out.push(node.text); return out; }
  node.kids.forEach(k => leafTexts(k, out));
  return out;
}

function branchIssues(branch) {
  const issues = [];
  const items = /^Multiple issues at /.test(branch.text) ? branch.kids : [branch];
  items.forEach(it => {
    if (UNION_HEAD_RE.test(it.text)) {
      const path = UNION_HEAD_RE.exec(it.text)[1];
      const leaves = Array.from(new Set(leafTexts(it, []).map(t => t.replace(/ at \S+$/, ""))));
      issues.push(leaves.length ? `${path}: ${leaves.join(" / ")}` : `${path}: no variant matched`);
    } else if (!/^… \+\d+ deeper/.test(it.text)) {
      issues.push(it.text);
    }
  });
  return issues;
}

function collectBranches(node, path, out) {
  node.kids.forEach(k => {
    const m = UNION_HEAD_RE.exec(k.text);
    if (m && m[1] === path) collectBranches(k, path, out); else out.push(k);
  });
  return out;
}

function compressValidationError(message) {
  if (typeof message !== "string" || message.indexOf("failed validation") === -1) return message;
  let out = message;
  if (message.length > 500 && message.indexOf("to be one of the following") !== -1) {
    const lines = message.split("\n");
    const headAt = lines.findIndex(l => /Expected .+ to be one of the following, but none matched:$/.test(l));
    if (headAt !== -1) {
      const tailAt = lines.findIndex((l, i) => i > headAt && /^\s*(at line \d+|HINT:)/.test(l));
      const treeLines = lines.slice(headAt + 1, tailAt === -1 ? lines.length : tailAt);
      const lead = lines[headAt].replace(/Expected .+ to be one of the following, but none matched:$/, "");
      const path = /Expected (.+) to be one of the following, but none matched:$/.exec(lines[headAt])[1];
      const tree = parseIndented(treeLines);
      const branches = collectBranches(tree, path, []).map(b => ({ b, issues: branchIssues(b) })).filter(x => x.issues.length);
      if (branches.length > 1) {
        const typeMiss = /^Invalid (?:literal|enum) value.* at \S+\.type$/;
        const scored = branches.map(x => ({ ...x, typeOk: !x.issues.some(i => typeMiss.test(i)) }));
        scored.sort((a, c) => (c.typeOk - a.typeOk) || (a.issues.length - c.issues.length));
        const best = scored[0];
        out = `${lead}${path} matches no variant. Closest (${best.typeOk ? "its type is right" : "no type matched"}): ${best.issues.join("; ")}. ` +
          `${branches.length - 1} other variants skipped. Valid shapes: bridge.info().reactions, or bridge.setReaction / openOverlay / closeOverlay.` +
          (tailAt === -1 ? "" : "\n" + lines.slice(tailAt).join("\n"));
      }
    }
  }
  if (/\.transition/.test(out) && /Required value missing|no variant matched/.test(out) && !/null = instant/.test(out)) {
    out += (/[.!]$/.test(out) ? " " : ". ") + "A NODE action needs the key `transition` (null = instant).";
  }
  if (OVERLAY_KEY_RE.test(out) && !/READ-ONLY FRAME propert/.test(out)) {
    out += (/[.!]$/.test(out) ? " " : ". ") + "overlayPositionType / overlayBackground / overlayBackgroundInteraction are not action keys but READ-ONLY FRAME properties: link with bridge.openOverlay, tell the user to set the overlay look in the Prototype panel.";
  }
  return out;
}

// Same for validation errors a script caught and returned inside its result.
function compressValidationDeep(value, depth = 0) {
  if (typeof value === "string") return compressValidationError(value);
  if (depth > 6 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(v => compressValidationDeep(v, depth + 1));
  const out = {};
  for (const k of Object.keys(value)) out[k] = compressValidationDeep(value[k], depth + 1);
  return out;
}

module.exports = { compressValidationError, compressValidationDeep };
