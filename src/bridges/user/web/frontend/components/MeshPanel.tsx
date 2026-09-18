/**
 * MeshPanel — the mesh view: connection graph plus path-trace (agent-comms#201).
 *
 * Both the graph and the trace are genuine one-shot reads (agent-comms#206): the graph has no real-time channel of its own, and a trace is a single on-demand network round trip, not reactive state. useQuery/useMutation own their own loading/error/result lifecycles here, replacing what used to be three separate hand-rolled useState calls for the trace and a manually-refreshed prop for the graph.
 */

import { Stack, Tabs, Text } from "@mantine/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { MeshClient } from "../mesh-client.js";
import { MeshGraphView } from "./MeshGraphView.js";
import { MeshTraceView } from "./MeshTraceView.js";

interface MeshPanelProps {
  /** Narrowed to just the two utils this component actually uses, the same Pick-based narrowing dispatch-action.ts's ActionDispatchClient already established for the same "component/function only needs a slice of the full client" shape. */
  queryUtils: Pick<MeshClient["queryUtils"], "getMeshGraph" | "getMeshTrace">;
}

export function MeshPanel({ queryUtils }: MeshPanelProps) {
  const [selectedTarget, setSelectedTarget] = useState<string | undefined>(
    undefined,
  );
  const graphQuery = useQuery(queryUtils.getMeshGraph.queryOptions());
  const traceMutation = useMutation(queryUtils.getMeshTrace.mutationOptions());

  function handleTrace(): void {
    if (selectedTarget === undefined) return;
    traceMutation.mutate({ target: selectedTarget });
  }

  const graph = graphQuery.data;
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
            loading={traceMutation.isPending}
            error={
              traceMutation.error !== null
                ? traceMutation.error instanceof Error
                  ? traceMutation.error.message
                  : "Unknown error"
                : undefined
            }
            result={traceMutation.data}
          />
        </Stack>
      </Tabs.Panel>
    </Tabs>
  );
}
