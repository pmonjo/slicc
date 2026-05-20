# Extension-leader tray sync wiring

**Issue:** [#682](https://github.com/ai-ecoverse/slicc/issues/682)
**Branch:** `fix/extension-leader-sync-682`
**Date:** 2026-05-20

## Problem

When the Chrome extension runs as a **tray leader** (worker base URL set, no
join URL), followers can complete WebRTC signaling but the leader broadcasts
nothing — no chat snapshots, no agent events, no scoops list, no sprinkles, no
federated CDP. The follower-side data channel opens, then sits silent until its
keepalive trips and tears it down.

The gap site is `packages/chrome-extension/src/offscreen.ts:438-480` — the
`if (trayRuntimeConfig?.workerBaseUrl)` branch in `syncTrayRuntime`. It
constructs `LeaderTrayManager` + `LeaderTrayPeerManager` correctly, but never
constructs a `LeaderSyncManager`, never subscribes to agent events, never
broadcasts scoops/sprinkles lists, and `onPeerConnected` only logs instead of
calling `sync.addFollower(bootstrapId, channel, …)`.

The standalone-leader path was fixed on `feat/browser-follower-sprinkle-sync`
and is the canonical reference: `packages/webapp/src/ui/page-leader-tray.ts`
(helper) + `packages/webapp/src/ui/main.ts:2418-2503` (callbacks).

## Key insight that shapes the design

The issue's scope estimate (~150-200 LoC + 5 panel↔offscreen RPC message
types) assumed every `LeaderSyncManagerOptions` callback would need to be
threaded across the panel↔offscreen boundary. After mapping data sources,
**most of what `LeaderSyncManager` needs already lives in offscreen** — only
three pieces of state are panel-only, and all three are one-way panel→offscreen
pushes. No request/response RPC is required.

| `LeaderSyncManagerOptions` field                                 | Source in extension mode                                                                                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `getMessages()`                                                  | `OffscreenBridge.getBuffer(activeScoopJid)` — the bridge is the canonical chat store in extension mode; `ChatPanel.getMessages()` is a downstream view |
| `getMessagesForScoop(jid)`                                       | `OffscreenBridge.getBuffer(jid)`                                                                                                                       |
| `getScoopJid()`                                                  | bridge tracks `activeScoopJid` via the existing scoop-selection wire                                                                                   |
| `getScoops()`                                                    | `orchestrator.getScoops().map(...)`                                                                                                                    |
| `getSprinkles()`                                                 | **panel-only** — `SprinkleManager.available() + opened()`; pushed snapshot                                                                             |
| `readSprinkleContent(name)`                                      | `sharedFs.readFile(path)` after name→path lookup from the cached sprinkle snapshot                                                                     |
| `onSprinkleLick`                                                 | `lickManager.emitEvent({ type: 'sprinkle', ... })` — same routing the follower path already uses at `offscreen.ts:247`                                 |
| `onFollowerMessage`                                              | dispatch a synthetic `user-message` envelope through the existing offscreen path                                                                       |
| `onFollowerAbort`                                                | `orchestrator.stopScoop(activeJid)`                                                                                                                    |
| AgentEvent subscription                                          | tap inside `OffscreenBridge.createCallbacks` — the same callbacks that already emit `agent-event` envelopes to the panel                               |
| `browserAPI` / `browserTransport` / `vfs`                        | already in `offscreen.ts:init()`                                                                                                                       |
| `sprinkleManager.setSendToSprinkleHook` (local update broadcast) | **panel-only** — pushed                                                                                                                                |
| `chat.setOnLocalUserMessage` (local echo)                        | **panel-only** — pushed                                                                                                                                |

## Approach

### Option A (chosen): offscreen-local sync + 3-message panel push bridge

`LeaderSyncManager` is constructed in offscreen. Its callbacks resolve from
offscreen-local state directly. A narrow panel→offscreen bridge handles the
three panel-only pieces, all fire-and-forget (no waiter maps, no timeouts).

### Rejected alternatives

**B — Issue's Option A (request/response RPC for every callback).** Inflates
LoC, adds round-trip latency to every broadcast cycle, requires five new waiter
maps, and invents RPC for state that's already offscreen-side. Strictly worse
than A.

