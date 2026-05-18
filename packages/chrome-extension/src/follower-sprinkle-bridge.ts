/**
 * Panel ↔ offscreen bridge for follower-mode sprinkle sync.
 *
 * The real `FollowerSyncManager` lives in the offscreen document (because the
 * agent / signaling / WebRTC live there, surviving side-panel close). But the
 * sprinkle renderer needs DOM, so the panel does the actual rendering via the
 * shared `SprinkleFollowerController`. This bridge connects the two halves
 * over `chrome.runtime` messages:
 *
 *   - **Offscreen → panel**: `follower-sprinkles-list`, `follower-sprinkle-update`,
 *     `follower-sprinkle-fetch-result` — the controller reconciles open state and
 *     resolves outstanding fetches.
 *   - **Panel → offscreen**: `follower-sprinkle-fetch`, `follower-sprinkle-lick`
 *     — the offscreen invokes its `FollowerSyncManager` and dispatches over the
 *     WebRTC data channel.
 *
 * The two helpers in this file form symmetrical halves of the wire:
 *
 *   - `PanelFollowerSprinkleProxy` (panel-side `SprinkleFollowerSync`)
 *   - `connectOffscreenFollowerSprinkleBridge` (offscreen-side adapter)
 *
 * Both are intentionally side-effect-free at the module level so they can be
 * exercised under jsdom without a real Chrome runtime.
 */

import type {
  FollowerSprinkleFetchRequestMsg,
  FollowerSprinkleFetchResultMsg,
  FollowerSprinkleLickMsg,
  FollowerSprinklesListMsg,
  FollowerSprinkleUpdateMsg,
} from './messages.js';
import type { SprinkleFollowerSync } from '../../../packages/webapp/src/ui/sprinkle-follower-controller.js';
import type { SprinkleSummary } from '../../../packages/webapp/src/scoops/tray-sync-protocol.js';

/**
 * Generic chrome.runtime sender — kept narrow so tests can substitute a
 * synchronous in-memory pipe.
 */
export interface PanelMessageSender {
  send(envelope: { source: 'panel'; payload: unknown }): void;
}

/**
 * Subscription helper — returns an unsubscribe handle. The panel transport
 * already exposes `onMessage`; tests provide a fake.
 */
export interface PanelMessageSubscriber {
  onMessage(handler: (envelope: { source: string; payload: unknown }) => void): () => void;
}

/**
 * Panel-side proxy that implements `SprinkleFollowerSync` by routing every
 * request through the panel↔offscreen runtime channel.
 *
 * The controller calls `fetchSprinkleContent` and `sendSprinkleLick`; the
 * proxy serializes the request, waits for a matching `follower-sprinkle-fetch-result`
 * envelope, and resolves / rejects the pending promise. Lick messages are
 * fire-and-forget — the leader's lick router owns the result.
 */
export class PanelFollowerSprinkleProxy implements SprinkleFollowerSync {
  private readonly pending = new Map<
    string,
    { resolve: (content: string) => void; reject: (err: Error) => void }
  >();
  private nextId = 1;

  constructor(
    private readonly sender: PanelMessageSender,
    subscriber: PanelMessageSubscriber,
    private readonly listeners: {
      onSprinklesList?: (sprinkles: SprinkleSummary[]) => void;
      onSprinkleUpdate?: (sprinkleName: string, data: unknown) => void;
    } = {}
  ) {
    this.unsubscribe = subscriber.onMessage((envelope) => {
      if (envelope.source !== 'offscreen') return;
      const payload = envelope.payload as { type?: string };
      if (!payload || typeof payload.type !== 'string') return;

      switch (payload.type) {
        case 'follower-sprinkles-list': {
          const msg = payload as FollowerSprinklesListMsg;
          this.listeners.onSprinklesList?.(msg.sprinkles);
          break;
        }
        case 'follower-sprinkle-update': {
          const msg = payload as FollowerSprinkleUpdateMsg;
          this.listeners.onSprinkleUpdate?.(msg.sprinkleName, msg.data);
          break;
        }
        case 'follower-sprinkle-fetch-result': {
          const msg = payload as FollowerSprinkleFetchResultMsg;
          const pending = this.pending.get(msg.id);
          if (!pending) return;
          this.pending.delete(msg.id);
          if (msg.error !== undefined) pending.reject(new Error(msg.error));
          else if (msg.content !== undefined) pending.resolve(msg.content);
          else pending.reject(new Error('Empty follower-sprinkle-fetch-result'));
          break;
        }
      }
    });
  }

