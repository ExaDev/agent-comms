import * as os from "node:os";
import * as path from "node:path";

/** The environment default for the mesh's persistent keys, trust and ledgers. */
export const DATA_DIR_ENV_VAR = "AGENT_COMMS_DATA_DIR";

export interface DataDirectoryLocation {
  /** Base directory for all persistent mesh data, including the shared account and machine keys. Overrides the environment default and any legacy slot-only dir. */
  dataDir?: string;
}

/** Explicit directory first, then the environment setting, then the existing home-directory default. Blank environment values are treated as unset. */
export function resolveDataDir({
  dir,
  env = process.env,
}: Readonly<{
  dir?: string | undefined;
  env?: Readonly<Record<string, string | undefined>>;
}> = {}): string {
  const configured = env[DATA_DIR_ENV_VAR]?.trim();
  if (dir !== undefined) return dir;
  if (configured !== undefined && configured !== "") return configured;
  return path.join(os.homedir(), ".agent-comms");
}
