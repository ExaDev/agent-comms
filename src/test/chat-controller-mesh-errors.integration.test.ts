/**
 * Integration test for how a ChatController's own mesh store reports errors: to a listener on the controller's "error" event when the host UI has one (the TUI), and to stderr otherwise, since an "error" event nobody listens for would throw out of the store's callback.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatController } from "../bridges/user/controller.js";
import { unreachableHubUrl } from "./hub-helpers.js";
import { waitFor } from "./test-transport.js";

let nextPort = 22_450;
function freshPort(): number {
  nextPort += 1;
  return nextPort;
}

describe("ChatController mesh errors", () => {
  const controllers: ChatController[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const controller of controllers.splice(0)) {
      await controller.shutdown();
    }
  });

  async function startController(): Promise<ChatController> {
    // Becoming coordinator dials the hub unconditionally, and this hub URL refuses connections, so the store reports a real error.
    const controller = new ChatController("errors-test", {
      coordinatorPort: freshPort(),
      hubUrl: await unreachableHubUrl(),
    });
    controllers.push(controller);
    return controller;
  }

  it("emits a mesh error on the controller's error event when a listener is attached", async () => {
    const controller = await startController();
    const errors: Error[] = [];
    controller.on("error", (error: Error) => {
      errors.push(error);
    });

    await controller.init();

    await waitFor(() => errors.length > 0, "the hub dial failure is reported");
    expect(errors[0]).toBeInstanceOf(Error);
  });

  it("writes a mesh error to stderr instead of throwing when nothing listens for the error event", async () => {
    const controller = await startController();
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await controller.init();

    await waitFor(
      () =>
        stderr.mock.calls.some(([line]) =>
          String(line).startsWith("agent-comms: "),
        ),
      "the hub dial failure reaches stderr",
    );
  });
});
