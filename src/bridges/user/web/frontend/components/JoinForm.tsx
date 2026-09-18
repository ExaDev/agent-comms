/**
 * JoinForm — inline form for joining a room by name.
 */

import { Box } from "@mantine/core";
import { SubmitRow } from "web-ui-primitives";

interface JoinFormProps {
  visible: boolean;
  onSubmit: (roomName: string) => void;
  onCancel: () => void;
}

export function JoinForm({ visible, onSubmit, onCancel }: JoinFormProps) {
  if (!visible) return null;

  return (
    <Box py={4}>
      <SubmitRow
        ariaLabel="Room name"
        placeholder="Room name..."
        submitLabel="Join"
        size="xs"
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    </Box>
  );
}
