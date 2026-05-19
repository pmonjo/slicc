/**
 * Tests for `ThrottledErrorTracker` — the throttle/recovery helper
 * shared by `page-leader-tray.ts` and `page-follower-tray.ts`.
 *
 * Covers the contract documented in `throttled-error-tracker.ts`:
 *   - First failure passes the `-Infinity` initial-state gate.
 *   - Subsequent failures inside the throttle window are suppressed.
 *   - Failures BEYOND the throttle window log again.
 *   - Recovery requires N consecutive successes (debounce) — a single
 *     success between failures does NOT reset the throttle.
 *   - Recovery resets the throttle so the NEXT failure logs again.
 *   - `reportSuccess` is a no-op when not in failing state.
 *   - Logs at `error` level for both failure and recovery (so the
 *     prod log gate doesn't suppress them).
 */

import { describe, expect, it } from 'vitest';
import { ThrottledErrorTracker } from '../../src/scoops/throttled-error-tracker.js';
import type { Logger } from '../../src/core/logger.js';

function makeFakeLogger(): {
  logger: Logger;
  calls: { level: string; msg: string; data: unknown }[];
} {
  const calls: { level: string; msg: string; data: unknown }[] = [];
  const logger: Logger = {
    debug: (msg: string, data?: unknown) => calls.push({ level: 'debug', msg, data }),
    info: (msg: string, data?: unknown) => calls.push({ level: 'info', msg, data }),
    warn: (msg: string, data?: unknown) => calls.push({ level: 'warn', msg, data }),
    error: (msg: string, data?: unknown) => calls.push({ level: 'error', msg, data }),
  };
  return { logger, calls };
}

