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
import { authorise } from "../web-access.js";

const SOURCE_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const FRONTEND_ROOT = fileURLToPath(new URL("../frontend/", import.meta.url));
const DEFINING_FILE = fileURLToPath(
  new URL("../hosted-dashboard.ts", import.meta.url),
);

/** The address of a request from this machine, the only client the hosted dashboard is admitted from. */
const OWN_CLIENT = "127.0.0.1";
const POLICY = {
  token: undefined,
  bindHost: OWN_CLIENT,
  port: 41_234,
  localClientAddresses: () => new Set<string>(),
};

/** What the bridge decides about a cross-origin request carrying `origin`, from this machine. */
function decisionFor(origin: string): string {
  return authorise(POLICY, {
    method: "GET",
    url: "/",
    remoteAddress: OWN_CLIENT,
    headers: { host: `${OWN_CLIENT}:${String(POLICY.port)}`, origin },
  }).kind;
}

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

/** Every text file the frontend ships beside its code: the page, the manifest and any other. */
function shippedFrontendFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "test" ? [] : shippedFrontendFiles(file);
    }
    return /\.(html|json|webmanifest|css|svg|txt)$/u.test(entry.name)
      ? [file]
      : [];
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

it("is the one place a production source or a shipped frontend file names the hosted dashboard's host", () => {
  const host = new URL(HOSTED_DASHBOARD_ORIGIN).host;
  const files = [
    ...productionSources(SOURCE_ROOT),
    ...shippedFrontendFiles(FRONTEND_ROOT),
  ];

  const naming = files.filter(
    (file) =>
      file !== DEFINING_FILE && fs.readFileSync(file, "utf-8").includes(host),
  );

  expect(files).toContain(DEFINING_FILE);
  expect(files.some((file) => file.endsWith("index.html"))).toBe(true);
  expect(files.some((file) => file.endsWith("manifest.json"))).toBe(true);
  expect(naming.map((file) => path.relative(SOURCE_ROOT, file))).toEqual([]);
});

it("is the origin the bridge admits from this machine, and no other origin is", () => {
  expect(decisionFor(HOSTED_DASHBOARD_ORIGIN)).toBe("allow");
  expect(decisionFor("https://not-the-dashboard.example")).toBe("deny");
});
