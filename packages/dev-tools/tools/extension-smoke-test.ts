/**
 * CDP-driven smoke test for the SLICC Chrome extension.
 *
 * End-to-end verification: launches a disposable Chrome profile with
 * `dist/extension/` loaded, drives the extension via CDP to run the two
 * highest-risk shell commands (`ffmpeg -version` and `node -e`), and
 * asserts they complete without remote-code policy violations.
 *
 * Usage:
 *   npm run build -w @slicc/chrome-extension   # produces dist/extension/
 *   tsx packages/dev-tools/tools/extension-smoke-test.ts
 *
 * Environment knobs:
 *   CHROME_PATH                  override Chrome executable
 *   SLICC_SMOKE_TIMEOUT_MS       overall per-scenario timeout (default 120000)
 *   SLICC_SMOKE_KEEP_PROFILE=1   skip teardown of the tmp profile (debug aid)
 *   SLICC_CI=1                   running under xvfb / headed-CI
 *
 * Wire approach:
 *   1. Spawn Chrome with --load-extension + --remote-debugging-port=0;
 *      discover the live port via DevToolsActivePort.
 *   2. Find the extension ID by scanning /json/list for a service-worker.js
 *      target.
 *   3. Open `chrome-extension://<id>/index.html?detached=1` as a tab so
 *      the side-panel UI bootstraps in a CDP-reachable target.
 *   4. Attach to that target. Use `Runtime.evaluate` to install a tiny
 *      bridge in the page that synthesizes `TerminalControlMsg` envelopes
 *      via `chrome.runtime.sendMessage` and collects matching
 *      `TerminalEventMsg` responses — same wire format the panel's own
 *      `TerminalSessionClient` uses (see
 *      `packages/webapp/src/shell/terminal-protocol.ts` and
 *      `packages/webapp/src/kernel/transport-chrome-runtime.ts`).
 *   5. Track every `Network.requestWillBeSent` and apply per-scenario
 *      assertions on the captured request log.
 *
 * Exit codes:
 *   0  — both scenarios passed.
 *   1  — at least one assertion failed; details are printed AND mirrored
 *        to the artifact file whose path is the last line of stderr.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

import { findChromeExecutable } from '../../node-server/src/chrome-launch.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EXTENSION_DIR = join(REPO_ROOT, 'dist', 'extension');
const SCENARIO_TIMEOUT_MS = Number(process.env['SLICC_SMOKE_TIMEOUT_MS'] ?? 120_000);
const CDP_READY_TIMEOUT_MS = 20_000;
const READY_POLL_TIMEOUT_MS = 30_000;

const FORBIDDEN_HOSTS = ['unpkg.com', 'esm.sh', 'cdn.jsdelivr.net'];

// ---------------------------------------------------------------------------
// Artifact log — captures everything the script does so a failed CI run is
// debuggable from a single file.
// ---------------------------------------------------------------------------

const ARTIFACT_DIR = mkdtempSync(join(tmpdir(), 'slicc-smoke-'));
const ARTIFACT_LOG = join(ARTIFACT_DIR, 'smoke.log');
const CHROME_STDERR_LOG = join(ARTIFACT_DIR, 'chrome.stderr.log');

function logArtifact(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  try {
    writeFileSync(ARTIFACT_LOG, stamped, { flag: 'a' });
  } catch {
    // Ignore — log only.
  }
  process.stderr.write(stamped);
}

// ---------------------------------------------------------------------------
// CDP helpers
// ---------------------------------------------------------------------------

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

function fetchJson(port: number, path: string, method: 'GET' | 'PUT' = 'GET'): Promise<unknown> {
  return new Promise((resolveJson, rejectJson) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method, headers: { Host: '127.0.0.1' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          try {
            resolveJson(body ? JSON.parse(body) : null);
          } catch (err) {
            rejectJson(new Error(`Bad JSON from ${path}: ${(err as Error).message}: ${body}`));
          }
        });
      }
    );
    req.on('error', rejectJson);
    req.end();
  });
}

async function waitForCdp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      await fetchJson(port, '/json/version');
      return;
    } catch (err) {
      lastErr = err;
      await delay(150);
    }
  }
  throw new Error(`CDP /json/version not reachable on port ${port}: ${String(lastErr)}`);
}

async function findExtensionId(port: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = (await fetchJson(port, '/json/list')) as CdpTarget[];
    for (const t of targets) {
      const m = t.url?.match(/^chrome-extension:\/\/([a-p]{32})\/service-worker\.js/);
      if (m) return m[1]!;
    }
    await delay(200);
  }
  throw new Error('Could not find extension service-worker target in /json/list');
}

async function readDevToolsActivePort(userDataDir: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  const path = join(userDataDir, 'DevToolsActivePort');
  while (Date.now() < deadline) {
    try {
      const first = readFileSync(path, 'utf8').split('\n')[0]?.trim() ?? '';
      const port = Number.parseInt(first, 10);
      if (Number.isInteger(port) && port > 0 && port < 65_536) return port;
    } catch {
      // Not written yet.
    }
    await delay(100);
  }
  throw new Error(`DevToolsActivePort never appeared in ${userDataDir}`);
}

// ---------------------------------------------------------------------------
// CDP session over WebSocket — minimal hand-rolled client.
// ---------------------------------------------------------------------------

interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
}

class CdpSession {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private listeners = new Set<(ev: CdpEvent) => void>();
  private closed = false;

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.on('message', (raw) => this.handleMessage(raw.toString()));
    this.ws.on('close', () => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error('CDP socket closed'));
      this.pending.clear();
    });
  }

  static async connect(wsUrl: string): Promise<CdpSession> {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
    });
    return new CdpSession(ws);
  }

  private handleMessage(text: string): void {
    let parsed: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: Record<string, unknown>;
    };
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof parsed.id === 'number') {
      const handler = this.pending.get(parsed.id);
      if (!handler) return;
      this.pending.delete(parsed.id);
      if (parsed.error) handler.reject(new Error(parsed.error.message ?? 'CDP error'));
      else handler.resolve(parsed.result);
    } else if (parsed.method) {
      const ev: CdpEvent = { method: parsed.method, params: parsed.params ?? {} };
      for (const l of this.listeners) l(ev);
    }
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('CDP socket closed'));
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    return new Promise<unknown>((res, rej) => {
      this.pending.set(id, { resolve: res as (v: unknown) => void, reject: rej });
      this.ws.send(JSON.stringify(payload), (err) => {
        if (err) {
          this.pending.delete(id);
          rej(err);
        }
      });
    });
  }

  onEvent(handler: (ev: CdpEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // Ignore.
    }
  }
}

// ---------------------------------------------------------------------------
// In-page bridge — installed once per page session.
// ---------------------------------------------------------------------------

/**
 * Source for the in-page bridge. Runs inside the extension's index.html
 * context, where `chrome.runtime` is fully available. The bridge:
 *   - Opens a single terminal session in the offscreen document.
 *   - Exposes `window.__sliccSmokeExec(command)` returning the captured
 *     stdout/stderr/exitCode.
 *
 * Note: we keep this as a string so `Runtime.evaluate` ships exactly what
 * the page executes — no TS-to-JS surprises at runtime.
 */
