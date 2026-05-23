/**
 * E2e tests — full browser automation of the agent-comms web UI.
 *
 * Tests the complete flow: page load, WebSocket connect,
 * room creation, message sending, delivery events.
 *
 * Each test uses a unique room name to avoid collisions.
 */

import { test, expect } from "./fixtures.js";

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
    await expect(page.locator("#sidebar h2")).toHaveText("Agent Comms");

    // Input bar present
    await expect(page.locator("#input")).toBeVisible();
    await expect(page.locator("#send-btn")).toBeVisible();
  });

  test("header shows default text", async ({ page, port }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.locator("#header")).toHaveText("Select a room");
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
    await expect(page.locator("#messages")).toContainText("Connected to mesh");
  });

  test("can create a room via /create command", async ({ page, port }) => {
    const roomName = uniqueName("e2e-room");
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.locator("#messages")).toContainText("Connected to mesh");

    await page.locator("#input").fill(`/create ${roomName}`);
    await page.locator("#send-btn").click();

    // Should see the room in sidebar
    await expect(page.locator("#room-list")).toContainText(roomName, {
      timeout: 5000,
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
    await expect(page.locator("#messages")).toContainText("Connected to mesh");

    // Click the room in sidebar to join
    const roomItem = page.locator("#room-list .room-item", {
      hasText: roomName,
    });
    await roomItem.click();

    // Wait for join to complete
    await expect(page.locator("#header")).toContainText(roomName);

    // Type and send a message
    await page.locator("#input").fill("Hello from e2e!");
    await page.locator("#send-btn").click();

    // The server responds with a "Sent to" result
    await expect(page.locator("#messages")).toContainText("Sent to", {
      timeout: 5000,
    });
  });

  test("/help shows command list", async ({ page, port }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.locator("#messages")).toContainText("Connected to mesh");

    await page.locator("#input").fill("/help");
    await page.locator("#send-btn").click();

    await expect(page.locator("#messages")).toContainText("/join");
    await expect(page.locator("#messages")).toContainText("/dm");
  });

  test("unknown command shows error", async ({ page, port }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.locator("#messages")).toContainText("Connected to mesh");

    await page.locator("#input").fill("/foobar");
    await page.locator("#send-btn").click();

    await expect(page.locator("#messages")).toContainText(
      "Unknown command: /foobar",
    );
  });
});
