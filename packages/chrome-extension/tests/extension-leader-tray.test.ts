import { describe, it, expect, vi } from 'vitest';
import { startExtensionLeaderTray } from '../src/extension-leader-tray.js';
import type { LeaderSyncManagerOptions } from '../../webapp/src/scoops/tray-leader-sync.js';

function makeMockBridge(opts: { coneJid?: string; messages?: Record<string, any[]> } = {}) {
  const messages = opts.messages ?? {};
  return {
    getConeJid: vi.fn(() => opts.coneJid ?? null),
    getActiveScoopJid: vi.fn(() => null),
    setActiveScoopJid: vi.fn(),
    getMessagesForJid: vi.fn((jid: string) => messages[jid] ?? []),
    routeSprinkleLick: vi.fn(),
    notifyPanelIncomingMessage: vi.fn(),
    onAgentEvent: vi.fn(() => () => {}),
    persistScoop: vi.fn(),
    getBuffer: vi.fn((jid: string) => messages[jid] ?? []),
  };
}

function makeMockOrchestrator(scoops: any[] = []) {
  return {
    getScoops: vi.fn(() => scoops),
    handleMessage: vi.fn().mockResolvedValue(undefined),
    handleWebhookEvent: vi.fn(),
    stopScoop: vi.fn(),
    createScoopTab: vi.fn(),
  };
}

function makeMockSharedFs(files: Record<string, string> = {}) {
  return {
    readFile: vi.fn(async (path: string) => {
      if (path in files) return files[path];
      throw new Error('not found');
    }),
  };
}

function makeStubBrowser() {
  return {
    listPages: vi.fn().mockResolvedValue([]),
    setTrayTargetProvider: vi.fn(),
    getTransport: vi.fn(() => undefined),
  } as any;
}

describe('startExtensionLeaderTray — read-only callbacks', () => {
  function startWithCapture(
    overrides: Partial<Parameters<typeof startExtensionLeaderTray>[0]> = {}
  ) {
    let capturedOptions!: LeaderSyncManagerOptions;
    const orchestrator =
      overrides.orchestrator ??
      makeMockOrchestrator([{ jid: 'cone-1', name: 'cone', isCone: true, folder: 'cone' }]);
    const bridge = overrides.bridge ?? makeMockBridge({ coneJid: 'cone-1' });
    const handle = startExtensionLeaderTray({
      workerBaseUrl: 'wss://test',
      bridge: bridge as any,
      orchestrator: orchestrator as any,
      sharedFs: overrides.sharedFs ?? (makeMockSharedFs() as any),
      browser: overrides.browser ?? makeStubBrowser(),
      log: console as any,
      leaderBridge:
        overrides.leaderBridge ??
        ({
          getSprinkles: () => [],
          resolveSprinklePath: () => null,
          signalLeaderMode: vi.fn(),
          detach: vi.fn(),
        } as any),
      _trayLeaderFactory: () =>
        ({
          start: vi.fn().mockResolvedValue({}),
          stop: vi.fn(),
          clearSession: vi.fn().mockResolvedValue(undefined),
          sendControlMessage: vi.fn(),
        }) as any,
      _peerManagerFactory: () =>
        ({
          stop: vi.fn(),
          getPeers: vi.fn(() => []),
          handleControlMessage: vi.fn().mockResolvedValue(undefined),
        }) as any,
      _onSyncOptions: (opts) => {
        capturedOptions = opts;
      },
      ...overrides,
    });
    return { handle, options: capturedOptions, orchestrator, bridge };
  }

  it('getMessages reads from bridge.getMessagesForJid(activeJid)', () => {
    const bridge = makeMockBridge({
      coneJid: 'cone-1',
      messages: { 'cone-1': [{ id: 'm1', role: 'user', content: 'hi' }] },
    });
    const { handle, options } = startWithCapture({ bridge: bridge as any });
    expect(options.getMessages()).toHaveLength(1);
    handle.stop();
  });

  it('getScoops projects orchestrator scoops to ScoopSummary shape', () => {
    const orchestrator = makeMockOrchestrator([
      {
        jid: 'c',
        name: 'cone',
        isCone: true,
        folder: 'cone',
        assistantLabel: 'sliccy',
        trigger: undefined,
      },
      {
        jid: 's',
        name: 'helper',
        isCone: false,
        folder: 'helper',
        assistantLabel: 'helper',
        trigger: undefined,
      },
    ]);
    const { handle, options } = startWithCapture({ orchestrator: orchestrator as any });
    expect(options.getScoops?.()).toEqual([
      {
        jid: 'c',
        name: 'cone',
        folder: 'cone',
        isCone: true,
        assistantLabel: 'sliccy',
        trigger: undefined,
      },
      {
        jid: 's',
        name: 'helper',
        folder: 'helper',
        isCone: false,
        assistantLabel: 'helper',
        trigger: undefined,
      },
    ]);
    handle.stop();
  });

  it('readSprinkleContent looks up path via leaderBridge.resolveSprinklePath then reads sharedFs', async () => {
    const leaderBridge = {
      getSprinkles: () => [
        { name: 'w', title: 'W', path: '/welcome.shtml', open: false, autoOpen: false },
      ],
      resolveSprinklePath: (name: string) => (name === 'w' ? '/welcome.shtml' : null),
      signalLeaderMode: vi.fn(),
      detach: vi.fn(),
    };
    const sharedFs = makeMockSharedFs({ '/welcome.shtml': '<p>hi</p>' });
    const { handle, options } = startWithCapture({
      leaderBridge: leaderBridge as any,
      sharedFs: sharedFs as any,
    });
    expect(await options.readSprinkleContent?.('w')).toBe('<p>hi</p>');
    expect(await options.readSprinkleContent?.('nope')).toBeNull();
    handle.stop();
  });
});