const PAGE_BRIDGE_SOURCE = `
(() => {
  if (window.__sliccSmokeReady) return 'already-installed';
  const SID = 'slicc-smoke-' + Math.random().toString(36).slice(2, 10);
  const inflight = new Map();
  let openedResolve;
  const opened = new Promise((res) => { openedResolve = res; });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.source !== 'offscreen') return false;
    const payload = msg.payload;
    if (!payload || typeof payload !== 'object') return false;
    if (payload.sid !== SID) return false;
    if (payload.type === 'terminal-status' && payload.state === 'opened') {
      openedResolve(true);
    } else if (payload.type === 'terminal-output') {
      const slot = inflight.get(payload.execId);
      if (slot) {
        if (payload.stream === 'stderr') slot.stderr += payload.data;
        else slot.stdout += payload.data;
      }
    } else if (payload.type === 'terminal-exit') {
      const slot = inflight.get(payload.execId);
      if (slot) {
        inflight.delete(payload.execId);
        slot.resolve({ stdout: slot.stdout, stderr: slot.stderr, exitCode: payload.exitCode });
      }
    } else if (payload.type === 'terminal-status' && payload.state === 'error') {
      for (const [, slot] of inflight) slot.reject(new Error(payload.error || 'terminal error'));
      inflight.clear();
    }
    return false;
  });

  chrome.runtime.sendMessage({
    source: 'panel',
    payload: { type: 'terminal-open', sid: SID, cwd: '/' }
  });

  window.__sliccSmokeOpened = opened;
  window.__sliccSmokeExec = (command, timeoutMs) => {
    const execId = 'exec-' + Math.random().toString(36).slice(2, 10);
    return opened.then(() => new Promise((res, rej) => {
      const timer = setTimeout(() => {
        inflight.delete(execId);
        rej(new Error('exec timed out after ' + timeoutMs + 'ms: ' + command));
      }, timeoutMs);
      inflight.set(execId, {
        stdout: '', stderr: '',
        resolve: (r) => { clearTimeout(timer); res(r); },
        reject: (e) => { clearTimeout(timer); rej(e); }
      });
      chrome.runtime.sendMessage({
        source: 'panel',
        payload: { type: 'terminal-exec', sid: SID, execId, command }
      });
    }));
  };
  window.__sliccSmokeReady = true;
  return 'installed';
})()
`;

