// ==========================================================================
// Server-level instructions handed to the MCP client on initialize, plus
// hints appended to failures that never reach the Figma sandbox.
// ==========================================================================
// Some clients (Claude Code among them) cut server instructions off after
// ~2000 characters, so this is ordered by value and kept near that size: the
// token-economy rules first, the execution model next, reference last. The
// long-form guide lives in docs/GUIDE.md and bridge.info().
const SERVER_INSTRUCTIONS = [
  "Mokido: LIVE read/write of the open Figma Desktop file (Mokido plugin); REST tools optional.",
  "",
  "TOKEN ECONOMY — every call re-reads the whole conversation, and what it returns stays there:",
  "1. READ with figma_inspect: every id in ONE call; find / props / context; like:'<ref id>' = find its copies + diff each; compare:'<ref id>' = diff given ids; view:'map'/'table'/'flow' (prototype links); figma_read_canvas = page tree. No read scripts in figma_execute_code (use_instead).",
  "2. WRITE the whole change in ONE figma_execute_code call (all breakpoints; verify inside: bridge.check / compare). Return only ids/flags.",
  "3. Replies over max_output_bytes (3500 B, max 3900) are shrunk: page with offset=K, don't slice bridge.state.lastResult.",
  "4. A screenshot ≈1k tokens, a turn re-sends the whole chat: to orient, one shot of all ids beats a series of reads; to verify, trust `warnings` / bridge.check.",
  "5. Past 45s a call returns { status: \"running\", job_id }: call figma_job_status once, it blocks until done. PLUGIN_BUSY: wait for that job, never retry blindly. `stalled`: stop, ask the user.",
  "",
  "Execution model: each call is a FRESH async function body (top-level await/return work, import/export don't, declarations don't survive). Never eval. Persist code with bridge.define(name, src ending in module.exports = {...}) + bridge.require(name); data with bridge.store.set/get (in the file) or bridge.state. `return bridge.info()` lists all helpers; macros: bridge.replaceWithInstance/setProps/setText/shift/moveInto/fitSection/context/setReaction/openOverlay.",
  "",
  "Figma limits: no x/y inside an INSTANCE (use AutoLayout; bridge.setPosition explains), bridge.componentize(node) instead of createComponentFromNode, await ensureFont(family, style) before text edits, colors are 0..1 floats.",
  "",
  "Write calls return checkpoint_id (figma_rollback undoes creations and snapshotted edits, not deletions), ids and lint warnings. Several files open: figma_list_targets, then target: \"<fileName>\"."
].join("\n");

module.exports = { SERVER_INSTRUCTIONS };
