/**
 * The dashboard page as the hosted deployment serves it: from a static host, with no bridge behind the page. A page navigation is answered by the network while the host is reachable, so a cached page cannot mask a redirect; the page's content security policy holds in a real browser; and the page loads nothing from another host.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import type * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures.js";

const DIST = fileURLToPath(new URL("../dist", import.meta.url));
const HTTP_OK = 200;
const HTTP_FOUND = 302;
const HTTP_NOT_FOUND = 404;

/** How long the inline-script probe waits for a script the policy should have refused. */
const REFUSED_SCRIPT_WAIT_MS = 100;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

/** A static host serving the built dashboard, whose answer for the page can be changed while it runs. */
interface StaticHost {
  readonly origin: string;
  /** Replaces the page's HTML, or restores the built one with undefined. */
  setPage: (html: string | undefined) => void;
  /** Answers the page with a redirect to `location`, or stops redirecting with undefined. */
  redirectPageTo: (location: string | undefined) => void;
  /** Closes every connection at once instead of answering, as an unreachable host does. */
  goOffline: () => void;
  close: () => Promise<void>;
}

function readDistFile(pathname: string): Buffer | undefined {
  const file = path.join(DIST, path.normalize(pathname));
  if (!file.startsWith(DIST)) return undefined;
  try {
    return fs.readFileSync(file);
  } catch {
    return undefined;
  }
}

