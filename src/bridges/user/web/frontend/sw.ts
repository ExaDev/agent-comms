/**
 * Service worker for the Agent Comms PWA.
 *
 * Provides offline caching:
 * - Install: pre-caches the app shell (HTML, JS, manifest, icons).
 * - Fetch:  network-first for API calls, cache-first for static assets.
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
  match: (request: Request) => Promise<Response | undefined>;
  put: (request: Request, response: Response) => Promise<void>;
}

/** One entry of the precache manifest vite-plugin-pwa injects at build time, replacing the literal string `self.__WB_MANIFEST` in this file's compiled output with an array literal. */
interface PrecacheEntry {
  url: string;
  revision: string | null;
}

interface ServiceWorkerGlobalScope {
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

const CACHE_NAME = "agent-comms-v1";

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
// Activate — remove old caches
// ---------------------------------------------------------------------------

self.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(
    self.caches
      .keys()
      .then(async (names) =>
        Promise.all(
          names
            .filter((name) => name !== CACHE_NAME)
            .map(async (name) => self.caches.delete(name)),
        ),
      ),
  );
});

// ---------------------------------------------------------------------------
// Fetch — network-first for API, cache-first for everything else
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

self.addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);

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
