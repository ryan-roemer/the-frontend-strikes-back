// TODO: Schemas are the contract. Descriptions are prompt engineering.
export const searchDocumentsSchema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Natural language search query.",
    },
    limit: {
      type: "integer",
      description: "Maximum number of documents to return.",
      minimum: 1,
      maximum: 25,
      default: 5,
    },
    // TODO: Constrain the agent with enums instead of free text.
    sortBy: {
      type: "string",
      enum: ["relevance", "newest", "oldest"],
      default: "relevance",
    },
  },
  required: ["query"],
  additionalProperties: false,
};
