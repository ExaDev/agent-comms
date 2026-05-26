/**
 * RelayClient — main-thread API for the relay SharedWorker.
 *
 * Creates a SharedWorker from the built relay-worker.js bundle and
 * provides a typed interface for the React frontend to:
 *
 *   - Connect to two mesh endpoints simultaneously
 *   - Disconnect from both
 *   - Query relay status (connection state, forwarding stats)
 *   - Subscribe to real-time status updates
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RelayStatus {
  connectedA: boolean;
  connectedB: boolean;
  urlA: string | undefined;
  urlB: string | undefined;
  forwardedCount: number;
  errors: string[];
}

export type RelayStatusListener = (status: RelayStatus) => void;

// ---------------------------------------------------------------------------
// RelayClient
// ---------------------------------------------------------------------------

export class RelayClient {
  private worker: SharedWorker | undefined;
  private status: RelayStatus = {
    connectedA: false,
    connectedB: false,
    urlA: undefined,
    urlB: undefined,
    forwardedCount: 0,
    errors: [],
  };
  private readonly listeners = new Set<RelayStatusListener>();

  /** Connect to the relay SharedWorker. Idempotent. */
  connect(): void {
    if (this.worker) return;

    const worker = new SharedWorker("/relay-worker.js");
    this.worker = worker;

    worker.port.onmessage = (event: MessageEvent) => {
      const raw: unknown = JSON.parse(
        typeof event.data === "string" ? event.data : String(event.data),
      );
      if (isStatusMessage(raw)) {
        this.status = raw.status;
        this.notify();
      } else if (isErrorMessage(raw)) {
        console.error("[RelayClient]", raw.message);
      }
    };

    worker.port.start();
  }

  /** Connect the relay to two mesh WebSocket endpoints. */
  connectRelay(urlA: string, urlB: string): void {
    this.postToWorker({ type: "connect", urlA, urlB });
  }

  /** Disconnect the relay from both mesh endpoints. */
  disconnect(): void {
    this.postToWorker({ type: "disconnect" });
  }

  /** Get the current relay status (snapshot). */
  get(): Readonly<RelayStatus> {
    return this.status;
  }

  /** Subscribe to status changes. Returns an unsubscribe function. */
  subscribe(listener: RelayStatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Destroy the client and release the SharedWorker port. */
  destroy(): void {
    if (this.worker) {
      this.worker.port.close();
      this.worker = undefined;
    }
  }

  private postToWorker(msg: unknown): void {
    if (this.worker) {
      this.worker.port.postMessage(JSON.stringify(msg));
    }
  }

  private notify(): void {
    const snapshot = this.status;
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

interface StatusMessage {
  type: "status";
  status: RelayStatus;
}

interface ErrorMessage {
  type: "error";
  message: string;
}

function isStatusMessage(value: unknown): value is StatusMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as Record<string, unknown>).type === "status" &&
    "status" in value
  );
}

function isErrorMessage(value: unknown): value is ErrorMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as Record<string, unknown>).type === "error"
  );
}
