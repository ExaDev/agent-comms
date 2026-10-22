// Decides whether a version is already listed on the MCP registry, kept here rather than in scripts/publish-mcp-registry.ts for the same reason as mcp-registry-retry.ts: a test under src/test/ cannot import from scripts/. The registry publish runs as its own CI job after the release and is re-run by hand after an outage, so it must skip a version the registry already lists, because publishing one again fails the job.
const REGISTRY_BASE_URL = "https://registry.modelcontextprotocol.io";
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;

/** The registry's endpoint for one version of one server. The name carries a `/` (`io.github.<owner>/<repo>`) that must stay inside a single path segment. */
export function registryVersionUrl(name: string, version: string): string {
  return `${REGISTRY_BASE_URL}/v0/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;
}

/** Reads the status of a {@link registryVersionUrl} response: 200 means listed, 404 means not listed. Any other status says nothing about whether the version is listed, so it throws and fails the job to be re-run, never guessing either way. */
export function isPublishedOnRegistry(status: number): boolean {
  if (status === HTTP_OK) return true;
  if (status === HTTP_NOT_FOUND) return false;
  throw new Error(
    `MCP registry answered ${String(status)} when asked whether the version is listed`,
  );
}
