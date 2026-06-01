# `slicc.captureScreen()` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `captureScreen()` method to the sprinkle bridge that lets sprinkles capture a screen/window/tab via Chrome's native `getDisplayMedia` picker and receive the result as a Promise — no LLM turns required.

**Architecture:** The sprinkle posts a `sprinkle-capture-screen` message. The renderer handles it by calling the existing panel-RPC `screencapture` handler (which uses `getDisplayMedia`). The result (bytes + dimensions) is converted to base64 and posted back. Works in CLI mode (renderer has DOM) and extension mode (renderer routes through panel-RPC).

**Tech Stack:** TypeScript, postMessage bridge, panel-RPC (`packages/webapp/src/kernel/panel-rpc.ts`), `getDisplayMedia` Web API, Vitest.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/webapp/src/ui/sprinkle-bridge.ts` | `SprinkleBridgeAPI` interface + `SprinkleBridge` class — add `captureScreen` to both |
| `packages/webapp/src/ui/sprinkle-renderer.ts` | Message handler + bridge script injection — handle `sprinkle-capture-screen` messages |
| `packages/webapp/tests/ui/sprinkle-bridge.test.ts` | Unit tests for the bridge-level `captureScreen` handler delegation |
| `packages/webapp/tests/ui/sprinkle-renderer.test.ts` | Unit tests for the postMessage capture-screen flow in sandbox mode |

---

### Task 1: Add `captureScreen` to the bridge interface and class

**Files:**
- Modify: `packages/webapp/src/ui/sprinkle-bridge.ts`
- Test: `packages/webapp/tests/ui/sprinkle-bridge.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/webapp/tests/ui/sprinkle-bridge.test.ts`:

```typescript
it('captureScreen() delegates to the captureScreen handler', async () => {
  const captureScreenHandlerMock = vi.fn().mockResolvedValue({
    base64: 'iVBORw0KGgo=',
    width: 1920,
    height: 1080,
    mimeType: 'image/png',
  });
  bridge = new SprinkleBridge(
    mockFs,
    lickHandler,
    closeHandler,
    stopConeHandlerMock,
    attachImageHandlerMock,
    captureScreenHandlerMock
  );
  const api = bridge.createAPI('test-sprinkle');
  const result = await api.captureScreen();
  expect(captureScreenHandlerMock).toHaveBeenCalledTimes(1);
  expect(result).toEqual({
    base64: 'iVBORw0KGgo=',
    width: 1920,
    height: 1080,
    mimeType: 'image/png',
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- --run packages/webapp/tests/ui/sprinkle-bridge.test.ts`
Expected: FAIL — `SprinkleBridge` constructor doesn't accept a 6th argument yet; `captureScreen` doesn't exist on the API.

- [ ] **Step 3: Add the `CaptureScreenResult` type, update the interface, and modify the class**

In `packages/webapp/src/ui/sprinkle-bridge.ts`, add the result type after the existing imports:

```typescript
export interface CaptureScreenResult {
  base64: string;
  width: number;
  height: number;
  mimeType: string;
}
```

Add to `SprinkleBridgeAPI` interface (after `attachImage`):

```typescript
/** Capture a screen/window/tab via Chrome's native picker. Returns base64 PNG + metadata. */
captureScreen(): Promise<CaptureScreenResult>;
```

Add to the `SprinkleBridge` class:
- A new private field: `private captureScreenHandler: () => Promise<CaptureScreenResult>;`
- Accept it as the 6th constructor parameter.
- In `createAPI()`, add:

```typescript
captureScreen: () => this.captureScreenHandler(),
```

- [ ] **Step 4: Update existing tests to pass the new constructor argument**

All existing tests create `SprinkleBridge` with 5 args. Add a 6th `vi.fn()` to each `beforeEach` so existing tests still pass. The new constructor parameter is the `captureScreenHandler`:

```typescript
const captureScreenHandlerMock = vi.fn();
bridge = new SprinkleBridge(
  mockFs,
  lickHandler,
  closeHandler,
  stopConeHandlerMock,
  attachImageHandlerMock,
  captureScreenHandlerMock
);
```

- [ ] **Step 5: Run all tests to verify they pass**

Run: `npm run test -- --run packages/webapp/tests/ui/sprinkle-bridge.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add packages/webapp/src/ui/sprinkle-bridge.ts packages/webapp/tests/ui/sprinkle-bridge.test.ts
git commit -m "feat(sprinkle-bridge): add captureScreen to interface and class"
```

---

### Task 2: Handle `sprinkle-capture-screen` in the renderer (sandbox/extension mode)

**Files:**
- Modify: `packages/webapp/src/ui/sprinkle-renderer.ts`
- Test: `packages/webapp/tests/ui/sprinkle-renderer.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/webapp/tests/ui/sprinkle-renderer.test.ts`. The sandbox mode messageHandler dispatches `sprinkle-capture-screen` and posts a response. Find the existing sandbox test pattern and add:

```typescript
it('handles sprinkle-capture-screen by calling bridge.captureScreen and posting response', async () => {
  // Arrange: set up a mock bridge with captureScreen
  const mockResult = {
    base64: 'iVBORw0KGgo=',
    width: 1920,
    height: 1080,
    mimeType: 'image/png',
  };
  mockBridge.captureScreen = vi.fn().mockResolvedValue(mockResult);

  // Act: simulate postMessage from sprinkle iframe
  const postMessageSpy = vi.fn();
  // ... fire a MessageEvent with type: 'sprinkle-capture-screen', id: 'req-1'

  // Assert: response posted back with the result
  expect(postMessageSpy).toHaveBeenCalledWith(
    {
      type: 'sprinkle-capture-screen-response',
      id: 'req-1',
      base64: 'iVBORw0KGgo=',
      width: 1920,
      height: 1080,
      mimeType: 'image/png',
    },
    '*'
  );
});
```

Note: Adapt to the existing test patterns in the file — the mock setup for `SprinkleRenderer` varies by test. The key assertion is that when a `sprinkle-capture-screen` message arrives, `bridge.captureScreen()` is called and the result is posted back with the matching `id`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- --run packages/webapp/tests/ui/sprinkle-renderer.test.ts`
Expected: FAIL — no handler for `sprinkle-capture-screen` in the message handler.

- [ ] **Step 3: Add the message handler case in `renderInSandbox`**

In `sprinkle-renderer.ts`, inside the `this.messageHandler` function in `renderInSandbox()`, after the `sprinkle-fetch-script` case (around line 284), add:

```typescript
} else if (msg.type === 'sprinkle-capture-screen') {
  this.bridge.captureScreen().then(
    (result) =>
      iframe.contentWindow?.postMessage(
        {
          type: 'sprinkle-capture-screen-response',
          id: msg.id,
          base64: result.base64,
          width: result.width,
          height: result.height,
          mimeType: result.mimeType,
        },
        '*'
      ),
    (err: unknown) =>
      iframe.contentWindow?.postMessage(
        {
          type: 'sprinkle-capture-screen-response',
          id: msg.id,
          error: err instanceof Error ? err.message : String(err),
        },
        '*'
      )
  );
}
```

- [ ] **Step 4: Add the same handler in `renderFullDoc`**

In the `renderFullDoc` method's message handler (around line 695, after the `sprinkle-rm` case), add the identical handler:

```typescript
} else if (msg.type === 'sprinkle-capture-screen') {
  this.bridge.captureScreen().then(
    (result) =>
      iframe.contentWindow?.postMessage(
        {
          type: 'sprinkle-capture-screen-response',
          id: msg.id,
          base64: result.base64,
          width: result.width,
          height: result.height,
          mimeType: result.mimeType,
        },
        '*'
      ),
    (err: unknown) =>
      iframe.contentWindow?.postMessage(
        {
          type: 'sprinkle-capture-screen-response',
          id: msg.id,
          error: err instanceof Error ? err.message : String(err),
        },
        '*'
      )
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test -- --run packages/webapp/tests/ui/sprinkle-renderer.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add packages/webapp/src/ui/sprinkle-renderer.ts packages/webapp/tests/ui/sprinkle-renderer.test.ts
git commit -m "feat(sprinkle-renderer): handle sprinkle-capture-screen messages"
```

---

### Task 3: Add `captureScreen` to the bridge script (injected into full-doc iframes)

**Files:**
- Modify: `packages/webapp/src/ui/sprinkle-renderer.ts` (the `generateBridgeScript()` method)

- [ ] **Step 1: Add `captureScreen` to the bridge script API object**

In `generateBridgeScript()` (around line 392), inside the `var api = { ... }` object, after the `attachImage` entry, add:

```javascript
captureScreen: function() {
  return _vfsCall('sprinkle-capture-screen', {}, function(m) {
    return { base64: m.base64, width: m.width, height: m.height, mimeType: m.mimeType };
  });
},
```

This reuses the existing `_vfsCall` helper which already handles `id` generation, `postMessage`, callback matching, and error rejection.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (the bridge script is a plain string template, no TS compilation involved).

- [ ] **Step 3: Commit**

```bash
git add packages/webapp/src/ui/sprinkle-renderer.ts
git commit -m "feat(sprinkle-renderer): add captureScreen to injected bridge script"
```

---

### Task 4: Wire the `captureScreenHandler` in the sprinkle manager

**Files:**
- Modify: `packages/webapp/src/ui/sprinkle-manager.ts`

- [ ] **Step 1: Find where `SprinkleBridge` is constructed**

In `sprinkle-manager.ts`, locate where `new SprinkleBridge(...)` is called. This is where we inject the actual capture implementation.

- [ ] **Step 2: Add the `captureScreenHandler` as the 6th argument**

The handler needs access to the panel-RPC `screencapture` call. Import the required dependencies:

```typescript
import { getPanelRpcClient, hasLocalDom } from '../kernel/panel-rpc.js';
```

Then define the handler function (above or inline at the constructor call):

```typescript
const captureScreenHandler = async (): Promise<{
  base64: string;
  width: number;
  height: number;
  mimeType: string;
}> => {
  const mimeType = 'image/png';
  const quality = 1.0;

  const local = hasLocalDom();
  const panelRpc = getPanelRpcClient();

  if (!local && !panelRpc) {
    throw new Error('Screen capture unavailable in this environment');
  }

  if (local && !navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('Screen capture not supported in this browser');
  }

  let bytes: ArrayBuffer;
  let width: number;
  let height: number;

  if (local) {
    // Direct DOM capture (CLI/standalone mode)
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    try {
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => video.play().then(() => resolve()).catch(reject);
        video.onerror = () => reject(new Error('Failed to load video stream'));
      });
      await new Promise<void>((r) => setTimeout(r, 100));
      width = video.videoWidth;
      height = video.videoHeight;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Failed to get canvas context');
      ctx.drawImage(video, 0, 0, width, height);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('Failed to create image blob'))),
          mimeType,
          quality
        );
      });
      bytes = await blob.arrayBuffer();
    } finally {
      stream.getTracks().forEach((t) => t.stop());
    }
  } else {
    // Worker/extension: route through panel-RPC
    const result = await panelRpc!.call(
      'screencapture',
      { mimeType, quality },
      { timeoutMs: 5 * 60_000 }
    );
    bytes = result.bytes;
    width = result.width;
    height = result.height;
  }

  // Convert ArrayBuffer to base64
  const uint8 = new Uint8Array(bytes);
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < uint8.length; i += chunk) {
    binary += String.fromCharCode(...uint8.subarray(i, i + chunk));
  }
  const base64 = btoa(binary);

  return { base64, width, height, mimeType };
};
```

Pass `captureScreenHandler` as the 6th argument to `new SprinkleBridge(...)`.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Run full test suite**

Run: `npm run test -- --run`
Expected: ALL PASS. Some sprinkle-manager tests may need the new constructor argument added to their mock — check if the manager test creates `SprinkleBridge` directly.

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/ui/sprinkle-manager.ts
git commit -m "feat(sprinkle-manager): wire captureScreen handler with panel-RPC"
```

---

### Task 5: Add `captureScreen` to the inline mode (CLI non-iframe sprinkles)

**Files:**
- Modify: `packages/webapp/src/ui/sprinkle-renderer.ts`

- [ ] **Step 1: Verify inline mode already works**

In inline mode (`renderInline`), the sprinkle accesses `window.__slicc_sprinkles[name]` directly. Since `captureScreen` is now on the `SprinkleBridgeAPI` returned by `createAPI()`, inline sprinkles already have access to it — no extra wiring needed.

Verify by checking that `this.bridge` (which is a `SprinkleBridgeAPI`) is what gets stored in `window.__slicc_sprinkles[sprinkleName]` at line 732 of the renderer.

- [ ] **Step 2: Write a quick sanity test**

Add to `packages/webapp/tests/ui/sprinkle-renderer-inline.test.ts` (or the closest existing inline test file):

```typescript
it('inline mode exposes captureScreen on the bridge', () => {
  // After rendering inline, the bridge at window.__slicc_sprinkles[name]
  // should have captureScreen as a function
  expect(typeof bridge.captureScreen).toBe('function');
});
```

- [ ] **Step 3: Run tests**

Run: `npm run test -- --run packages/webapp/tests/ui/sprinkle-renderer-inline.test.ts`
Expected: PASS

- [ ] **Step 4: Commit (if any changes needed)**

```bash
git add packages/webapp/tests/ui/sprinkle-renderer-inline.test.ts
git commit -m "test: verify captureScreen available in inline mode"
```

---

### Task 6: Final verification

**Files:** None (verification only)

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: PASS with no errors

- [ ] **Step 2: Run full test suite**

Run: `npm run test -- --run`
Expected: ALL PASS

- [ ] **Step 3: Run prettier on changed files**

```bash
npx prettier --write packages/webapp/src/ui/sprinkle-bridge.ts packages/webapp/src/ui/sprinkle-renderer.ts packages/webapp/src/ui/sprinkle-manager.ts packages/webapp/tests/ui/sprinkle-bridge.test.ts packages/webapp/tests/ui/sprinkle-renderer.test.ts packages/webapp/tests/ui/sprinkle-renderer-inline.test.ts
```

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 5: Final commit if formatting changed anything**

```bash
git add -A && git status
# Only commit if prettier changed files
git commit -m "style: format captureScreen changes"
```
