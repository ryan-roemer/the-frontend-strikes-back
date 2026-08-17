/**
 * The deck's URL flags, read the same way everywhere.
 *
 * `?chat`, `?tools`, `?mcp` and `?dump` all mean the same thing in the same way, and all
 * four had their own copy of this: the same try/catch around `URLSearchParams`, the same
 * `null | "" | "true" | "1"` acceptance list, written out three times in
 * `chat/state.js`, `chat/tools/state.js` and `chat/mcp/index.js`.
 *
 * BARE `?chat` COUNTS, which is the whole reason the acceptance list is not just
 * `=== "true"`. A flag you have to remember the value of is a flag you will get wrong at
 * the podium, and these are all typed into a URL bar minutes before walking on stage.
 *
 * Every read is guarded: a `URLSearchParams` constructor can throw on an exotic URL, and
 * a deck that fails to load because a query string upset it is the worst possible trade
 * for a feature flag.
 */

const params = () => {
  try {
    return new URLSearchParams(location.search);
  } catch {
    return new URLSearchParams("");
  }
};

/** Is `?name` set, bare or with an affirmative value? */
export const flag = (name) => {
  const search = params();
  if (!search.has(name)) return false;
  const value = search.get(name);
  return value === null || value === "" || value === "true" || value === "1";
};

/** The value of `?name=…`, or null. For the flags that also carry an argument. */
export const param = (name) => params().get(name) || null;
