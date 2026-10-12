const text = (s) => ({ type: "text", text: s });

// Runs *inside* the page the user is signed in to, with auth and prefs.
export const execute = async (args) => {
  const { session, prefs, documents } = window.app.getState();
  if (!session) return { isError: true, content: [text("Not signed in.")] };

  // Reuse the frontend code the app already uses.
  const results = await documents.search({ ...args, locale: prefs.locale });
  // Optional: sync the app UI.
  window.app.setSearchResults(results);
  return { content: results.map((d) => text(d.title)) };
};
