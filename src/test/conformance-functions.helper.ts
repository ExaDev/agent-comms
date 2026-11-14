/**
 * The call table the TypeScript conformance runner (`conformance.unit.test.ts`) resolves a corpus case's `function` and `schema` names in. Each entry narrows its JSON arguments, builds any object the function takes that JSON cannot carry (a Set, a Map, a callback), calls the function and returns plain data. A case never names anything but a pure function of its arguments.
 */
import {
  AGENT_SELF_GOSSIP_KEY,
  DEFAULT_PRESENCE_STALE_AFTER_MS,
  HOSTED_ROOMS_GOSSIP_KEY,
  PRESENCE_GOSSIP_KEY,
  PRESENCE_READVERTISE_INTERVAL_MS,
  hostedRoomAdverts,
  summariseAgentSelfAdvert,
  summariseHostedRooms,
} from "../core/gossip-extensions.js";
import {
  inviterAgentExtension,
  parseInviterAgentExtension,
  parseRoomStateExtension,
  roomStateExtension,
} from "../core/room-wire-extensions.js";
import type * as os from "node:os";
import {
  buildAction,
  formatDeliveryEvent,
  isActionableEvent,
  MCP_TOOL_PARAMS,
} from "../core/bridge.js";
import { retryOnAddrInUse } from "../core/bind-retry.js";
import { isClaudeCodeComm } from "../bridges/claude-code/claudeCommand.js";
import { resolveDefaultCommand } from "../core/default-command.js";
import { resolveDelegationsRemaining } from "../core/delegation-policy.js";
import {
  formatDisplayName,
  formatNames,
  parseDisplayName,
  shortId,
} from "../core/display-name.js";
import { agentTable } from "../core/agent-table.js";
import {
  createMeshErrorReporter,
  describeMeshError,
  formatMeshError,
} from "../core/error-reporting.js";
import { groupAgentsByMachine } from "../core/machine-list-groups.js";
import { PeerLinkError } from "../core/peer-link-error.js";
import { selectRelay } from "../core/relay-selection.js";
import { compareCodeUnits, compareDisplayNames } from "../core/ordering.js";
import {
  APPROVAL_RESPONSE_GRACE_MS,
  ROOM_JOIN_APPROVAL_TIMEOUT_MS,
  ROOM_REQUEST_TIMEOUT_MS,
  manageRequestTimeoutMs,
} from "../core/request-timeouts.js";
import { isHostedRoomAdvert } from "../core/room-discovery.js";
import { resolveRoomId } from "../core/room-lookup.js";
import {
  dmRoomPath,
  ownerNamedRoomPath,
  parseRoomPath,
  slugRoomName,
} from "../core/room-path.js";
import {
  accessCookieName,
  accessUrls,
  authorise,
  canonicalAddress,
  isLoopbackAddress,
  isWildcardHost,
  localWebUrl,
  requiresAccessToken,
  resolveWebBindHost,
  tokensMatch,
} from "../bridges/user/web/web-access.js";
import {
  hasConnectedBefore,
  shouldAutoConnect,
} from "../bridges/user/web/frontend/boot-logic.js";
import { parseInput, routeAction } from "../bridges/user/web/frontend/input.js";
import {
  deliveryEventToMessage,
  roomMessageToDisplay,
} from "../bridges/user/web/frontend/messages.js";
import { buildProjectTree } from "../bridges/user/web/frontend/project-tree.js";
import { isServedByBridge } from "../bridges/user/web/frontend/served-by-bridge.js";
import {
  parseDeepLink,
  resolveDeepLink,
  syncUrl,
} from "../bridges/user/web/frontend/url-sync.js";
import { RoomMessageSchema, RoomSchema } from "../core/types.js";
import {
  classifyManageOutcome,
  describeRefusal,
} from "../core/send-outcome.js";
import type { Room } from "../core/types.js";
import { CommsError } from "../core/store.js";
import {
  AgentIdentitySchema,
  CommsActionSchema,
  DeliveryEventSchema,
} from "../core/types.js";
import {
  formatListedAgentVersions,
  handleQueryVersion,
} from "../core/version-report-actions.js";

