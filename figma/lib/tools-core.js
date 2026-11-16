const TOOLS_CORE = [
  // 1. Live Canvas Tools
  {
    name: "figma_execute_code",
    // Kept short, but the few rules that decide how many turns a task takes
    // live HERE, not only in SERVER_INSTRUCTIONS: some clients never show a
    // server's instructions to the model (Antigravity sessions made 0 bridge.*
    // calls in ~220 figma_execute_code runs), while tool descriptions always
    // reach it. The long-form contract stays in instructions + bridge.info().
    description: "WRITE tool: run JavaScript in the open Figma document (Figma Desktop + 'Mokido' plugin) to create, edit, move, style or delete nodes. To READ (explore a section, list children, find layers, check texts / fonts / variants / table columns) call figma_inspect instead: every id in one call, one line per node, view:\"table\" for tables; a read script here costs a model turn per question and its reply names the figma_inspect call to use (use_instead). Every call is a full model turn, so make the whole change in ONE call — all screens / breakpoints, verified in the same code with bridge.check — and put capture_node_ids on that same call instead of a separate figma_screenshot. Globals: `figma`, `await ensureFont(family, style)`, `getFreePosition(w, h)`, `bridge`: bridge.check({ '1:2': { width: 320, fill: '#FFFFFF' } }) -> pass/fail list; bridge.define(name, src) + bridge.require(name) keep helpers between calls (each call is a fresh function body — never eval); `return bridge.info()` lists the rest. Macros: bridge.replaceWithInstance(target, comp, {props, text}), bridge.setProps(inst, {Status: 'Dropdown'}), bridge.setText(root, {layer: '…'}) or bridge.setText(textNode, 'new text') (keeps mixed font styles, sizes, colours by words: THE way to replace the text of a label with several font styles — never `characters =`, which flattens them, and never a per-character getRangeFontName/setRangeFontName loop), bridge.shift(ids, {dx, dy}), bridge.moveInto(ids, section, {layout, gap}), bridge.fitSection(s), bridge.context(id), bridge.componentize(nodeObject) -> new COMPONENT, same name/size/look, NEW id (never raw createComponentFromNode), prototype links: await bridge.openOverlay(triggerId, overlayFrameId, { position: 'BOTTOM_CENTER', dim: 0.4, closeOnOutside: true }) (the overlay look is read-only in the Plugin API: the reply names the MANUAL STEP for the user), bridge.closeOverlay(id), bridge.setReaction(id, { to: frameId, nav: 'NAVIGATE' }); read links with figma_inspect view:\"flow\". Call macros directly, don't read their source. Never findAll the whole page — scope to a section. Return only the ids/flags you need: responses over max_output_bytes (3500) are shrunk, the full value stays in bridge.state.lastResult.",
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "JavaScript to run in the Figma sandbox, compiled as an async function body (top-level await and return allowed; import/export are not). Example: const frame = figma.createFrame(); frame.resize(400, 600); frame.name = 'Card'; figma.currentPage.appendChild(frame); return 'Created frame';"
        },
        description: {
          type: "string",
          description: "Short human-readable description of the action (e.g. 'Create login modal', 'Update brand colors') shown in Figma toasts and logs."
        },
        capture: {
          type: "boolean",
          description: "Set to true to capture a PNG of what this call created/modified and return it for visual verification. Never touches the user's selection — see capture_node_ids."
        },
        capture_node_ids: {
          type: "array",
          items: { type: "string" },
          description: "Node ids to screenshot instead of the default (whatever this call created/modified, falling back to the user's current selection only if neither exists). The user's selection is never mutated to enable a capture."
        },
        diff: {
          type: "boolean",
          description: "Currently ignored (the \"before\" screenshot stalls the plugin); the reply has the after image only."
        },
        scale: {
          type: "number",
          description: "Screenshot resolution scale (default: 1)."
        },
        max_px: {
          type: "number",
          description: "Longest side of each returned image in px (default: 1024). Image tokens grow with pixel count, not file size."
        },
        max_output_bytes: {
          type: "number",
          description: "Cap on the whole text response in UTF-8 bytes (default: 3500 — under the ~4 KB at which some clients spill output to a file and cost an extra turn; in clients that spill big outputs to a file, 0 and values above 3900 become 3900). Larger results are shrunk structurally (multi-line text is cut by whole lines), cuts marked with …."
        },
        async: {
          type: "boolean",
          description: "Return { status: 'running', job_id } immediately instead of waiting — collect it later with figma_job_status. Calls that run past 45s do this automatically."
        },
        target: {
          type: "string",
          description: "fileName of a specific connected Figma document to run this in, when more than one is open (see figma_list_targets). Defaults to whichever is currently focused."
        }
      },
      required: ["code"]
    }
  },
  {
    name: "figma_inspect",
    description: "READ the live Figma document in ONE call — the tool for any read (not figma_execute_code); pass every node id you need at once instead of one call per node. Default: a compact outline, one line per node (TYPE \"name\" #id WxH @x,y [V gap8 pad16 fill/hug a:start/center] size:fill/hug fill:#FFF stroke:#E8EAF0/0,1,1,1 r0,0,3,3 shadow:… font \"text…\"; non-defaults only; a TEXT named after its text drops the name; `a:P/C` = primaryAxisAlignItems/counterAxisAlignItems, start = MIN, center = CENTER, end = MAX, between = SPACE_BETWEEN, absent = MIN/MIN), as deep as fits the reply unless `depth` is given; `children:N` marks a node with more below. `like: \"<ref id>\"` (or several) FINDS every copy of the reference under node_ids (screens/sections; default: its section) — instances of the same component, or same name — and diffs each against it: the call for \"redo these like the reference\" when you don't know where the copies are. `compare: \"<ref id>\"` lists, per node_id, every difference from that reference (layout, sizing, stroke, radius, effects, clip, font, variant; children matched by name) and ends with REF lines, the reference's exact values to copy into the write (no props read needed) — one call for \"make these like that one\", and the check after the write. `props` returns exact values instead: { id: { prop: value } } (also fill, stroke, text, font, layout, padding, parent, children, main, variant, props, absolute, reactions, connector). `find` searches node names under node_ids (or the current page); `find_text` searches text content. `view: \"map\"` = canvas map (sections, breakpoints). `view: \"flow\"` = the prototype links under node_ids (a section or screens): per screen, source, trigger, action, target, transition, plus the overlay settings of overlay targets — never scan the page for `reactions`. `context: true` adds ancestor sections, breakpoints and component variants. `offset` skips the first N outline lines when a reply ends with `pass offset=K`. `check` returns only mismatches. Combine them freely. Changes nothing.",
    inputSchema: {
      type: "object",
      properties: {
        node_ids: {
          type: "array",
          items: { type: "string" },
          description: "Node ids to read (\"12:34\" or \"12-34\"). Omit to use the current page."
        },
        node_id: { type: "string", description: "Alias of node_ids for one id." },
        ids: { type: "array", items: { type: "string" }, description: "Alias of node_ids." },
        depth: {
          type: "number",
          description: "Outline levels below each node (0 = the nodes only, max 6). Omit it: the outline goes as deep as fits the reply."
        },
        props: {
          type: "array",
          items: { type: "string" },
          description: "Return these properties per node instead of an outline, e.g. [\"width\", \"layoutSizingHorizontal\", \"fill\", \"text\"]; also \"reactions\" (prototype interactions), \"connector\" (FigJam connector ends) and \"texts\" (all texts below a frame, id + full characters, pages with offset)."
        },
        view: {
          type: "string",
          enum: ["outline", "map", "table", "flow"],
          description: "\"outline\" (default) = one line per node; \"map\" = canvas map: sections, frames, breakpoints and component sets in a few lines; \"table\" = per table (found by structure) the columns: header, width, sizing, cell contents, plus row and cell ids; \"flow\" = prototype links (screen, source, trigger, action, target, transition, overlay settings) under node_ids (without node_ids: every top-level screen of the current page)."
        },
        context: {
          type: "boolean",
          description: "Also return, per node: ancestor sections, breakpoint siblings and component variants ({ id: context })."
        },
        like: {
          type: "string",
          description: "Reference node id (several: comma-separated): find its copies under node_ids (default: the reference's top section) and list, per copy, its frame and how it differs (missing children come with the reference's own line, and REF lines at the end give the reference's exact values, so no extra read is needed). Copies that already match are listed as identical."
        },
        compare: {
          type: "string",
          description: "Reference node id: instead of an outline, list how each node_id differs from it (x/y/width and text content are skipped; height, stroke sides/align are compared). Ends with REF lines: the exact values of the differing reference nodes, to copy in figma_execute_code without a props read. 'identical' = nothing to fix."
        },
        find_text: {
          type: "string",
          description: "Case-insensitive substring of TEXT content to search for under node_ids (or the current page). One line per match: #id \"layer\" «text» in <parent layer #id>, screen \"<top frame>\" (the parent is the frame to click or edit)."
        },
        offset: {
          type: "number",
          description: "Skip the first N lines of the outline / found list (use the K from a '… pass offset=K' line to read the next page)."
        },
        find: {
          type: "string",
          description: "Case-insensitive substring of node names to search for under node_ids (or the current page). Up to 8 matches come back with their subtree outline (as deep as fits, no extra read needed); more matches as one line each."
        },
        find_type: {
          type: "string",
          description: "Restrict find to one node type, e.g. FRAME, TEXT, INSTANCE."
        },
        limit: {
          type: "number",
          description: "Max find matches (default 30)."
        },
        check: {
          type: "object",
          description: "Expectations to verify: { \"12:34\": { \"width\": 320, \"fill\": \"#FFFFFF\", \"layout\": \"V gap8 pad16\" } }. Returns { pass, fail: [{ id, key, want, got }], missing }."
        },
        max_output_bytes: {
          type: "number",
          description: "Cap on the text response in UTF-8 bytes (default 3500; in clients that spill big outputs to a file, 0 and values above 3900 become 3900). A cut outline ends with '… pass offset=K': use `offset` to page instead of raising this."
        },
        target: {
          type: "string",
          description: "fileName of a specific connected Figma document, when more than one is open (see figma_list_targets)."
        }
      }
    }
  },
  {
    name: "figma_html",
    description: "WRITE tool: build a screen from ONE HTML (flex/grid -> Auto Layout, text, fills, shadows, svg). Pass `html` or `path` to a .html (no JS, <style> inside, Inter, flex+gap not margin, var(--token) -> variables, data-component -> instances, data-name = layer name; else warnings). Reply: ids, layers, instances, bound, absolute_fallback and text_wrapped (want 0), warnings. widths:[1440,390] = frame per width. Plugin window must be open.",
    inputSchema: {
      type: "object",
      properties: {
        html: {
          type: "string",
          description: "Full HTML document or fragment. Use `path` instead for big pages."
        },
        path: {
          type: "string",
          description: "Absolute or relative path of a local .html file on this machine (read by the server, up to 2 MB). Give either html or path."
        },
        width: {
          type: "number",
          description: "Viewport width in px the HTML is laid out at (default 1440, 100..8000). Media queries use it."
        },
        widths: {
          type: "array",
          items: { type: "number" },
          description: "Several viewport widths, e.g. [1440, 390]: one frame per width, placed side by side. Overrides width."
        },
        height: {
          type: "number",
          description: "Viewport height in px for 100vh rules (default 900). The frame is as tall as the page."
        },
        name: {
          type: "string",
          description: "Name of the root frame (default 'HTML'; with widths the width is appended)."
        },
        parent: {
          type: "string",
          description: "Id of a frame or section to build into (default: free space on the current page)."
        },
        x: { type: "number", description: "Canvas x of the root (default: free space)." },
        y: { type: "number", description: "Canvas y of the root (default: free space)." },
        capture: {
          type: "boolean",
          description: "Also return a PNG of the built frame."
        },
        max_output_bytes: {
          type: "number",
          description: "Cap on the text response in UTF-8 bytes (default 3500)."
        },
        target: {
          type: "string",
          description: "fileName of a specific connected Figma document when more than one is open (see figma_list_targets)."
        }
      }
    }
  },
  {
    name: "figma_screenshot",
    description: "Capture PNG screenshots of specific nodes or the current selection in Figma, to check layout, contrast, typography and spacing. Each image costs ~1k tokens at the default max_px, and stays in context: check mechanical things through write-call `warnings` or bridge.check first, and take one screenshot per finished stage rather than after every edit. Right after a figma_execute_code edit, put capture_node_ids on that call instead — this tool is then an extra turn.",
    inputSchema: {
      type: "object",
      properties: {
        node_ids: {
          type: "string",
          description: "Optional comma-separated list of Figma node IDs to screenshot (e.g. '123:456, 123:457'). If omitted, captures current selection or entire page."
        },
        scale: {
          type: "number",
          description: "Export resolution scale factor (default: 1)."
        },
        max_px: {
          type: "number",
          description: "Longest side of each image in px (default: 1024). Raise only to read fine detail; crop with node_ids instead where possible."
        },
        description: {
          type: "string",
          description: "Optional action description for Figma toast and logs."
        },
        target: {
          type: "string",
          description: "fileName of a specific connected Figma document, when more than one is open (see figma_list_targets)."
        }
      }
    }
  },
  {
    name: "figma_get_selection",
    description: "Get information and properties (dimensions, coordinates, text, fills, parent, page, AutoLayout context) of the currently selected nodes on the Figma canvas.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "fileName of a specific connected Figma document, when more than one is open (see figma_list_targets)."
        }
      }
    }
  },
  {
    name: "figma_create_ui_card",
    description: "Create a modern, professionally styled UI Card with badge/pill, bold title, subtitle, full-width action button, and AutoLayout in Figma. Automatically captures and returns a visual screenshot.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Card title (default: 'Figma AI Bridge')" },
        subtitle: { type: "string", description: "Card description or subtitle text" },
        badge_text: { type: "string", description: "Optional badge/pill label" },
        button_text: { type: "string", description: "Action button label" },
        bg_color: { type: "string", description: "Hex background color (default: '#F5F0FF')" },
        width: { type: "number", description: "Width in px (default: 400)" }
      }
    }
  },
];

module.exports = { TOOLS_CORE };
