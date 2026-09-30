/**
 * Whether the page was served by a bridge's own web server, in which case the mesh socket is on the page's own origin. The alternative is a standalone deployment (GitHub Pages, the hosted mesh instance), which has no bridge at its own origin and probes localhost instead.
 *
 * Loopback origins are always a bridge. A plain `http:` origin is one too, whatever its host: a bridge reached over the LAN (agent-comms#346) is served over plain http, while every standalone deployment is https, which also could not dial a plain ws socket on its own origin anyway.
 */

const LOOPBACK_HOST_PATTERN = /^(localhost|127\.\d+\.\d+\.\d+)(:\d+)?$/;

export function isServedByBridge(location: {
  readonly host: string;
  readonly protocol: string;
}): boolean {
  return (
    LOOPBACK_HOST_PATTERN.test(location.host) || location.protocol === "http:"
  );
}