type CorpusFunction = (...args: readonly unknown[]) => unknown;

/** The outcome of validating an input: what the schema made of it, or every issue it found. */
export type ValidateResult =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly issues: readonly {
        readonly path: readonly (string | number)[];
        readonly code: string;
        readonly message: string;
      }[];
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("expected a string");
  return value;
}

function num(value: unknown): number {
  if (typeof value !== "number") throw new TypeError("expected a number");
  return value;
}

function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw new TypeError("expected a boolean");
  return value;
}

function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError("expected a list");
  return value;
}

function rec(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("expected an object");
  return value;
}

function strings(value: unknown): string[] {
  return list(value).map(str);
}

/** The field of an object as a string, or undefined when it is absent. */
function optStr(
  object: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = object[key];
  return value === undefined ? undefined : str(value);
}

function displayParts(value: unknown): {
  id: string;
  petname?: string;
  selfName?: string;
} {
  const parts = rec(value);
  const petname = optStr(parts, "petname");
  const selfName = optStr(parts, "selfName");

  return {
    id: str(parts.id),
    ...(petname !== undefined && { petname }),
    ...(selfName !== undefined && { selfName }),
  };
}

/** An error built the way the transport raises one: a plain error, an errno error, or a PeerLinkError around either. */
function buildError(value: unknown): Error {
  const spec = rec(value);
  const kind = str(spec.kind);
  if (kind === "errno" || kind === "error") {
    const error: Error & { code?: string } = new Error(str(spec.message));
    if (kind === "errno") error.code = str(spec.code);

    return error;
  }
  const cause =
    spec.cause === undefined
      ? new Error("unspecified")
      : buildError(spec.cause);
  const action = str(spec.action);
  if (action !== "dial" && action !== "send")
    throw new TypeError("unknown action");
  const port = spec.port === undefined ? undefined : num(spec.port);

  return new PeerLinkError(action, str(spec.peerId), port, cause);
}

function agent(id: string): ReturnType<typeof AgentIdentitySchema.parse> {
  return AgentIdentitySchema.parse({
    id,
    version: 0,
    name: id,
    harness: "test",
    cwd: "/test",
    pid: 1,
    startedAt: "",
    visibility: "visible",
    status: "active",
    tags: [],
    subscribedRooms: [],
  });
}

/** What an async function made of a scripted series of attempts: its result or error, and how many attempts it made. */
async function runBindRetry(
  script: unknown,
  retries: number,
  delayMs: number,
): Promise<unknown> {
  const steps = list(script).map(rec);
  const rejections = new Map<number, Error>();
  let attempts = 0;
  const attempt = async (): Promise<string> => {
    const index = Math.min(attempts, steps.length - 1);
    const step = steps[index];
    attempts += 1;
    if (step === undefined) throw new TypeError("an empty script");
    const rejects = step.rejects;
    if (rejects !== undefined) {
      const error = rejections.get(index) ?? new Error(str(rejects));
      rejections.set(index, error);

      return Promise.reject(error);
    }

    return Promise.resolve(str(step.resolves));
  };
  try {
    return {
      result: await retryOnAddrInUse(attempt, retries, delayMs),
      attempts,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      rethrownRejection: [...rejections.values()].some(
        (sent) => sent === error,
      ),
      attempts,
    };
  }
}

function relaySelection(value: unknown): unknown {
  const input = rec(value);
  const trusted = strings(input.trusted);
  const offers = list(input.offers).map((offer) => {
    const parts = rec(offer);

    return {
      deviceHex: str(parts.deviceHex),
      addresses: strings(parts.addresses),
      machineLocal: bool(parts.machineLocal),
    };
  });

  return selectRelay({
    offers,
    isTrusted: (hex) => trusted.includes(hex),
    ownDeviceHex: str(input.own),
    publicHubUrl: str(input.publicHub),
  });
}

