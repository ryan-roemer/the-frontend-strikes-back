document.modelContext.registerTool({
  name: "search_documents",
  description: "Search the user's documents and return matching excerpts.",
  // The schema is the contract, and descriptions are prompt engineering.
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural language query." },
      sortBy: { type: "string", enum: ["relevance", "newest", "oldest"] },
    },
    required: ["query"],
  },
  // Hook into exposed functionality in your frontend app.
  execute: async (args) => window.app.searchDocuments(args),
});
