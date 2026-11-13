const fs = require("fs");
const os = require("os");
const path = require("path");
const { SERVER_VERSION, PACKAGE_ROOT } = require("./config");

// ------------------------------------------------------------------
// Startup update check. Non-blocking and opt-out — this project's whole
// pitch is running on a machine with no registry access, so a slow/failed
// network call here must never delay startup or print anything scarier
// than nothing at all.
//
// Compares SERVER_VERSION with the latest release on npm, not commits on
// main: an npx install has no git commit to compare (the package ships no
// .git), and a docs-only commit on main isn't an update anyone needs. Runs
// only for an installed copy (~/.mokido/mcp/), recognised by the
// version.json install.mjs writes beside this figma/ directory; a
// source-tree run via `node figma/index.js` skips silently.
// ------------------------------------------------------------------
const UPDATE_PACKAGE = "mokido";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    return null;
  }
}

/** True when `latest` is a strictly higher x.y.z than `current`. Anything
 * that doesn't parse (a prerelease tag, the 0.0.0-stage placeholder npm
 * leaves on a first publish) counts as "not newer" rather than a guess. */
function isNewerVersion(latest, current) {
  const parse = (v) => /^\d+\.\d+\.\d+$/.test(String(v)) ? String(v).split(".").map(Number) : null;
  const a = parse(latest), b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function updateNotice(latest, current) {
  return `[Mokido] Update available: v${current} -> v${latest}. Run "npx mokido@latest" ` +
    `(or "git pull" + "node install.mjs --update" in your clone), then reopen the Figma plugin ` +
    `and restart your AI client.`;
}

async function checkForUpdates() {
  try {
    if (process.env.FIGMA_MCP_NO_UPDATE_CHECK) return;
    if (!readJsonSafe(path.join(PACKAGE_ROOT, "version.json"))) return;

    const cacheDir = path.join(os.homedir(), ".mokido");
    const cachePath = path.join(cacheDir, "update-check.json");
    const cache = readJsonSafe(cachePath);

    // A cache left by the old commit-based check has no latestVersion: stale.
    let latest = cache && cache.latestVersion;
    const fresh = latest && typeof cache.lastCheckedAt === "number" &&
      (Date.now() - cache.lastCheckedAt) < UPDATE_CHECK_INTERVAL_MS;

    if (!fresh) {
      const res = await fetch(`https://registry.npmjs.org/${UPDATE_PACKAGE}/latest`, {
        headers: { "User-Agent": "mokido", "Accept": "application/json" },
        signal: AbortSignal.timeout(4000)
      });
      // Rate-limited, registry down, offline resolver returning a captive
      // portal page, whatever — try again next launch rather than guessing.
      if (!res.ok) return;
      const data = await res.json();
      if (!data || typeof data.version !== "string") return;
      latest = data.version;
      try {
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(cachePath, JSON.stringify({ lastCheckedAt: Date.now(), latestVersion: latest }), "utf8");
      } catch (e) {
        // Cache write failing just means we ask again next launch instead
        // of waiting out the full interval — not worth surfacing.
      }
    }

    if (isNewerVersion(latest, SERVER_VERSION)) {
      console.error(updateNotice(latest, SERVER_VERSION));
    }
  } catch (e) {
    // Offline, DNS failure, corporate proxy, a bug in this function itself —
    // never let a version check take the server down or print anything
    // alarming on a machine that's deliberately air-gapped.
  }
}

module.exports = { isNewerVersion, updateNotice, checkForUpdates };
