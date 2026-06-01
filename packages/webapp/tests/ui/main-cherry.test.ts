// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Shared, per-test-mutable control surface for the mocked CDP layer. Declared
// via vi.hoisted so the vi.mock factories below (hoisted above imports) can
// reference it safely.
const mockState = vi.hoisted(() => ({
  transportConfig: {
    joinUrl: null as string | null,
    provisioningAuth: null as {
      token: string;
      coneName?: string;
      createIfMissing?: boolean;
    } | null,
    connect: vi.fn(async () => {}),
  },
  browserConnect: vi.fn(async () => {}),
}));

vi.mock('../../src/cdp/cherry-host-transport.js', () => ({
  // Regular function (not arrow) so it is constructable with `new`.
  CherryHostTransport: vi.fn(function () {
    return {
      connect: () => mockState.transportConfig.connect(),
      get joinUrl() {
        return mockState.transportConfig.joinUrl;
      },
      get provisioningAuth() {
        return mockState.transportConfig.provisioningAuth;
      },
    };
  }),
}));

vi.mock('../../src/cdp/index.js', () => ({
  BrowserAPI: vi.fn(function (transport: unknown) {
    return { __transport: transport, connect: mockState.browserConnect };
  }),
}));

import { resolveCherryJoinUrl, setupCherryFollower } from '../../src/ui/main-cherry.js';

const TOKEN = 'ims-token-xyz-secret';

type FetchCall = { url: string; init?: RequestInit };

/** Install a recording fetch stub driven by a per-URL responder. */
function installFetch(
  responder: (url: string) => { ok: boolean; status?: number; body?: unknown }
): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const r = responder(url);
      return {
        ok: r.ok,
        status: r.status ?? (r.ok ? 200 : 500),
        json: async () => r.body,
      } as Response;
    })
  );
  return calls;
}

function authHeaderOf(init?: RequestInit): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.Authorization;
}

describe('resolveCherryJoinUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('returns the joinUrl directly for a running cone (single list call)', async () => {
    const calls = installFetch(() => ({
      ok: true,
      body: [{ name: 'cone-a', status: 'running', joinUrl: 'https://app/run' }],
    }));
    const url = await resolveCherryJoinUrl({ token: TOKEN, coneName: 'cone-a' });
    expect(url).toBe('https://app/run');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/cloud/list?json=true');
  });

  it('resumes a paused cone and returns the resumed joinUrl', async () => {
    const calls = installFetch((u) =>
      u.startsWith('/api/cloud/list')
        ? { ok: true, body: [{ name: 'cone-a', status: 'paused', sandboxId: 'sb1' }] }
        : { ok: true, body: { joinUrl: 'https://app/resumed' } }
    );
    const url = await resolveCherryJoinUrl({ token: TOKEN, coneName: 'cone-a' });
    expect(url).toBe('https://app/resumed');
    expect(calls.map((c) => c.url)).toEqual([
      '/api/cloud/list?json=true',
      '/api/cloud/resume?json=true',
    ]);
    expect(JSON.parse(calls[1]!.init!.body as string)).toEqual({ sandboxId: 'sb1' });
  });

  it('starts a new cone when none matches and createIfMissing is true', async () => {
    const calls = installFetch((u) =>
      u.startsWith('/api/cloud/list')
        ? { ok: true, body: [] }
        : { ok: true, body: { joinUrl: 'https://app/new' } }
    );
    const url = await resolveCherryJoinUrl({
      token: TOKEN,
      coneName: 'cone-z',
      createIfMissing: true,
    });
    expect(url).toBe('https://app/new');
    expect(calls[1]!.url).toBe('/api/cloud/start?json=true');
    expect(JSON.parse(calls[1]!.init!.body as string)).toEqual({ name: 'cone-z' });
  });

  it('throws when no cone matches and createIfMissing is false', async () => {
    installFetch(() => ({ ok: true, body: [] }));
    await expect(resolveCherryJoinUrl({ token: TOKEN, coneName: 'cone-z' })).rejects.toThrow(
      /no matching cone/i
    );
  });

  it('throws with the status when /api/cloud/list fails', async () => {
    installFetch(() => ({ ok: false, status: 503 }));
    await expect(resolveCherryJoinUrl({ token: TOKEN, coneName: 'cone-a' })).rejects.toThrow(
      /list failed \(503\)/
    );
  });

  it('INVARIANT: the IMS token only ever rides in the Authorization header of same-origin /api/cloud/* calls, and is never persisted', async () => {
    const calls = installFetch((u) =>
      u.startsWith('/api/cloud/list')
        ? { ok: true, body: [{ name: 'cone-a', status: 'paused', sandboxId: 'sb1' }] }
        : { ok: true, body: { joinUrl: 'https://app/resumed?t=leadertoken' } }
    );
    await resolveCherryJoinUrl({ token: TOKEN, coneName: 'cone-a' });

    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      // Same-origin relative path — never an absolute/third-party URL.
      expect(c.url.startsWith('/api/cloud/')).toBe(true);
      // The token rides only in the Authorization header...
      expect(authHeaderOf(c.init)).toBe(`Bearer ${TOKEN}`);
      // ...and never in the URL (no query-string/path leak).
      expect(c.url).not.toContain(TOKEN);
      // ...and never in the request body.
      expect(String(c.init?.body ?? '')).not.toContain(TOKEN);
    }
    // The token is never written to browser storage.
    const dump = JSON.stringify(
      Object.fromEntries(
        Array.from({ length: localStorage.length }, (_, i) => {
          const k = localStorage.key(i)!;
          return [k, localStorage.getItem(k)];
        })
      )
    );
    expect(dump).not.toContain(TOKEN);
  });
});

describe('setupCherryFollower', () => {
  beforeEach(() => {
    mockState.transportConfig.joinUrl = null;
    mockState.transportConfig.provisioningAuth = null;
    mockState.transportConfig.connect.mockClear();
    mockState.browserConnect.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the handshake joinUrl and does NOT re-connect the already-connected transport (I3)', async () => {
    mockState.transportConfig.joinUrl = 'https://app/handshake';
    const result = await setupCherryFollower();
    expect(result.joinUrl).toBe('https://app/handshake');
    // BrowserAPI wraps the connected transport; the redundant browser.connect()
    // that previously always threw "state is connected" must not be called.
    expect(mockState.browserConnect).not.toHaveBeenCalled();
    expect((result.browser as unknown as { __transport: unknown }).__transport).toBe(
      result.transport
    );
  });

  it('provisions a joinUrl from the handshake auth when no joinUrl was supplied', async () => {
    mockState.transportConfig.provisioningAuth = {
      token: TOKEN,
      coneName: 'cone-a',
      createIfMissing: true,
    };
    installFetch(() => ({
      ok: true,
      body: [{ name: 'cone-a', status: 'running', joinUrl: 'https://app/provisioned' }],
    }));
    const result = await setupCherryFollower();
    expect(result.joinUrl).toBe('https://app/provisioned');
    expect(mockState.browserConnect).not.toHaveBeenCalled();
  });

  it('throws when the handshake yields neither a joinUrl nor provisioning auth', async () => {
    await expect(setupCherryFollower()).rejects.toThrow(/no joinUrl/i);
  });
});
