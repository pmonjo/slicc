import type { SandboxHandle } from './substrate.js';
import type { CloudStatus } from './types.js';
import { CloudError } from './errors.js';

export interface PollOpts {
  timeoutMs: number;
  intervalMs: number;
}

export async function pollCloudStatus(handle: SandboxHandle, opts: PollOpts): Promise<CloudStatus> {
  const start = Date.now();
  let lastError: unknown = null;
  while (Date.now() - start < opts.timeoutMs) {
    try {
      const raw = await handle.readFile('/tmp/slicc-join.json');
      const parsed = JSON.parse(raw) as CloudStatus;
      if (parsed.joinUrl) return parsed;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  const errSuffix = lastError
    ? ` (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})`
    : ' (file never appeared)';
  throw new CloudError(
    'SANDBOX_NOT_READY',
    `cloud-status did not appear within ${opts.timeoutMs}ms; sandbox may have failed to boot${errSuffix}`
  );
}

export async function pollForRefreshedStatus(
  handle: SandboxHandle,
  baselineUpdatedAt: string | undefined,
  opts: PollOpts
): Promise<CloudStatus> {
  const start = Date.now();
  let lastError: unknown = null;
  let lastStalePayload: CloudStatus | null = null;
  while (Date.now() - start < opts.timeoutMs) {
    try {
      const raw = await handle.readFile('/tmp/slicc-join.json');
      const parsed = JSON.parse(raw) as CloudStatus;
      if (parsed.joinUrl) {
        // Require a STRICTLY newer updatedAt than the registry baseline.
        // If we have no baseline (first-time resume of an externally-created
        // sandbox), accept any well-formed read.
        if (!baselineUpdatedAt) return parsed;
        if (parsed.updatedAt && parsed.updatedAt !== baselineUpdatedAt) {
          return parsed;
        }
        // File exists, joinUrl present, but updatedAt unchanged — capture for
        // the timeout error so we can tell "missing" from "stale".
        lastStalePayload = parsed;
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  let errSuffix = '';
  if (lastStalePayload) {
    errSuffix =
      ` (file present but stale: baseline.updatedAt=${baselineUpdatedAt}, ` +
      `current.updatedAt=${lastStalePayload.updatedAt}, ` +
      `current.trayId=${lastStalePayload.trayId})`;
  } else if (lastError) {
    errSuffix = ` (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})`;
  } else {
    errSuffix = ' (file never appeared)';
  }
  throw new CloudError(
    'LEADER_NOT_READY',
    `cloud-status did not refresh within ${opts.timeoutMs}ms${errSuffix}`
  );
}
