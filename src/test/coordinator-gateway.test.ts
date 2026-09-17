/**
 * Direct unit tests for CoordinatorGateway -- the connect-hub-on-become-coordinator / disconnect-hub-on-lose-coordinator wiring (agent-comms#154), tested against injected connectHub/disconnectHub closures rather than a real transport or hub socket, mirroring peer-lifecycle.test.ts's own DI-based approach.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CoordinatorGateway,
  type CoordinatorGatewayDeps,
} from "../core/coordinator-gateway.js";

const HUB_URL = "wss://mesh.example.test/";

function makeHarness(): {
  gateway: CoordinatorGateway;
  connectHub: ReturnType<typeof vi.fn>;
  disconnectHub: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
} {
  const connectHub = vi.fn().mockResolvedValue(undefined);
  const disconnectHub = vi.fn().mockResolvedValue(undefined);
  const onError = vi.fn<(error: Error) => void>();
  const deps: CoordinatorGatewayDeps = {
    hubUrl: HUB_URL,
    connectHub,
    disconnectHub,
    onError,
  };
  return {
    gateway: new CoordinatorGateway(deps),
    connectHub,
    disconnectHub,
    onError,
  };
}

describe("CoordinatorGateway — onBecameCoordinator", () => {
  it("dials the configured hub URL", async () => {
    const { gateway, connectHub } = makeHarness();

    await gateway.onBecameCoordinator();

    expect(connectHub).toHaveBeenCalledWith(HUB_URL);
    expect(connectHub).toHaveBeenCalledTimes(1);
  });

  it("marks isConnected true once dialled", async () => {
    const { gateway } = makeHarness();
    expect(gateway.isConnected).toBe(false);

    await gateway.onBecameCoordinator();

    expect(gateway.isConnected).toBe(true);
  });

  it("is idempotent -- a second call while already connected does not redial", async () => {
    const { gateway, connectHub } = makeHarness();

    await gateway.onBecameCoordinator();
    await gateway.onBecameCoordinator();

    expect(connectHub).toHaveBeenCalledTimes(1);
  });

  it("reports a dial failure via onError rather than throwing -- local coordinator election must not depend on hub reachability", async () => {
    const { gateway, connectHub, onError } = makeHarness();
    const dialError = new Error("ECONNREFUSED");
    connectHub.mockRejectedValueOnce(dialError);

    await expect(gateway.onBecameCoordinator()).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledWith(dialError);
  });

  it("does not mark itself connected after a failed dial, so a later call can retry", async () => {
    const { gateway, connectHub } = makeHarness();
    connectHub.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await gateway.onBecameCoordinator();
    expect(gateway.isConnected).toBe(false);

    await gateway.onBecameCoordinator();

    expect(gateway.isConnected).toBe(true);
    expect(connectHub).toHaveBeenCalledTimes(2);
  });
});

describe("CoordinatorGateway — onLostCoordinator", () => {
  it("drops the hub connection when one is held", async () => {
    const { gateway, disconnectHub } = makeHarness();
    await gateway.onBecameCoordinator();

    await gateway.onLostCoordinator();

    expect(disconnectHub).toHaveBeenCalledTimes(1);
    expect(gateway.isConnected).toBe(false);
  });

  it("is a no-op when this side never became the gateway", async () => {
    const { gateway, disconnectHub } = makeHarness();

    await gateway.onLostCoordinator();

    expect(disconnectHub).not.toHaveBeenCalled();
  });

  it("is a no-op on a second call after already losing the role", async () => {
    const { gateway, disconnectHub } = makeHarness();
    await gateway.onBecameCoordinator();
    await gateway.onLostCoordinator();

    await gateway.onLostCoordinator();

    expect(disconnectHub).toHaveBeenCalledTimes(1);
  });

  it("allows redialling after losing and regaining the role", async () => {
    const { gateway, connectHub } = makeHarness();
    await gateway.onBecameCoordinator();
    await gateway.onLostCoordinator();

    await gateway.onBecameCoordinator();

    expect(connectHub).toHaveBeenCalledTimes(2);
  });
});
