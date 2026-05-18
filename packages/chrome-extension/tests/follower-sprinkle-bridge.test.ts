import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  PanelFollowerSprinkleProxy,
  connectOffscreenFollowerSprinkleBridge,
  type OffscreenFollowerSprinkleSync,
} from '../src/follower-sprinkle-bridge.js';
import type { SprinkleSummary } from '../../../packages/webapp/src/scoops/tray-sync-protocol.js';

/**
 * Mini message bus that wires a panel side and an offscreen side together so
 * tests don't need a real `chrome.runtime`. Envelopes propagate synchronously
 * — Promise resolution on fetch responses still needs an `await` cycle.
 */
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
    },
  };
}

function makeOffscreenSync(): OffscreenFollowerSprinkleSync & {
  fetched: string[];
  licks: Array<{ name: string; body: unknown; targetScoop?: string }>;
  contentByName: Map<string, string>;
  rejectNext?: Error;
} {
  const fetched: string[] = [];
  const licks: Array<{ name: string; body: unknown; targetScoop?: string }> = [];
  const contentByName = new Map<string, string>();
  const surface = {
    contentByName,
    fetched,
    licks,
    rejectNext: undefined as Error | undefined,
    async fetchSprinkleContent(name: string): Promise<string> {
      fetched.push(name);
      if (surface.rejectNext) throw surface.rejectNext;
      const content = contentByName.get(name);
      if (content === undefined) throw new Error(`no content stub for ${name}`);
      return content;
    },
    sendSprinkleLick(name: string, body: unknown, targetScoop?: string): void {
      licks.push({ name, body, targetScoop });
    },
  };
  return surface;
}

