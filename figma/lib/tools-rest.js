const TOOLS_REST = [
  // 2. Figma REST API Tools (Cloud)
  {
    name: "get_me",
    description: "Verify authenticated user and token validity via Figma Cloud REST API.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "get_file",
    description: "Get full document metadata and token-optimized layer hierarchy of a Figma file by URL or file key. Automatically prunes noise and converts to semantic Pseudo-JSX/Tree format to save 85%+ tokens.",
    inputSchema: {
      type: "object",
      properties: {
        file_key: { type: "string", description: "Figma file key or complete Figma file/design URL" },
        depth: { type: "number", description: "Hierarchy depth (default: 2)" },
        format: {
          type: "string",
          enum: ["jsx", "tree", "json", "raw"],
          description: "Output format: 'jsx' (clean semantic Pseudo-JSX, default), 'tree' (indented text tree), 'json' (pruned JSON), or 'raw' (unmodified raw Figma API response)"
        },
        simplify: { type: "boolean", description: "Whether to apply token pruning and vector collapsing (default: true)" },
        include_hidden: { type: "boolean", description: "Whether to include hidden layers (default: false)" },
        max_depth: { type: "number", description: "Hard cap on tree traversal depth before nodes are truncated (default: 25)" },
        budget_tokens: { type: "number", description: "Target response size in tokens. If set (and simplify is not false), depth is reduced and re-serialized until the output fits, with a trailing comment noting the reduction." }
      },
      required: ["file_key"]
    }
  },
  {
    name: "get_node",
    description: "Get token-optimized node/component design data for specific nodes in a Figma file. Automatically prunes AST noise, collapses vector icons, and returns clean Pseudo-JSX/Tree format (saves 85%+ tokens).",
    inputSchema: {
      type: "object",
      properties: {
        file_key: { type: "string", description: "Figma file key or complete Figma URL" },
        node_ids: { type: "string", description: "Comma-separated list of node IDs (e.g. '1234:5678') or encoded from URL" },
        depth: { type: "number", description: "Subtree depth (default: 3)" },
        format: {
          type: "string",
          enum: ["jsx", "tree", "json", "raw"],
          description: "Output format: 'jsx' (clean semantic Pseudo-JSX, default), 'tree' (indented text tree), 'json' (pruned JSON), or 'raw' (unmodified raw Figma API response)"
        },
        simplify: { type: "boolean", description: "Whether to apply token pruning and vector collapsing (default: true)" },
        include_hidden: { type: "boolean", description: "Whether to include hidden layers (default: false)" },
        max_depth: { type: "number", description: "Hard cap on tree traversal depth before nodes are truncated (default: 25)" },
        budget_tokens: { type: "number", description: "Target response size in tokens. If set (and simplify is not false), depth is reduced and re-serialized until the output fits, with a trailing comment noting the reduction." }
      },
      required: ["file_key"]
    }
  },
  {
    name: "get_image",
    description: "Render and export nodes to image URLs (PNG, SVG, JPG, PDF) via Figma Cloud API.",
    inputSchema: {
      type: "object",
      properties: {
        file_key: { type: "string", description: "Figma file key or complete Figma URL" },
        node_ids: { type: "string", description: "Comma-separated node IDs to render" },
        format: { type: "string", enum: ["png", "jpg", "svg", "pdf"], description: "Image format (default: png)" },
        scale: { type: "number", description: "Image scale factor 1 to 4 (default: 2)" }
      },
      required: ["file_key"]
    }
  },
  {
    name: "get_image_fills",
    description: "Get download URLs for all images used as fills in a Figma file.",
    inputSchema: {
      type: "object",
      properties: {
        file_key: { type: "string", description: "Figma file key or complete Figma URL" }
      },
      required: ["file_key"]
    }
  },
  {
    name: "get_styles",
    description: "Get all color, text, and effect styles defined in a Figma file.",
    inputSchema: {
      type: "object",
      properties: {
        file_key: { type: "string", description: "Figma file key or complete Figma URL" }
      },
      required: ["file_key"]
    }
  },
  {
    name: "get_components",
    description: "Get all components and component sets in a Figma file.",
    inputSchema: {
      type: "object",
      properties: {
        file_key: { type: "string", description: "Figma file key or complete Figma URL" }
      },
      required: ["file_key"]
    }
  },
  {
    name: "get_comments",
    description: "List all comments and threads on a Figma file.",
    inputSchema: {
      type: "object",
      properties: {
        file_key: { type: "string", description: "Figma file key or complete Figma URL" }
      },
      required: ["file_key"]
    }
  },
  {
    name: "post_comment",
    description: "Post a comment or reply to a Figma file or specific node.",
    inputSchema: {
      type: "object",
      properties: {
        file_key: { type: "string", description: "Figma file key or complete Figma URL" },
        message: { type: "string", description: "Comment message text" },
        node_id: { type: "string", description: "Optional target node ID" }
      },
      required: ["file_key", "message"]
    }
  }
];

module.exports = { TOOLS_REST };
