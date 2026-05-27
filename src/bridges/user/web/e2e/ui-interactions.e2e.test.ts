/**
 * E2E tests — web UI interaction edge cases.
 *
 * Tests sidebar toggling, room switching (click and /join),
 * /leave, /rename, /dm, and agent list presence in the sidebar.
 */

import { test, expect } from "./fixtures.js";

let testCounter = 0;
function uniqueName(prefix: string): string {
  testCounter++;
  return `${prefix}-${Date.now()}-${testCounter}`;
}

test.describe("Sidebar toggle", () => {
  test("clicking sidebar toggle collapses and expands the sidebar", async ({
    page,
    port,
  }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.locator("#messages")).toContainText("Connected to mesh");

    // Sidebar should be visible initially
    const sidebar = page.locator("#sidebar");
    await expect(sidebar).toBeVisible();

    // Click the toggle to collapse
    await page.locator("#sidebar-toggle").click();

    // Sidebar should now have the collapsed class
    await expect(sidebar).toHaveClass(/sidebar-collapsed/);

    // Click toggle again to expand
    await page.locator("#sidebar-toggle").click();

    // Sidebar should no longer have the collapsed class
    await expect(sidebar).not.toHaveClass(/sidebar-collapsed/);
  });
});

test.describe("Room switching via sidebar click", () => {
  test("clicking a room in the sidebar switches the chat area", async ({
    page,
    port,
  }) => {
    const roomName = uniqueName("click-room");

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

    // Click the room in sidebar
    const roomItem = page.locator("#room-list .room-item", {
      hasText: roomName,
    });
    await roomItem.waitFor({ state: "visible", timeout: 10000 });
    await roomItem.click();

    // Header should show the room name
    await expect(page.locator("#header")).toContainText(roomName, {
      timeout: 10000,
    });

    // The leave button should appear when in a room
    await expect(page.locator(".leave-btn")).toBeVisible();
  });

  test("switching between two rooms updates the header", async ({
    page,
    port,
  }) => {
    const roomA = uniqueName("room-a");
    const roomB = uniqueName("room-b");

    // Create both rooms via API
    await fetch(`http://127.0.0.1:${port}/api/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create_room",
        name: roomA,
        type: "public",
      }),
    });
    await fetch(`http://127.0.0.1:${port}/api/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create_room",
        name: roomB,
        type: "public",
      }),
    });

    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.locator("#messages")).toContainText("Connected to mesh");

    // Click room A
    const roomItemA = page.locator("#room-list .room-item", {
      hasText: roomA,
    });
    await roomItemA.waitFor({ state: "visible", timeout: 10000 });
    await roomItemA.click();
    await expect(page.locator("#header")).toContainText(roomA, {
      timeout: 10000,
    });

    // Click room B
    const roomItemB = page.locator("#room-list .room-item", {
      hasText: roomB,
    });
    await roomItemB.waitFor({ state: "visible", timeout: 10000 });
    await roomItemB.click();
    await expect(page.locator("#header")).toContainText(roomB, {
      timeout: 10000,
    });
  });
});

test.describe("Room switching via /join command", () => {
  test("/join switches to an existing room", async ({ page, port }) => {
    const roomName = uniqueName("join-cmd-room");

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
    await expect(page.locator("#messages")).toContainText("Joined");
  });

  test("/join for nonexistent room returns server error via API", async ({
    port,
  }) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "join_room",
        room: "nonexistent-room-xyz",
      }),
    });
    const result = await res.json();
    expect(result.isError).toBeTruthy();
    expect(result.content).toContain("not found");
  });
});

