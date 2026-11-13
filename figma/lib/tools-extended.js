const TOOLS_EXTENDED = [
  {
    name: "figma_find_components",
    description: "Find and inspect components, component sets, variants, and component property definitions in the active Figma file without flooding LLM context. Returns names, variant values, keys, and IDs.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to filter components by name, description, or variant name (optional, if empty returns all top components)"
        },
        page_name: {
          type: "string",
          description: "Optional page name filter (e.g. '🎨 Design System' or 'Components')"
        },
        include_variants: {
          type: "boolean",
          description: "Whether to collect and return all available variant property keys and values (default: true)"
        },
        limit: {
          type: "number",
          description: "Maximum number of components to return to prevent token bloat (default: 30)"
        },
        refresh_index: {
          type: "boolean",
          description: "Force a fresh scan instead of using the cached component index (normally at most 60s stale — see figma_read_canvas / instructions for how the index works)."
        },
        target: {
          type: "string",
          description: "fileName of a specific connected Figma document, when more than one is open (see figma_list_targets)."
        }
      }
    }
  },
  {
    name: "figma_insert_component_instance",
    description: "Create and insert an instance of a master component or component set into the canvas or target AutoLayout container. Supports selecting variants, applying text overrides with auto font loading, and can return a PNG screenshot (capture: true) for visual verification.",
    inputSchema: {
      type: "object",
      properties: {
        component_name: {
          type: "string",
          description: "Name of the master component or ComponentSet to instantiate (e.g. 'Button', 'Card', 'Input')"
        },
        component_id: {
          type: "string",
          description: "Direct node ID of the master component or ComponentSet (optional alternative to component_name)"
        },
        properties: {
          type: "object",
          description: "Key-value map of variant properties and component properties to apply (e.g. {'Type': 'Primary', 'Size': 'MD', 'State': 'Default'})"
        },
        text_overrides: {
          type: "object",
          description: "Key-value map of text overrides for text layers inside the component (e.g. {'Label': 'Submit', 'Description': 'Confirm order'})"
        },
        target_parent_id: {
          type: "string",
          description: "Target container/frame node ID to insert the instance into. If omitted, inserts into current selected frame or active page."
        },
        position: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            index: { type: "number", description: "Child index in AutoLayout parent" }
          },
          description: "Optional placement coordinates or child index in AutoLayout container"
        },
        capture: {
          type: "boolean",
          description: "Whether to capture and return a PNG screenshot of the inserted instance (default: false)"
        },
        scale: {
          type: "number",
          description: "Screenshot resolution scale (default: 1)"
        },
        target: {
          type: "string",
          description: "fileName of a specific connected Figma document, when more than one is open (see figma_list_targets)."
        }
      }
    }
  },
  {
    name: "figma_get_variables",
    description: "Retrieve all Figma Variable collections, modes (e.g. Light/Dark), and design tokens (colors, numbers, strings, booleans) from the active document.",
    inputSchema: {
      type: "object",
      properties: {
        collection_name: {
          type: "string",
          description: "Optional filter by variable collection name (e.g. 'Theme', 'Tokens', 'Spacing')"
        },
        limit: {
          type: "number",
          description: "Maximum number of tokens to return across all matched collections, to prevent token bloat on large design-token files (default: 300)"
        },
        target: {
          type: "string",
          description: "fileName of a specific connected Figma document, when more than one is open (see figma_list_targets)."
        }
      }
    }
  },
  {
    name: "figma_set_variables_mode",
    description: "Switch the active Figma Variables mode (e.g. Dark Mode, Light Mode, Brand theme) for a specific artboard/frame or the entire page.",
    inputSchema: {
      type: "object",
      properties: {
        collection_name: {
          type: "string",
          description: "Name of the variable collection (e.g. 'Theme', 'Mode', 'Brand')"
        },
        mode_name: {
          type: "string",
          description: "Target mode name to activate (e.g. 'Dark', 'Light', 'Compact')"
        },
        target_id: {
          type: "string",
          description: "Target node ID (frame/artboard) to set mode on. If omitted, applies to current selection or active page."
        },
        capture: {
          type: "boolean",
          description: "Whether to capture a PNG screenshot of the target after switching mode (default: false)"
        },
        scale: {
          type: "number",
          description: "Screenshot resolution scale (default: 1)"
        },
        target: {
          type: "string",
          description: "fileName of a specific connected Figma document, when more than one is open (see figma_list_targets)."
        }
      },
      required: ["collection_name", "mode_name"]
    }
  },
  {
    name: "figma_insert_svg",
    description: "Insert raw SVG/vector code directly into Figma canvas or target AutoLayout container with automatic scale-proportional resizing, fill/stroke color overrides, optional component creation, and an optional PNG screenshot (capture: true).",
    inputSchema: {
      type: "object",
      properties: {
        svg_code: {
          type: "string",
          description: "Raw XML/SVG string (e.g. '<svg xmlns=\"...\" viewBox=\"0 0 24 24\">...</svg>')"
        },
        name: {
          type: "string",
          description: "Optional layer name for the created SVG node (e.g. 'Icon / Shield', 'Brand / Google')"
        },
        width: {
          type: "number",
          description: "Desired width in pixels (e.g. 24, 32, 48)"
        },
        height: {
          type: "number",
          description: "Desired height in pixels (e.g. 24, 32, 48)"
        },
        fill_override: {
          type: "string",
          description: "Specific fill color override (Hex e.g. '#FFFFFF' or RGB) applied to vector shapes with non-empty fills"
        },
        stroke_override: {
          type: "string",
          description: "Specific stroke color override (Hex e.g. '#6366F1' or RGB) applied to vector paths with non-empty strokes"
        },
        color_override: {
          type: "string",
          description: "Universal color override (Hex '#6366F1' or RGB) applied to all active fills and strokes"
        },
        target_parent_id: {
          type: "string",
          description: "Target container/frame node ID to insert the SVG into. If omitted, inserts into current selected frame or active page."
        },
        position: {
          type: "object",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            index: { type: "number", description: "Child index in AutoLayout parent" }
          },
          description: "Optional placement coordinates or child index in AutoLayout container"
        },
        as_component: {
          type: "boolean",
          description: "Whether to wrap the resulting SVG node into a reusable master ComponentNode (default: false)"
        },
        capture: {
          type: "boolean",
          description: "Whether to capture and return a PNG screenshot of the inserted SVG (default: false)"
        },
        scale: {
          type: "number",
          description: "Screenshot resolution scale factor (default: 2.0)"
        },
        target: {
          type: "string",
          description: "fileName of a specific connected Figma document, when more than one is open (see figma_list_targets)."
        }
      },
      required: ["svg_code"]
    }
  },
  {
    name: "figma_get_canvas_layout",
    description: "Inspect top-level frames and artboards on the active Figma page to prevent overlap. Returns all screen coordinates, bounding box, and a calculated 'suggestedNextPosition' for placing new artboards safely.",
    inputSchema: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: ["RIGHT", "BOTTOM"],
          description: "Placement direction relative to existing screens ('RIGHT' or 'BOTTOM', default: 'RIGHT')"
        },
        gap: {
          type: "number",
          description: "Spacing in pixels between artboards (default: 80)"
        },
        limit: {
          type: "number",
          description: "Maximum number of artboards to list, to prevent token bloat on pages with hundreds of frames (default: 200)"
        },
        layout: {
          type: "string",
          enum: ["row", "grid"],
          description: "'row' (default) places along one axis per `direction`, like before. 'grid' shelf-packs into a `columns`-wide grid so a run of generated screens fills a compact rectangle instead of one long ribbon."
        },
        columns: {
          type: "number",
          description: "Column count for layout: 'grid' (default: 4)."
        },
        target: {
          type: "string",
          description: "fileName of a specific connected Figma document, when more than one is open (see figma_list_targets)."
        }
      }
    }
  },
  {
    name: "figma_rollback",
    description: "Undo what a previous write call (figma_execute_code, figma_insert_component_instance, figma_insert_svg) did: removes nodes it created and restores properties on nodes it modified. Deletions the code performed on pre-existing nodes are never recoverable. Every write call's response includes the checkpoint_id to pass here.",
    inputSchema: {
      type: "object",
      properties: {
        checkpoint_id: {
          type: "string",
          description: "The checkpoint_id from a previous write call's response. Omit (or pass \"last\") to roll back the most recent not-yet-rolled-back checkpoint."
        },
        target: {
          type: "string",
          description: "fileName of a specific connected Figma document, when more than one is open (see figma_list_targets)."
        }
      }
    }
  },
  {
    name: "figma_job_status",
    description: "Wait for a figma_execute_code call that came back as { status: 'running', job_id } (it ran past 45s, or was called with async: true). BLOCKS until the job finishes or wait_ms passes, then returns the same result/screenshot the synchronous call would have — so call it once, not in a polling loop. `stalled: true` means the plugin looks frozen: STOP, ask the user to check Figma; a second figma_job_status for that job returns at once with the same advice. A finished job is forgotten after being read once.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "The job_id from figma_execute_code's { status: 'running', job_id } response." },
        wait_ms: { type: "number", description: "How long to block waiting for the job to finish (default: 45000, max: 55000; 0 = just peek)." }
      },
      required: ["job_id"]
    }
  },
  {
    name: "figma_list_targets",
    description: "List every Figma document currently connected to this bridge (fileName, current page, which one is focused). Use this when a LIVE tool call fails with AMBIGUOUS_TARGET, or before working with a specific file among several open at once — pass the fileName as `target` on any LIVE tool.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "figma_read_canvas",
    description: "Read the LIVE, currently-open Figma document as token-optimized Pseudo-JSX/Tree/JSON — the same pipeline get_file/get_node use for the cloud API, applied to whatever is open in Figma Desktop right now. Prefer this over hand-writing a tree walk in figma_execute_code; it is far cheaper in tokens and its output format matches get_file/get_node exactly.",
    inputSchema: {
      type: "object",
      properties: {
        node_ids: {
          type: "string",
          description: "Comma-separated node IDs to read. Omit to read the top-level frames of the current page."
        },
        format: {
          type: "string",
          enum: ["jsx", "tree", "json"],
          description: "Output format — same meaning as get_file/get_node (default: 'jsx')."
        },
        depth: {
          type: "number",
          description: "Traversal depth from each requested node, hard-capped at 12 (default: 6)."
        },
        include_hidden: {
          type: "boolean",
          description: "Whether to include hidden (visible=false) layers (default: false)."
        },
        budget_tokens: {
          type: "number",
          description: "Target response size in tokens (default: 4000). If the requested depth overshoots this, depth is reduced and re-serialized (no extra round trip) until it fits, with a trailing comment noting the reduction."
        },
        target: {
          type: "string",
          description: "fileName of a specific connected Figma document, when more than one is open (see figma_list_targets)."
        }
      }
    }
  },
];

module.exports = { TOOLS_EXTENDED };
