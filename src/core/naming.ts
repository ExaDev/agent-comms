/**
 * Naming (agent-comms#345): the viewer's petnames, the machine's own self display name, and the one namer every surface formats an id with. A MeshStore collaborator handed to CommsTool the way discovery is, so the tool's naming actions and every listing read through the same object.
 *
 * Nothing here is gossiped by this module. Petnames never leave the viewer's storage; the machine's name reaches peers only as the claim GroupProofs signs and puts in the advert.
 */

import {
  MAX_DISPLAY_NAME_LENGTH,
  formatDisplayName,
  parseDisplayName,
  type DisplayNameParts,
} from "./display-name.js";
import type { Petnames } from "./petnames.js";
import { CommsError } from "./store.js";

/** Formats one id by the display convention. selfName, when given, is the name the caller already knows the subject asserts (an agent's registered name); otherwise the namer supplies the one it knows, if any. */
export type Namer = (id: string, selfName?: string) => string;

/** The namer for a surface with no naming wired: no petnames and no known self names, only what the caller passes. */
export const plainNamer: Namer = (id, selfName) =>
  formatDisplayName({ id, selfName });

export interface NamingDeps {
  petnames: Petnames;
  /** Every machine's verified self display name, keyed by machine id. */
  machineNames: () => Promise<Map<string, string>>;
  /** The agents requesterId may see, whose registered names are their self-asserted names. */
  listAgents: (
    requesterId: string,
  ) => Promise<readonly Readonly<{ id: string; name: string }>[]>;
  /** Persists this machine's own name (undefined clears it) and re-signs its claim. */
  saveMachineName: (name: string | undefined) => Promise<void>;
}

export class Naming {
  constructor(private readonly deps: Readonly<NamingDeps>) {}

  /** Labels deviceHex as name in the viewer's own petnames. Throws INVALID_NAME for an unusable name. Returns the label as stored. */
  setPetname(deviceHex: string, name: string): string {
    return this.deps.petnames.set(deviceHex, name);
  }

  /** Removes the viewer's label for deviceHex. Returns whether there was one. */
  clearPetname(deviceHex: string): boolean {
    return this.deps.petnames.clear(deviceHex);
  }

  /** Every label the viewer has set, keyed by device-id. */
  listPetnames(): Map<string, string> {
    return this.deps.petnames.list();
  }

  /** Names this machine (undefined clears the name). Throws INVALID_NAME for an unusable name. Returns the name as stored. */
  async setMachineName(name: string | undefined): Promise<string | undefined> {
    if (name === undefined) {
      await this.deps.saveMachineName(undefined);
      return undefined;
    }
    const parsed = parseDisplayName(name);
    if (parsed === undefined) {
      throw new CommsError(
        `A machine name must be non-empty, at most ${String(MAX_DISPLAY_NAME_LENGTH)} characters, and free of control characters.`,
        "INVALID_NAME",
      );
    }
    await this.deps.saveMachineName(parsed);
    return parsed;
  }

  /** Every id requesterId has a name for, a petname or a known self name, with those names: the parts a surface outside this process (the dashboard) formats with formatDisplayName. */
  async nameParts(requesterId: string): Promise<DisplayNameParts[]> {
    const petnames = this.deps.petnames.list();
    const selfNames = await this.selfNames(requesterId);
    const ids = new Set([...petnames.keys(), ...selfNames.keys()]);
    return [...ids].map((id) => ({
      id,
      ...(petnames.has(id) ? { petname: petnames.get(id) } : {}),
      ...(selfNames.has(id) ? { selfName: selfNames.get(id) } : {}),
    }));
  }

  /** Every self-asserted name this store knows, keyed by device-id: verified machine names and the registered names of the agents requesterId may see. */
  private async selfNames(requesterId: string): Promise<Map<string, string>> {
    const names = await this.deps.machineNames();
    for (const agent of await this.deps.listAgents(requesterId)) {
      names.set(agent.id, agent.name);
    }
    return names;
  }

  /** The namer for requesterId's view right now: the viewer's petnames, then the self names this store knows, then the short id. */
  async namer(requesterId: string): Promise<Namer> {
    const petnames = this.deps.petnames.list();
    const selfNames = await this.selfNames(requesterId);
    return (id, selfName) => {
      const key = id.toLowerCase();
      return formatDisplayName({
        id,
        petname: petnames.get(key),
        selfName: selfName ?? selfNames.get(key),
      });
    };
  }
}