**C — Move `SprinkleManager` to offscreen.** Refactor too large for this fix.
`SprinkleManager` owns DOM rendering. Out of scope.

## Architecture

```text
┌─ Side panel ────────────────────────────────────────────────┐
│  ChatPanel                                                  │
│    .setOnLocalUserMessage(text, msgId, atts)                │
│  SprinkleManager                                            │
│    .setSendToSprinkleHook(name, data)                       │
│    .available() / .opened()  ← refresh/open/close events    │
│                                                             │
│  PanelLeaderSyncProxy (new)                                 │
│    pushSprinklesSnapshot(SprinkleSummary[])                 │
│    pushSprinkleUpdate(name, data)                           │
│    pushUserMessageEcho(text, msgId, atts)                   │
└────────┬─────────────────────────────────── chrome.runtime ─┘
         │                                          (panel→offscreen, fire-and-forget)
         ▼
┌─ Offscreen document ────────────────────────────────────────┐
│  connectOffscreenLeaderSyncBridge(hub) (new)                │
│    caches latest SprinkleSummary[]                          │
│    fans:                                                    │
│      sprinkle.update → sync.broadcastSprinkleUpdate         │
│      user.echo       → sync.broadcastUserMessage            │
│                                                             │
│  LeaderSyncManager (constructed here)                       │
│    getMessages       → bridge.getBuffer(activeJid)          │
│    getMessagesForScoop→ bridge.getBuffer(jid)               │
│    getScoopJid       → bridge.getActiveScoopJid()           │
│    getScoops         → orchestrator.getScoops()             │
│    getSprinkles      → bridge.getCachedSprinkles()          │
│    readSprinkleContent → sharedFs.readFile(name→path)       │
│    onSprinkleLick    → lickManager.emitEvent('sprinkle',…)  │
│    onFollowerMessage → orchestrator user-message dispatch   │
│    onFollowerAbort   → orchestrator.stopScoop(activeJid)    │
│    browserAPI/transport/vfs → already in init()             │
│                                                             │
│  OffscreenBridge.onAgentEvent(handler) (new)                │
│    sync.broadcastEvent ← handler (AgentEvent)               │
│                                                             │
│  LeaderTrayPeerManager.onPeerConnected (fixed)              │
│    sync.addFollower(bootstrapId, channel, {runtime, …})     │
└─────────────────────────────────────────────────────────────┘
```

## Components

### 1. `OffscreenBridge.onAgentEvent(handler)` — new method

**File:** `packages/chrome-extension/src/offscreen-bridge.ts`

Adds a fan-out tap at the `OrchestratorCallbacks` layer (NOT at the wire-emit
layer, because the wire envelope shape is a flat `{ type: 'agent-event',
scoopJid, eventType, … }` that diverges from `AgentEvent` in `ui/types.ts`).

Implementation: keep a `Set<(event: AgentEvent) => void>` on the bridge.
Inside `createCallbacks`, wrap each callback so it (a) does its existing
panel-emit work AND (b) constructs an `AgentEvent` and calls every registered
listener with try/catch. The mapping:

| Orchestrator callback                    | Resulting `AgentEvent`                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `onResponse(jid, text, isPartial=true)`  | `{ type: 'content_delta', messageId, text }`                                                            |
| `onResponse(jid, text, isPartial=false)` | `{ type: 'content_delta', messageId, text }` + treat as full                                            |
| `onResponseDone(jid)`                    | `{ type: 'content_done', messageId }` + `{ type: 'turn_end', messageId }`                               |
| `onToolStart(jid, name, input)`          | `{ type: 'tool_use_start', messageId, toolName, toolInput }`                                            |
| `onToolEnd(jid, name, result, isError)`  | `{ type: 'tool_result', messageId, toolName, result, isError }`                                         |
| `onToolUI(jid, name, requestId, html)`   | `{ type: 'tool_ui', messageId, toolName, requestId, html }`                                             |
| `onToolUIDone(jid, requestId)`           | `{ type: 'tool_ui_done', messageId, requestId }`                                                        |
| `onError(jid, error)`                    | `{ type: 'error', error }`                                                                              |
| `onSendMessage(jid, text)`               | `{ type: 'message_start', messageId }` + `{ type: 'content_delta', text }` + `{ type: 'content_done' }` |

