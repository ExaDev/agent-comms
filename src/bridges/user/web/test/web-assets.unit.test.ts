/**
 * Unit tests for reading the frontend build output on demand.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createFrontendAssetLoader,
  FrontendNotBuiltError,
  loadFrontendAssets,
} from "../web-assets.js";
import { scratchDirectory } from "../../../../test/scratch-directory.helper.js";

const ICON_FILENAMES = [
  "icon-96x96.svg",
  "icon-192x192.svg",
  "icon-512x512.svg",
];

let assetDir: string;

beforeEach(() => {
  assetDir = scratchDirectory("web-assets-");
});

afterEach(() => {
  fs.rmSync(assetDir, { recursive: true, force: true });
});

function writeBuild(options: Readonly<{ meshWorker: boolean }>): void {
  fs.mkdirSync(path.join(assetDir, "icons"), { recursive: true });
  fs.writeFileSync(path.join(assetDir, "index.html"), "<html>index</html>");
  fs.writeFileSync(path.join(assetDir, "bundle.js"), "bundle();");
  fs.writeFileSync(path.join(assetDir, "sw.js"), "sw();");
  fs.writeFileSync(path.join(assetDir, "manifest.json"), '{"name":"x"}');
  if (options.meshWorker) {
    fs.writeFileSync(path.join(assetDir, "mesh-worker.js"), "worker();");
  }
  for (const filename of ICON_FILENAMES) {
    fs.writeFileSync(
      path.join(assetDir, "icons", filename),
      `<svg ${filename}/>`,
    );
  }
}

describe("loadFrontendAssets", () => {
  it("reads every asset of a complete build", () => {
    writeBuild({ meshWorker: true });

    const assets = loadFrontendAssets(assetDir);

    expect(assets.indexHtml).toBe("<html>index</html>");
    expect(assets.bundleJs).toBe("bundle();");
    expect(assets.meshWorkerJs).toBe("worker();");
    expect(assets.swJs).toBe("sw();");
    expect(assets.manifestJson).toBe('{"name":"x"}');
    expect(Object.keys(assets.icons).sort()).toEqual(
      [...ICON_FILENAMES].sort(),
    );
    expect(assets.icons["icon-96x96.svg"]?.toString()).toBe(
      "<svg icon-96x96.svg/>",
    );
  });

  it("stands a placeholder in for the optional mesh worker", () => {
    writeBuild({ meshWorker: false });

    expect(loadFrontendAssets(assetDir).meshWorkerJs).toBe(
      "/* mesh-worker not built */",
    );
  });

  it("reports an unbuilt checkout, naming the missing index.html", () => {
    const error = (() => {
      try {
        loadFrontendAssets(path.join(assetDir, "never-built"));
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(FrontendNotBuiltError);
    expect((error as FrontendNotBuiltError).message).toContain(
      path.join(assetDir, "never-built", "index.html"),
    );
  });

  it("does not mistake a partial build for an unbuilt checkout", () => {
    writeBuild({ meshWorker: true });
    fs.rmSync(path.join(assetDir, "bundle.js"));

    expect(() => loadFrontendAssets(assetDir)).toThrow(/ENOENT/);
    expect(() => loadFrontendAssets(assetDir)).not.toThrow(
      FrontendNotBuiltError,
    );
  });
});

describe("createFrontendAssetLoader", () => {
  it("reads nothing until it is first called", () => {
    const load = createFrontendAssetLoader(path.join(assetDir, "never-built"));

    expect(typeof load).toBe("function");
  });

  it("returns the same assets after the first read, even if the files change", () => {
    writeBuild({ meshWorker: true });
    const load = createFrontendAssetLoader(assetDir);

    const first = load();
    fs.writeFileSync(path.join(assetDir, "index.html"), "<html>changed</html>");

    expect(load()).toBe(first);
    expect(load().indexHtml).toBe("<html>index</html>");
  });

  it("does not remember a failed load, so a build finishing later is picked up", () => {
    const load = createFrontendAssetLoader(assetDir);
    expect(() => load()).toThrow(FrontendNotBuiltError);

    writeBuild({ meshWorker: true });

    expect(load().indexHtml).toBe("<html>index</html>");
  });
});
