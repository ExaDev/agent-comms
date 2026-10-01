/**
 * CommsTool's naming actions (agent-comms#345): setting, clearing and listing the viewer's petnames, and naming this machine. Split out of tool.ts to keep that file under the repo's max-lines cap, as gateway-trust-actions.ts is.
 */

import type { CommsAction } from "./types.js";
import type { CommsResult } from "./tool.js";
import { idWithNames, type Namer, type Naming } from "./naming.js";

/** The result for a bridge constructed without naming wired. */
function namingUnavailable(): CommsResult {
  return {
    content: "Naming is not available on this bridge.",
    isError: true,
  };
}

/** Labels action.device with the viewer's own petname. */
export function petnameSet(
  naming: Naming | undefined,
  action: CommsAction & { action: "petname_set" },
): CommsResult {
  if (naming === undefined) return namingUnavailable();
  const label = naming.setPetname(action.device, action.name);
  return {
    content: `You now call ${action.device} "${label}". Only you see this name.`,
    isError: false,
  };
}

/** Removes the viewer's petname for action.device. */
export function petnameClear(
  naming: Naming | undefined,
  action: CommsAction & { action: "petname_clear" },
): CommsResult {
  if (naming === undefined) return namingUnavailable();
  return {
    content: naming.clearPetname(action.device)
      ? `Cleared your name for ${action.device}.`
      : `You had no name for ${action.device}.`,
    isError: false,
  };
}

/** Every petname the viewer has set, each with its full id and the display name it now produces. */
export function petnameList(
  naming: Naming | undefined,
  namer: Namer,
): CommsResult {
  if (naming === undefined) return namingUnavailable();
  const petnames = [...naming.listPetnames().keys()];
  if (petnames.length === 0) {
    return { content: "You have not named anything.", isError: false };
  }
  return {
    content: `Your names:\n${petnames.map((id) => `  ${idWithNames(id, namer)}`).join("\n")}`,
    isError: false,
  };
}

/** Names this machine, or clears its name when action.name is omitted. */
export async function machineName(
  naming: Naming | undefined,
  action: CommsAction & { action: "machine_name" },
): Promise<CommsResult> {
  if (naming === undefined) return namingUnavailable();
  const name = await naming.setMachineName(action.name);
  return {
    content:
      name === undefined
        ? "This machine no longer asserts a name."
        : `This machine now calls itself "${name}"; peers see it as its own claim, beside any name they gave it.`,
    isError: false,
  };
}
