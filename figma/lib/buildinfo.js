// Build label between releases (T-140). The version number changes only on a
// public release; an install from a git checkout gets a label from
// `git describe`, so the plugin and the server show which commit they run:
//   on the release tag, clean tree   -> "4.4.0"
//   58 commits after v4.4.0          -> "4.5.0-dev.58+b4ffd0c"
//   uncommitted changes on top       -> "4.5.0-dev.58+b4ffd0c.dirty"
// The part after "-" is a semver prerelease (older than the real 4.5.0), the
// part after "+" is build metadata (the commit). An npm install has no .git,
// so it shows the plain version.
const fs = require("fs");
const path = require("path");

const SEMVER = /^\d+\.\d+\.\d+$/;

function nextMinor(version) {
  const [major, minor] = version.split(".").map(Number);
  return `${major}.${minor + 1}.0`;
}

/** version: package.json version; describe: output of
 * `git describe --tags --long --dirty --abbrev=7 --match v[0-9]*` or null. */
function buildLabel(version, describe) {
  const m = /^v(\d+\.\d+\.\d+)-(\d+)-g([0-9a-f]{4,40})(-dirty)?$/.exec(String(describe || "").trim());
  if (!m || !SEMVER.test(String(version))) return version;
  const [, tag, count, sha, dirty] = m;
  if (count === "0" && !dirty && tag === version) return version;
  // Version already bumped for the coming release (release commit not tagged
  // yet): keep it; otherwise the work goes to the next minor.
  const base = tag === version ? nextMinor(version) : version;
  return `${base}-dev.${count}+${sha}${dirty ? ".dirty" : ""}`;
}

/** The label install.mjs stored in version.json beside figma/, or null. */
function readBuild(packageRoot) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(packageRoot, "version.json"), "utf8"));
    return typeof data.build === "string" && /^\d+\.\d+\.\d+([-+][0-9A-Za-z.+-]*)?$/.test(data.build) ? data.build : null;
  } catch {
    return null;
  }
}

module.exports = { buildLabel, readBuild };
