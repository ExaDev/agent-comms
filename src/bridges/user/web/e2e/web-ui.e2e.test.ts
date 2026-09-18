/**
 * E2e tests — full browser automation of the agent-comms web UI.
 *
 * Tests the complete flow: page load, WebSocket connect, room creation, message sending, delivery events.
 *
 * Each test uses a unique room name to avoid collisions.
 */

import { expect } from "@playwright/test";
import { test } from "./fixtures.js";

let testCounter = 0;
function uniqueName(prefix: string): string {
  testCounter++;
  return `${prefix}-${Date.now()}-${testCounter}`;
}

test.describe("Web UI", () => {
  test("loads the page and connects to WebSocket", async ({ page, port }) => {
    await page.goto(`http://127.0.0.1:${port}`);

    // Title is set
    await expect(page).toHaveTitle("Agent Comms");

    // Sidebar header visible
    await expect(
      page.getByRole("navigation").getByText("Agent Comms"),
    ).toBeVisible();

    // Input bar present
    await expect(page.getByLabel("Message")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  });

  test("header shows default text", async ({ page, port }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.locator("header")).toHaveText("Select a room");
  });

  test("REST API lists agents", async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/agents`);
    const agents = await res.json();
    expect(Array.isArray(agents)).toBeTruthy();
  });

  test("REST API lists rooms", async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/rooms`);
    const rooms = await res.json();
    expect(Array.isArray(rooms)).toBeTruthy();
  });

  test("POST /api/action creates a room", async ({ port }) => {
    const name = uniqueName("api-room");
    const res = await fetch(`http://127.0.0.1:${port}/api/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create_room",
        name,
        type: "public",
        description: "Created by e2e test",
      }),
    });
    const result = await res.json();
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("Created");
  });

  test("shows connected message after WebSocket opens", async ({
    page,
    port,
  }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.getByText("Connected to mesh")).toBeVisible();
  });

  test("can create a room via /create command", async ({ page, port }) => {
    const roomName = uniqueName("e2e-room");
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.getByText("Connected to mesh")).toBeVisible();

    await page.getByLabel("Message").fill(`/create ${roomName}`);
    await page.getByRole("button", { name: "Send" }).click();

    // Should see the room in sidebar
    await expect(page.getByRole("navigation").getByText(roomName)).toBeVisible({
      timeout: 10000,
    });
  });

  test("can send a message to a room", async ({ page, port }) => {
    const roomName = uniqueName("chat-room");

    // Create room via API first
    await fetch(`http://127.0.0.1:${port}/api/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create_room",
        name: roomName,
        type: "public",
      }),
    });

    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.getByText("Connected to mesh")).toBeVisible();

    // Click the room in sidebar to join
    const roomItem = page.getByText(roomName);
    await roomItem.waitFor({ state: "visible", timeout: 10000 });
    await roomItem.click();

    // Wait for join to complete
    await expect(page.locator("header")).toContainText(roomName);

    // Type and send a message
    await page.getByLabel("Message").fill("Hello from e2e!");
    await page.getByRole("button", { name: "Send" }).click();

    // The server responds with a "Sent to" result
    await expect(page.getByText("Sent to", { exact: false })).toBeVisible({
      timeout: 10000,
    });
  });

  test("/help shows command list", async ({ page, port }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.getByText("Connected to mesh")).toBeVisible();

    await page.getByLabel("Message").fill("/help");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText("/join", { exact: false })).toBeVisible();
    await expect(page.getByText("/dm", { exact: false })).toBeVisible();
  });

  test("unknown command shows error", async ({ page, port }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.getByText("Connected to mesh")).toBeVisible();

    await page.getByLabel("Message").fill("/foobar");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText("Unknown command: /foobar")).toBeVisible();
  });

  test("can join a room via /join command", async ({ page, port }) => {
    const roomName = uniqueName("join-room");

    // Create room via API
    await fetch(`http://127.0.0.1:${port}/api/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create_room",
        name: roomName,
        type: "public",
      }),
    });

    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.getByText("Connected to mesh")).toBeVisible();

    await page.getByLabel("Message").fill(`/join ${roomName}`);
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.locator("header")).toContainText(roomName, {
      timeout: 10000,
    });
    await expect(page.getByText("Joined", { exact: false })).toBeVisible();
  });

  test("can leave a room via /leave command", async ({ page, port }) => {
    const roomName = uniqueName("leave-room");

    // Create and join room via API
    await fetch(`http://127.0.0.1:${port}/api/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create_room",
        name: roomName,
        type: "public",
      }),
    });

    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.getByText("Connected to mesh")).toBeVisible();

    // Join via sidebar click first
    const roomItem = page.getByText(roomName);
    await roomItem.waitFor({ state: "visible", timeout: 10000 });
    await roomItem.click();
    await expect(page.locator("header")).toContainText(roomName);

    // Leave
    await page.getByLabel("Message").fill("/leave");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText(`Left room "${roomName}"`)).toBeVisible({
      timeout: 10000,
    });
  });

  test("GET /api/rooms/:id/messages returns messages", async ({ port }) => {
    const roomName = uniqueName("msgs-room");

    // Create room
    const createRes = await fetch(`http://127.0.0.1:${port}/api/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create_room",
        name: roomName,
        type: "public",
      }),
    });
    const createResult = await createRes.json();
    expect(createResult.isError).toBeFalsy();

    // Send a message via API
    await fetch(`http://127.0.0.1:${port}/api/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "send",
        target: roomName,
        content: "Test message for history",
      }),
    });

    // Fetch messages
    const res = await fetch(
      `http://127.0.0.1:${port}/api/rooms/${roomName}/messages`,
    );
    const messages = await res.json();
    expect(Array.isArray(messages)).toBeTruthy();
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].content).toBe("Test message for history");
  });

  test("sidebar updates member count after room creation", async ({
    page,
    port,
  }) => {
    const roomName = uniqueName("count-room");

    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.getByText("Connected to mesh")).toBeVisible();

    await page.getByLabel("Message").fill(`/create ${roomName}`);
    await page.getByRole("button", { name: "Send" }).click();

    // Room appears in sidebar with (1) member count
    await expect(page.getByText(`${roomName} (1)`)).toBeVisible({
      timeout: 10000,
    });
  });

  // A prior version of this test drove the legacy chat socket's raw JSON action/result frames directly against the root path to prove "sending a message returns a confirmation". That wire protocol no longer exists -- state, patches, actions, and delivery all go through the oRPC endpoint on /ws/mesh now, exercised end-to-end by orpc-router.integration.test.ts. The same user-facing behaviour this test verified is already covered above by "can send a message to a room", which drives the real browser UI rather than a raw socket.
});
