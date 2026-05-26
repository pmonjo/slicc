import { describe, it, expect } from 'vitest';
import { startCone } from '../src/operations/start.js';
import type {
  CreateOpts,
  SandboxHandle,
  SandboxSubstrate,
  SubstrateId,
  SandboxSummary,
} from '../src/index.js';
import { MemRegistry, makeFakeHandle } from './fixtures/index.js';

// Specialized for startCone: handle stores files per-create, tracks kill state for list result.
function makeStartTestSubstrate(opts: { joinJson: string }): SandboxSubstrate {
  const files = new Map<string, string>();
  let killed = false;

  return {
    id: 'e2b' as SubstrateId,
    async create(_opts: CreateOpts): Promise<SandboxHandle> {
      const sandboxId = 'sbx-fake';
      files.set('/tmp/slicc-join.json', opts.joinJson);

      const handle = makeFakeHandle({ sandboxId });
      return {
        sandboxId: handle.sandboxId,
        substrate: handle.substrate,
        pause: handle.pause,
        kill: async () => {
          killed = true;
        },
        getInfo: handle.getInfo,
        writeFile: handle.writeFile,
        readFile: async (path: string) => {
          const content = files.get(path);
          if (!content) throw new Error(`ENOENT ${path}`);
          return content;
        },
        run: handle.run,
      } as SandboxHandle;
    },
    async connect() {
      throw new Error('not used in startCone tests');
    },
    async list(): Promise<SandboxSummary[]> {
      if (killed) return [];
      return [
        {
          sandboxId: 'sbx-fake',
          state: 'running',
          metadata: {},
        },
      ];
    },
  };
}

