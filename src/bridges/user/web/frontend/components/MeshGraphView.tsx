/**
 * MeshGraphView — force-directed rendering of the mesh's connection graph (agent-comms#201).
 *
 * Uses d3-force purely for layout: forceSimulation computes node positions, which are then rendered as plain SVG driven by React, not by d3's own DOM manipulation. The simulation is run to convergence synchronously (a fixed tick count, no requestAnimationFrame loop) so a render is a pure function of `graph` -- deterministic, and cheap enough to redo in full whenever the graph changes, matching how the rest of the mesh's live state already re-renders wholesale on every WS-driven refresh rather than patching in place.
 */

import { Box, Text } from "@mantine/core";
import { useMemo } from "react";
import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import type { MeshGraph } from "../types.js";

interface MeshGraphViewProps {
  graph: MeshGraph;
  selectedDevice: string | undefined;
  onSelectDevice: (deviceId: string) => void;
}

interface LaidOutNode extends SimulationNodeDatum {
  id: string;
}

interface LaidOutLink extends SimulationLinkDatum<LaidOutNode> {
  kind: "direct" | "relay";
}

/** Fixed simulation extent -- the SVG's own viewBox is set to match, so layout is independent of the element's actual rendered size on screen. */
const LAYOUT_WIDTH = 600;
const LAYOUT_HEIGHT = 400;

/** How many ticks to run the simulation before treating it as settled. d3-force's own alphaDecay (default ~0.0228) reaches alpha's minimum (0.001) in ~300 ticks; running a fixed, generous count synchronously is simpler and just as deterministic as watching for convergence, for a graph this small. */
const SIMULATION_TICKS = 300;

const NODE_RADIUS = 10;
/** Length of the truncated device-id hex label shown next to each node -- enough to distinguish devices at a glance without a full 64-character hash crowding the graph. */
const LABEL_HEX_LENGTH = 8;
/** Vertical gap between a node's own circle and its label, below NODE_RADIUS. */
const LABEL_OFFSET = 12;

function layoutGraph(graph: MeshGraph): {
  nodes: readonly LaidOutNode[];
  links: readonly LaidOutLink[];
} {
  const nodes: LaidOutNode[] = graph.nodes.map((id) => ({ id }));
  const links: LaidOutLink[] = graph.edges.map((edge) => ({
    source: edge.from,
    target: edge.to,
    kind: edge.kind,
  }));

  const simulation = forceSimulation(nodes)
    .force(
      "link",
      forceLink<LaidOutNode, LaidOutLink>(links).id((node) => node.id),
    )
    .force("charge", forceManyBody())
    .force("center", forceCenter(LAYOUT_WIDTH / 2, LAYOUT_HEIGHT / 2))
    .stop();

  for (let tick = 0; tick < SIMULATION_TICKS; tick++) {
    simulation.tick();
  }

  return { nodes, links };
}

/** A force-linked node's own source/target start as the plain device-id strings passed into forceLink's data; forceSimulation mutates them in place into the resolved LaidOutNode objects once the simulation runs. Narrows a link endpoint back to that resolved node so its x/y can be read for rendering. */
function resolvedNode(
  endpoint: LaidOutNode | string | number,
): LaidOutNode | undefined {
  return typeof endpoint === "object" ? endpoint : undefined;
}

export function MeshGraphView({
  graph,
  selectedDevice,
  onSelectDevice,
}: MeshGraphViewProps) {
  const { nodes, links } = useMemo(() => layoutGraph(graph), [graph]);

  if (nodes.length === 0) {
    return (
      <Text c="dimmed" p="md">
        No known devices in the mesh graph.
      </Text>
    );
  }

  return (
    <Box p="md">
      <svg
        role="img"
        aria-label="Mesh connection graph"
        viewBox={`0 0 ${String(LAYOUT_WIDTH)} ${String(LAYOUT_HEIGHT)}`}
        width="100%"
        style={{ maxHeight: LAYOUT_HEIGHT }}
      >
        {links.map((link) => {
          const source = resolvedNode(link.source);
          const target = resolvedNode(link.target);
          if (!source || !target) return null;
          return (
            <line
              key={`${source.id}-${target.id}`}
              x1={source.x}
              y1={source.y}
              x2={target.x}
              y2={target.y}
              stroke="var(--mantine-color-dark-3)"
              strokeWidth={1.5}
              strokeDasharray={link.kind === "relay" ? "4 3" : undefined}
            />
          );
        })}
        {nodes.map((node) => (
          <g
            key={node.id}
            transform={`translate(${String(node.x ?? 0)}, ${String(node.y ?? 0)})`}
            onClick={() => {
              onSelectDevice(node.id);
            }}
            style={{ cursor: "pointer" }}
            role="button"
            aria-label={`Device ${node.id}`}
          >
            <circle
              r={NODE_RADIUS}
              fill={
                node.id === selectedDevice
                  ? "var(--mantine-color-accent-5)"
                  : "var(--mantine-color-dark-2)"
              }
              stroke="var(--mantine-color-accent-5)"
              strokeWidth={node.id === selectedDevice ? 2 : 0}
            />
            <text
              y={NODE_RADIUS + LABEL_OFFSET}
              textAnchor="middle"
              fontSize={10}
              fill="var(--mantine-color-text)"
            >
              {node.id.slice(0, LABEL_HEX_LENGTH)}
            </text>
          </g>
        ))}
      </svg>
    </Box>
  );
}
