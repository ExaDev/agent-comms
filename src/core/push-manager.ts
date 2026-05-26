/**
 * Push subscription manager — tracks browser push subscriptions and
 * dispatches Web Push notifications when agents are offline.
 *
 * The PushManager is a standalone module — MeshStore doesn't know about it.
 * The web server bridge checks whether the target agent's WebSocket is
 * disconnected and falls back to push when a subscription exists.
 */

import type { VapidKeys } from "./vapid.js";
import { generateVapidKeys } from "./vapid.js";
import { sendWebPush, type PushSubscription, type PushPayload } from "./web-push.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { PushSubscription, PushPayload };

// ---------------------------------------------------------------------------
// PushManager
// ---------------------------------------------------------------------------

export class PushManager {
  private readonly vapidKeys: VapidKeys;
  private readonly subject: string;
  private readonly subscriptions: Map<string, PushSubscription> = new Map();

  constructor(subject = "mailto:agent-comms@localhost") {
    this.vapidKeys = generateVapidKeys();
    this.subject = subject;
  }

  /**
   * Register a push subscription for a given agent ID.
   * Overwrites any existing subscription for the same agent.
   */
  addSubscription(agentId: string, subscription: PushSubscription): void {
    this.subscriptions.set(agentId, subscription);
  }

  /**
   * Remove a push subscription.
   */
  removeSubscription(agentId: string): void {
    this.subscriptions.delete(agentId);
  }

  /**
   * Check whether a push subscription exists for the given agent.
   */
  hasSubscription(agentId: string): boolean {
    return this.subscriptions.has(agentId);
  }

  /**
   * Send a push notification to a subscribed agent.
   *
   * No-ops silently if no subscription exists — callers should check
   * hasSubscription() first if they need to distinguish the two cases.
   */
  async sendPush(agentId: string, payload: PushPayload): Promise<void> {
    const subscription = this.subscriptions.get(agentId);
    if (!subscription) return;

    await sendWebPush(subscription, payload, this.vapidKeys, this.subject);
  }

  /**
   * Get the VAPID public key for the PWA to use in `pushManager.subscribe()`.
   */
  getPublicKey(): string {
    return this.vapidKeys.publicKey;
  }
}