// ---------------------------------------------------------------------------
// Network log — keeps every request seen during the page lifetime, with
// timestamps so per-scenario windows can be sliced after the fact.
// ---------------------------------------------------------------------------

interface NetEntry {
  ts: number;
  url: string;
  initiator: string | null;
}

function makeNetworkRecorder(cdp: CdpSession): {
  entries: NetEntry[];
  dispose: () => void;
} {
  const entries: NetEntry[] = [];
  const off = cdp.onEvent((ev) => {
    if (ev.method !== 'Network.requestWillBeSent') return;
    const req = ev.params as {
      request?: { url?: string };
      initiator?: { type?: string; url?: string };
    };
    const url = req.request?.url ?? '';
    if (!url) return;
    entries.push({
      ts: Date.now(),
      url,
      initiator: req.initiator?.url ?? req.initiator?.type ?? null,
    });
  });
  return { entries, dispose: off };
}

// ---------------------------------------------------------------------------
// Scenario runners
// ---------------------------------------------------------------------------

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function evalInPage<T>(
  cdp: CdpSession,
  expression: string,
  awaitPromise = false
): Promise<T> {
  const result = (await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  })) as {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (result.exceptionDetails) {
    const msg =
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'unknown';
    throw new Error(`Runtime.evaluate exception: ${msg}`);
  }
  return result.result?.value as T;
}

async function waitForPageReady(cdp: CdpSession): Promise<void> {
  const deadline = Date.now() + READY_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ready = await evalInPage<boolean>(
      cdp,
      'Boolean(typeof chrome !== "undefined" && chrome?.runtime?.id && document.readyState !== "loading")'
    );
    if (ready) return;
    await delay(200);
  }
  throw new Error('Side panel page never reached ready state');
}

async function installBridge(cdp: CdpSession): Promise<void> {
  const status = await evalInPage<string>(cdp, PAGE_BRIDGE_SOURCE);
  logArtifact(`bridge install: ${status}`);
  // Wait for the offscreen-side `terminal-status: opened` reply.
  await evalInPage<boolean>(
    cdp,
    `Promise.race([
       window.__sliccSmokeOpened,
       new Promise((_, rej) => setTimeout(() => rej(new Error('terminal-open timed out')), 20000))
     ]).then(() => true)`,
    /* awaitPromise */ true
  );
}

async function execShell(
  cdp: CdpSession,
  command: string,
  timeoutMs = 60_000
): Promise<ExecResult> {
  const expr = `window.__sliccSmokeExec(${JSON.stringify(command)}, ${timeoutMs})`;
  return evalInPage<ExecResult>(cdp, expr, /* awaitPromise */ true);
}

interface ScenarioFailure {
  scenario: string;
  message: string;
  detail?: Record<string, unknown>;
}

function assertScenario(
  failures: ScenarioFailure[],
  scenario: string,
  condition: boolean,
  message: string,
  detail?: Record<string, unknown>
): void {
  if (condition) {
    logArtifact(`✓ [${scenario}] ${message}`);
  } else {
    logArtifact(`✗ [${scenario}] ${message}${detail ? ' ' + JSON.stringify(detail) : ''}`);
    failures.push({ scenario, message, detail });
  }
}

