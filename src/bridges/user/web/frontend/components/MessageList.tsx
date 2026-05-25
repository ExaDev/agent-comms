/**
 * MessageList — scrollable message area with auto-scroll.
 */

import { useRef, useEffect } from "preact/hooks";
import type { DisplayMessage } from "../types.js";
import { Message } from "./Message.js";

export function MessageList({ messages }: { messages: DisplayMessage[] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [messages.length]);

  return (
    <div id="messages" ref={ref}>
      {messages.map((msg, i) => (
        <Message key={i} message={msg} />
      ))}
    </div>
  );
}
