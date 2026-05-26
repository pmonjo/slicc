import { describe, it, expect } from 'vitest';
import { pauseCone, CloudError } from '../src/index.js';
import type {
  ConeEntry,
  Registry,
  SandboxSubstrate,
  SandboxHandle,
  SubstrateId,
  CreateOpts,
  SandboxInfo,
  RunResult,
} from '../src/index.js';

class MemRegistry implements Registry {
  entries: ConeEntry[] = [];

  async list(): Promise<ConeEntry[]> {
    return [...this.entries];
  }

  async findByNameOrId(q: string): Promise<ConeEntry | null> {
    return this.entries.find((e) => e.sandboxId === q || e.name === q) ?? null;
  }

  async append(e: ConeEntry): Promise<void> {
    const i = this.entries.findIndex((x) => x.sandboxId === e.sandboxId);
    if (i >= 0) {
      this.entries[i] = { ...this.entries[i]!, ...e };
    } else {
      this.entries.push(e);
    }
  }

  async update(id: string, patch: Partial<ConeEntry>): Promise<void> {
    const i = this.entries.findIndex((e) => e.sandboxId === id);
    if (i < 0) throw new Error(`entry not found: ${id}`);
    this.entries[i] = { ...this.entries[i]!, ...patch };
  }

  async remove(id: string): Promise<void> {
    this.entries = this.entries.filter((e) => e.sandboxId !== id);
  }
}

function fakeSubstrateWith(handle: SandboxHandle): SandboxSubstrate {
  return {
    id: 'e2b',
    async create(_opts: CreateOpts) {
      throw new Error('not used in pause test');
    },
    async connect(_id: string) {
      return handle;
    },
    async list() {
      return [];
    },
  };
}

function makeHandle(id: string, paused = { value: false }): SandboxHandle {
  return {
    sandboxId: id,
    substrate: 'e2b' as SubstrateId,
    pause: async () => {
      paused.value = true;
    },
    kill: async () => {
      // noop
    },
    getInfo: async (): Promise<SandboxInfo> => ({
      sandboxId: id,
      state: paused.value ? 'paused' : 'running',
      metadata: {},
      createdAt: new Date().toISOString(),
    }),
    writeFile: async () => {
      // noop
    },
    readFile: async () => '',
    run: async (): Promise<RunResult> => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }),
  };
}

describe('pauseCone', () => {
  it('pauses a running cone and updates registry state', async () => {
    const registry = new MemRegistry();
    await registry.append({
      sandboxId: 's-1',
      substrate: 'e2b',
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      state: 'running',
      joinUrl: 'https://example.com/join',
    });

    const pausedFlag = { value: false };
    const substrate = fakeSubstrateWith(makeHandle('s-1', pausedFlag));

    await pauseCone({ substrate, registry }, 's-1');

    expect(pausedFlag.value).toBe(true);
    const entry = await registry.findByNameOrId('s-1');
    expect(entry).toBeDefined();
    expect(entry?.state).toBe('paused');
  });

  it('throws NOT_FOUND when query does not match', async () => {
    const registry = new MemRegistry();
    const substrate = fakeSubstrateWith(makeHandle('s-x'));

    await expect(pauseCone({ substrate, registry }, 'missing')).rejects.toThrow();
    let thrownErr: Error | undefined;
    try {
      await pauseCone({ substrate, registry }, 'missing');
    } catch (err) {
      thrownErr = err as Error;
    }
    expect(thrownErr).toBeInstanceOf(CloudError);
    const cloudErr = thrownErr as CloudError;
    expect(cloudErr.code).toBe('NOT_FOUND');
    expect(cloudErr.message).toContain('cloud session not found');
  });

  it('throws ALREADY_PAUSED when entry is already paused', async () => {
    const registry = new MemRegistry();
    await registry.append({
      sandboxId: 's-2',
      substrate: 'e2b',
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      state: 'paused',
      joinUrl: 'https://example.com/join',
    });

    const substrate = fakeSubstrateWith(makeHandle('s-2'));

    let thrownErr: Error | undefined;
    try {
      await pauseCone({ substrate, registry }, 's-2');
    } catch (err) {
      thrownErr = err as Error;
    }
    expect(thrownErr).toBeInstanceOf(CloudError);
    const cloudErr = thrownErr as CloudError;
    expect(cloudErr.code).toBe('ALREADY_PAUSED');
    expect(cloudErr.message).toContain('already paused');
  });

  it('preserves trayId and lastJoinUpdatedAt on pause', async () => {
    const registry = new MemRegistry();
    const originalTrayId = 'tray-123';
    const originalLastJoinUpdatedAt = '2026-05-22T10:00:00Z';

    await registry.append({
      sandboxId: 's-3',
      substrate: 'e2b',
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      state: 'running',
      joinUrl: 'https://example.com/join',
      trayId: originalTrayId,
      lastJoinUpdatedAt: originalLastJoinUpdatedAt,
    });

    const substrate = fakeSubstrateWith(makeHandle('s-3'));
    await pauseCone({ substrate, registry }, 's-3');

    const entry = await registry.findByNameOrId('s-3');
    expect(entry?.trayId).toBe(originalTrayId);
    expect(entry?.lastJoinUpdatedAt).toBe(originalLastJoinUpdatedAt);
  });

  it('finds entry by name', async () => {
    const registry = new MemRegistry();
    await registry.append({
      sandboxId: 's-4',
      name: 'my-session',
      substrate: 'e2b',
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      state: 'running',
      joinUrl: 'https://example.com/join',
    });

    const pausedFlag = { value: false };
    const substrate = fakeSubstrateWith(makeHandle('s-4', pausedFlag));

    await pauseCone({ substrate, registry }, 'my-session');

    expect(pausedFlag.value).toBe(true);
    const entry = await registry.findByNameOrId('my-session');
    expect(entry?.state).toBe('paused');
  });
});
