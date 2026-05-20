import { describe, it, expect, vi } from 'vitest';
import {
  PanelLeaderSyncProxy,
  connectOffscreenLeaderSyncBridge,
  type OffscreenMessageHub,
  type ActiveScoopSink,
} from '../src/leader-sync-bridge.js';
import type { LeaderSyncManager } from '../../webapp/src/scoops/tray-leader-sync.js';

function createBus() {
  type Envelope = { source: string; payload: unknown };
  const panelListeners = new Set<(e: Envelope) => void>();
  const offscreenListeners = new Set<(e: Envelope) => void>();
  return {
    panelSender: {
      send(envelope: Envelope): void {
        for (const l of offscreenListeners) l(envelope);
      },
    },
    panelSubscriber: {
      onMessage(handler: (e: Envelope) => void): () => void {
        panelListeners.add(handler);
        return () => panelListeners.delete(handler);
      },
    },
    offscreenHub: {
      sendToPanel(envelope: Envelope): void {
        for (const l of panelListeners) l(envelope);
      },
      onPanelMessage(handler: (e: Envelope) => void): () => void {
        offscreenListeners.add(handler);
        return () => offscreenListeners.delete(handler);
      },
    } satisfies OffscreenMessageHub,
  };
}

function makeMockSync() {
  return {
    broadcastSprinkleUpdate: vi.fn(),
    broadcastUserMessage: vi.fn(),
  } as unknown as LeaderSyncManager & {
    broadcastSprinkleUpdate: ReturnType<typeof vi.fn>;
    broadcastUserMessage: ReturnType<typeof vi.fn>;
  };
}

function makeMockBridge() {
  return {
    setActiveScoopJid: vi.fn(),
  } satisfies ActiveScoopSink;
}

describe('PanelLeaderSyncProxy → offscreen adapter', () => {
  it('sprinkles snapshot is cached and retrievable via getSprinkles', () => {
    const bus = createBus();
    const sync = makeMockSync();
    const bridge = makeMockBridge();
    const adapter = connectOffscreenLeaderSyncBridge(bus.offscreenHub, () => sync, bridge);
    const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
    proxy.pushSprinklesSnapshot([
      { name: 'welcome', title: 'W', path: '/w.shtml', open: true, autoOpen: false },
    ]);
    expect(adapter.getSprinkles()).toHaveLength(1);
    expect(adapter.resolveSprinklePath('welcome')).toBe('/w.shtml');
    expect(adapter.resolveSprinklePath('nope')).toBeNull();
  });

  it('sprinkle update fans to broadcastSprinkleUpdate', () => {
    const bus = createBus();
    const sync = makeMockSync();
    const bridge = makeMockBridge();
    connectOffscreenLeaderSyncBridge(bus.offscreenHub, () => sync, bridge);
    const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
    proxy.pushSprinkleUpdate('welcome', { x: 1 });
    expect(sync.broadcastSprinkleUpdate).toHaveBeenCalledWith('welcome', { x: 1 });
  });

  it('user message echo fans to broadcastUserMessage', () => {
    const bus = createBus();
    const sync = makeMockSync();
    const bridge = makeMockBridge();
    connectOffscreenLeaderSyncBridge(bus.offscreenHub, () => sync, bridge);
    const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
    proxy.pushUserMessageEcho('hi', 'm1', [{ name: 'a.png' }] as any);
    expect(sync.broadcastUserMessage).toHaveBeenCalledWith('hi', 'm1', [{ name: 'a.png' }]);
  });

  it('active-scoop write-through to bridge.setActiveScoopJid', () => {
    const bus = createBus();
    const sync = makeMockSync();
    const bridge = makeMockBridge();
    connectOffscreenLeaderSyncBridge(bus.offscreenHub, () => sync, bridge);
    const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
    proxy.pushActiveScoop('scoop-7');
    expect(bridge.setActiveScoopJid).toHaveBeenCalledWith('scoop-7');
  });

  it('detach() removes the hub listener — subsequent envelopes are no-ops', () => {
    const bus = createBus();
    const sync = makeMockSync();
    const bridge = makeMockBridge();
    const adapter = connectOffscreenLeaderSyncBridge(bus.offscreenHub, () => sync, bridge);
    adapter.detach();
    const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
    proxy.pushSprinkleUpdate('welcome', { x: 1 });
    expect(sync.broadcastSprinkleUpdate).not.toHaveBeenCalled();
  });

  it('syncRef returning null is tolerated (no throws)', () => {
    const bus = createBus();
    const bridge = makeMockBridge();
    connectOffscreenLeaderSyncBridge(bus.offscreenHub, () => null, bridge);
    const proxy = new PanelLeaderSyncProxy(bus.panelSender, bus.panelSubscriber, {});
    expect(() => proxy.pushSprinkleUpdate('welcome', null)).not.toThrow();
  });
});
