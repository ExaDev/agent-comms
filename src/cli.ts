/**
 * The `agent-comms` executable: runs the command line against this process's own arguments and stdin. The dispatch itself lives in cli-main.ts, where a test can reach it without binding this machine's default ports.
 */

import { main } from "./cli-main.js";

// process.argv[0] is the node binary, [1] the script path, the rest the subcommand and its own args.
const SCRIPT_ARGS_START_INDEX = 2;

main({
  args: process.argv.slice(SCRIPT_ARGS_START_INDEX),
  stdinIsTerminal: process.stdin.isTTY,
});
