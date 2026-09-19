/**
 * Default sink for a mesh store's error channel. MeshStore.onError carries every failure the mesh handles internally (a hub dial that was refused, a gossip send that failed, a default-front session that could not attach), and nothing shows them unless a bridge assigns a handler, so a bridge without a UI of its own routes them to stderr.
 */

/** The single line a mesh error is reported as. */
export function formatMeshError(error: Readonly<Error>): string {
  return `agent-comms: ${error.message}\n`;
}

/** Builds the handler a bridge assigns to `store.onError`, writing each error to `write` as one line. `write` defaults to the process's stderr, which stdio bridges keep clear of protocol traffic. Returns the handler rather than assigning it, so the caller does the assignment itself, like wireDefaultCcPeerFront does for onCoordinatorRoleChanged. */
export function createMeshErrorReporter(
  write: (line: string) => void = (line) => {
    process.stderr.write(line);
  },
): (error: Error) => void {
  return (error) => {
    write(formatMeshError(error));
  };
}
