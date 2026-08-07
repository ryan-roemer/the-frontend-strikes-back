// TODO: The payoff -- the handler reuses what the app already has.
// Session auth, user preferences, and business logic all come for free
// because this runs *inside* the page the user is already signed in to.
export const execute = async ({ query, limit = 5, sortBy = "relevance" }) => {
  const { session, preferences, documents } = window.app.getState();

  if (!session) {
    return {
      isError: true,
      content: [{ type: "text", text: "Not signed in." }],
    };
  }

  // TODO: Same search the human UI uses -- no duplicate backend.
  const results = await documents.search({
    query,
    limit,
    sortBy,
    locale: preferences.locale,
  });

  // TODO: Keep the UI in sync so the human sees what the agent did.
  window.app.setSearchResults(results);

  return {
    content: results.map((doc) => ({
      type: "text",
      text: `${doc.title}\n${doc.excerpt}`,
    })),
  };
};