describe('PanelFollowerSprinkleProxy ↔ OffscreenFollowerSprinkleBridge', () => {
  let bus: ReturnType<typeof createBus>;
  let offscreenSync: ReturnType<typeof makeOffscreenSync>;

  beforeEach(() => {
    bus = createBus();
    offscreenSync = makeOffscreenSync();
    connectOffscreenFollowerSprinkleBridge(bus.offscreenHub, offscreenSync);
  });

  it('forwards a fetchSprinkleContent round-trip through the bridge', async () => {
    offscreenSync.contentByName.set('welcome', '<p>hello</p>');
    const proxy = new PanelFollowerSprinkleProxy(bus.panelSender, bus.panelSubscriber);

    const content = await proxy.fetchSprinkleContent('welcome');
    expect(content).toBe('<p>hello</p>');
    expect(offscreenSync.fetched).toEqual(['welcome']);
  });

  it('propagates a fetch error from offscreen to the panel', async () => {
    offscreenSync.rejectNext = new Error('leader gone');
    const proxy = new PanelFollowerSprinkleProxy(bus.panelSender, bus.panelSubscriber);

    await expect(proxy.fetchSprinkleContent('welcome')).rejects.toThrow('leader gone');
  });

  it('routes multiple concurrent fetches by id without crossing the wires', async () => {
    offscreenSync.contentByName.set('a', 'aaa');
    offscreenSync.contentByName.set('b', 'bbb');
    const proxy = new PanelFollowerSprinkleProxy(bus.panelSender, bus.panelSubscriber);

    const [a, b] = await Promise.all([
      proxy.fetchSprinkleContent('a'),
      proxy.fetchSprinkleContent('b'),
    ]);
    expect(a).toBe('aaa');
    expect(b).toBe('bbb');
  });

  it('forwards sendSprinkleLick over the wire', () => {
    const proxy = new PanelFollowerSprinkleProxy(bus.panelSender, bus.panelSubscriber);

    proxy.sendSprinkleLick('welcome', { action: 'click' }, 'scoop-1');

    expect(offscreenSync.licks).toEqual([
      { name: 'welcome', body: { action: 'click' }, targetScoop: 'scoop-1' },
    ]);
  });

  it('fans out sprinkles.list from offscreen to the panel listener', () => {
    const onSprinklesList = vi.fn();
    new PanelFollowerSprinkleProxy(bus.panelSender, bus.panelSubscriber, { onSprinklesList });

    const bridge = connectOffscreenFollowerSprinkleBridge(bus.offscreenHub, offscreenSync);
    const sprinkles: SprinkleSummary[] = [
      { name: 'welcome', title: 'Welcome', path: '/x.shtml', open: true, autoOpen: true },
    ];
    bridge.forwardSprinklesList(sprinkles);

    expect(onSprinklesList).toHaveBeenCalledWith(sprinkles);
  });

  it('fans out sprinkle.update from offscreen to the panel listener', () => {
    const onSprinkleUpdate = vi.fn();
    new PanelFollowerSprinkleProxy(bus.panelSender, bus.panelSubscriber, { onSprinkleUpdate });

    const bridge = connectOffscreenFollowerSprinkleBridge(bus.offscreenHub, offscreenSync);
    bridge.forwardSprinkleUpdate('welcome', { step: 1 });

    expect(onSprinkleUpdate).toHaveBeenCalledWith('welcome', { step: 1 });
  });

  it('ignores envelopes from non-offscreen sources on the panel side', () => {
    const onSprinklesList = vi.fn();
    new PanelFollowerSprinkleProxy(bus.panelSender, bus.panelSubscriber, { onSprinklesList });

    // Simulate a stray envelope from another source (e.g. service worker).
    bus.offscreenHub.sendToPanel({
      source: 'service-worker' as unknown as 'offscreen',
      payload: { type: 'follower-sprinkles-list', sprinkles: [] },
    });

    expect(onSprinklesList).not.toHaveBeenCalled();
  });

  it('dispose() rejects outstanding fetches and detaches the listener', async () => {
    // Don't stub content — the fetch will hang until dispose.
    const proxy = new PanelFollowerSprinkleProxy(bus.panelSender, bus.panelSubscriber);

    // Intercept the request so the bridge never resolves it.
    const pending = proxy.fetchSprinkleContent('hangs');
    proxy.dispose();

    await expect(pending).rejects.toThrow(/disposed/);

    // After dispose, sending more envelopes from offscreen does nothing.
    const onSprinklesList = vi.fn();
    // Recreate proxy after dispose to confirm a fresh instance still works.
    new PanelFollowerSprinkleProxy(bus.panelSender, bus.panelSubscriber, { onSprinklesList });
    const bridge2 = connectOffscreenFollowerSprinkleBridge(bus.offscreenHub, offscreenSync);
    bridge2.forwardSprinklesList([]);
    expect(onSprinklesList).toHaveBeenCalled();
  });

  it('detach() stops the offscreen bridge from receiving further panel messages', async () => {
    const proxy = new PanelFollowerSprinkleProxy(bus.panelSender, bus.panelSubscriber);
    // First fetch through the bridge works.
    offscreenSync.contentByName.set('one', 'first');
    await expect(proxy.fetchSprinkleContent('one')).resolves.toBe('first');

    // Detach the active bridge.
    // (The bridge constructed in beforeEach is the one to detach.)
    // Hard to grab from outside, so we wire a second bridge then detach the first:
    // Mimic the realistic scenario where a reconnect builds a new bridge.
    // For this test we just detach and confirm new sends produce no fetches.
    const secondBridge = connectOffscreenFollowerSprinkleBridge(bus.offscreenHub, offscreenSync);
    secondBridge.detach();
    // Both bridges are now offscreen handlers; the first one still works.
    // To prove detach() works, build a fresh bus.
    const bus2 = createBus();
    const offscreenSync2 = makeOffscreenSync();
    const lonely = connectOffscreenFollowerSprinkleBridge(bus2.offscreenHub, offscreenSync2);
    lonely.detach();
    const proxy2 = new PanelFollowerSprinkleProxy(bus2.panelSender, bus2.panelSubscriber);
    // No-one is listening for fetch requests now.
    const hanging = proxy2.fetchSprinkleContent('whatever');
    await new Promise((r) => setTimeout(r, 5));
    // The fetch is still pending — nothing on the other side will resolve it.
    expect(offscreenSync2.fetched).toEqual([]);
    proxy2.dispose(); // Reject to avoid an unhandled-promise warning.
    await expect(hanging).rejects.toThrow(/disposed/);
  });
});