function reporterLines(errors: unknown): string[] {
  const lines: string[] = [];
  const report = createMeshErrorReporter((line) => {
    lines.push(line);
  });
  for (const error of list(errors)) report(buildError(error));

  return lines;
}

function versionStore(
  value: unknown,
): Parameters<typeof formatListedAgentVersions>[0] {
  const spec = rec(value);
  const agentComms = optStr(spec, "agentComms");
  const wireMeshCore = optStr(spec, "wireMeshCore");
  const ccPeer = optStr(spec, "ccPeer");

  return {
    ...(agentComms !== undefined && {
      getPeerAgentCommsVersion: () => agentComms,
    }),
    ...(wireMeshCore !== undefined && {
      getPeerWireMeshCoreVersion: () => wireMeshCore,
    }),
    ...(ccPeer !== undefined && { getPeerCcPeerVersion: () => ccPeer }),
  };
}

function accessPolicy(value: unknown): Parameters<typeof authorise>[0] {
  const parts = rec(value);
  const localClientAddresses = new Set(
    strings(parts.localClientAddresses ?? []),
  );
  const acceptedTicket = optStr(parts, "acceptedTicket");

  return {
    token: optStr(parts, "token"),
    bindHost: str(parts.bindHost),
    port: num(parts.port),
    localClientAddresses: () => localClientAddresses,
    tickets:
      acceptedTicket === undefined
        ? undefined
        : { consume: (presented) => presented === acceptedTicket },
  };
}

function accessRequest(value: unknown): Parameters<typeof authorise>[1] {
  const parts = rec(value);

  return {
    method: str(parts.method),
    url: str(parts.url),
    remoteAddress: str(parts.remoteAddress),
    headers: Object.fromEntries(
      Object.entries(rec(parts.headers)).map(([key, header]) => [
        key,
        str(header),
      ]),
    ),
  };
}

function interfaceTable(
  value: unknown,
): NodeJS.Dict<os.NetworkInterfaceInfo[]> {
  const table: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {};
  for (const entry of list(value).map(rec)) {
    const name = str(entry.name);
    const base = {
      address: str(entry.address),
      internal: bool(entry.internal),
      mac: "00:00:00:00:00:00",
    };
    const info: os.NetworkInterfaceInfo =
      entry.family === "IPv6"
        ? {
            ...base,
            family: "IPv6",
            netmask: "ffff:ffff:ffff:ffff::",
            cidr: null,
            scopeid: 0,
          }
        : { ...base, family: "IPv4", netmask: "255.255.255.0", cidr: null };
    (table[name] ??= []).push(info);
  }

  return table;
}

type FrontendEvent = Parameters<typeof deliveryEventToMessage>[0];

/** The dashboard declares its own DeliveryEvent, whose optional fields cannot hold undefined, while the schema's output type allows it; a parsed event never carries an undefined field, since an absent optional key stays absent. */
function frontendEvent(value: unknown): FrontendEvent {
  return DeliveryEventSchema.parse(value) as FrontendEvent;
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : str(value);
}

/** A Storage whose only entry is the connected flag, when one is given. */
function connectedFlagStorage(flag: unknown): Storage {
  const value = optionalString(flag);

  return {
    getItem: () => value ?? null,
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
    length: 0,
    key: () => null,
  };
}

function pageLocation(value: unknown): { host: string; protocol: string } {
  const parts = rec(value);

  return { host: str(parts.host), protocol: str(parts.protocol) };
}

function frontendRooms(value: unknown): {
  id: string;
  name: string;
  type: "public";
  owner: string;
  createdAt: string;
  description: string;
  members: string[];
  invited: string[];
}[] {
  return list(value).map((entry) => {
    const parts = rec(entry);
    const id = str(parts.id);

    return {
      id,
      name: optStr(parts, "name") ?? id,
      type: "public",
      owner: "a1",
      createdAt: "",
      description: optStr(parts, "description") ?? "",
      members: [],
      invited: [],
    };
  });
}

