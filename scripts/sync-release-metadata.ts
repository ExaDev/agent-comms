import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function parseJsonObject(text: string, label: string): JsonObject {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return parsed;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function stringifyJson(value: JsonObject): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const root = process.cwd();
const packagePath = path.join(root, "package.json");
const pluginPath = path.join(root, ".claude-plugin/plugin.json");
const marketplacePath = path.join(root, ".claude-plugin/marketplace.json");
const serverPath = path.join(root, "server.json");
const readmePath = path.join(root, "README.md");

const packageObject = parseJsonObject(
  await readFile(packagePath, "utf8"),
  "package.json",
);
const pluginObject = parseJsonObject(
  await readFile(pluginPath, "utf8"),
  ".claude-plugin/plugin.json",
);
const marketplaceObject = parseJsonObject(
  await readFile(marketplacePath, "utf8"),
  ".claude-plugin/marketplace.json",
);
const serverObject = parseJsonObject(
  await readFile(serverPath, "utf8"),
  "server.json",
);

const packageVersion = requireString(
  packageObject.version,
  "package.json version",
);
const mcpName = requireString(packageObject.mcpName, "package.json mcpName");
const packageName = requireString(packageObject.name, "package.json name");
const serverName = requireString(serverObject.name, "server.json name");
const serverVersion = requireString(
  serverObject.version,
  "server.json version",
);
const pluginVersion = requireString(
  pluginObject.version,
  ".claude-plugin/plugin.json version",
);

// marketplace.json contains a `plugins` array — find the entry whose name
// matches package.json `name` and bump its version. Throw if the plugin
// isn't declared at all, since that would silently leave the manifest stale.
const marketplacePluginsValue = marketplaceObject.plugins;
if (!isUnknownArray(marketplacePluginsValue)) {
  throw new Error(
    ".claude-plugin/marketplace.json must declare a plugins array",
  );
}
const marketplacePluginEntry = marketplacePluginsValue.find(
  (entry): entry is JsonObject => isRecord(entry) && entry.name === packageName,
);
if (!marketplacePluginEntry) {
  throw new Error(
    `.claude-plugin/marketplace.json has no plugin entry named "${packageName}"`,
  );
}
const marketplacePluginVersion = requireString(
  marketplacePluginEntry.version,
  `.claude-plugin/marketplace.json plugins[name=${packageName}].version`,
);

if (serverName !== mcpName) {
  throw new Error(
    `server.json name (${serverName}) must match package.json mcpName (${mcpName})`,
  );
}

const packagesValue = serverObject.packages;
if (!isUnknownArray(packagesValue) || packagesValue.length !== 1) {
  throw new Error("server.json must define exactly one package entry");
}

const packageEntryValue = packagesValue[0];
if (!isRecord(packageEntryValue)) {
  throw new Error("server.json package entry must be an object");
}

const registryType = requireString(
  packageEntryValue.registryType,
  "server.json package entry registryType",
);
const identifier = requireString(
  packageEntryValue.identifier,
  "server.json package entry identifier",
);

if (registryType !== "npm") {
  throw new Error('server.json package entry must use registryType="npm"');
}

if (identifier !== packageName) {
  throw new Error(
    `server.json package identifier (${identifier}) must match package.json name (${packageName})`,
  );
}

serverObject.version = packageVersion;
packageEntryValue.version = packageVersion;
pluginObject.version = packageVersion;
marketplacePluginEntry.version = packageVersion;

const readmeContent = await readFile(readmePath, "utf8");
const updatedReadme = readmeContent
  .replaceAll(/version-(\d+\.\d+\.\d+)-blue/g, `version-${packageVersion}-blue`)
  .replaceAll(
    /releases\/tag\/v\d+\.\d+\.\d+/g,
    `releases/tag/v${packageVersion}`,
  );

const needsServerWrite = serverVersion !== packageVersion;
const needsPluginWrite = pluginVersion !== packageVersion;
const needsMarketplaceWrite = marketplacePluginVersion !== packageVersion;
const needsReadmeWrite = readmeContent !== updatedReadme;

if (needsServerWrite) {
  await writeFile(serverPath, stringifyJson(serverObject));
}
if (needsPluginWrite) {
  await writeFile(pluginPath, stringifyJson(pluginObject));
}
if (needsMarketplaceWrite) {
  await writeFile(marketplacePath, stringifyJson(marketplaceObject));
}
if (needsReadmeWrite) {
  await writeFile(readmePath, updatedReadme);
}
