/**
 * Resolves what a bare `agent-comms` (no subcommand) should do from how it was started (agent-comms#339).
 *
 * A terminal on stdin means a person ran it, so it stays the setup tool. A stdin that is not a terminal means a harness launched it and is about to speak MCP over it, so it serves the generic `mcp` bridge, which makes the package name alone a valid MCP server command. Any explicit subcommand is returned untouched, so `setup`, `status`, `remove` and `bridge <id>` keep their meaning.
 */
export function resolveDefaultCommand(
  args: readonly string[],
  stdinIsTerminal: boolean,
): readonly string[] {
  if (args.length > 0 || stdinIsTerminal) return args;
  return ["bridge", "mcp"];
}