describe('startCone', () => {
  it('creates a sandbox, polls join.json, appends to registry, returns StartResult', async () => {
    // Use a recent timestamp that will pass the minUpdatedAt check (5s skew margin)
    const updatedAt = new Date().toISOString();
    const substrate = makeStartTestSubstrate({
      joinJson: JSON.stringify({
        joinUrl: 'https://w/join/x',
        trayId: 't-1',
        updatedAt,
      }),
    });
    const registry = new MemRegistry();
    const result = await startCone(
      { substrate, registry },
      {
        envContents: 'ANTHROPIC_API_KEY=sk-x\nE2B_API_KEY=should-be-stripped',
        workerBaseUrl: 'https://w',
        sliccVersion: 'test',
        name: 'smoke',
      }
    );
    expect(result.joinUrl).toBe('https://w/join/x');
    expect(result.name).toBe('smoke');
    expect(result.sandboxId).toBe('sbx-fake');

    const entries = await registry.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe('smoke');
    expect(entries[0]?.state).toBe('running');
    expect(entries[0]?.lastJoinUpdatedAt).toBe(updatedAt);
    expect(entries[0]?.trayId).toBe('t-1');
    expect(entries[0]?.substrate).toBe('e2b');
  });

  it('throws SANDBOX_NOT_READY when pollCloudStatus times out', async () => {
    const substrate = makeStartTestSubstrate({ joinJson: '{}' }); // no joinUrl → poll never returns
    const registry = new MemRegistry();
    await expect(
      startCone(
        { substrate, registry },
        {
          envContents: '',
          workerBaseUrl: 'https://w',
          sliccVersion: 'test',
          pollTimeoutMs: 200,
          pollIntervalMs: 50,
        }
      )
    ).rejects.toMatchObject({ name: 'CloudError', code: 'SANDBOX_NOT_READY' });
    // Registry should have no entries (best-effort cleanup happened pre-throw).
    expect(await registry.list()).toHaveLength(0);
    // Substrate should have no sandboxes (killed during cleanup).
    expect(await substrate.list()).toHaveLength(0);
  });

  it('includes stderr tail in error message when poll fails', async () => {
    // Create a substrate that seeds stderr but no join.json
    const files = new Map<string, string>();
    files.set(
      '/tmp/slicc-stderr.log',
      'Error: Failed to launch\n  cause: missing deps\nStack trace...'
    );

    const substrate: SandboxSubstrate = {
      id: 'e2b' as SubstrateId,
      async create(_opts: CreateOpts): Promise<SandboxHandle> {
        const handle = makeFakeHandle({ sandboxId: 'sbx-err' });
        return {
          sandboxId: handle.sandboxId,
          substrate: handle.substrate,
          pause: handle.pause,
          kill: handle.kill,
          getInfo: handle.getInfo,
          writeFile: handle.writeFile,
          readFile: async (path: string) => {
            const content = files.get(path);
            if (!content) throw new Error(`ENOENT ${path}`);
            return content;
          },
          run: handle.run,
        } as SandboxHandle;
      },
      async connect() {
        throw new Error('not used');
      },
      async list(): Promise<SandboxSummary[]> {
        return [];
      },
    };

    const registry = new MemRegistry();
    await expect(
      startCone(
        { substrate, registry },
        {
          envContents: '',
          workerBaseUrl: 'https://w',
          sliccVersion: 'test',
          pollTimeoutMs: 200,
          pollIntervalMs: 50,
        }
      )
    ).rejects.toThrow(/missing deps/);
  });

  it('rejects stale /tmp/slicc-join.json from template snapshot and waits for fresh one', async () => {
    // Simulate the template-baked stale file → fresh file transition.
    // First read returns stale (updatedAt 1 hour ago), second returns fresh (updatedAt now).
    const staleUpdatedAt = new Date(Date.now() - 3600_000).toISOString();
    const freshUpdatedAt = new Date().toISOString();
    const files = new Map<string, string>();
    let readCount = 0;

    files.set(
      '/tmp/slicc-join.json',
      JSON.stringify({
        joinUrl: 'https://w/join/stale',
        trayId: 't-stale',
        updatedAt: staleUpdatedAt,
      })
    );

    const substrate: SandboxSubstrate = {
      id: 'e2b' as SubstrateId,
      async create(_opts: CreateOpts): Promise<SandboxHandle> {
        const handle = makeFakeHandle({ sandboxId: 'sbx-stale' });
        return {
          sandboxId: handle.sandboxId,
          substrate: handle.substrate,
          pause: handle.pause,
          kill: handle.kill,
          getInfo: handle.getInfo,
          writeFile: handle.writeFile,
          readFile: async (path: string) => {
            if (path === '/tmp/slicc-join.json') {
              readCount++;
              if (readCount === 1) {
                // First read: stale template-baked file
                return JSON.stringify({
                  joinUrl: 'https://w/join/stale',
                  trayId: 't-stale',
                  updatedAt: staleUpdatedAt,
                });
              } else {
                // Second+ read: fresh file written by node-server
                return JSON.stringify({
                  joinUrl: 'https://w/join/fresh',
                  trayId: 't-fresh',
                  updatedAt: freshUpdatedAt,
                });
              }
            }
            const content = files.get(path);
            if (!content) throw new Error(`ENOENT ${path}`);
            return content;
          },
          run: handle.run,
        } as SandboxHandle;
      },
      async connect() {
        throw new Error('not used');
      },
      async list(): Promise<SandboxSummary[]> {
        return [];
      },
    };

    const registry = new MemRegistry();
    const result = await startCone(
      { substrate, registry },
      {
        envContents: '',
        workerBaseUrl: 'https://w',
        sliccVersion: 'test',
        pollTimeoutMs: 2000,
        pollIntervalMs: 50,
      }
    );

    // Should have waited past the stale read and returned the fresh one
    expect(result.joinUrl).toBe('https://w/join/fresh');
    expect(readCount).toBeGreaterThan(1); // Proves the stale read was rejected

    const entries = await registry.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.trayId).toBe('t-fresh');
    expect(entries[0]?.lastJoinUpdatedAt).toBe(freshUpdatedAt);
  });
});
