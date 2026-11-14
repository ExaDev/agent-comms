/**
 * Where the hosted dashboard is served from. One definition, imported by everything that names the hosted origin: the bridge's admission of it (web-access.ts) and the tests that stand in for it.
 *
 * The origin is the unit a browser keeps storage apart by, so it is also the line between the dashboard and every other page that shares a host with it.
 */

/** The origin of the dashboard deployed to GitHub Pages. It discovers a bridge's server by probing loopback ports and then opens its `/ws/mesh` socket cross-origin, so its Origin is admitted from a client on this machine; every other foreign origin is refused. */
export const HOSTED_DASHBOARD_ORIGIN = "https://exadev.github.io";

/** The address a person opens to reach the hosted dashboard: its origin and the path its site is published under. */
export const HOSTED_DASHBOARD_URL = `${HOSTED_DASHBOARD_ORIGIN}/agent-comms/`;