async function runFfmpegScenario(
  cdp: CdpSession,
  net: NetEntry[],
  extId: string,
  failures: ScenarioFailure[]
): Promise<void> {
  const scenario = 'ffmpeg';
  logArtifact(`[${scenario}] running 'ffmpeg -version' ...`);
  const start = Date.now();
  let result: ExecResult;
  try {
    result = await execShell(cdp, 'ffmpeg -version', SCENARIO_TIMEOUT_MS);
  } catch (err) {
    failures.push({ scenario, message: `exec threw: ${(err as Error).message}` });
    return;
  }
  const slice = net.filter((e) => e.ts >= start);
  logArtifact(
    `[${scenario}] exitCode=${result.exitCode} stdout=${result.stdout.length}B stderr=${result.stderr.length}B network=${slice.length}`
  );

  assertScenario(
    failures,
    scenario,
    result.exitCode === 0,
    `exit code 0 (got ${result.exitCode})`,
    {
      stderrTail: result.stderr.slice(-2000),
      stdoutTail: result.stdout.slice(-2000),
    }
  );
  const combined = `${result.stdout}\n${result.stderr}`;
  assertScenario(
    failures,
    scenario,
    /ffmpeg version/i.test(combined),
    'output contains "ffmpeg version"',
    { tail: combined.slice(-500) }
  );

  // Network rules: every .js fetched during the scenario MUST come from
  // chrome-extension://<id>/ — any cross-origin .js is a remote-code-hosting
  // violation. Cross-origin .wasm is allowed for now (unpkg ffmpeg-core.wasm
  // bundling lands later).
  const jsViolations = slice.filter((e) => {
    if (!/\.js(\?|$)/i.test(e.url)) return false;
    if (e.url.startsWith(`chrome-extension://${extId}/`)) return false;
    return FORBIDDEN_HOSTS.some((h) => e.url.includes(`//${h}/`) || e.url.includes(`//${h}:`));
  });
  assertScenario(
    failures,
    scenario,
    jsViolations.length === 0,
    'no remote .js fetches from forbidden hosts',
    { violations: jsViolations.slice(0, 10).map((e) => e.url) }
  );

  const localCore = slice.find(
    (e) => e.url.startsWith(`chrome-extension://${extId}/`) && e.url.includes('ffmpeg-core.js')
  );
  assertScenario(
    failures,
    scenario,
    !!localCore,
    'ffmpeg-core.js loaded from chrome-extension://<id>/',
    {
      sampleExtensionUrls: slice
        .filter((e) => e.url.startsWith(`chrome-extension://${extId}/`))
        .slice(0, 10)
        .map((e) => e.url),
    }
  );
}

