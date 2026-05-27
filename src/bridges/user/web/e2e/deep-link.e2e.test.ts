/**
 * E2e tests — URL deep linking (?room=, ?dm= query parameters).
 *
 * Verifies that navigating with query parameters auto-selects the
 * correct room or DM target.
 */

import { test, expect } from "./fixtures.js";

let testCounter = 0;
function uniqueName(prefix: string): string {
  testCounter++;
  return `${prefix}-${Date.now()}-${testCounter}`;
}

test.describe("Deep linking", () => {
  test("navigating to ?room= selects the room", async ({ page, port }) => {
    const roomName = uniqueName("deep-room");

    // Create a room via the API and extract the room ID
    const res = await fetch(`http://127.0.0.1:${port}/api/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create_room",
        name: roomName,
        type: "public",
      }),
    });
    const result = await res.json();
    expect(result.isError).toBeFalsy();
    // Result content: 'Created public room "name" (id).'
    const idMatch = (result.content as string).match(/\(([a-zA-Z0-9_-]+)\)\.$/);
    const roomId = idMatch?.[1];
    expect(roomId).toBeTruthy();

    // Navigate with the room deep link (uses room ID, not name)
    await page.goto(`http://127.0.0.1:${port}?room=${roomId}`);

    // Wait for the page to load and connect
    await expect(page.locator("#messages")).toContainText("Connected to mesh", {
      timeout: 10000,
    });

    // The header should show the room name (deep link resolved and joined)
    await expect(page.locator("#header")).toContainText(roomName, {
      timeout: 10000,
    });
  });

  test("navigating to ?dm= sets DM target", async ({ page, port }) => {
    const agentName = uniqueName("deep-agent");

    // Register an agent via the API
    await fetch(`http://127.0.0.1:${port}/api/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "list_agents",
      }),
    });

    // Navigate with a DM deep link
    await page.goto(`http://127.0.0.1:${port}?dm=agent-123`);

    // Wait for the page to load
    await expect(page.locator("#messages")).toContainText("Connected to mesh", {
      timeout: 10000,
    });

    // The header should show "DM with agent-123"
    await expect(page.locator("#header")).toContainText("DM with agent-123", {
      timeout: 10000,
    });
  });

  test("deep link to nonexistent room shows default header", async ({
    page,
    port,
  }) => {
    await page.goto(`http://127.0.0.1:${port}?room=nonexistent-room`);

    await expect(page.locator("#messages")).toContainText("Connected to mesh", {
      timeout: 10000,
    });

    // The deep link can't resolve, so header stays at default
    await expect(page.locator("#header")).toContainText("Select a room");
  });

  test("URL updates when navigating to a room", async ({ page, port }) => {
    const roomName = uniqueName("url-room");

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

    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.locator("#messages")).toContainText("Connected to mesh");

    // Click the room in sidebar
    const roomItem = page.locator("#room-list .room-item", {
      hasText: roomName,
    });
    await roomItem.click();
    await expect(page.locator("#header")).toContainText(roomName);

    // URL should now contain ?room=
    const url = page.url();
    expect(url).toContain(`room=${roomName}`);
  });
});
