import * as claudeCode from "./claude-code/channel.js";
import * as codex from "./codex/tool.js";
import * as mcp from "./mcp/index.js";

export interface Bridge {
  run: () => void | Promise<void>;
}

export const bridges: Record<string, Bridge> = {
  "claude-code": claudeCode,
  codex,
  mcp,
};
