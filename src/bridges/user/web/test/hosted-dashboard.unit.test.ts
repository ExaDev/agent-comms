/**
 * The hosted dashboard's origin is defined once: no production source names the host the dashboard is served from except `hosted-dashboard.ts`, so moving the dashboard is a change to one file.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  HOSTED_DASHBOARD_ORIGIN,
  HOSTED_DASHBOARD_URL,
} from "../hosted-dashboard.js";

const SOURCE_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const DEFINING_FILE = fileURLToPath(
  new URL("../hosted-dashboard.ts", import.meta.url),
);

/** Whether a path under src is test code or test support, which names hosts as data. */
function isTestFile(file: string): boolean {
  return (
    /\.(test|spec)\.tsx?$/u.test(file) ||
    file.endsWith(".helper.ts") ||
    file.split(path.sep).some((part) => part === "test" || part === "e2e")
  );
}

function productionSources(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionSources(file);
    return /\.tsx?$/u.test(entry.name) && !isTestFile(file) ? [file] : [];
  });
}

it("is an https origin with no path, and the page's address lies under it", () => {
  const origin = new URL(HOSTED_DASHBOARD_ORIGIN);

  expect(origin.protocol).toBe("https:");
  expect(origin.origin).toBe(HOSTED_DASHBOARD_ORIGIN);
  expect(HOSTED_DASHBOARD_URL.startsWith(`${HOSTED_DASHBOARD_ORIGIN}/`)).toBe(
    true,
  );
  expect(new URL(HOSTED_DASHBOARD_URL).origin).toBe(HOSTED_DASHBOARD_ORIGIN);
});

it("is the one place a production source names the hosted dashboard's host", () => {
  const host = new URL(HOSTED_DASHBOARD_ORIGIN).host;
  const sources = productionSources(SOURCE_ROOT);

  const naming = sources.filter(
    (file) =>
      file !== DEFINING_FILE && fs.readFileSync(file, "utf-8").includes(host),
  );

  expect(sources).toContain(DEFINING_FILE);
  expect(naming.map((file) => path.relative(SOURCE_ROOT, file))).toEqual([]);
});