/** The URLs `syncUrl` hands to `history.replaceState`, with the globals it reads stubbed for the call and put back after. */
function syncedUrls(state: unknown): string[] {
  const parts = rec(state);
  const urls: string[] = [];
  const originalHistory: unknown = Reflect.get(globalThis, "history");
  const originalLocation: unknown = Reflect.get(globalThis, "location");
  const define = (name: string, value: unknown): void => {
    Object.defineProperty(globalThis, name, {
      value,
      writable: true,
      configurable: true,
    });
  };
  define("history", {
    replaceState(_data: unknown, _unused: string, url?: string): void {
      urls.push(url ?? "");
    },
  });
  define("location", {
    href: "http://localhost:19877/",
    pathname: "/",
    search: "",
    hash: "",
  });
  try {
    syncUrl({
      currentRoom: optionalString(parts.currentRoom),
      dmTarget: optionalString(parts.dmTarget),
    });
  } finally {
    define("history", originalHistory);
    define("location", originalLocation);
  }

  return urls;
}

/** A room as the extension helpers read it: the fields a case names, and empty ones for the rest. */
function roomOf(value: unknown): Room {
  const parts = rec(value);
  const type = str(parts.type);
  if (type !== "public" && type !== "private" && type !== "secret") {
    throw new TypeError("expected a room type");
  }

  return RoomSchema.parse({
    id: str(parts.id),
    version: 0,
    name: str(parts.name),
    type,
    owner: str(parts.owner),
    createdAt: "",
    description: str(parts.description),
    members: [],
    invited: [],
    memberJoins: {},
    memberLeaves: {},
    invitedJoins: {},
    invitedLeaves: {},
  });
}

function hostedAdvert(
  value: unknown,
): Parameters<typeof summariseHostedRooms>[0][number] {
  const parts = rec(value);
  const type = str(parts.type);
  if (type !== "public" && type !== "private") {
    throw new TypeError("expected a hosted room type");
  }

  return {
    path: str(parts.path),
    name: str(parts.name),
    type,
    description: str(parts.description),
  };
}

function selfAdvert(
  value: unknown,
): Parameters<typeof summariseAgentSelfAdvert>[0] {
  const parts = rec(value);
  const optional = (key: string): string | undefined => optStr(parts, key);
  const membership = optional("membership");
  const machine = optional("machine");
  const machineName = optional("machineName");
  const principalName = optional("principalName");

  return {
    name: str(parts.name),
    harness: str(parts.harness),
    ...(membership !== undefined && { membership }),
    ...(machine !== undefined && { machine }),
    ...(machineName !== undefined && { machineName }),
    ...(principalName !== undefined && { principalName }),
    cwd: str(parts.cwd),
    pid: num(parts.pid),
    startedAt: str(parts.startedAt),
    tags: strings(parts.tags),
    subscribedRooms: strings(parts.subscribedRooms),
  };
}

