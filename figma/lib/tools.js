const { FIGMA_TOKEN } = require("./config");
const { TOOLS_CORE } = require("./tools-core");
const { TOOLS_EXTENDED } = require("./tools-extended");
const { TOOLS_REST } = require("./tools-rest");

// ==========================================
// Tool Definitions & Handler
// ==========================================
const TOOLS = [...TOOLS_CORE, ...TOOLS_EXTENDED, ...TOOLS_REST];

// ==========================================================================
// Tool tiers — which of the 22 defined tools are actually SENT to the model.
// A longer tools/list costs every single turn (every schema is re-sent) and
// makes tool SELECTION worse, not just more expensive, so the surface is
// trimmed by what's actually usable in this server's current configuration:
//   - "core"/"extended" tools are always sent — LIVE tools work with zero
//     configuration once the plugin is connected.
//   - "rest" tools need FIGMA_PERSONAL_ACCESS_TOKEN; without one they are
//     dead weight (every call would just fail with REST_TOKEN_MISSING), so
//     they're hidden entirely rather than left in as a confusing option.
//   - "legacy" tools (figma_create_ui_card, get_me, get_image_fills) are
//     superseded by other tools and hidden by default; set
//     FIGMA_MCP_LEGACY_TOOLS=1 to keep them available for existing workflows
//     built around them. Nothing is deleted, only hidden.
// ==========================================================================
const TOOL_TIERS = {
  figma_execute_code: "core",
  figma_inspect: "core",
  figma_read_canvas: "core",
  figma_screenshot: "core",
  figma_find_components: "core",
  figma_insert_component_instance: "core",
  figma_insert_svg: "core",
  figma_get_variables: "core",
  figma_rollback: "core",

  figma_get_selection: "extended",
  figma_get_canvas_layout: "extended",
  figma_set_variables_mode: "extended",
  figma_job_status: "extended",
  figma_list_targets: "extended",

  get_file: "rest",
  get_node: "rest",
  get_image: "rest",
  get_styles: "rest",
  get_components: "rest",
  get_comments: "rest",
  post_comment: "rest",

  figma_create_ui_card: "legacy",
  get_me: "legacy",
  get_image_fills: "legacy"
};

// MCP tool annotations (spec 2025-03-26+): behaviour hints clients use for
// permission prompts and registries (Glama TDQS) use to judge safety. Kept
// apart from the descriptions so the text the model reads doesn't grow.
// Live tools never leave the machine (openWorldHint false); REST tools call
// api.figma.com. execute_code / rollback can delete nodes, hence destructive.
const READ_LIVE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE_LIVE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const READ_REST = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const TOOL_ANNOTATIONS = {
  figma_execute_code: { ...WRITE_LIVE, destructiveHint: true },
  figma_inspect: READ_LIVE,
  figma_read_canvas: READ_LIVE,
  figma_screenshot: READ_LIVE,
  figma_find_components: READ_LIVE,
  figma_insert_component_instance: WRITE_LIVE,
  figma_insert_svg: WRITE_LIVE,
  figma_get_variables: READ_LIVE,
  figma_rollback: { ...WRITE_LIVE, destructiveHint: true },

  figma_get_selection: READ_LIVE,
  figma_get_canvas_layout: READ_LIVE,
  figma_set_variables_mode: { ...WRITE_LIVE, idempotentHint: true },
  figma_job_status: { ...READ_LIVE, idempotentHint: false },
  figma_list_targets: READ_LIVE,

  get_file: READ_REST,
  get_node: READ_REST,
  get_image: READ_REST,
  get_styles: READ_REST,
  get_components: READ_REST,
  get_comments: READ_REST,
  post_comment: { ...READ_REST, readOnlyHint: false, idempotentHint: false },

  figma_create_ui_card: WRITE_LIVE,
  get_me: READ_REST,
  get_image_fills: READ_REST
};

function getActiveTools() {
  const hasRestToken = !!FIGMA_TOKEN;
  const legacyEnabled = process.env.FIGMA_MCP_LEGACY_TOOLS === "1";
  return TOOLS.filter(t => {
    const tier = TOOL_TIERS[t.name] || "extended";
    if (tier === "rest") return hasRestToken;
    if (tier === "legacy") return legacyEnabled;
    return true;
  }).map(t => TOOL_ANNOTATIONS[t.name] ? { ...t, annotations: TOOL_ANNOTATIONS[t.name] } : t);
}

module.exports = { TOOLS, getActiveTools };