describe('ThrottledErrorTracker', () => {
  it('first reportFailure logs at error level immediately (passes -Infinity gate)', () => {
    const { logger, calls } = makeFakeLogger();
    const now = 100;
    const tracker = new ThrottledErrorTracker(logger, {
      failureMessage: 'failed',
      recoveryMessage: 'recovered',
      now: () => now,
    });
    tracker.reportFailure(new Error('boom'));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ level: 'error', msg: 'failed' });
    expect(calls[0].data).toMatchObject({ error: 'boom' });
  });

  it('subsequent failures within 60s are suppressed (throttle holds)', () => {
    const { logger, calls } = makeFakeLogger();
    let now = 100;
    const tracker = new ThrottledErrorTracker(logger, {
      failureMessage: 'failed',
      recoveryMessage: 'recovered',
      now: () => now,
    });
    tracker.reportFailure(new Error('boom-1'));
    now = 5_000;
    tracker.reportFailure(new Error('boom-2'));
    now = 30_000;
    tracker.reportFailure(new Error('boom-3'));
    now = 59_999;
    tracker.reportFailure(new Error('boom-4'));
    // Only the first failure logs — second through fourth are within
    // 60s of the first and get suppressed.
    expect(calls).toHaveLength(1);
    expect(calls[0].data).toMatchObject({ error: 'boom-1' });
  });

  it('failure AFTER the throttle window logs again', () => {
    const { logger, calls } = makeFakeLogger();
    let now = 0;
    const tracker = new ThrottledErrorTracker(logger, {
      failureMessage: 'failed',
      recoveryMessage: 'recovered',
      now: () => now,
    });
    tracker.reportFailure(new Error('boom-1'));
    now = 61_000;
    tracker.reportFailure(new Error('boom-2'));
    expect(calls).toHaveLength(2);
    expect(calls[1].data).toMatchObject({ error: 'boom-2' });
  });

  it('reportSuccess when not in failing state is a no-op', () => {
    const { logger, calls } = makeFakeLogger();
    const tracker = new ThrottledErrorTracker(logger, {
      failureMessage: 'failed',
      recoveryMessage: 'recovered',
    });
    tracker.reportSuccess();
    tracker.reportSuccess();
    tracker.reportSuccess();
    expect(calls).toHaveLength(0);
  });

  it('recovery requires N consecutive successes — fewer is not enough', () => {
    const { logger, calls } = makeFakeLogger();
    const tracker = new ThrottledErrorTracker(logger, {
      failureMessage: 'failed',
      recoveryMessage: 'recovered',
      recoveryDebounceTicks: 5,
    });
    tracker.reportFailure(new Error('boom-1'));
    tracker.reportSuccess();
    tracker.reportSuccess();
    tracker.reportSuccess();
    tracker.reportSuccess(); // 4 successes — still 1 short
    expect(calls).toHaveLength(1); // only the failure
    expect(calls.filter((c) => c.msg === 'recovered')).toHaveLength(0);
  });

  it('recovery log fires on the Nth consecutive success and resets the throttle', () => {
    const { logger, calls } = makeFakeLogger();
    let now = 0;
    const tracker = new ThrottledErrorTracker(logger, {
      failureMessage: 'failed',
      recoveryMessage: 'recovered',
      recoveryDebounceTicks: 3,
      now: () => now,
    });
    tracker.reportFailure(new Error('boom-1'));
    tracker.reportSuccess();
    tracker.reportSuccess();
    tracker.reportSuccess(); // 3rd success — recovery fires
    const recoveryLogs = calls.filter((c) => c.msg === 'recovered');
    expect(recoveryLogs).toHaveLength(1);
    expect(recoveryLogs[0].level).toBe('error');
    expect(recoveryLogs[0].data).toMatchObject({ kind: 'recovery' });

    // After recovery, throttle is reset — the next failure should log
    // immediately even though we're well within the 60s window.
    now = 1_000;
    tracker.reportFailure(new Error('boom-2'));
    const failureLogs = calls.filter((c) => c.msg === 'failed');
    expect(failureLogs).toHaveLength(2);
    expect(failureLogs[1].data).toMatchObject({ error: 'boom-2' });
  });

  it('flapping (fail → succeed → fail → succeed) does NOT reset throttle until debounce window of successes', () => {
    const { logger, calls } = makeFakeLogger();
    let now = 0;
    const tracker = new ThrottledErrorTracker(logger, {
      failureMessage: 'failed',
      recoveryMessage: 'recovered',
      recoveryDebounceTicks: 5,
      now: () => now,
    });
    // Initial failure
    tracker.reportFailure(new Error('boom-1'));
    // Flap: success-failure-success-failure (counter resets on each failure)
    tracker.reportSuccess();
    tracker.reportSuccess();
    now = 10_000;
    tracker.reportFailure(new Error('boom-2'));
    tracker.reportSuccess();
    now = 20_000;
    tracker.reportFailure(new Error('boom-3'));
    // Throughout the flapping, the throttle keeps the failures
    // suppressed — only the very first one logged. Recovery never
    // fired because consecutive-successes never reached 5.
    const failureLogs = calls.filter((c) => c.msg === 'failed');
    const recoveryLogs = calls.filter((c) => c.msg === 'recovered');
    expect(failureLogs).toHaveLength(1);
    expect(recoveryLogs).toHaveLength(0);
  });

  it('failure resets the consecutive-success counter (no half-recovery)', () => {
    const { logger, calls } = makeFakeLogger();
    const tracker = new ThrottledErrorTracker(logger, {
      failureMessage: 'failed',
      recoveryMessage: 'recovered',
      recoveryDebounceTicks: 3,
    });
    tracker.reportFailure(new Error('boom-1'));
    tracker.reportSuccess();
    tracker.reportSuccess(); // 2 of 3
    tracker.reportFailure(new Error('boom-2')); // counter resets
    tracker.reportSuccess();
    tracker.reportSuccess(); // back to 2 of 3 — should NOT trigger recovery
    expect(calls.filter((c) => c.msg === 'recovered')).toHaveLength(0);
    tracker.reportSuccess(); // now 3 of 3 — recovery fires
    expect(calls.filter((c) => c.msg === 'recovered')).toHaveLength(1);
  });

  it('uses performance.now() by default (smoke-test that the default injection works)', () => {
    const { logger, calls } = makeFakeLogger();
    // No `now` option provided — must fall back to performance.now()
    // without throwing.
    const tracker = new ThrottledErrorTracker(logger, {
      failureMessage: 'failed',
      recoveryMessage: 'recovered',
    });
    expect(() => tracker.reportFailure(new Error('first'))).not.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('non-Error rejections are coerced to string in the data field', () => {
    const { logger, calls } = makeFakeLogger();
    const tracker = new ThrottledErrorTracker(logger, {
      failureMessage: 'failed',
      recoveryMessage: 'recovered',
    });
    tracker.reportFailure('a plain string rejection');
    expect(calls[0].data).toMatchObject({ error: 'a plain string rejection' });
  });
});
