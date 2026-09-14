/**
 * Service worker for the Agent Comms PWA.
 *
 * Handles push events from the browser push service and displays
 * notifications. On notification click, focuses or opens the PWA window.
 *
 * Also provides offline caching:
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

interface PushMessageData {
  json: () => Record<string, unknown>;
  text: () => string;
}

interface PushEvent extends ExtendableEvent {
  readonly data: PushMessageData | null;
}

interface NotificationEvent extends ExtendableEvent {
  readonly notification: Notification & {
    data: Record<string, unknown> | undefined;
  };
  readonly action: string;
}

interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith: (response: Readonly<Promise<Response>>) => void;
}

interface Client {
  url: string;
  focus: () => Promise<Client>;
}

interface Clients {
  matchAll: (
    opts: Readonly<{
      type: "window";
      includeUncontrolled: boolean;
    }>,
  ) => Promise<Client[]>;
  openWindow: (url: string) => Promise<Client>;
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

interface ServiceWorkerRegistration {
  showNotification: (
    title: string,
    options?: NotificationOptions & { data?: Record<string, unknown> },
  ) => Promise<void>;
}

interface ServiceWorkerGlobalScope {
  location: { origin: string };
  registration: ServiceWorkerRegistration;
  clients: Clients;
  caches: CacheStorage;
  addEventListener: ((
    type: "push",
    listener: (event: PushEvent) => void,
  ) => void) &
    ((
      type: "notificationclick",
      listener: (event: NotificationEvent) => void,
    ) => void) &
    ((
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

const APP_SHELL = [
  "./",
  "./bundle.js",
  "./sw.js",
  "./manifest.json",
  "./icons/icon-96x96.svg",
  "./icons/icon-192x192.svg",
  "./icons/icon-512x512.svg",
];

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

// ---------------------------------------------------------------------------
// Push event handler
// ---------------------------------------------------------------------------

self.addEventListener("push", (event: PushEvent) => {
  let title = "Agent Comms";
  let body = "New message";

  if (event.data) {
    try {
      const data = event.data.json();
      if (typeof data.title === "string") title = data.title;
      if (typeof data.body === "string") body = data.body;
    } catch {
      const text = event.data.text();
      if (text) body = text;
    }
  }

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      data: {
        url: self.location.origin,
      },
    }),
  );
});

// ---------------------------------------------------------------------------
// Notification click handler
// ---------------------------------------------------------------------------

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();

  const notificationData: unknown = event.notification.data;
  const targetUrl =
    typeof notificationData === "object" &&
    notificationData !== null &&
    "url" in notificationData &&
    typeof notificationData.url === "string"
      ? notificationData.url
      : self.location.origin;

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (clientList: readonly Client[]) => {
        for (const client of clientList) {
          if (client.url === targetUrl && "focus" in client) {
            return client.focus();
          }
        }
        return self.clients.openWindow(targetUrl);
      }),
  );
});