async function startStaticHost(): Promise<StaticHost> {
  let page: string | undefined;
  let redirect: string | undefined;
  let offline = false;
  const sockets = new Set<net.Socket>();
  const server = http.createServer((request, response) => {
    if (offline) {
      request.socket.destroy();
      return;
    }
    const pathname = new URL(request.url ?? "/", "http://host").pathname;
    const isPage = pathname === "/" || pathname === "/index.html";
    if (isPage && redirect !== undefined) {
      response.writeHead(HTTP_FOUND, { Location: redirect });
      response.end();
      return;
    }
    const body =
      isPage && page !== undefined
        ? page
        : readDistFile(pathname === "/" ? "/index.html" : pathname);
    if (body === undefined) {
      response.writeHead(HTTP_NOT_FOUND);
      response.end();
      return;
    }
    response.writeHead(HTTP_OK, {
      "Content-Type":
        CONTENT_TYPES[path.extname(pathname)] ??
        CONTENT_TYPES[".html"] ??
        "text/plain",
      "Cache-Control": "no-store",
    });
    response.end(body);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    setPage: (html) => {
      page = html;
    },
    redirectPageTo: (location) => {
      redirect = location;
    },
    goOffline: () => {
      offline = true;
      for (const socket of sockets) socket.destroy();
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

/** Records every policy violation the page reports, from before its own scripts run. */
async function recordViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.defineProperty(window, "__policyViolations", { value: seen });
    document.addEventListener("securitypolicyviolation", (event) => {
      seen.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return async () =>
    page.evaluate(
      () =>
        (window as unknown as { __policyViolations: string[] })
          .__policyViolations,
    );
}

/** Loads `url` and waits until the page has rendered and registered its service worker, the point by which it has made every request it makes at load. The page keeps trying to reach a bridge afterwards, so the network never goes idle and is not waited on. */
async function loadPage(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.locator("#root")).not.toBeEmpty();
  await page.evaluate(async () => navigator.serviceWorker.ready);
}

/** Waits until a service worker controls the page, reloading once if the first load was not controlled. */
async function untilControlled(page: Page): Promise<void> {
  await page.evaluate(async () => navigator.serviceWorker.ready);
  const controlled = async (): Promise<boolean> =>
    page.evaluate(() => navigator.serviceWorker.controller !== null);
  if (!(await controlled())) await page.reload();
  await expect.poll(controlled).toBe(true);
}

test.describe("the dashboard page served by a bridge", () => {
  test("loads with no policy violation and requests nothing from another host", async ({
    page,
    port,
  }) => {
    const violations = await recordViolations(page);
    const hosts = new Set<string>();
    page.on("request", (request) => {
      hosts.add(new URL(request.url()).host);
    });

    await loadPage(page, `http://127.0.0.1:${String(port)}`);

    expect(await violations()).toEqual([]);
    expect([...hosts]).toEqual([`127.0.0.1:${String(port)}`]);
  });

  test("a script the page did not ship is refused by the policy", async ({
    page,
    port,
  }) => {
    const violations = await recordViolations(page);
    await page.goto(`http://127.0.0.1:${String(port)}`);

    const ran = await page.evaluate(async (waitMs) => {
      const probe = window as unknown as { __inlineRan: boolean };
      probe.__inlineRan = false;
      const script = document.createElement("script");
      script.textContent = "window.__inlineRan = true;";
      document.head.appendChild(script);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, waitMs);
      });
      return probe.__inlineRan;
    }, REFUSED_SCRIPT_WAIT_MS);

    expect(ran).toBe(false);
    expect((await violations()).some((v) => v.startsWith("script-src"))).toBe(
      true,
    );
  });
});

test.describe("the dashboard page served by a static host", () => {
  let host: StaticHost;

  test.beforeEach(async () => {
    host = await startStaticHost();
  });

  test.afterEach(async () => {
    await host.close();
  });

  test("answers a navigation from the network while the host is reachable", async ({
    page,
  }) => {
    await page.goto(`${host.origin}/`);
    await untilControlled(page);
    expect(await page.title()).toBe("Agent Comms");

    host.setPage("<!doctype html><title>Served by the host now</title>");
    await page.goto(`${host.origin}/`);

    expect(await page.title()).toBe("Served by the host now");
  });

  test("follows a redirect the host answers, which a cached page would mask", async ({
    page,
  }) => {
    const moved = await startStaticHost();
    try {
      moved.setPage("<!doctype html><title>Moved</title>");
      await page.goto(`${host.origin}/`);
      await untilControlled(page);

      host.redirectPageTo(`${moved.origin}/`);
      await page.goto(`${host.origin}/`);

      expect(page.url()).toBe(`${moved.origin}/`);
      expect(await page.title()).toBe("Moved");
    } finally {
      await moved.close();
    }
  });

  test("falls back to the cached page when the host is unreachable", async ({
    page,
  }) => {
    await page.goto(`${host.origin}/`);
    await untilControlled(page);

    host.goOffline();
    await page.goto(`${host.origin}/`);

    expect(await page.title()).toBe("Agent Comms");
  });

  test("falls back to the cached page for an address it has never loaded when the host is unreachable", async ({
    page,
  }) => {
    await page.goto(`${host.origin}/`);
    await untilControlled(page);

    host.goOffline();
    await page.goto(`${host.origin}/?room=never-loaded`);

    expect(await page.title()).toBe("Agent Comms");
  });

  test("keeps the app shell in a cache named for this version and drops the old one", async ({
    page,
  }) => {
    // Only on the first load of the tab: the script runs again on every navigation, which would put the old cache back after the new worker had removed it.
    await page.addInitScript(() => {
      if (sessionStorage.getItem("old-cache-made") !== null) return;
      sessionStorage.setItem("old-cache-made", "yes");
      void caches.open("agent-comms-v1");
    });
    await page.goto(`${host.origin}/`);
    await untilControlled(page);

    await expect
      .poll(async () => page.evaluate(async () => caches.keys()))
      .toEqual(["agent-comms-v2"]);
  });

  test("loads with no policy violation and requests nothing from another host", async ({
    page,
  }) => {
    const violations = await recordViolations(page);
    const hosts = new Set<string>();
    page.on("request", (request) => {
      const url = new URL(request.url());
      // The page looks for a bridge on this machine's loopback ports, which the policy allows.
      if (url.hostname !== "127.0.0.1") hosts.add(url.host);
    });

    await loadPage(page, `${host.origin}/`);

    expect(await violations()).toEqual([]);
    expect([...hosts]).toEqual([]);
  });
});
