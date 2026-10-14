document.modelContext.registerTool({
  name: "search_documents",
  description:
    "Search the company knowledge base. Use for any question about our docs or expertise.",
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