  fetchSprinkleContent(sprinkleName: string): Promise<string> {
    const id = `panel-${Date.now()}-${this.nextId++}`;
    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const payload: FollowerSprinkleFetchRequestMsg = {
        type: 'follower-sprinkle-fetch',
        id,
        sprinkleName,
      };
      this.sender.send({ source: 'panel', payload });
    });
  }

  sendSprinkleLick(sprinkleName: string, body: unknown, targetScoop?: string): void {
    const payload: FollowerSprinkleLickMsg = {
      type: 'follower-sprinkle-lick',
      sprinkleName,
      body,
      targetScoop,
    };
    this.sender.send({ source: 'panel', payload });
  }

  /** Reject every outstanding fetch and stop listening. */
  dispose(): void {
    this.unsubscribe();
    const err = new Error('PanelFollowerSprinkleProxy disposed');
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
  }

  private readonly unsubscribe: () => void;
}

/**
 * Offscreen-side adapter: subscribes to `chrome.runtime.onMessage` for
 * panel→offscreen sprinkle follower ops and routes them through the supplied
 * `FollowerSyncManager`-like surface. Also pushes `sprinkles.list` /
 * `sprinkle.update` payloads from the leader back to the panel as runtime
 * messages.
 *
 * Returned `detach()` cancels both directions — call it when the active
 * follower sync changes (e.g. the data channel closed and a new one is
 * starting) so a stale leader's payloads don't leak into the panel.
 */
export interface OffscreenFollowerSprinkleSync {
  fetchSprinkleContent(sprinkleName: string): Promise<string>;
  sendSprinkleLick(sprinkleName: string, body: unknown, targetScoop?: string): void;
}

export interface OffscreenMessageHub {
  /** Send an envelope to the side panel (and any other panel-like consumers). */
  sendToPanel(envelope: { source: 'offscreen'; payload: unknown }): void;
  /** Subscribe to incoming panel envelopes. */
  onPanelMessage(handler: (envelope: { source: string; payload: unknown }) => void): () => void;
}

export interface OffscreenFollowerSprinkleBridgeHandle {
  /** Push a `sprinkles.list` from the active leader connection to the panel. */
  forwardSprinklesList(sprinkles: SprinkleSummary[]): void;
  /** Push a `sprinkle.update` from the active leader connection to the panel. */
  forwardSprinkleUpdate(sprinkleName: string, data: unknown): void;
  /** Tear down the listener registered against the message hub. */
  detach(): void;
}

export function connectOffscreenFollowerSprinkleBridge(
  hub: OffscreenMessageHub,
  sync: OffscreenFollowerSprinkleSync
): OffscreenFollowerSprinkleBridgeHandle {
  const off = hub.onPanelMessage((envelope) => {
    if (envelope.source !== 'panel') return;
    const payload = envelope.payload as { type?: string };
    if (!payload || typeof payload.type !== 'string') return;

    switch (payload.type) {
      case 'follower-sprinkle-fetch': {
        const msg = payload as FollowerSprinkleFetchRequestMsg;
        sync
          .fetchSprinkleContent(msg.sprinkleName)
          .then((content) => {
            const reply: FollowerSprinkleFetchResultMsg = {
              type: 'follower-sprinkle-fetch-result',
              id: msg.id,
              content,
            };
            hub.sendToPanel({ source: 'offscreen', payload: reply });
          })
          .catch((err: unknown) => {
            const reply: FollowerSprinkleFetchResultMsg = {
              type: 'follower-sprinkle-fetch-result',
              id: msg.id,
              error: err instanceof Error ? err.message : String(err),
            };
            hub.sendToPanel({ source: 'offscreen', payload: reply });
          });
        break;
      }
      case 'follower-sprinkle-lick': {
        const msg = payload as FollowerSprinkleLickMsg;
        sync.sendSprinkleLick(msg.sprinkleName, msg.body, msg.targetScoop);
        break;
      }
    }
  });

  return {
    forwardSprinklesList(sprinkles) {
      const payload: FollowerSprinklesListMsg = {
        type: 'follower-sprinkles-list',
        sprinkles,
      };
      hub.sendToPanel({ source: 'offscreen', payload });
    },
    forwardSprinkleUpdate(sprinkleName, data) {
      const payload: FollowerSprinkleUpdateMsg = {
        type: 'follower-sprinkle-update',
        sprinkleName,
        data,
      };
      hub.sendToPanel({ source: 'offscreen', payload });
    },
    detach() {
      off();
    },
  };
}