export const FUNCTIONS: Readonly<Record<string, CorpusFunction>> = {
  "display-name.formatDisplayName": (parts) =>
    formatDisplayName(displayParts(parts)),
  "display-name.formatNames": (parts) => formatNames(displayParts(parts)),
  "display-name.parseDisplayName": (raw) => parseDisplayName(str(raw)),
  "display-name.shortId": (id) => shortId(str(id)),
  "room-path.ownerNamedRoomPath": (owner, name) =>
    ownerNamedRoomPath(str(owner), str(name)),
  "room-path.dmRoomPath": (a, b) => dmRoomPath(str(a), str(b)),
  "room-path.parseRoomPath": (path) => parseRoomPath(str(path)),
  "room-path.slugRoomName": (name) => slugRoomName(str(name)),
  "send-outcome.classifyManageOutcome": (outcome) => {
    const parts = rec(outcome);
    if (parts.result === "ok") return classifyManageOutcome({ result: "ok" });
    const message = optStr(parts, "message");

    return classifyManageOutcome({
      result: "error",
      code: str(parts.code),
      ...(message !== undefined && { message }),
    });
  },
  "send-outcome.describeRefusal": (refusal) => {
    const parts = rec(refusal);
    const message = optStr(parts, "message");

    return describeRefusal({
      code: str(parts.code),
      ...(message !== undefined && { message }),
    });
  },
  "bridge.formatDeliveryEvent": (event) =>
    formatDeliveryEvent(DeliveryEventSchema.parse(event)),
  "bridge.isActionableEvent": (event) =>
    isActionableEvent(DeliveryEventSchema.parse(event)),
  "bridge.buildAction": (params) => buildAction(rec(params)),
  "default-command.resolveDefaultCommand": (args, stdinIsTerminal) =>
    resolveDefaultCommand(strings(args), bool(stdinIsTerminal)),
  "claude-command.isClaudeCodeComm": (comm) => isClaudeCodeComm(str(comm)),
  "delegation-policy.resolveDelegationsRemaining": (
    policy,
    capability,
    bearer,
    requested,
  ) => {
    const parts = rec(policy);
    const overrides = parts.perAgentOverrides;
    const perAgentOverrides =
      overrides === undefined
        ? undefined
        : new Map(
            Object.entries(rec(overrides)).map(([key, set]) => [
              key,
              new Set(strings(set)),
            ]),
          );
    const resolved = {
      nonDelegable: new Set(strings(parts.nonDelegable)),
      ...(perAgentOverrides !== undefined && { perAgentOverrides }),
    };
    if (requested === undefined) {
      return resolveDelegationsRemaining(
        resolved,
        str(capability),
        str(bearer),
        undefined,
      );
    }

    return resolveDelegationsRemaining(
      resolved,
      str(capability),
      str(bearer),
      num(requested),
    );
  },
  "request-timeouts.manageRequestTimeoutMs": (command, approvalWindowMs) => {
    const parts = rec(command);

    return manageRequestTimeoutMs(
      { verb: str(parts.verb), params: rec(parts.params) },
      num(approvalWindowMs),
    );
  },
  "request-timeouts.constants": () => ({
    approvalResponseGraceMs: APPROVAL_RESPONSE_GRACE_MS,
    roomJoinApprovalTimeoutMs: ROOM_JOIN_APPROVAL_TIMEOUT_MS,
    roomRequestTimeoutMs: ROOM_REQUEST_TIMEOUT_MS,
  }),
  "bind-retry.retryOnAddrInUse": async (script, retries, delayMs) =>
    runBindRetry(script, num(retries), num(delayMs)),
  "error-reporting.describeMeshError": (error) =>
    describeMeshError(buildError(error)),
  "error-reporting.formatMeshError": (error) =>
    formatMeshError(buildError(error)),
  "error-reporting.reportedLines": (errors) => reporterLines(errors),
  "room-lookup.resolveRoomId": (candidates, roomIdOrName) =>
    resolveRoomId(
      list(candidates).map((candidate) => {
        const parts = rec(candidate);

        return { id: str(parts.id), name: str(parts.name) };
      }),
      str(roomIdOrName),
    ),
  "room-discovery.isHostedRoomAdvert": (value) => isHostedRoomAdvert(value),
  "agent-table.agentTable": (rows) => {
    const typed = list(rows).map((row) => {
      const parts = rec(row);

      return {
        id: str(parts.id),
        name: str(parts.name),
        harness: str(parts.harness),
        status: str(parts.status),
        visibility: str(parts.visibility),
        cwd: str(parts.cwd),
      };
    });
    const table = agentTable(typed);

    return { header: table.header, lines: typed.map((row) => table.line(row)) };
  },
  "machine-list-groups.groupAgentsByMachine": (
    agentIds,
    machines,
    ownMachine,
    namerTemplate,
  ) => {
    const agents = strings(agentIds).map(agent);
    const placed =
      machines === null
        ? undefined
        : new Map(
            list(machines).map((pair) => {
              const [device, machine] = strings(pair);
              if (device === undefined || machine === undefined)
                throw new TypeError("a pair");

              return [device, machine] as const;
            }),
          );
    const template = str(namerTemplate);

    return groupAgentsByMachine(
      agents,
      placed,
      ownMachine === null ? undefined : str(ownMachine),
      (id) => template.replaceAll("{id}", id),
    ).map((group) => ({
      heading: group.heading,
      agents: group.agents.map((member) => member.id),
    }));
  },
  "relay-selection.selectRelay": relaySelection,
  "gossip-extensions.hostedRoomAdverts": (rooms, ownerId) =>
    hostedRoomAdverts(
      new Map(list(rooms).map((entry) => [str(rec(entry).id), roomOf(entry)])),
      str(ownerId),
    ),
  "gossip-extensions.summariseHostedRooms": (adverts) =>
    summariseHostedRooms(list(adverts).map(hostedAdvert)),
  "gossip-extensions.summariseAgentSelfAdvert": (advert) =>
    summariseAgentSelfAdvert(selfAdvert(advert)),
  "gossip-extensions.constants": () => ({
    agentSelfGossipKey: AGENT_SELF_GOSSIP_KEY,
    defaultPresenceStaleAfterMs: DEFAULT_PRESENCE_STALE_AFTER_MS,
    hostedRoomsGossipKey: HOSTED_ROOMS_GOSSIP_KEY,
    presenceGossipKey: PRESENCE_GOSSIP_KEY,
    presenceReadvertiseIntervalMs: PRESENCE_READVERTISE_INTERVAL_MS,
  }),
  "room-wire-extensions.roomStateExtension": (room) =>
    roomStateExtension(room === null ? undefined : roomOf(room)),
  "room-wire-extensions.parseRoomStateExtension": (value) =>
    parseRoomStateExtension(value),
  "room-wire-extensions.inviterAgentExtension": (inviter) => {
    const parts = rec(inviter);

    return inviterAgentExtension({
      ...agent(str(parts.name)),
      name: str(parts.name),
      cwd: str(parts.cwd),
    });
  },
  "room-wire-extensions.parseInviterAgentExtension": (value) =>
    parseInviterAgentExtension(value),
  "input.parseInput": (text, room, dm) =>
    parseInput(str(text), optionalString(room), optionalString(dm)),
  "input.routeParsedInput": (text, room, dm) =>
    routeAction(
      parseInput(str(text), optionalString(room), optionalString(dm)),
    ) ?? null,
  "url-sync.parseDeepLink": (search) => parseDeepLink(str(search)),
  "url-sync.resolveParsedDeepLink": (search, rooms) => {
    const link = parseDeepLink(str(search));
    if (link === undefined) throw new Error("not a deep link");

    return resolveDeepLink(link, frontendRooms(rooms));
  },
  "url-sync.syncedUrls": (state) => syncedUrls(state),
  "boot-logic.hasConnectedBefore": (flag) =>
    hasConnectedBefore(connectedFlagStorage(flag)),
  "boot-logic.shouldAutoConnect": (location, flag) =>
    shouldAutoConnect(pageLocation(location), connectedFlagStorage(flag)),
  "served-by-bridge.isServedByBridge": (location) =>
    isServedByBridge(pageLocation(location)),
  "messages.deliveryEventToMessage": (event, currentRoom) =>
    deliveryEventToMessage(frontendEvent(event), optionalString(currentRoom)),
  "messages.roomMessageToDisplay": (message) =>
    roomMessageToDisplay(RoomMessageSchema.parse(message)),
  "ordering.compareCodeUnits": (a, b) => compareCodeUnits(str(a), str(b)),
  "ordering.compareDisplayNames": (a, b) => compareDisplayNames(str(a), str(b)),
  "project-tree.buildProjectTree": (agents, rooms) =>
    buildProjectTree(
      list(agents).map((entry) => {
        const parts = rec(entry);
        const id = str(parts.id);

        return {
          id,
          name: optStr(parts, "name") ?? `agent-${id}`,
          harness: "pi",
          cwd: optStr(parts, "cwd") ?? `/home/user/project-${id}`,
          pid: 1,
          startedAt: "",
          visibility: "visible",
          status: "active",
          tags: [],
          subscribedRooms: [],
        };
      }),
      frontendRooms(rooms),
    ),
  "web-access.authorise": (policy, request) =>
    authorise(accessPolicy(policy), accessRequest(request)),
  "web-access.accessCookieName": (port) => accessCookieName(num(port)),
  "web-access.resolveWebBindHost": (option, environment) =>
    resolveWebBindHost(
      option === null ? undefined : str(option),
      Object.fromEntries(
        Object.entries(rec(environment)).map(([key, v]) => [key, str(v)]),
      ),
    ),
  "web-access.wildcardAfterResolve": (spelling) => {
    const host = resolveWebBindHost(str(spelling), {});

    return {
      requiresAccessToken: requiresAccessToken(host),
      wildcard: isWildcardHost(host),
    };
  },
  "web-access.canonicalAddress": (address) => canonicalAddress(str(address)),
  "web-access.isWildcardHost": (host) => isWildcardHost(str(host)),
  "web-access.localWebUrl": (host, port) => localWebUrl(str(host), num(port)),
  "web-access.requiresAccessToken": (host) => requiresAccessToken(str(host)),
  "web-access.isLoopbackAddress": (address) => isLoopbackAddress(str(address)),
  "web-access.tokensMatch": (presented, expected) =>
    tokensMatch(str(presented), str(expected)),
  "web-access.accessUrls": (policy, interfaces) => {
    const parts = rec(policy);

    return accessUrls({ ...accessPolicy(parts), token: str(parts.token) }, () =>
      interfaceTable(interfaces),
    );
  },
  "version-report-actions.handleQueryVersion": async (store, action) => {
    const parts = rec(store);
    const query = parts.queryVersion;
    const result = await handleQueryVersion(
      query === undefined
        ? {}
        : {
            queryVersion: async (deviceId: string) => {
              if (deviceId !== str(rec(action).device))
                throw new Error("asked for another device");

              return Promise.resolve(
                "error" in rec(query)
                  ? { error: str(rec(query).error) }
                  : { version: str(rec(query).version) },
              );
            },
          },
      { action: "query_version", device: str(rec(action).device) },
    );

    return { content: result.content, isError: result.isError };
  },
  "version-report-actions.formatListedAgentVersions": (store, deviceId) =>
    formatListedAgentVersions(
      versionStore(store),
      str(deviceId),
      false,
      undefined,
    ),
};

function toIssues(error: {
  readonly issues: readonly {
    readonly path: readonly PropertyKey[];
    readonly code: string;
    readonly message: string;
  }[];
}): ValidateResult {
  return {
    ok: false,
    issues: error.issues.map((issue) => ({
      path: issue.path.map((step) =>
        typeof step === "number" ? step : String(step),
      ),
      code: issue.code,
      message: issue.message,
    })),
  };
}

export const SCHEMAS: Readonly<
  Record<string, (input: unknown) => ValidateResult>
> = {
  "tool-params": (input) => {
    const result = MCP_TOOL_PARAMS.safeParse(input);

    return result.success
      ? { ok: true, value: result.data }
      : toIssues(result.error);
  },
  "comms-action": (input) => {
    const result = CommsActionSchema.safeParse(input);

    return result.success
      ? { ok: true, value: result.data }
      : toIssues(result.error);
  },
};

/** Exposed for the CommsError code check the runner makes on a `throws` expectation. */
export function errorCode(error: unknown): string | undefined {
  return error instanceof CommsError ? error.code : undefined;
}
