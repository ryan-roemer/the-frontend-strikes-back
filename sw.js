/**
 * Offline mode: answer requests to CDN hosts from `offline/`, when there is a copy.
 *
 * OPT-IN PER PAGE LOAD, WITH `?offline`. The snippet in `index.html`'s <head> registers
 * this worker only on localhost and only when the URL has the flag, and this worker only
 * answers for pages that were opened with it. A page opened without the flag is left
 * alone even if the worker is still installed from an earlier session, so it loads
 * exactly as it would with no worker at all. `?offline=false` unregisters it. GitHub
 * Pages publishes this file, but nothing registers it there.
 *
 * See `docs/offline.md` for the commands and `docs/handoffs/offline-handoff.md` §2 for
 * why this is a service worker and not a second import map.
 *
 * `offline/manifest.json` maps each URL to a file under `offline/files/`. It is written by
 * `npm run offline:fetch` and is gitignored. A URL that is not in the manifest goes to the
 * network, so a stale or missing `offline/` directory means "online as usual", not a
 * broken deck.
 */

const MANIFEST = new URL("offline/manifest.json", self.registration.scope);

/** The same values `chat/url.js` `flag()` accepts: `?offline`, `=true`, `=1`. */
const isOffline = (href) => {
  const value = new URL(href).searchParams.get("offline");
  return value === "" || value === "true" || value === "1";
};

/**
 * The manifest, once it has loaded. `null` while a load is in flight.
 *
 * KEPT SYNCHRONOUSLY READABLE so the fetch handler can decide on the spot to leave a
 * request alone. A request the handler does not answer goes to the network untouched,
 * which is more faithful than re-issuing it with `fetch(request)`.
 */
let entries = null;
let loading = null;

const loadManifest = () => {
  entries = null;
  loading = fetch(MANIFEST, { cache: "no-store" })
    .then((res) => (res.ok ? res.json() : {}))
    .catch(() => ({}))
    .then((json) => (entries = json));
  return loading;
};

loadManifest();

/**
 * Whether each page (by client id) was opened with `?offline`.
 *
 * Recorded from the navigation request, so the answer is known before the page's
 * first subresource arrives. The browser can stop and restart this worker while a page
 * is open, which empties the map. A page it doesn't know is then looked up by its
 * current URL. Spectacle keeps extra query params when it changes slides, so the flag
 * is still there.
 */
const pages = new Map();

const pageIsOffline = async (clientId) => {
  if (!pages.has(clientId)) {
    const client = clientId ? await self.clients.get(clientId) : null;
    pages.set(clientId, Boolean(client && isOffline(client.url)));
  }
  return pages.get(clientId);
};

// Take over straight away. The first load after registering is then controlled from
// the moment this activates, so its lazy requests (chat, wasm, backgrounds) already
// come from disk.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);

/**
 * The local copy of one URL.
 *
 * A NEW `Response`, NEVER THE ONE `fetch()` RETURNED FOR THE LOCAL FILE. A module's base
 * URL is its response URL. A constructed response has none, so the browser uses the
 * request URL (jsDelivr) instead, and the bundles' root-relative `/npm/…` imports and the
 * Phosphor CSS's relative font paths keep resolving against the CDN. Passing the local
 * response through would make every module's base URL localhost.
 *
 * The body is piped, not buffered: the LiteRT wasm files are 20–35 MB each.
 */
const answer = async (request, clientId) => {
  if (!(await pageIsOffline(clientId))) return fetch(request);

  const entry = (await loading)[request.url];
  if (!entry) return fetch(request);

  const local = await fetch(new URL(entry.file, MANIFEST)).catch(() => null);
  if (!local?.ok) return fetch(request);

  return new Response(local.body, {
    headers: {
      "content-type": entry.type,
      "content-length": String(entry.bytes),
    },
  });
};

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (request.mode === "navigate") {
      pages.set(event.resultingClientId, isOffline(request.url));
      // Re-read the manifest on every page load, so `offline:fetch` takes effect on
      // the next reload rather than whenever the browser next restarts this worker.
      loadManifest();
    }
    return;
  }

  if (request.method !== "GET") return;
  // Decided without waiting whenever possible, so a request this worker has no
  // business with never goes through it.
  const known = pages.get(event.clientId);
  if (known === false) return;
  if (known && entries && !entries[request.url]) return;
  event.respondWith(answer(request, event.clientId));
});
