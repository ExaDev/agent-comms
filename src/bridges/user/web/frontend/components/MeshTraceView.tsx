/**
 * MeshTraceView — target picker plus live path-trace result for mesh_trace (agent-comms#201).
 *
 * Purely presentational: the trace itself (a real, on-demand network round trip rather than reactive state) is owned by the parent, which fetches on the "Trace" click and passes the outcome back down. This keeps the component trivially testable without mocking fetch.
 */

import { Badge, Button, Group, Select, Stack, Text } from "@mantine/core";
import type { MeshTraceResult } from "../types.js";

interface MeshTraceViewProps {
  targets: readonly string[];
  /** Each target's label: its display name by the shared convention (core/display-name.ts). */
  label: (deviceId: string) => string;
  selectedTarget: string | undefined;
  onSelectTarget: (deviceId: string) => void;
  onTrace: () => void;
  loading: boolean;
  error: string | undefined;
  result: MeshTraceResult | undefined;
}

function describeSide(side: Readonly<MeshTraceResult["local"]>): string {
  if (!side.relayed) return "direct";
  return side.hubAddress !== undefined
    ? `relayed via ${side.hubAddress}`
    : "relayed";
}

export function MeshTraceView({
  targets,
  label,
  selectedTarget,
  onSelectTarget,
  onTrace,
  loading,
  error,
  result,
}: MeshTraceViewProps) {
  const options = targets.map((id) => ({
    value: id,
    label: label(id),
  }));

  return (
    <Stack p="md" gap="sm">
      <Group align="flex-end" gap="xs">
        <Select
          label="Target device"
          placeholder="Choose a device"
          size="xs"
          data={options}
          value={selectedTarget ?? null}
          onChange={(value) => {
            if (value !== null) onSelectTarget(value);
          }}
        />
        <Button
          size="xs"
          disabled={selectedTarget === undefined || loading}
          loading={loading}
          onClick={onTrace}
        >
          Trace
        </Button>
      </Group>

      {error !== undefined && <Text c="red">{error}</Text>}

      {result !== undefined && (
        <Stack gap={4}>
          <Group gap="xs">
            <Badge color={result.outcome.result === "ok" ? "green" : "red"}>
              {result.outcome.result === "ok"
                ? "ok"
                : (result.outcome.code ?? "error")}
            </Badge>
            <Text size="sm">{result.rttMs}ms round trip</Text>
          </Group>
          <Text size="sm" c="dimmed">
            Local: {describeSide(result.local)}
          </Text>
          {result.remote !== undefined && (
            <Text size="sm" c="dimmed">
              Remote: {describeSide(result.remote)}
            </Text>
          )}
        </Stack>
      )}
    </Stack>
  );
}
