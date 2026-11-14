/**
 * Service worker for the Agent Comms PWA.
 *
 * Provides offline caching:
 * - Install: pre-caches the app shell (HTML, JS, manifest, icons).
 * - Fetch:  network-first for page navigations and API calls, cache-first for static assets.
 * - Activate: removes old caches when the SW version changes.
 *
 * This file is built as a separate bundle (not part of the main app bundle)
 * because service workers run in a separate context with no DOM access.
 */

// ---------------------------------------------------------------------------
// Service worker environment types (minimal, self-contained)
// ---------------------------------------------------------------------------

interface ExtendableEvent extends Event {
  waitUntil: (promise: Readonly<Promise<unknown>>) => void;
}

interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith: (response: Readonly<Promise<Response>>) => void;
}

interface CacheStorage {
  open: (name: string) => Promise<Cache>;
  delete: (name: string) => Promise<boolean>;
  keys: () => Promise<string[]>;
}

interface Cache {
  addAll: (requests: readonly string[]) => Promise<void>;
  match: (request: Request | string) => Promise<Response | undefined>;
  put: (request: Request | string, response: Response) => Promise<void>;
}

/** One entry of the precache manifest vite-plugin-pwa injects at build time, replacing the literal string `self.__WB_MANIFEST` in this file's compiled output with an array literal. */
interface PrecacheEntry {
  url: string;
  revision: string | null;
}

interface ServiceWorkerGlobalScope {
  location: { href: string };
  caches: CacheStorage;
  __WB_MANIFEST: PrecacheEntry[];
  addEventListener: ((
    type: "install" | "activate",
    listener: (event: ExtendableEvent) => void,
  ) => void) &
    ((type: "fetch", listener: (event: FetchEvent) => void) => void);
  skipWaiting: () => Promise<void>;
}

declare const self: ServiceWorkerGlobalScope;

// ---------------------------------------------------------------------------
// Cache versioning — bump to invalidate old caches on deploy
// ---------------------------------------------------------------------------

const CACHE_NAME = "agent-comms-v2";

/** The app shell to precache, derived from vite-plugin-pwa's own build-time scan of dist/ -- this is what closes the previous gap where mesh-worker.js, built as a separate non-hashed bundle outside Vite's own module graph, was never in the hand-maintained list. */
const APP_SHELL = self.__WB_MANIFEST.map((entry) => entry.url);

// ---------------------------------------------------------------------------
// Install — pre-cache the app shell
// ---------------------------------------------------------------------------

self.addEventListener("install", (event: ExtendableEvent) => {
  event.waitUntil(
    self.caches
      .open(CACHE_NAME)
      .then(async (cache) => cache.addAll(APP_SHELL))
      .then(async () => self.skipWaiting()),
  );
});

// ---------------------------------------------------------------------------
// Activate — remove this application's old caches
// ---------------------------------------------------------------------------

/** The prefix of every cache this application has created. Cache Storage belongs to the origin, not to a worker, so on an origin shared with other applications a cache of another name may be theirs: only names under this prefix are this application's to delete. */
const CACHE_PREFIX = "agent-comms-";

self.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(
    self.caches
      .keys()
      .then(async (names) =>
        Promise.all(
          names
            .filter(
              (name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME,
            )
            .map(async (name) => self.caches.delete(name)),
        ),
      ),
  );
});

// ---------------------------------------------------------------------------
// Fetch: network-first for page navigations and API calls, cache-first for everything else
// ---------------------------------------------------------------------------

/** Lower bound (inclusive) of the HTTP success status range worth caching. */
const HTTP_STATUS_OK_MIN = 200;

/** Upper bound (exclusive) of the HTTP success status range worth caching. */
const HTTP_STATUS_OK_MAX_EXCLUSIVE = 300;

/** True for a GET response whose status falls in the cacheable success range. */
function isCacheableGetResponse(
  request: Readonly<Request>,
  response: Readonly<Response>,
): boolean {
  return (
    request.method === "GET" &&
    response.status >= HTTP_STATUS_OK_MIN &&
    response.status < HTTP_STATUS_OK_MAX_EXCLUSIVE
  );
}

/** Whether a navigation response is the application's own page, the only thing a navigation may leave in the cache: a success from the host itself, as HTML. A captive portal's or a proxy's page answers 200 too, and is not the application's. */
function isApplicationPage(response: Readonly<Response>): boolean {
  return (
    response.type === "basic" &&
    response.status >= HTTP_STATUS_OK_MIN &&
    response.status < HTTP_STATUS_OK_MAX_EXCLUSIVE &&
    (response.headers.get("content-type") ?? "").startsWith("text/html")
  );
}

/** The lowest status that means the host (or a proxy in front of it) failed to serve the page, not that the page is gone or moved: a navigation answered this way is served from the cached application page when one exists. */
const HTTP_SERVER_ERROR_MIN = 500;

/** The cache key of the application's page, which every navigation falls back to when the network is unreachable. It is one key whatever the address a navigation asked for, so a query (a room, a directory) neither makes an entry of its own nor leaves its text in a key. */
const OFFLINE_PAGE = new URL("index.html", self.location.href).href;

self.addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);

  // Page navigations: network-first, so the page always comes from the host while it is reachable. A cached page must never answer in the host's place: it would mask a redirect (the site moving to another origin) and keep serving a dashboard the host no longer serves. The cache is only the offline fallback.
  if (event.request.mode === "navigate") {
    event.respondWith(
      // "no-cache" revalidates with the host whatever the page's own freshness says, so a page the host's cache headers call fresh cannot mask a redirect.
      fetch(event.request, { cache: "no-cache" })
        .then((response) => {
          if (event.request.method === "GET" && isApplicationPage(response)) {
            const cloned = response.clone();
            void self.caches
              .open(CACHE_NAME)
              .then(async (cache) => cache.put(OFFLINE_PAGE, cloned));
          }
          return response;
        })
        .then(async (response) => {
          // A server error is a reachable host that cannot serve the page right now (a proxy's 522, a 502): the cached application page stands in when there is one, and the error is returned as it is when there is not. It is never cached, and a redirect or any other answer is the host's own and is always returned.
          if (response.status < HTTP_SERVER_ERROR_MIN) return response;
          const cache = await self.caches.open(CACHE_NAME);
          return (await cache.match(OFFLINE_PAGE)) ?? response;
        })
        .catch(async () =>
          self.caches
            .open(CACHE_NAME)
            .then(async (cache) => cache.match(OFFLINE_PAGE))
            .then(
              (cached) => cached ?? new Response("Offline", { status: 503 }),
            ),
        ),
    );
    return;
  }

  // API calls: network-first so stale data doesn't linger
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Only cache successful GET responses
          if (isCacheableGetResponse(event.request, response)) {
            const cloned = response.clone();
            void self.caches
              .open(CACHE_NAME)
              .then(async (cache) => cache.put(event.request, cloned));
          }
          return response;
        })
        .catch(async () =>
          self.caches
            .open(CACHE_NAME)
            .then(async (cache) => cache.match(event.request))
            .then(
              (cached) => cached ?? new Response("Offline", { status: 503 }),
            ),
        ),
    );
    return;
  }

  // Static assets: cache-first
  event.respondWith(
    self.caches
      .open(CACHE_NAME)
      .then(async (cache) => cache.match(event.request))
      .then(async (cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          // Cache successful GET responses for future offline use
          if (isCacheableGetResponse(event.request, response)) {
            const cloned = response.clone();
            void self.caches
              .open(CACHE_NAME)
              .then(async (cache) => cache.put(event.request, cloned));
          }
          return response;
        });
      }),
  );
});
