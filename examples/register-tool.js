// TODO: The smallest possible WebMCP tool registration.
navigator.modelContext.registerTool({
  name: "search_documents",
  description: "Search the user's documents and return matching excerpts.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to search for" },
    },
    required: ["query"],
  },
  async execute({ query }) {
    // TODO: Call the same function the UI's search box already calls.
    const results = await window.app.searchDocuments(query);

    return {
      content: [{ type: "text", text: JSON.stringify(results) }],
    };
  },
});
