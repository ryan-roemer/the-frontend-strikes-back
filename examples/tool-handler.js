const text = (s) => ({ type: "text", text: s });

// Session auth, preferences, and business logic come free: this runs *inside*
// the page the user is already signed in to.
export const execute = async (args) => {
  const { session, prefs, documents } = window.app.getState();
  if (!session) return { isError: true, content: [text("Not signed in.")] };

  // The same search the human UI already uses -- no duplicate backend.
  const results = await documents.search({ ...args, locale: prefs.locale });

  // Keep the UI in sync, so the human sees what the agent did.
  window.app.setSearchResults(results);
  return { content: results.map((d) => text(d.title)) };
};
