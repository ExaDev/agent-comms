/**
 * isLoopbackAddress (agent-comms#341): which dialled addresses count as reaching only this machine, and so which dialled sessions may take part in the coordinator election.
 */

import { test, expect } from "vitest";
import { isLoopbackAddress } from "../core/loopback-address.js";

test.each([
  "127.0.0.1",
  "127.255.255.254",
  "::1",
  "0:0:0:0:0:0:0:1",
  "::ffff:127.0.0.1",
])("%s is a loopback address", (host) => {
  expect(isLoopbackAddress(host)).toBe(true);
});

test.each([
  "192.168.1.20",
  "10.0.0.1",
  "128.0.0.1",
  "0.0.0.0",
  "::",
  "fe80::1",
  "::ffff:192.168.1.20",
  "localhost",
  "example.com",
])("%s is not a loopback address", (host) => {
  expect(isLoopbackAddress(host)).toBe(false);
});
