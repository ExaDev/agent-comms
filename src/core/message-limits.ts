/**
 * The size limit shared by every path that takes message text from outside this process: the web bridge's HTTP bodies and WebSocket messages, and the `content` of a message sent through the MCP tool.
 */

import { CommsError } from "./store.js";

const BYTES_PER_KIB = 1024;
const KIB_PER_MIB = 1024;

/**
 * The most bytes the bridge reads from one HTTP request body, accepts in one dashboard WebSocket message, and accepts as the content of one message sent through the tool.
 *
 * The largest legitimate input is a chat message a person typed or pasted. One mebibyte holds a pasted document of several hundred thousand characters, even with every character escaped in a JSON action, which is well beyond anything a conversation carries, while keeping what one request can make the bridge hold in memory small. Every other request the dashboard sends (room, agent and read calls) is a few hundred bytes.
 */
export const MAX_MESSAGE_BYTES = KIB_PER_MIB * BYTES_PER_KIB;

/** The `code` of the error raised for message content over MAX_MESSAGE_BYTES. */
export const MESSAGE_TOO_LARGE = "MESSAGE_TOO_LARGE";

/** Throws a CommsError, before anything is sent, when `content` is longer than MAX_MESSAGE_BYTES in UTF-8. The text of the error states the limit and the size, never the content. */
export function requireMessageWithinLimit(content: string): void {
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > MAX_MESSAGE_BYTES) {
    throw new CommsError(
      `The message is ${String(bytes)} bytes and the limit is ${String(MAX_MESSAGE_BYTES)} bytes; nothing was sent. Send it in shorter parts.`,
      MESSAGE_TOO_LARGE,
    );
  }
}
