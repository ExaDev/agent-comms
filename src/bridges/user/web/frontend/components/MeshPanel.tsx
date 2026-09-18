/**
 * MeshPanel — the mesh view: connection graph plus path-trace (agent-comms#201).
 *
 * Owns the trace request lifecycle (loading/error/result) since it's a genuine on-demand network round trip, not reactive state the way agents/rooms/the graph itself are. Clicking a node in the graph selects it as the trace target, so the two sub-views share one selection.
 */

import { Stack, Tabs, Text } from "@mantine/core";
import { useState } from "react";
import { fetchMeshTrace } from "../api.js";
import type { MeshGraph, MeshTraceResult } from "../types.js";
import { MeshGraphView } from "./MeshGraphView.js";
import { MeshTraceView } from "./MeshTraceView.js";

interface MeshPanelProps {
  graph: MeshGraph | undefined;
}

export function MeshPanel({ graph }: MeshPanelProps) {
  const [selectedTarget, setSelectedTarget] = useState<string | undefined>(
    undefined,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<MeshTraceResult | undefined>(undefined);

  function handleTrace(): void {
    if (selectedTarget === undefined) return;
    setLoading(true);
    setError(undefined);
    setResult(undefined);
    fetchMeshTrace(selectedTarget)
      .then((traceResult) => {
        setResult(traceResult);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setLoading(false);
      });
  }

  if (graph === undefined) {
    return (
      <Text c="dimmed" p="md">
        Mesh graph is not available on this connection.
      </Text>
    );
  }

  return (
    <Tabs defaultValue="graph">
      <Tabs.List>
        <Tabs.Tab value="graph">Graph</Tabs.Tab>
        <Tabs.Tab value="trace">Trace</Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="graph">
        <MeshGraphView
          graph={graph}
          selectedDevice={selectedTarget}
          onSelectDevice={setSelectedTarget}
        />
      </Tabs.Panel>
      <Tabs.Panel value="trace">
        <Stack>
          <MeshTraceView
            targets={graph.nodes}
            selectedTarget={selectedTarget}
            onSelectTarget={setSelectedTarget}
            onTrace={handleTrace}
            loading={loading}
            error={error}
            result={result}
          />
        </Stack>
      </Tabs.Panel>
    </Tabs>
  );
}