`messageId` comes from `bridge.currentMessageId.get(scoopJid)` (the same id the
bridge uses for its buffered message); `message_start` may need to be emitted
when a new message is created (see `getOrCreateAssistantMsg`).

API:

```ts
onAgentEvent(handler: (event: AgentEvent) => void): () => void;
```

Returns an unsubscribe function. Used by the offscreen leader branch to wire
`sync.broadcastEvent`.

**Open verification step before coding:** confirm the protocol consumer
(`tray-leader-sync.ts` → `agent.event` wire payload → `FollowerSyncManager`
fan-out) tolerates the synthesized `messageId`s and the `onSendMessage`
3-event split. The standalone path goes through `pi-agent-core` which emits
real `message_start` events upstream; we're synthesizing here. If the follower
breaks on duplicate `message_start` or missing fields, switch to passing the
raw orchestrator-callback signal as a custom event shape.

### 2. `leader-sync-bridge.ts` — new file

**File:** `packages/chrome-extension/src/leader-sync-bridge.ts`

Symmetrical bridge halves modeled on `follower-sprinkle-bridge.ts`. All three
message flows are panel→offscreen, fire-and-forget.

#### Panel-side

```ts
export class PanelLeaderSyncProxy {
  constructor(sender: PanelMessageSender);

  /** Push latest sprinkle availability + open state. Idempotent; call after every
   *  SprinkleManager.refresh() / open / close. */
  pushSprinklesSnapshot(sprinkles: SprinkleSummary[]): void;

  /** Forward a local SprinkleManager.sendToSprinkle call to the leader. */
  pushSprinkleUpdate(sprinkleName: string, data: unknown): void;

  /** Forward the leader's locally-typed user message so followers see it. */
  pushUserMessageEcho(text: string, messageId: string, attachments?: MessageAttachment[]): void;

  /** Tear down. Idempotent. */
  dispose(): void;
}
```

#### Offscreen-side

```ts
export interface OffscreenLeaderSyncBridgeHandle {
  /** Return the cached sprinkle snapshot (or [] if none received yet). */
  getSprinkles(): SprinkleSummary[];
  /** Resolve sprinkle name → VFS path from the cached snapshot. Returns null when unknown. */
  resolveSprinklePath(name: string): string | null;
  /** Stop listening. Idempotent. */
  detach(): void;
}

export function connectOffscreenLeaderSyncBridge(
  hub: OffscreenMessageHub,
  sync: LeaderSyncManager
): OffscreenLeaderSyncBridgeHandle;
```

The offscreen adapter holds a private `SprinkleSummary[]` cache. Inbound
`leader-sprinkle-update` calls `sync.broadcastSprinkleUpdate(name, data)`.
Inbound `leader-user-message-echo` calls `sync.broadcastUserMessage(text, id,
atts)`. Inbound `leader-sprinkles-snapshot` replaces the cached array.

`OffscreenMessageHub` is the same interface already used by
`follower-sprinkle-bridge.ts` — reuse it for symmetry.

### 3. New message types in `messages.ts`

```ts
export interface LeaderSprinklesSnapshotMsg {
  type: 'leader-sprinkles-snapshot';
  sprinkles: SprinkleSummaryEnvelope[]; // shape-compatible with SprinkleSummary
}

export interface LeaderSprinkleUpdateMsg {
  type: 'leader-sprinkle-update';
  sprinkleName: string;
  data: unknown;
}

export interface LeaderUserMessageEchoMsg {
  type: 'leader-user-message-echo';
  text: string;
  messageId: string;
  attachments?: MessageAttachment[];
}
```

Add each to the `PanelToOffscreenMessage` union. Mirror the compile-time
assertion `_AssertSprinkleSummaryEnvelopeMatches` from
`follower-sprinkle-bridge.ts` so the envelope type stays assignable to
`SprinkleSummary[]`.

### 4. `offscreen.ts:438-480` rewrite (the `workerBaseUrl` branch)

Replace the existing logging-only stub with a full mirror of
`page-leader-tray.ts:134-336`:

```ts
if (trayRuntimeConfig?.workerBaseUrl) {
  // 1. Construct LeaderSyncManager with offscreen-local callbacks.
  const leaderBridge = connectOffscreenLeaderSyncBridge(hub, /* sync set below */);

  const sync = new LeaderSyncManager({
    getMessages: () => bridge.getBuffer(bridge.getActiveScoopJid() ?? CONE_JID),
    getMessagesForScoop: (jid) => bridge.getBuffer(jid),
    getScoopJid: () => bridge.getActiveScoopJid() ?? CONE_JID,
    getScoops: () => orchestrator.getScoops().map(toScoopSummary),
    getSprinkles: () => leaderBridge.getSprinkles(),
    readSprinkleContent: async (name) => {
      const path = leaderBridge.resolveSprinklePath(name);
      if (!path || !host.sharedFs) return null;
      try {
        const raw = await host.sharedFs.readFile(path, { encoding: 'utf-8' });
        return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      } catch { return null; }
    },
    onSprinkleLick: (name, body, targetScoop) =>
      lickManager.emitEvent({ type: 'sprinkle', sprinkleName: name, body, targetScoop, … }),
    onFollowerMessage: (text, messageId, attachments) => {
      // Surface the message to the active scoop. The orchestrator's
      // user-message handling path is private — dispatch a synthetic
      // 'user-message' envelope through the bridge's transport so it
      // hits the exact same code path the panel uses.
      // … (see Open Questions: confirm method signature)
    },
    onFollowerAbort: () => {
      const jid = bridge.getActiveScoopJid();
      if (jid) orchestrator.stopScoop(jid);
    },
    onFollowerCountChanged: (_count) => { /* persist follower list, optional */ },
    browserAPI: browser,
    browserTransport: browser.getTransport(),
    vfs: host.sharedFs ?? undefined,
  });

  browser.setTrayTargetProvider(sync);

  // 2. Peer manager: route open channels to sync.addFollower.
  let trayLeader!: LeaderTrayManager;
  const trayPeers = new LeaderTrayPeerManager({
    sendControlMessage: (m) => trayLeader.sendControlMessage(m),
    onPeerConnected: (peer, channel) => {
      log.info('Tray follower data channel opened (extension leader)', { … });
      sync.addFollower(peer.bootstrapId, channel, {
        runtime: peer.runtime,
        connectedAt: peer.connectedAt ?? undefined,
      });
    },
    onPeerDisconnected: (bootstrapId, reason) => log.info(…),
  });

  // 3. Tray manager (existing).
  trayLeader = new LeaderTrayManager({ … });

  // 4. Agent event tap.
  const unsubAgent = bridge.onAgentEvent((event) => sync.broadcastEvent(event));

  // 5. Periodic broadcasts (5s) — exactly mirrors page-leader-tray.ts.
  const cdpThrottle = new ThrottledErrorTracker(log, { … });
  const refreshLeaderTargets = async () => { /* same as standalone */ };
  const intervals = [
    setInterval(refreshLeaderTargets, 5000),
    setInterval(() => { sync.broadcastScoopsList(); sync.broadcastSprinklesList(); }, 5000),
  ];
  void refreshLeaderTargets();
  void trayLeader.start().catch(…);

  stopTrayRuntime = () => {
    for (const id of intervals) clearInterval(id);
    unsubAgent();
    leaderBridge.detach();
    trayPeers.stop();
    trayLeader.stop();
    sync.stop();
  };
  return;
}
```

`CONE_JID` and `toScoopSummary` are pulled from the same helpers the bridge
uses.

### 5. `OffscreenBridge` additions

Tracks the active scoop JID for `getMessages`. The bridge already receives
panel `scoop-select` envelopes — store the selected JID on a field and expose
`getActiveScoopJid(): string | null`.

Also expose `getBuffer(jid)` and `currentMessageId.get(jid)` (or equivalents)
if not already public; the bridge keeps these internal today and the leader
branch needs them.

### 6. Panel-side wiring in `main.ts`

Mirror the standalone wiring at `main.ts:2418-2503` for extension-leader mode.
In `mainExtension` (the side-panel boot path), inside the existing tray
configuration block:

```ts
if (extensionLeaderActive) {
  const leaderSyncProxy = new PanelLeaderSyncProxy(panelSender);

  // Snapshot pushes
  const pushSprinkles = () => {
    const opened = new Set(sprinkleManager.opened());
    leaderSyncProxy.pushSprinklesSnapshot(
      sprinkleManager.available().map((p) => ({
        name: p.name,
        title: p.title,
        path: p.path,
        open: opened.has(p.name),
        autoOpen: p.autoOpen,
      }))
    );
  };
  // After refresh/open/close via SprinkleManager event hooks.
  sprinkleManager.onChange(pushSprinkles);
  void sprinkleManager.refresh().then(pushSprinkles);

  // Sprinkle updates
  sprinkleManager.setSendToSprinkleHook((name, data) =>
    leaderSyncProxy.pushSprinkleUpdate(name, data)
  );

  // Local user message echo
  layout.panels.chat.setOnLocalUserMessage((text, messageId, attachments) =>
    leaderSyncProxy.pushUserMessageEcho(text, messageId, attachments)
  );
}
```

**Detection of extension-leader mode:** the panel doesn't directly know
whether the offscreen document picked the leader or follower branch. Two
options:

- Read `tray-worker-base-url` + `tray-join-url` from `chrome.storage.local`
  (the values the user typed). Leader = worker URL set, no join URL. This
  matches what `resolveTrayRuntimeConfig` does on the offscreen side.
- Have the bridge emit a `leader-mode-ready` envelope on activation. The
  panel turns its hooks on/off based on that signal.

**Decision:** start with the second option — the offscreen document is
authoritative about which branch it took, and the lifecycle hand-off (e.g.,
user pastes a join URL → switches from leader to follower) needs to flip the
panel hooks. Single source of truth, no race window where the panel pushes
sprinkle updates the offscreen has already torn down.

### 7. Lifecycle and gating

- Activation: when offscreen takes the `workerBaseUrl` branch, send
  `leader-mode-active` to the panel. Panel installs hooks.
- Deactivation: when `stopTrayRuntime` runs (because the user pasted a join
  URL via `refresh-tray-runtime`, or unloaded), send `leader-mode-inactive`.
  Panel removes hooks (`setSendToSprinkleHook(undefined)`,
  `setOnLocalUserMessage(undefined)`, `sprinkleManager.offChange(...)`,
  `leaderSyncProxy.dispose()`).
- The existing `syncTrayRuntime` already handles the join-URL switch (drops
  current branch, evaluates new config). We extend its `stopTrayRuntime`
  closure to include the leader teardown.

## Wire protocol invariants

We add no new tray-protocol messages — every wire payload is one that
`LeaderSyncManager.broadcast*` already emits. Followers (standalone webapp,
extension-as-follower, iOS native) already understand them; this fix only
makes the extension-leader produce them. The protocol file
(`tray-sync-protocol.ts`) is not touched.

## Tests

| Layer                   | Test file                                                           | Coverage                                                                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bridge unit             | `packages/chrome-extension/tests/leader-sync-bridge.test.ts` (new)  | proxy↔adapter in-memory pipe: sprinkles snapshot caching + `getSprinkles`, `resolveSprinklePath` hit/miss, sprinkle update → `sync.broadcastSprinkleUpdate` mock, user echo → `sync.broadcastUserMessage` mock, `detach()` stops both directions |
| AgentEvent tap          | `packages/chrome-extension/tests/offscreen-bridge.test.ts` (extend) | each `OrchestratorCallbacks` invocation produces the expected `AgentEvent` shape for registered listeners; unsubscribe stops emission                                                                                                            |
| Offscreen leader branch | `packages/chrome-extension/tests/offscreen-leader.test.ts` (new)    | with a stubbed `LeaderTrayPeerManager` and a mock `RTCDataChannel`, assert: `sync.addFollower` is called on `onPeerConnected`, broadcast intervals fire, `unsubAgent` stops the tap, `stopTrayRuntime` tears everything down once                |
| Standalone-leader smoke | `packages/webapp/tests/ui/page-leader-tray.test.ts` (existing)      | no changes needed; the standalone reference path is unchanged                                                                                                                                                                                    |
| Manual integration      | (no automation)                                                     | Boot extension as leader, standalone webapp as follower; verify the test plan below                                                                                                                                                              |

