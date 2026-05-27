/**
 * E2e tests — full browser automation of the agent-comms web UI.
 *
 * Tests the complete flow: page load, WebSocket connect,
 * room creation, message sending, delivery events.
 *
 * Each test uses a unique room name to avoid collisions.
 */

import { test, expect } from "./fixtures.js";
import WS from "ws";

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
    await expect(page.locator("#sidebar h2")).toContainText("Agent Comms");

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
      timeout: 10000,
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
    await expect(page.locator("#messages")).toContainText("Connected to mesh");

    await page.locator("#input").fill(`/join ${roomName}`);
    await page.locator("#send-btn").click();

    await expect(page.locator("#header")).toContainText(roomName, {
      timeout: 10000,
    });
    await expect(page.locator("#messages")).toContainText("Switched to");
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
    await expect(page.locator("#messages")).toContainText("Connected to mesh");

    // Join via sidebar click first
    const roomItem = page.locator("#room-list .room-item", {
      hasText: roomName,
    });
    await roomItem.click();
    await expect(page.locator("#header")).toContainText(roomName);

    // Leave
    await page.locator("#input").fill("/leave");
    await page.locator("#send-btn").click();

    await expect(page.locator("#messages")).toContainText(
      `Left room "${roomName}"`,
      {
        timeout: 10000,
      },
    );
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
    await expect(page.locator("#messages")).toContainText("Connected to mesh");

    await page.locator("#input").fill(`/create ${roomName}`);
    await page.locator("#send-btn").click();

    // Room appears in sidebar with (1) member count
    const roomItem = page.locator("#room-list .room-item", {
      hasText: roomName,
    });
    await expect(roomItem).toBeVisible({ timeout: 10000 });
    await expect(roomItem).toContainText("(1)");
  });

  test("sending a message returns confirmation via WebSocket", async ({
    port,
  }) => {
    const roomName = uniqueName("ws-send-room");

    // Create room
    await fetch(`http://127.0.0.1:${port}/api/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create_room",
        name: roomName,
        type: "public",
      }),
    });

    // Connect WebSocket and collect frames
    const ws = await new Promise<WS>((resolve) => {
      const ws = new WS(`ws://127.0.0.1:${port}`);
      ws.on("open", () => resolve(ws));
    });

    const frames: Record<string, unknown>[] = [];
    ws.on("message", (raw) => {
      frames.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    });

    // Join and send
    ws.send(JSON.stringify({ action: "join_room", room: roomName }));
    ws.send(
      JSON.stringify({
        action: "send",
        target: roomName,
        content: "Hello via WebSocket!",
      }),
    );

    // Wait for frames to accumulate
    await new Promise((r) => setTimeout(r, 500));

    const results = frames.filter(
      (f) =>
        f.type === "result" &&
        typeof (f.result as Record<string, unknown>)?.content === "string",
    );

    // Should see join result and send result
    const sendResult = results.find((f) =>
      ((f.result as Record<string, unknown>)?.content as string)?.includes(
        "Sent to",
      ),
    );
    expect(sendResult).toBeTruthy();

    ws.close();
  });
});
