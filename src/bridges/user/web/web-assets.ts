/**
 * The built web frontend the dashboard server serves: index.html, the JS bundle, the service worker, the mesh worker, the manifest and the PWA icons.
 *
 * These are build output (`build:frontend`), so a source checkout that was never built, such as a `pi install git:` clone whose install omits the development dependencies, does not have them. They are read on first use rather than when the server module is imported, so a missing frontend costs the routes that serve it and nothing else: the bridge still starts, and every API, WebSocket and mesh feature still works.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** The PWA icon files, all required alongside index.html. */
const ICON_FILENAMES = [
  "icon-96x96.svg",
  "icon-192x192.svg",
  "icon-512x512.svg",
] as const;

export interface FrontendAssets {
  indexHtml: string;
  bundleJs: string;
  /** Optional in the build: a placeholder stands in when it was not produced. */
  meshWorkerJs: string;
  swJs: string;
  manifestJson: string;
  icons: Readonly<Record<string, Buffer>>;
}

/** The frontend build output is absent from the directory it should be in. */
export class FrontendNotBuiltError extends Error {
  constructor(public readonly assetDir: string) {
    super(
      `The web frontend is not built: ${path.join(assetDir, "index.html")} is missing. A git checkout does not include the build output; install the npm package, or run \`pnpm build:frontend\` in a checkout with its development dependencies installed.`,
    );
    this.name = "FrontendNotBuiltError";
  }
}

function readIfPresent(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Reads the frontend build output from `assetDir` into memory. Throws FrontendNotBuiltError when `index.html` is absent, the marker that the build never ran; any other filesystem error, including a missing required file beside a present `index.html`, propagates, since that is a partial build and not an unbuilt checkout.
 */
export function loadFrontendAssets(assetDir: string): FrontendAssets {
  const indexHtml = readIfPresent(path.join(assetDir, "index.html"));
  if (indexHtml === undefined) throw new FrontendNotBuiltError(assetDir);

  const icons: Record<string, Buffer> = {};
  for (const filename of ICON_FILENAMES) {
    icons[filename] = fs.readFileSync(path.join(assetDir, "icons", filename));
  }

  return {
    indexHtml,
    bundleJs: fs.readFileSync(path.join(assetDir, "bundle.js"), "utf-8"),
    meshWorkerJs:
      readIfPresent(path.join(assetDir, "mesh-worker.js")) ??
      "/* mesh-worker not built */",
    swJs: fs.readFileSync(path.join(assetDir, "sw.js"), "utf-8"),
    manifestJson: fs.readFileSync(
      path.join(assetDir, "manifest.json"),
      "utf-8",
    ),
    icons,
  };
}

/**
 * A loader over `assetDir` that reads the build output on first call and returns the same assets afterwards. A failed load is not remembered, so a build that finishes while the server runs is picked up by the next request.
 */
export function createFrontendAssetLoader(
  assetDir: string,
): () => FrontendAssets {
  let loaded: FrontendAssets | undefined;
  return () => {
    loaded ??= loadFrontendAssets(assetDir);
    return loaded;
  };
}
