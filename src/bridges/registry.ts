import * as claudeCode from "./claude-code/channel.js";
import * as codex from "./codex/tool.js";
import * as mcp from "./mcp/server.js";
import * as ccPeer from "./cc-peer/run.js";
import type { BridgeRunOptions } from "../core/index.js";

export interface Bridge {
  /** Starts the bridge. Only a test passes options; a real launch runs it bare. */
  run: (options?: Readonly<BridgeRunOptions>) => void | Promise<void>;
}

export const bridges: Record<string, Bridge> = {
  "claude-code": claudeCode,
  codex,
  mcp,
  "cc-peer": ccPeer,
};
