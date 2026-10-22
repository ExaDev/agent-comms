import { describe, it, expect } from "vitest";
import {
  isPublishedOnRegistry,
  registryVersionUrl,
} from "../core/mcp-registry-version.js";

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_BAD_GATEWAY = 502;

describe("registryVersionUrl", () => {
  it("encodes the namespace separator so the server name stays one path segment", () => {
    expect(registryVersionUrl("io.github.ExaDev/agent-comms", "8.15.4")).toBe(
      "https://registry.modelcontextprotocol.io/v0/servers/io.github.ExaDev%2Fagent-comms/versions/8.15.4",
    );
  });
});

describe("isPublishedOnRegistry", () => {
  it("treats a 200 as published", () => {
    expect(isPublishedOnRegistry(HTTP_OK)).toBe(true);
  });

  it("treats a 404 as not published, which is what makes a missed publish detectable", () => {
    expect(isPublishedOnRegistry(HTTP_NOT_FOUND)).toBe(false);
  });

  it("refuses to guess from any other status, since publishing a version the registry already lists fails the job", () => {
    expect(() => isPublishedOnRegistry(HTTP_BAD_GATEWAY)).toThrow(
      String(HTTP_BAD_GATEWAY),
    );
  });
});
