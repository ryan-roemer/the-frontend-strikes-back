document.modelContext.registerTool({
  name: "search_documents",
  description: "Search documents and return matching excerpts.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural language query." },
    },
    required: ["query"],
  },
  // Use any existing app code, context, auth, prefs. Can update UI too.
  execute: ({ query }) => window.app.searchDocuments(query),
});
