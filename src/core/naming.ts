/**
 * Naming (agent-comms#345): the viewer's petnames, the machine's and the account's own self display names, and the one namer every surface formats an id with. A MeshStore collaborator handed to CommsTool the way discovery is, so the tool's naming actions and every listing read through the same object.
 *
 * Nothing here is gossiped by this module. Petnames never leave the viewer's storage; the machine's and the account's names reach peers only as the claims GroupProofs signs and puts in the advert.
 */

import {
  formatDisplayName,
  formatNames,
  type DisplayNameParts,
} from "./display-name.js";
import type { Petnames } from "./petnames.js";
import { requireDisplayName } from "./store.js";

export interface NameOptions {
  /** The name the caller already knows the subject asserts (an agent's registered name); otherwise the namer supplies the one it knows, if any. */
  selfName?: string | undefined;
  /** The surface prints the full id beside the name, so the short id is left out (formatNames rather than formatDisplayName), and an id with no name gives the empty string. */
  besideFullId?: boolean | undefined;
}

/** Formats one id by the display convention. */
export type Namer = (id: string, options?: Readonly<NameOptions>) => string;

/** Formats parts by options: formatNames beside a full id, formatDisplayName otherwise. */
function formatFor(
  parts: Readonly<DisplayNameParts>,
  options: Readonly<NameOptions> | undefined,
): string {
  return options?.besideFullId === true
    ? formatNames(parts)
    : formatDisplayName(parts);
}

/** The namer for a surface with no naming wired: no petnames and no known self names, only what the caller passes. */
export const plainNamer: Namer = (id, options) =>
  formatFor({ id, selfName: options?.selfName }, options);

/** id followed by its names, the form every listing whose entries are acted on by full id prints: two spaces between them, and the id alone when it has no name. */
export function idWithNames(id: string, namer: Namer): string {
  const names = namer(id, { besideFullId: true });
  return names === "" ? id : `${id}  ${names}`;
}

export interface NamingDeps {
  petnames: Petnames;
  /** Every machine's and user principal's verified self display name, keyed by issuer id. */
  issuerNames: () => Promise<Map<string, string>>;
  /** The agents requesterId may see, whose registered names are their self-asserted names. */
  listAgents: (
    requesterId: string,
  ) => Promise<readonly Readonly<{ id: string; name: string }>[]>;
  /** Persists this machine's own name (undefined clears it) and re-signs its claim. */
  saveMachineName: (name: string | undefined) => Promise<void>;
  /** Persists this account's own name (undefined clears it) and re-signs its claim. */
  saveUserName: (name: string | undefined) => Promise<void>;
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
    const parsed = requireDisplayName(name, "A machine name");
    await this.deps.saveMachineName(parsed);
    return parsed;
  }

  /** Names this account (undefined clears the name). Throws INVALID_NAME for an unusable name. Returns the name as stored. */
  async setPrincipalName(
    name: string | undefined,
  ): Promise<string | undefined> {
    if (name === undefined) {
      await this.deps.saveUserName(undefined);
      return undefined;
    }
    const parsed = requireDisplayName(name, "An account name");
    await this.deps.saveUserName(parsed);
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

  /** Every self-asserted name this store knows, keyed by device-id: verified machine and principal names and the registered names of the agents requesterId may see. */
  private async selfNames(requesterId: string): Promise<Map<string, string>> {
    const names = await this.deps.issuerNames();
    for (const agent of await this.deps.listAgents(requesterId)) {
      names.set(agent.id, agent.name);
    }
    return names;
  }

  /** The namer for requesterId's view right now: the viewer's petnames, then the self names this store knows, then the short id. */
  async namer(requesterId: string): Promise<Namer> {
    const petnames = this.deps.petnames.list();
    const selfNames = await this.selfNames(requesterId);
    return (id, options) => {
      const key = id.toLowerCase();
      return formatFor(
        {
          id,
          petname: petnames.get(key),
          selfName: options?.selfName ?? selfNames.get(key),
        },
        options,
      );
    };
  }
}
