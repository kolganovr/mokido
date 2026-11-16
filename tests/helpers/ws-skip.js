// WebSocket-dependent suites need the global WebSocket (Node >= 22). On Node 18 they skip (the skip is visible in the log);
// on Node >= 22 a missing WebSocket is a FAILURE, so the skip cannot go silent where the code is really tested.
function wsMissing(label) {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 22) { console.log("  FAIL global WebSocket is missing on Node " + process.versions.node + " (" + label + ")"); console.log("FAILURES: no WebSocket"); process.exit(1); }
  console.log("skip: needs Node >= 22 (global WebSocket), this is " + process.versions.node + " (" + label + ")");
  process.exit(0);
}
module.exports = { wsMissing };