## Manual test plan

1. `SLICC_EXT_DEV=1 npm run build -w @slicc/chrome-extension`. Load
   `dist/extension` in Chrome for Testing per
   `packages/chrome-extension/CLAUDE.md` "Local QA" recipe.
2. In the extension side panel, paste a tray worker URL (no join URL). Confirm
   `host` in the panel terminal shows leader status active.
3. In a separate window, run `npm run dev` and open the standalone webapp.
   Paste the same tray join URL (read from the extension's URL bar / `host`
   output).
4. Standalone follower must show: initial snapshot (any pre-existing
   conversation), full scoops list, sprinkles list.
5. Type in the **leader** chat → follower sees the user message live + agent
   stream tokens.
6. Trigger leader-side `sprinkle send welcome '{"action":"test"}'` → follower's
   welcome sprinkle receives the update.
7. Click a sprinkle on the **follower** → leader's lick router fires (verify
   via cone receiving a `sprinkle` channel message).
8. Type a message on the **follower** → leader's cone receives it as a user
   message and responds.

## Open questions to resolve during implementation

1. **`onFollowerMessage` plumbing.** The standalone path calls
   `agentHandle.sendMessage(text, messageId, attachments)` which routes
   through the worker bridge. In offscreen there's no `agentHandle` — the
   orchestrator is local. The simplest path is to dispatch a synthetic
   `user-message` envelope through the bridge transport so the existing
   panel-message handling code runs unchanged. Confirm during implementation
   that the bridge transport has a public injection seam, or expose a
   `bridge.dispatchUserMessage(jid, text, msgId, atts)` helper that mirrors
   what the wire listener does.

2. **AgentEvent synthesis fidelity.** The mapping table above synthesizes
   `messageId` and splits `onSendMessage` into three events. If the follower
   protocol consumer breaks on this (e.g., duplicate `message_start`, missing
   fields the orchestrator-callback layer doesn't carry), fall back to a
   non-`AgentEvent`-shaped tap and add a new wire payload to
   `tray-sync-protocol.ts`. Verify by capturing standalone-leader's
   `agent.event` payloads under the same scenarios and diffing against the
   synthesized ones.

3. **Sprinkle snapshot push trigger.** `SprinkleManager` doesn't expose an
   `onChange` event today. Either add one (preferred — small, reusable), or
   wrap `refresh()` / `open()` / `close()` at the call sites in `main.ts`.
   Decision: add `SprinkleManager.onChange(handler): () => void` (a few LoC,
   no behavior change for the standalone path).

## LoC estimate

| File                                                     |   Source |    Tests |
| -------------------------------------------------------- | -------: | -------: |
| `leader-sync-bridge.ts`                                  |     ~150 |     ~150 |
| `messages.ts` additions                                  |      ~30 |        — |
| `offscreen-bridge.ts` AgentEvent tap + active-jid getter |      ~60 |      ~60 |
| `offscreen.ts` `workerBaseUrl` branch rewrite            |     ~120 |      ~80 |
| `main.ts` panel-side wiring + activation listener        |      ~40 |        — |
| `SprinkleManager.onChange`                               |      ~10 |      ~20 |
| **Total**                                                | **~410** | **~310** |

Wider than the issue's ~150-200 estimate because (a) test coverage targets the
existing webapp coverage floors and (b) the AgentEvent tap is a real piece of
plumbing the issue didn't itemize.

## Cross-references

- Standalone reference: `packages/webapp/src/ui/page-leader-tray.ts`
- Standalone caller: `packages/webapp/src/ui/main.ts:2418-2503`
- Gap site: `packages/chrome-extension/src/offscreen.ts:438-480`
- Existing panel↔offscreen RPC patterns: `sprinkle-proxy.ts`,
  `follower-sprinkle-bridge.ts`, `OffscreenBridge.createCallbacks`
- Protocol: `packages/webapp/src/scoops/tray-sync-protocol.ts` (no changes)
- Architecture: `docs/architecture.md` "Multi-Browser Sync (Tray)
  Architecture" — add a note that the extension-leader path is now wired.
