document.modelContext.registerTool({
  name: "search_documents",
  description: "Search the user's documents and return matching excerpts.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural language query." },
    },
    required: ["query"],
  },
  execute: ({ query }) => window.app.searchDocuments(query),
});
