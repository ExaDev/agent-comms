/**
 * MessageList — scrollable message area with auto-scroll.
 */

import { ScrollArea, Stack } from "@mantine/core";
import { useEffect, useRef } from "react";
import type { DisplayMessage } from "../types.js";
import { Message } from "./Message.js";

export function MessageList({
  messages,
}: {
  messages: readonly DisplayMessage[];
}) {
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [messages.length]);

  return (
    <ScrollArea
      flex={1}
      p="md"
      viewportRef={viewportRef}
      aria-label="Conversation"
    >
      <Stack gap={4}>
        {messages.map((msg, i) => (
          <Message key={i} message={msg} />
        ))}
      </Stack>
    </ScrollArea>
  );
}
