/**
 * Registers the service worker once the page has loaded. A module of its own, imported by main.tsx, because the page's content security policy allows no inline script.
 */

/** Registers `./sw.js` when the browser supports service workers; does nothing otherwise. */
export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("./sw.js");
  });
}
