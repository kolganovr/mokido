// Build label between releases (T-140). Run: node tests/buildinfo.test.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { buildLabel, readBuild } = require("../figma/lib/buildinfo.js");

let failures = 0, passed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failures++; console.log("  FAIL " + name + (extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 400) : "")); }
}

(async () => {
  check("on the release tag, clean: plain version", buildLabel("4.4.0", "v4.4.0-0-gb4ffd0c") === "4.4.0");
  check("58 commits after v4.4.0: next minor dev", buildLabel("4.4.0", "v4.4.0-58-gb4ffd0c") === "4.5.0-dev.58+b4ffd0c", buildLabel("4.4.0", "v4.4.0-58-gb4ffd0c"));
  check("local edits: .dirty in build metadata", buildLabel("4.4.0", "v4.4.0-58-gb4ffd0c-dirty") === "4.5.0-dev.58+b4ffd0c.dirty");
  check("edits on the tag itself are not the release", buildLabel("4.4.0", "v4.4.0-0-gb4ffd0c-dirty") === "4.5.0-dev.0+b4ffd0c.dirty");
  check("version already bumped, tag not yet: keeps the bumped version", buildLabel("4.5.0", "v4.4.0-60-gabcdef1") === "4.5.0-dev.60+abcdef1");
  check("trailing newline from git is fine", buildLabel("4.4.0", "v4.4.0-3-g1234567\n") === "4.5.0-dev.3+1234567");
  check("no git (npm install): plain version", buildLabel("4.4.0", null) === "4.4.0" && buildLabel("4.4.0", "") === "4.4.0");
  check("garbage describe: plain version", buildLabel("4.4.0", "b4ffd0c") === "4.4.0" && buildLabel("4.4.0", "release-1-gabc1234") === "4.4.0");
  const semverPre = /^\d+\.\d+\.\d+-[0-9A-Za-z.]+\+[0-9A-Za-z.]+$/;
  check("dev label is valid semver (prerelease + build)", semverPre.test(buildLabel("4.4.0", "v4.4.0-58-gb4ffd0c-dirty")));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "buildinfo-"));
  check("readBuild: no version.json -> null", readBuild(tmp) === null);
  fs.writeFileSync(path.join(tmp, "version.json"), JSON.stringify({ commit: "x", build: "4.5.0-dev.58+b4ffd0c" }));
  check("readBuild: reads the label", readBuild(tmp) === "4.5.0-dev.58+b4ffd0c");
  fs.writeFileSync(path.join(tmp, "version.json"), JSON.stringify({ commit: "x" }));
  check("readBuild: old marker without build -> null", readBuild(tmp) === null);
  fs.writeFileSync(path.join(tmp, "version.json"), JSON.stringify({ build: "<script>" }));
  check("readBuild: rejects a non-version string", readBuild(tmp) === null);

  const ROOT = path.join(__dirname, "..");
  const ui = fs.readFileSync(path.join(ROOT, "figma-plugin", "ui.html"), "utf8");
  check("source ui.html keeps the empty PLUGIN_BUILD placeholder", ui.includes('const PLUGIN_BUILD = "";'));

  const inst = await import(pathToFileURL(path.join(ROOT, "install.mjs")).href);
  const pdir = path.join(tmp, "plugin");
  fs.mkdirSync(pdir);
  fs.writeFileSync(path.join(pdir, "ui.html"), '<script>const PLUGIN_BUILD = "";</script>');
  inst.injectPluginBuild(pdir, "4.5.0-dev.58+b4ffd0c");
  check("injectPluginBuild bakes the label", fs.readFileSync(path.join(pdir, "ui.html"), "utf8").includes('const PLUGIN_BUILD = "4.5.0-dev.58+b4ffd0c";'));

  check("getRepoDescribe: a folder that is not the repo root -> null", inst.getRepoDescribe(path.join(ROOT, "figma")) === null);
  const d = inst.getRepoDescribe(ROOT);
  // CI checkouts can be shallow without tags: null is allowed there, a value must parse.
  check("getRepoDescribe on this checkout: null or v-tag describe", d === null || /^v\d+\.\d+\.\d+-\d+-g[0-9a-f]+(-dirty)?$/.test(d), d);
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(failures ? `FAILURES: ${failures}` : `ALL PASS (${passed} checks passed)`);
  process.exit(failures ? 1 : 0);
})();
