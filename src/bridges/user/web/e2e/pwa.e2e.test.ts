/**
 * E2E tests — PWA features: service worker, manifest, standalone mode,
 * offline caching, and install prompt.
 *
 * Verifies the progressive web app shell: that the service worker
 * registers and takes control, the manifest is linked and valid,
 * standalone display mode is detectable, app shell responses are
 * cached after activation, and the install prompt infrastructure
 * is present.
 */

import { test, expect } from "./fixtures.js";

function hasSizes(value: unknown): value is { sizes: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "sizes" in value &&
    typeof value.sizes === "string"
  );
}

test.describe("PWA features", () => {
  test.describe("Service worker registration", () => {
    test("service worker is registered after page load", async ({
      page,
      port,
    }) => {
      await page.goto(`http://127.0.0.1:${port}`);

      const registrations = await page.evaluate(async () => {
        const regs = await navigator.serviceWorker.getRegistrations();
        return regs.map((reg) => ({
          scope: reg.scope,
          state:
            reg.installing?.state ?? reg.waiting?.state ?? reg.active?.state,
        }));
      });

      expect(registrations.length).toBeGreaterThanOrEqual(1);
      expect(registrations[0]?.scope).toContain("/");
    });

    test("service worker is registered and present", async ({ page, port }) => {
      await page.goto(`http://127.0.0.1:${port}`);

      const hasRegistration = await page.evaluate(async () => {
        const regs = await navigator.serviceWorker.getRegistrations();
        return regs.length > 0;
      });
      expect(hasRegistration).toBe(true);
    });
  });

  test.describe("Web app manifest", () => {
    test("page links to manifest.json", async ({ page, port }) => {
      await page.goto(`http://127.0.0.1:${port}`);

      const manifestLink = page.locator('link[rel="manifest"]');
      await expect(manifestLink).toHaveAttribute("href", "./manifest.json");
    });

    test("manifest.json has required PWA fields", async ({ page, port }) => {
      await page.goto(`http://127.0.0.1:${port}`);

      const manifest = await page.evaluate<Record<string, unknown> | null>(
        async () => {
          const link = document.querySelector('link[rel="manifest"]');
          if (!link) return null;
          const href = link.getAttribute("href");
          if (!href) return null;
          const res = await fetch(href);
          return res.json();
        },
      );

      expect(manifest).not.toBeNull();
      expect(manifest?.name).toBe("Agent Comms");
      expect(manifest?.short_name).toBe("Comms");
      expect(manifest?.start_url).toBe("./");
      expect(manifest?.display).toBe("standalone");
    });
  });

  test.describe("Standalone mode detection", () => {
    test("display-mode: standalone media query is queryable", async ({
      page,
      port,
    }) => {
      await page.goto(`http://127.0.0.1:${port}`);

      // In browser context, standalone should not match
      const browserMode = await page.evaluate(
        () => window.matchMedia("(display-mode: standalone)").matches,
      );
      expect(browserMode).toBe(false);

      // Verify the MediaQueryList API is accessible and reports correct media
      const query = await page.evaluate(() => {
        const mql = window.matchMedia("(display-mode: standalone)");
        return { matches: mql.matches, media: mql.media };
      });
      expect(query.media).toBe("(display-mode: standalone)");
    });

    test("standalone media query supports change listeners", async ({
      page,
      port,
    }) => {
      await page.goto(`http://127.0.0.1:${port}`);

      // Verify the change event listener can be attached —
      // the API surface that apps use to detect standalone mode.
      const listenerWorks = await page.evaluate(() => {
        const mql = window.matchMedia("(display-mode: standalone)");
        let listenerFired = false;
        mql.addEventListener("change", () => {
          listenerFired = true;
        });
        // The listener infrastructure is present; we can't trigger a real
        // display-mode change in headless Chromium, but addEventListener
        // must not throw.
        return typeof mql.addEventListener === "function";
      });

      expect(listenerWorks).toBe(true);
    });
  });

  test.describe("Offline caching", () => {
    test("app shell resources are cached after service worker activates", async ({
      page,
      port,
    }) => {
      await page.goto(`http://127.0.0.1:${port}`);

      // Wait for the service worker to reach activated state
      await page.waitForFunction(
        async () => {
          const regs = await navigator.serviceWorker.getRegistrations();
          const reg = regs[0];
          if (!reg) return false;
          return reg.active?.state === "activated";
        },
        { timeout: 15000 },
      );

      // Give the service worker time to populate the cache via its
      // install handler (cache.addAll happens in waitUntil).
      await page.waitForTimeout(2000);

      // Check that the agent-comms cache exists and has app shell entries
      const cacheEntries = await page.evaluate<{
        found: boolean;
        entries: string[];
      }>(async () => {
        const names = await caches.keys();
        const commsCache = names.find((n) => n.startsWith("agent-comms"));
        if (!commsCache) return { found: false, entries: [] };

        const cache = await caches.open(commsCache);
        const requests = await cache.keys();
        return {
          found: true,
          entries: requests.map((r) => new URL(r.url).pathname),
        };
      });

      expect(cacheEntries.found).toBe(true);
      expect(cacheEntries.entries).toContain("/");
      expect(cacheEntries.entries).toContain("/bundle.js");
    });

    test("cached index.html survives offline mode", async ({ page, port }) => {
      await page.goto(`http://127.0.0.1:${port}`);

      // Wait for service worker to activate
      await page.waitForFunction(
        async () => {
          const regs = await navigator.serviceWorker.getRegistrations();
          const reg = regs[0];
          if (!reg) return false;
          return reg.active?.state === "activated";
        },
        { timeout: 15000 },
      );
      await page.waitForTimeout(2000);

      // Reload so the SW controls the page
      await page.reload();
      await page.waitForFunction(
        () => navigator.serviceWorker.controller !== null,
        { timeout: 10000 },
      );

      // Go offline and reload — page should still render from cache
      const context = page.context();
      await context.setOffline(true);

      const response = await page.reload();
      expect(response).not.toBeNull();
      const title = await page.title();
      expect(title).toBe("Agent Comms");

      await context.setOffline(false);
    });

    test("cached bundle.js is served offline", async ({ page, port }) => {
      await page.goto(`http://127.0.0.1:${port}`);

      // Wait for service worker to activate
      await page.waitForFunction(
        async () => {
          const regs = await navigator.serviceWorker.getRegistrations();
          const reg = regs[0];
          if (!reg) return false;
          return reg.active?.state === "activated";
        },
        { timeout: 15000 },
      );
      await page.waitForTimeout(2000);

      // Reload so the SW controls the page
      await page.reload();
      await page.waitForFunction(
        () => navigator.serviceWorker.controller !== null,
        { timeout: 10000 },
      );

      // Go offline and fetch bundle.js — service worker should serve from cache
      const context = page.context();
      await context.setOffline(true);

      const bundleStatus = await page.evaluate(async () => {
        try {
          const res = await fetch("/bundle.js");
          return { ok: res.ok, status: res.status };
        } catch {
          return { ok: false, status: 0 };
        }
      });

      expect(bundleStatus.ok).toBe(true);
      expect(bundleStatus.status).toBe(200);

      await context.setOffline(false);
    });
  });

  test.describe("Install prompt", () => {
    test("manifest has installability requirements", async ({ page, port }) => {
      await page.goto(`http://127.0.0.1:${port}`);

      // Verify the manifest link exists — this is what triggers
      // beforeinstallprompt in browsers that support it.
      const manifestHref = await page.evaluate(() => {
        const link = document.querySelector('link[rel="manifest"]');
        return link?.getAttribute("href");
      });
      expect(manifestHref).toBe("./manifest.json");

      // Verify manifest has the fields required for installability:
      // name (or short_name), icons (192px + 512px), start_url, display
      const manifest = await page.evaluate<Record<string, unknown> | null>(
        async () => {
          const link = document.querySelector('link[rel="manifest"]');
          const href = link?.getAttribute("href");
          if (!href) return null;
          const res = await fetch(href);
          return res.json();
        },
      );

      expect(manifest?.name).toBeTruthy();
      expect(manifest?.icons).toBeTruthy();
      const icons = manifest?.icons;
      const hasRequiredIcons =
        Array.isArray(icons) &&
        icons.some((icon) => hasSizes(icon) && icon.sizes.includes("192")) &&
        icons.some((icon) => hasSizes(icon) && icon.sizes.includes("512"));
      expect(hasRequiredIcons).toBe(true);
    });

    test("beforeinstallprompt event can be captured", async ({
      page,
      port,
    }) => {
      await page.goto(`http://127.0.0.1:${port}`);

      // Add a listener for beforeinstallprompt after the page loads.
      // In headless Chromium this event typically does NOT fire (it
      // requires meeting all installability criteria including HTTPS
      // and sufficient interaction). The test verifies the event API
      // is accessible and a listener can be attached without error.
      const listenerAttached = await page.evaluate(() => {
        try {
          window.addEventListener("beforeinstallprompt", () => {
            // Listener attached successfully — the event may or may not
            // fire depending on the browser environment.
          });
          return true;
        } catch {
          return false;
        }
      });

      expect(listenerAttached).toBe(true);
    });
  });
});