async function runNodeScenario(cdp: CdpSession, failures: ScenarioFailure[]): Promise<void> {
  const scenario = 'node-e';
  const command = `node -e "const _ = require('lodash'); console.log(_.VERSION || 'ok')"`;
  logArtifact(`[${scenario}] running ${command} ...`);
  let result: ExecResult;
  try {
    result = await execShell(cdp, command, SCENARIO_TIMEOUT_MS);
  } catch (err) {
    failures.push({ scenario, message: `exec threw: ${(err as Error).message}` });
    return;
  }
  logArtifact(
    `[${scenario}] exitCode=${result.exitCode} stdout=${result.stdout.length}B stderr=${result.stderr.length}B`
  );
  assertScenario(
    failures,
    scenario,
    result.exitCode === 0,
    `exit code 0 (got ${result.exitCode})`,
    {
      stderrTail: result.stderr.slice(-2000),
      stdoutTail: result.stdout.slice(-2000),
    }
  );
  const trimmed = result.stdout.trim();
  assertScenario(
    failures,
    scenario,
    trimmed.length > 0,
    'stdout is non-empty (lodash version or "ok")',
    { stdout: trimmed }
  );
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  logArtifact(`smoke test artifact dir: ${ARTIFACT_DIR}`);

  if (!existsSync(EXTENSION_DIR)) {
    logArtifact(
      `ERROR: ${EXTENSION_DIR} does not exist. Run 'npm run build -w @slicc/chrome-extension' first.`
    );
    return 1;
  }
  if (!existsSync(join(EXTENSION_DIR, 'manifest.json'))) {
    logArtifact(`ERROR: ${EXTENSION_DIR}/manifest.json missing — incomplete extension build.`);
    return 1;
  }

  const chromePath = findChromeExecutable({ executablePreference: 'chrome-for-testing' });
  if (!chromePath) {
    logArtifact(
      'ERROR: no Chrome executable found. Set CHROME_PATH or install Chrome for Testing via puppeteer.'
    );
    return 1;
  }
  logArtifact(`chrome executable: ${chromePath}`);

  const profileDir = mkdtempSync(join(tmpdir(), 'slicc-smoke-profile-'));
  logArtifact(`chrome user-data-dir: ${profileDir}`);

  const args = [
    `--load-extension=${EXTENSION_DIR}`,
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-crash-reporter',
    '--disable-background-tracing',
    '--disable-blink-features=AutomationControlled',
    'about:blank',
  ];

  let chrome: ChildProcess | null = null;
  let cdp: CdpSession | null = null;
  let exitCode = 1;

  try {
    chrome = spawn(chromePath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GOOGLE_CRASHPAD_DISABLE: '1' },
    });
    chrome.stderr?.on('data', (b: Buffer) => {
      try {
        writeFileSync(CHROME_STDERR_LOG, b, { flag: 'a' });
      } catch {
        // Ignore.
      }
    });
    chrome.on('exit', (code, sig) => logArtifact(`chrome exited code=${code} signal=${sig}`));

    const cdpPort = await readDevToolsActivePort(profileDir, CDP_READY_TIMEOUT_MS);
    logArtifact(`chrome CDP port: ${cdpPort}`);
    await waitForCdp(cdpPort, 10_000);

    const extId = await findExtensionId(cdpPort, CDP_READY_TIMEOUT_MS);
    logArtifact(`extension id: ${extId}`);

    const panelUrl = `chrome-extension://${extId}/index.html?detached=1`;
    const newTab = (await fetchJson(
      cdpPort,
      `/json/new?${encodeURIComponent(panelUrl)}`,
      'PUT'
    )) as CdpTarget;
    if (!newTab?.webSocketDebuggerUrl) throw new Error('Failed to open panel tab');
    logArtifact(`panel tab opened: ${newTab.id} ws=${newTab.webSocketDebuggerUrl}`);

    // Connect to the new tab's WebSocketDebuggerUrl directly — this is a
    // target-scoped session, no Target.attachToTarget hop required.
    // Chrome's `/json/new` endpoint emits an authority-less ws URL
    // (`ws://127.0.0.1/devtools/page/<id>`) — inject the CDP port we
    // already know. Also fold `localhost` → `127.0.0.1` for IPv6-only
    // resolvers that resolve `localhost` to `::1` and miss IPv4 CDP.
    const wsUrl = newTab.webSocketDebuggerUrl
      .replace('ws://localhost/', `ws://127.0.0.1:${cdpPort}/`)
      .replace('ws://localhost:', `ws://127.0.0.1:`)
      .replace(/^ws:\/\/127\.0\.0\.1\//, `ws://127.0.0.1:${cdpPort}/`);
    cdp = await CdpSession.connect(wsUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    const recorder = makeNetworkRecorder(cdp);

    await waitForPageReady(cdp);
    logArtifact('page chrome.runtime ready; installing bridge ...');
    await installBridge(cdp);
    logArtifact('terminal session opened; running scenarios ...');

    const failures: ScenarioFailure[] = [];
    await runFfmpegScenario(cdp, recorder.entries, extId, failures);
    await runNodeScenario(cdp, failures);
    recorder.dispose();

    if (failures.length === 0) {
      logArtifact('all scenarios passed');
      exitCode = 0;
    } else {
      logArtifact(`FAILURES (${failures.length}):`);
      for (const f of failures) {
        logArtifact(
          `  [${f.scenario}] ${f.message}${f.detail ? ' ' + JSON.stringify(f.detail) : ''}`
        );
      }
    }
  } catch (err) {
    logArtifact(`fatal: ${(err as Error).message}`);
    if ((err as Error).stack) logArtifact((err as Error).stack!);
  } finally {
    try {
      cdp?.close();
    } catch {
      // Ignore.
    }
    if (chrome && chrome.exitCode === null) {
      try {
        chrome.kill('SIGTERM');
        await Promise.race([
          new Promise<void>((res) => chrome!.once('exit', () => res())),
          delay(3000),
        ]);
        if (chrome.exitCode === null) chrome.kill('SIGKILL');
      } catch {
        // Ignore.
      }
    }
    if (!process.env['SLICC_SMOKE_KEEP_PROFILE']) {
      try {
        rmSync(profileDir, { recursive: true, force: true });
      } catch {
        // Ignore.
      }
    }
    // Last line of stderr is always the artifact-log path so CI / humans
    // can grab it without parsing the rest of the output.
    process.stderr.write(`\nsmoke artifacts: ${ARTIFACT_LOG}\n`);
  }
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    logArtifact(`top-level error: ${(err as Error).message}`);
    process.exit(1);
  });
