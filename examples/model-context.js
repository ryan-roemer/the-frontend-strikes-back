const { modelContext } = document;

// The page: register tools.
await modelContext.registerTool(/* ... */);

// An agent: find the tools, and call one.
const [tool] = await modelContext.getTools();
console.log(await modelContext.executeTool(tool, { query: "WebMCP" }));

// Either side: hear when the list changes.
modelContext.addEventListener("toolchange" /*,  ... */);
