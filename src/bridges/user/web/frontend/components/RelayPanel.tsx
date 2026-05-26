/**
 * RelayPanel — UI for configuring the PWA mesh relay.
 *
 * Provides input fields for two mesh WebSocket URLs, connect/disconnect
 * controls, and a live status display showing connection state and
 * forwarding statistics.
 */

import { useState, useEffect } from "preact/hooks";
import type { RelayStatus } from "../relay-client.js";

export interface RelayPanelProps {
  status: RelayStatus;
  onConnect: (urlA: string, urlB: string) => void;
  onDisconnect: () => void;
}

export function RelayPanel({ status, onConnect, onDisconnect }: RelayPanelProps) {
  const [urlA, setUrlA] = useState(status.urlA ?? "ws://localhost:8080/ws/mesh");
  const [urlB, setUrlB] = useState(status.urlB ?? "ws://localhost:8081/ws/mesh");
  const [expanded, setExpanded] = useState(false);

  const bothConnected = status.connectedA && status.connectedB;
  const eitherConnected = status.connectedA || status.connectedB;

  // Sync URL fields when the relay reports new URLs (e.g. after reconnect)
  useEffect(() => {
    if (status.urlA) setUrlA(status.urlA);
    if (status.urlB) setUrlB(status.urlB);
  }, [status.urlA, status.urlB]);

  if (!expanded) {
    return (
      <div class="relay-panel relay-collapsed">
        <button
          class="relay-toggle-btn"
          onClick={() => { setExpanded(true); }}
        >
          ⤺ Relay
          {bothConnected && <span class="relay-badge relay-badge-green">●</span>}
          {eitherConnected && !bothConnected && <span class="relay-badge relay-badge-yellow">●</span>}
          {status.forwardedCount > 0 && (
            <span class="relay-count">{status.forwardedCount}</span>
          )}
        </button>
      </div>
    );
  }

  const handleConnect = (e: Event) => {
    e.preventDefault();
    if (urlA.trim() && urlB.trim()) {
      onConnect(urlA.trim(), urlB.trim());
    }
  };

  return (
    <div class="relay-panel">
      <div class="relay-header">
        <span class="relay-title">Mesh Relay</span>
        <button
          class="relay-collapse-btn"
          onClick={() => { setExpanded(false); }}
          title="Collapse relay panel"
        >
          ✕
        </button>
      </div>

      <form class="relay-form" onSubmit={handleConnect}>
        <label class="relay-label">
          Mesh A
          <input
            type="url"
            class="relay-input"
            placeholder="ws://machine-a:8080/ws/mesh"
            value={urlA}
            onInput={(e) => {
              const target = e.target;
              if (target instanceof HTMLInputElement) setUrlA(target.value);
            }}
            disabled={eitherConnected}
          />
          <span class={`relay-status-dot ${status.connectedA ? "active" : ""}`} />
        </label>

        <label class="relay-label">
          Mesh B
          <input
            type="url"
            class="relay-input"
            placeholder="ws://machine-b:8080/ws/mesh"
            value={urlB}
            onInput={(e) => {
              const target = e.target;
              if (target instanceof HTMLInputElement) setUrlB(target.value);
            }}
            disabled={eitherConnected}
          />
          <span class={`relay-status-dot ${status.connectedB ? "active" : ""}`} />
        </label>

        <div class="relay-actions">
          {!eitherConnected ? (
            <button type="submit" class="relay-connect-btn" disabled={!urlA.trim() || !urlB.trim()}>
              Connect
            </button>
          ) : (
            <button type="button" class="relay-disconnect-btn" onClick={onDisconnect}>
              Disconnect
            </button>
          )}
        </div>
      </form>

      {eitherConnected && (
        <div class="relay-stats">
          <span class="relay-stat">Forwarded: {status.forwardedCount}</span>
          <span class="relay-stat">
            A: {status.connectedA ? "connected" : "disconnected"}
          </span>
          <span class="relay-stat">
            B: {status.connectedB ? "connected" : "disconnected"}
          </span>
        </div>
      )}

      {status.errors.length > 0 && (
        <div class="relay-errors">
          {status.errors.slice(-3).map((err, i) => (
            <div key={i} class="relay-error">{err}</div>
          ))}
        </div>
      )}
    </div>
  );
}
