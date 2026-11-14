import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = new URL("../../scripts/package-contents.ts", import.meta.url)
  .pathname;
const TSX = new URL("../../node_modules/.bin/tsx", import.meta.url).pathname;

function check(paths: readonly string[]): {
  status: number | null;
  output: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "package-contents-"));
  try {
    const listing = join(directory, "listing.json");
    writeFileSync(listing, JSON.stringify(paths));
    const result = spawnSync(TSX, [SCRIPT, "--listing", listing], {
      encoding: "utf8",
    });

    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(directory, { recursive: true });
  }
}

describe("the package contents check", () => {
  const runtime = [
    "package.json",
    "dist/cli.js",
    "dist/core/tool.js",
    "dist/core/tool.d.ts",
    "src/core/tool.ts",
    "dist/bridges/user/web/dist/bundle.js",
    "dist/bridges/user/web/dist/index.html",
  ];

  it("accepts a listing of runtime files only", () => {
    expect(check(runtime).status).toBe(0);
  });

  it.each([
    "dist/test/mesh-smoke.runner.js",
    "dist/core/test/bridge.unit.test.js",
    "dist/bridges/user/web/test/x.js",
    "dist/core/something.test.d.ts",
    "dist/test/test-transport.js",
    "src/bridges/user/web/test/bridge-web-server.helper.ts",
    "dist/test/delivery-receipt.helper.js",
    "dist/bridges/user/web/frontend/main.js",
    "dist/bridges/user/web/frontend/components/chat-area.d.ts.map",
    "dist/bridges/user/web/vite.config.js",
    "dist/bridges/user/web/vite.config.d.ts",
    "src/bridges/user/web/vite.config.ts",
    "dist/test/scratch-directory.setup.js",
  ])("refuses %s", (path) => {
    const result = check([...runtime, path]);
    expect(result.status).toBe(1);
    expect(result.output).toContain(path);
  });

  it("refuses an empty listing instead of passing it", () => {
    expect(check([]).status).not.toBe(0);
  });
});
