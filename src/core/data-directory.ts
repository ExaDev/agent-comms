import * as os from "node:os";
import * as path from "node:path";

/** The environment default for the mesh's persistent keys, trust and ledgers. */
export const DATA_DIR_ENV_VAR = "AGENT_COMMS_DATA_DIR";

export interface DataDirectoryLocation {
  /** Absolute base directory for all persistent mesh data, including the shared account and machine keys. Overrides the environment default and any legacy slot-only dir. */
  dataDir?: string;
}

/** Explicit directory first, then the environment setting, then the existing home-directory default. Blank environment values are treated as unset. Non-absolute directories are rejected. */
export function resolveDataDir({
  dir,
  env = process.env,
}: Readonly<{
  dir?: string | undefined;
  env?: Readonly<Record<string, string | undefined>>;
}> = {}): string {
  const configured = env[DATA_DIR_ENV_VAR]?.trim();
  const resolved =
    dir ??
    (configured !== undefined && configured !== ""
      ? configured
      : path.join(os.homedir(), ".agent-comms"));
  if (!path.isAbsolute(resolved)) {
    throw new Error(
      `${DATA_DIR_ENV_VAR} or explicit dir must be an absolute path`,
    );
  }
  return resolved;
}
