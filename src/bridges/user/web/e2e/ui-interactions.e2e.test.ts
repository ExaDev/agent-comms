/**
 * E2E tests — web UI interaction edge cases.
 *
 * Tests sidebar toggling, room switching (click and /join),
 * /leave, /rename, /dm, and agent list presence in the sidebar.
 */

import { expect } from "@playwright/test";
import { test } from "./fixtures.js";

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
    await expect(page.getByText("Connected to mesh")).toBeVisible();

    const nav = page.getByRole("navigation");
    const toggle = page.getByRole("button", { name: "Toggle sidebar" });

    // Sidebar starts on-screen (its x position is at or right of the viewport edge)
    const openBox = await nav.boundingBox();
    expect(openBox).not.toBeNull();
    expect(openBox?.x).toBeGreaterThanOrEqual(0);

    // Click the toggle to collapse — the navbar slides off-screen (negative x)
    await toggle.click();
    await expect(async () => {
      const box = await nav.boundingBox();
      expect(box?.x).toBeLessThan(0);
    }).toPass({ timeout: 5000 });

    // Click toggle again to expand — back on-screen
    await toggle.click();
    await expect(async () => {
      const box = await nav.boundingBox();
      expect(box?.x).toBeGreaterThanOrEqual(0);
    }).toPass({ timeout: 5000 });
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
    await expect(page.getByText("Connected to mesh")).toBeVisible();

    // Click the room in sidebar
    const roomItem = page.getByText(roomName);
    await roomItem.waitFor({ state: "visible", timeout: 10000 });
    await roomItem.click();

    // Header should show the room name
    await expect(page.locator("header")).toContainText(roomName, {
      timeout: 10000,
    });

    // The leave button should appear when in a room
    await expect(page.getByRole("button", { name: "Leave" })).toBeVisible();
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
    await expect(page.getByText("Connected to mesh")).toBeVisible();

    // Click room A
    const roomItemA = page.getByText(roomA);
    await roomItemA.waitFor({ state: "visible", timeout: 10000 });
    await roomItemA.click();
    await expect(page.locator("header")).toContainText(roomA, {
      timeout: 10000,
    });

    // Click room B
    const roomItemB = page.getByText(roomB);
    await roomItemB.waitFor({ state: "visible", timeout: 10000 });
    await roomItemB.click();
    await expect(page.locator("header")).toContainText(roomB, {
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
    await expect(page.getByText("Connected to mesh")).toBeVisible();

    await page.getByLabel("Message").fill(`/join ${roomName}`);
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.locator("header")).toContainText(roomName, {
      timeout: 10000,
    });
    await expect(page.getByText("Joined", { exact: false })).toBeVisible();
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
    await expect(page.getByText("Connected to mesh")).toBeVisible();

    // Join room via sidebar click
    const roomItem = page.getByText(roomName);
    await roomItem.waitFor({ state: "visible", timeout: 10000 });
    await roomItem.click();
    await expect(page.locator("header")).toContainText(roomName);

    // Leave via /leave
    await page.getByLabel("Message").fill("/leave");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText(`Left room "${roomName}"`)).toBeVisible({
      timeout: 10000,
    });

    // Header should revert to default
    await expect(page.locator("header")).toContainText("Select a room", {
      timeout: 10000,
    });
  });

  test("/leave without being in a room does nothing", async ({
    page,
    port,
  }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.getByText("Connected to mesh")).toBeVisible();

    // /leave with no current room is handled locally — onLeaveRoom()
    // does nothing and returns early. No message is added.
    await page.getByLabel("Message").fill("/leave");
    await page.getByRole("button", { name: "Send" }).click();

    // Header should remain at default
    await expect(page.locator("header")).toContainText("Select a room");
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
    await expect(page.getByText("Connected to mesh")).toBeVisible();

    await page.getByLabel("Message").fill(`/rename ${agentId} RenamedAgent`);
    await page.getByRole("button", { name: "Send" }).click();

    // Should see a result confirming the rename
    await expect(
      page.getByText("Renamed Dashboard", { exact: false }),
    ).toBeVisible({
      timeout: 10000,
    });
  });

  test("/rename without agent ID shows usage error", async ({ page, port }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.getByText("Connected to mesh")).toBeVisible();

    await page.getByLabel("Message").fill("/rename");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(
      page.getByText("Usage: /rename", { exact: false }),
    ).toBeVisible({
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
    await expect(page.getByText("Connected to mesh")).toBeVisible();

    // Send a DM to the agent (which is the self agent, but the action still goes through)
    await page.getByLabel("Message").fill(`/dm ${agentId} hello from dm`);
    await page.getByRole("button", { name: "Send" }).click();

    // Should see a result confirming the DM was sent
    await expect(page.getByText("DM", { exact: false }).first()).toBeVisible({
      timeout: 10000,
    });
  });

  test("/dm without arguments shows usage error", async ({ page, port }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.getByText("Connected to mesh")).toBeVisible();

    await page.getByLabel("Message").fill("/dm");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText("Usage: /dm", { exact: false })).toBeVisible({
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
    await expect(page.getByText("Connected to mesh")).toBeVisible();

    // The dashboard agent should appear in the sidebar navigation
    const agentsRes = await fetch(`http://127.0.0.1:${port}/api/agents`);
    const agents = await agentsRes.json();
    const agentName =
      typeof agents[0] === "object" && agents[0] !== null
        ? agents[0].name
        : undefined;
    expect(agentName).toBeTruthy();
    await expect(
      page.getByRole("navigation").getByText(agentName as string),
    ).toBeVisible({ timeout: 10000 });
  });

  test("clicking an agent in the sidebar sets DM target", async ({
    page,
    port,
  }) => {
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.getByText("Connected to mesh")).toBeVisible();

    const agentsRes = await fetch(`http://127.0.0.1:${port}/api/agents`);
    const agents = await agentsRes.json();
    const agentName =
      typeof agents[0] === "object" && agents[0] !== null
        ? agents[0].name
        : undefined;
    expect(agentName).toBeTruthy();

    // Click the agent item
    const agentItem = page
      .getByRole("navigation")
      .getByText(agentName as string);
    await agentItem.waitFor({ state: "visible", timeout: 10000 });
    await agentItem.click();

    // Header should show DM with agent name
    await expect(page.locator("header")).toContainText("DM with", {
      timeout: 10000,
    });
  });
});