test.describe("Leave room via /leave command", () => {
  test("/leave exits the current room", async ({ page, port }) => {
    const roomName = uniqueName("leave-cmd-room");

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

    // Join room via sidebar click
    const roomItem = page.locator("#room-list .room-item", {
      hasText: roomName,
    });
    await roomItem.waitFor({ state: "visible", timeout: 10000 });
    await roomItem.click();
    await expect(page.locator("#header")).toContainText(roomName);

    // Leave via /leave
    await page.locator("#input").fill("/leave");
    await page.locator("#send-btn").click();

    await expect(page.locator("#messages")).toContainText(
      `Left room "${roomName}"`,
      { timeout: 10000 },
    );

    // Header should revert to default
    await expect(page.locator("#header")).toContainText("Select a room", {
      timeout: 10000,
    });
  });

  test("/leave without being in a room does nothing", async ({
    page,
    port,
  }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.locator("#messages")).toContainText("Connected to mesh");

    // /leave with no current room is handled locally — onLeaveRoom()
    // does nothing and returns early. No message is added.
    await page.locator("#input").fill("/leave");
    await page.locator("#send-btn").click();

    // Header should remain at default
    await expect(page.locator("#header")).toContainText("Select a room");
  });
});

test.describe("Rename via /rename command", () => {
  test("/rename changes the agent name", async ({ page, port }) => {
    // Get the current agent ID
    const agentsRes = await fetch(`http://127.0.0.1:${port}/api/agents`);
    const agents = await agentsRes.json();
    const agentId =
      typeof agents[0] === "object" && agents[0] !== null
        ? agents[0].id
        : undefined;
    expect(agentId).toBeTruthy();

    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.locator("#messages")).toContainText("Connected to mesh");

    await page.locator("#input").fill(`/rename ${agentId} RenamedAgent`);
    await page.locator("#send-btn").click();

    // Should see a result confirming the rename
    await expect(page.locator("#messages")).toContainText("Renamed", {
      timeout: 10000,
    });
  });

  test("/rename without agent ID shows usage error", async ({ page, port }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.locator("#messages")).toContainText("Connected to mesh");

    await page.locator("#input").fill("/rename");
    await page.locator("#send-btn").click();

    await expect(page.locator("#messages")).toContainText("Usage: /rename", {
      timeout: 10000,
    });
  });
});

test.describe("DM via /dm command", () => {
  test("/dm sends a direct message to another agent", async ({
    page,
    port,
  }) => {
    // Get the dashboard agent ID
    const agentsRes = await fetch(`http://127.0.0.1:${port}/api/agents`);
    const agents = await agentsRes.json();
    const agentId =
      typeof agents[0] === "object" && agents[0] !== null
        ? agents[0].id
        : undefined;
    expect(agentId).toBeTruthy();

    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.locator("#messages")).toContainText("Connected to mesh");

    // Send a DM to the agent (which is the self agent, but the action still goes through)
    await page.locator("#input").fill(`/dm ${agentId} hello from dm`);
    await page.locator("#send-btn").click();

    // Should see a result confirming the DM was sent
    await expect(page.locator("#messages")).toContainText("DM", {
      timeout: 10000,
    });
  });

  test("/dm without arguments shows usage error", async ({ page, port }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.locator("#messages")).toContainText("Connected to mesh");

    await page.locator("#input").fill("/dm");
    await page.locator("#send-btn").click();

    await expect(page.locator("#messages")).toContainText("Usage: /dm", {
      timeout: 10000,
    });
  });
});

test.describe("Agent list in sidebar", () => {
  test("registered agents appear in the sidebar project tree", async ({
    page,
    port,
  }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.locator("#messages")).toContainText("Connected to mesh");

    // The dashboard agent should appear in the sidebar
    const agentItems = page.locator("#room-list .agent-item");
    await expect(agentItems.first()).toBeVisible({ timeout: 10000 });
  });

  test("clicking an agent in the sidebar sets DM target", async ({
    page,
    port,
  }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.locator("#messages")).toContainText("Connected to mesh");

    // Click an agent item
    const agentItem = page.locator("#room-list .agent-item").first();
    await agentItem.waitFor({ state: "visible", timeout: 10000 });
    await agentItem.click();

    // Header should show DM with agent ID
    await expect(page.locator("#header")).toContainText("DM with", {
      timeout: 10000,
    });
  });
});
