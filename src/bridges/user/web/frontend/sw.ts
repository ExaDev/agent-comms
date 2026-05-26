/**
 * Service worker for the Agent Comms PWA.
 *
 * Handles push events from the browser push service and displays
 * notifications. On notification click, focuses or opens the PWA window.
 *
 * This file is built as a separate bundle (not part of the main app bundle)
 * because service workers run in a separate context with no DOM access.
 */

// ---------------------------------------------------------------------------
// Service worker environment types (minimal, self-contained)
// ---------------------------------------------------------------------------

interface PushMessageData {
  json(): Record<string, unknown>;
  text(): string;
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

interface Client {
  url: string;
  focus(): Promise<Client>;
}

interface Clients {
  matchAll(opts: {
    type: "window";
    includeUncontrolled: boolean;
  }): Promise<Client[]>;
  openWindow(url: string): Promise<Client>;
}

interface ServiceWorkerRegistration {
  showNotification(
    title: string,
    options?: NotificationOptions & { data?: Record<string, unknown> },
  ): Promise<void>;
}

interface ServiceWorkerGlobalScope {
  location: { origin: string };
  registration: ServiceWorkerRegistration;
  clients: Clients;
  addEventListener(
    type: "push",
    listener: (event: PushEvent) => void,
  ): void;
  addEventListener(
    type: "notificationclick",
    listener: (event: NotificationEvent) => void,
  ): void;
}

declare const self: ServiceWorkerGlobalScope;

// ---------------------------------------------------------------------------
// Push event handler
// ---------------------------------------------------------------------------

self.addEventListener("push", (event: PushEvent) => {
  let title = "Agent Comms";
  let body = "New message";

  if (event.data) {
    try {
      const data = event.data.json();
      if (typeof data["title"] === "string") title = data["title"];
      if (typeof data["body"] === "string") body = data["body"];
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

  const targetUrl =
    event.notification.data?.url ?? self.location.origin;

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList: Client[]) => {
        for (const client of clientList) {
          if (client.url === targetUrl && "focus" in client) {
            return client.focus();
          }
        }
        return self.clients.openWindow(targetUrl);
      }),
  );
});
