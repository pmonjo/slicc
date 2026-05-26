# Cloud cones on sliccy.ai — design

## Goal

Move the hosted-leader feature from "laptop-CLI-only" to "web-accessible at sliccy.ai/cloud" so Adobe employees can spawn, list, pause/resume, and kill their own cloud cones from any browser without needing the CLI installed. The CLI path (`slicc --cloud …`) stays in place for power users; this adds a parallel web entry point.

## Audience and scope

- **Audience**: Adobe employees, gated via IMS sign-in. v2 expands to any IMS identity with an `ownerOrg` claim (i.e., users of Adobe-org Adobe products). No public/anonymous access.
- **In scope (v1)**: dashboard at `sliccy.ai/cloud` with sign-in, create, list, pause, resume, kill. Per-user caps enforced server-side. Adobe team e2b account pays the bill.
- **Out of scope**: see "Explicit non-goals" at the end.

## Architecture overview

```
sliccy.ai (existing CF worker)
  ├── /cloud                          ← dashboard SPA (HTML/JS, static assets)
  ├── /api/cloud/*                    ← REST API, IMS-Bearer-auth, routes to per-user DO
  ├── /auth/cloud-callback            ← IMS implicit-grant callback (reuses in-app pattern)
  ├── CloudSessionsDurableObject      ← NEW. one per IMS userId. holds cone list.
  └── SessionTrayDurableObject        ← UNCHANGED. one per tray.

       ↓ (worker → e2b SDK)

e2b sandbox (existing 'slicc' template, slightly modified)
  ├── node-server in --hosted mode    ← UNCHANGED
  ├── start.sh                        ← writes /slicc/secrets.env from env vars before exec
  ├── /api/hosted-bootstrap           ← UNCHANGED, exposes injected ADOBE_IMS_TOKEN
  └── /api/leader-restart             ← UNCHANGED, kicked by worker on resume
```

The orchestration code in `packages/node-server/src/cloud/` is the conceptual reference; the worker reimplements the essential operations against the e2b SDK because the Workers runtime may not load the full Node e2b SDK identically (verify during implementation; if it doesn't fit, switch to a dedicated Node backend service — captured as a fallback in the plan, not the recommendation).

The substrate abstraction (`SandboxSubstrate`) migrates conceptually but as two separate consumers: laptop CLI keeps its current code path; worker has its own thin substrate adapter.

## Auth flow

The dashboard reuses the existing in-app IMS OAuth flow (implicit grant, `response_type=token`), with browser-held tokens sent as `Authorization: Bearer` on every API call.

```
User → sliccy.ai/cloud
  ↓ (no token in localStorage)
Dashboard JS → opens IMS authorize popup, response_type=token
  ↓ (consent / SSO)
IMS → /auth/cloud-callback#access_token=…&expires_in=…
Callback page → postMessage to opener, closes
Dashboard → localStorage['cloud-ims-token'] = token, renders list
  ↓
Every API call → Authorization: Bearer <token>
  ↓
Worker validates JWT (see Validation pipeline below)
       → routes to env.CLOUD_SESSIONS.idFromName(userId)
```

**Validation pipeline (in order)**:

1. JWT signature verification via `jose.jwtVerify` against cached IMS jwks (RS256).
2. `payload.iss === expectedIssuer` and `payload.client_id === env.IMS_CLIENT_ID`.
3. `payload.type === 'access_token'`.
4. Extract `email` and `ownerOrg` from JWT claims; fall back to `GET /ims/profile/v1` with Bearer if either is missing.
5. Email-domain allowlist: `env.ALLOWED_EMAIL_DOMAIN` (CSV, default `adobe.com`, `*` to disable).
6. Email denylist: `env.BLOCKED_EMAILS` (CSV, lowercased, trimmed). Denial wins over allow.
7. Optional org gate: if `env.REQUIRE_OWNER_ORG === 'true'`, reject when `ownerOrg` is empty.

Cache the validated `AuthResult` keyed by `SHA-256(token)` with TTL = `min(10min, tokenExp − now)`. Same library + cache shape as proven authentication patterns elsewhere in the codebase.

**"No refresh" tradeoff**: implicit grant doesn't return refresh tokens. When a token expires (Adobe IMS access tokens typically 24h), the dashboard catches the next 401, re-launches the IMS popup, transparently re-fires the request. With SSO this is zero-click; with fresh sessions it's the standard consent screen. Acceptable for internal tool.

## API surface

All endpoints are under `/api/cloud/*`, all require `Authorization: Bearer <ims-access-token>`, all return JSON.

```
POST /api/cloud/start    body: { name?: string }
   200 { sandboxId, name, joinUrl, trayId, createdAt }
   403 CAP_EXCEEDED       (running >= 1 or paused >= 5)
   503 SANDBOX_NOT_READY  (e2b boot timed out)

GET  /api/cloud/list
   200 { cones: [{ sandboxId, name, state, joinUrl, createdAt, lastSeen }] }

POST /api/cloud/pause    body: { sandboxId }
   200 { ok: true }
   404 NOT_FOUND
   409 ALREADY_PAUSED

POST /api/cloud/resume   body: { sandboxId }
   200 { sandboxId, joinUrl, trayRebuilt }
   404 NOT_FOUND
   409 ALREADY_RUNNING
   503 LEADER_NOT_READY   (post-resume Page.reload kick failed)

POST /api/cloud/kill     body: { sandboxId }
   200 { ok: true }                 (idempotent: returns 200 if already gone)
   404 NOT_FOUND
```

Middleware order on every request:

```
authBearer    — verify JWT against IMS jwks; extract userId from sub claim
loadUserDO    — env.CLOUD_SESSIONS.idFromName(userId) → stub
checkCap      — only on /start; rejects if at running/paused cap
```

## State storage

One `CloudSessionsDurableObject` instance per IMS user, keyed by `userId` (IMS `sub` claim, the unique stable IMS user-id like `E376851E585957EB0A495CC4@adobe.com`).

```typescript
interface CloudSessionsState {
  cones: Array<{
    sandboxId: string;
    name: string;
    state: 'running' | 'paused';
    joinUrl: string;
    trayId: string;
    createdAt: string;
    lastSeen: string;
  }>;
  // No auth state stored — browser holds the Bearer, worker uses whatever
  // arrives on each request. Implicit-grant means no refresh tokens to store.
}
```

**Properties this gives for free**:

- **Per-user isolation**: User A's `/list` cannot return User B's cones. Different DO instance.
- **Cross-device consistency**: Same userId → same DO globally → laptop and phone see the same list.
- **Concurrent-write safety**: DO is single-threaded; rapid-fire actions serialize cleanly.
- **Defense in depth**: each e2b sandbox is also tagged with `metadata.userId` at create; if DO state is ever lost, the user's cone list can be reconstructed by listing e2b sandboxes filtered by metadata.

## Sandbox lifecycle integration

**Boot ordering** (the timing race that matters): the existing in-sandbox bootstrap (main.ts hosted-leader branch) fetches `/api/hosted-bootstrap` ~5s after `startPageLeaderTray`. If `secrets.env` doesn't exist at that moment, the page sees no token and the Adobe provider stays unconfigured. The laptop CLI uploads the file before the sandbox boots, so the race doesn't bite there. The worker has no file system access pre-boot.

**Fix in the template**: pass the IMS token as a sandbox env var at `Sandbox.create` time; `start.sh` writes `secrets.env` from those envs BEFORE `exec`'ing node-server:

```sh
# packages/dev-tools/e2b-template/start.sh
if [ -n "$ADOBE_IMS_TOKEN" ]; then
  cat > /slicc/secrets.env <<EOF
ADOBE_IMS_TOKEN=$ADOBE_IMS_TOKEN
ADOBE_IMS_TOKEN_DOMAINS=$ADOBE_IMS_TOKEN_DOMAINS
EOF
fi
exec node /opt/slicc/node-server/index.js --hosted --port 5710 --no-open …
```

Worker calls `Sandbox.create('slicc', { envs: { ADOBE_IMS_TOKEN, ADOBE_IMS_TOKEN_DOMAINS }, metadata: { userId, name }, readyCmd: waitForFile('/tmp/slicc-join.json') })`. By the time `create` returns, the sandbox has secrets in place AND the leader has registered with the tray.

**Resume token freshness**: on `/api/cloud/resume`, worker reads the current Bearer (which the dashboard refreshed if needed), writes a new `/slicc/secrets.env` via `sbx.files.write`, then `sbx.commands.run` curls `/api/leader-restart`. The 5s page-side bootstrap delay shipped in `78ff315d` re-fires after Page.reload and picks up the fresh token. Identical to the laptop CLI's resume.

**API contract between worker and sandbox** (stable surfaces — changing these breaks paused cones from older templates):

```
sandbox HTTP surface:
  POST /api/leader-restart      (loopback-only inside sandbox)
  GET  /api/hosted-bootstrap    (loopback-only inside sandbox)
  POST /api/cloud-status        (loopback-only, sandbox-internal)

sandbox file surface:
  /slicc/secrets.env            (worker writes here)
  /tmp/slicc-join.json          (sandbox writes; worker reads via SDK)

sandbox env vars (consumed by start.sh):
  ADOBE_IMS_TOKEN
  ADOBE_IMS_TOKEN_DOMAINS
  SLICC_TRAY_WORKER_BASE_URL    (existing)
```

The worker code that depends on these gets an inline comment marking each call site as "STABLE API — paused cones from older templates depend on this shape; deprecation cycle required."

## Template versioning and paused-cone semantics

The `slicc` template alias is mutable (`Template.build` republishes under the same name). New `Sandbox.create('slicc', …)` always gets the latest build.

**Paused cone behavior**: e2b snapshots the entire sandbox VM at pause. When a user resumes a cone paused 5 days ago, they get back THAT image — the dist/ baked into the template at pause time. Their cone keeps the code it was paused with. Pros: work preserved exactly. Cons: long-paused cones may have known bugs that have been fixed.

This is the implicit deal with paused cones, and it requires the stable API contract above. Document inline; mention in `packages/dev-tools/e2b-template/README.md`.

**No rollback story in v1**: e2b alias doesn't support "previous build". If a release breaks the template, roll forward (revert the commit, rerun CI). v1.1 could add immutable tags alongside the alias (`slicc:v3.2.3`) for explicit rollback support.

## Deployment and CI

Cadence: **on release tag** (semantic-release driven; not on every main-merge).

Extended `.github/workflows/worker.yml` runs in order:

```
1. npm run build                              # dist/ui + dist/node-server
2. npx wrangler deploy …                      # ships worker + serves dist/ui
3. bash packages/dev-tools/e2b-template/scripts/build-template.sh
                                              # rebuilds 'slicc' alias
4. bash packages/dev-tools/e2b-template/scripts/verify-template.sh
                                              # spawn-then-kill smoke
5. existing tests/deployed.test.ts            # worker route smoke
6. NEW (optional in v1): cloud E2E smoke through the live /api/cloud/*
        — only if a CI-friendly IMS auth path exists (technical-account
        token or a worker-side test bypass). If not available at impl
        time, this gets deferred — the live substrate test in step 3
        already covers the e2b round-trip; step 4 covers the template;
        steps 5 covers the worker routes. The marginal coverage is "the
        auth-middleware doesn't choke on real headers."
```

GitHub Actions secret: `E2B_API_KEY` scoped to the Adobe team. Adds ~5-10min to release (chromium apt-install layer is cached; only dist/ layers rebuild).

The local `bash packages/dev-tools/e2b-template/scripts/build-template.sh` keeps working for iterating on template Dockerfile/start.sh changes outside the release cycle.

## Dashboard UI

Vanilla SPA served from the worker. No framework. ~500 LoC.

```
┌─ sliccy.ai/cloud ─────────────────────────────────────────┐
│  Cloud cones                            [Karl] [Sign out] │
│                                                            │
│  + New cone   [────────name (optional)───────] [Create]   │
│                                                            │
│  ┌────────────────────────────────────────────────────┐   │
│  │ ● smoke-3        running     2 min ago      Open ⤴ │   │
│  │                                       Pause  Kill  │   │
│  ├────────────────────────────────────────────────────┤   │
│  │ ○ analysis       paused      18 hr ago    Resume   │   │
│  │                                              Kill   │   │
│  └────────────────────────────────────────────────────┘   │
│                          1 running · 1 paused (cap: 1/5)   │
└────────────────────────────────────────────────────────────┘
```

**User journeys**:

- _First visit_: no token → "Sign in with Adobe" → popup → token → empty list → Create → spinner ~25s → cone with state=running → Open → new tab to joinUrl → existing follower flow.
- _Returning_: token in localStorage → validated → list rendered → click Resume → spinner ~30s → state flips, fresh joinUrl → Open.
- _Cap hit_: Create button greyed when at running cap; tooltip explains. Worker returns 403 if the client misses the gate.
- _Token expired_: 401 caught by dashboard JS → re-launches IMS popup → on success, re-fires the original request. Visible as a brief popup flash.

**Live state**: poll `/api/cloud/list` on page load, window focus, and 5s after each mutation. No SSE/WS in v1.

**Open behavior**: cone joinUrl opens in a new tab (`target="_blank"`). Follower tab is independent of the dashboard tab.

**Errors**: top-right toast with the API-returned code (CAP_EXCEEDED, NOT_FOUND, LEADER_NOT_READY) and a one-line explanation. Full error stashed in console for debug.

## Caps and quotas

Worker-enforced hard caps stored in `env`:

```
CONE_CAP_RUNNING = 1     (max concurrent running cones per user)
CONE_CAP_PAUSED  = 5     (max paused cones per user)
```

Check happens in the `checkCap` middleware on `/api/cloud/start`. Pause/resume/kill don't check (they only move existing cones between buckets). Dashboard mirrors the cap in the UI so users see the limit before hitting it.

No "total runtime per month" cap in v1. E2B's `auto-pause-on-cap` (which we already set in the substrate) covers idle sandboxes that exceed e2b's per-sandbox runtime budget.

## Testing

| Layer          | Scope                                                                                                                                                  | Where                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Unit           | Worker handlers + DO state mutations + cap enforcement + JWT verification — mock e2b SDK at the substrate boundary                                     | `packages/cloudflare-worker/tests/cloud.test.ts` (new)      |
| Live opt-in    | Real e2b sandbox lifecycle via the worker substrate code — env-var-gated, same pattern as the existing `packages/node-server/tests/cloud-live.test.ts` | `packages/cloudflare-worker/tests/cloud-live.test.ts` (new) |
| Deployed smoke | One end-to-end against staging post-deploy: spawn via real API, get joinUrl, kill                                                                      | extends `tests/deployed.test.ts`                            |
| Template smoke | Confirm just-published `slicc` template boots                                                                                                          | existing `verify-template.sh` in CI                         |

The `FakeSubstrate` from `packages/node-server/tests/cloud/fake-substrate.ts` ports to the worker as-is — the worker depends on the substrate interface, not e2b directly.

IMS tests: mock the jwks endpoint, sign a test JWT with a known key. `jose` library standard.

## Rollout

Configuration via Wrangler env vars (changeable without redeploying code):

| Var                    | v1 launch                     | v2 expansion                  |
| ---------------------- | ----------------------------- | ----------------------------- |
| `ALLOWED_EMAIL_DOMAIN` | `adobe.com`                   | `*`                           |
| `BLOCKED_EMAILS`       | `""`                          | same — denylist always active |
| `REQUIRE_OWNER_ORG`    | `false`                       | `true`                        |
| `IMS_CLIENT_ID`        | `<sliccy-cloud-app-id>`       | same                          |
| `IMS_ENVIRONMENT`      | `prod` (or `stg1` on staging) | same                          |
| `CONE_CAP_RUNNING`     | `1`                           | same                          |
| `CONE_CAP_PAUSED`      | `5`                           | same                          |

**v1 launch**: Adobe employees only (`ALLOWED_EMAIL_DOMAIN=adobe.com`, `REQUIRE_OWNER_ORG=false`). Denylist available for abuse mitigation from day one.

**v2 expansion**: flip `REQUIRE_OWNER_ORG=true`, set `ALLOWED_EMAIL_DOMAIN=*`. Anyone whose IMS identity carries an `ownerOrg` claim (i.e., the user's IMS principal belongs to at least one Adobe-customer organization, internal or external) gets access. Denylist still wins.

Phase transition is a Wrangler env-var change + redeploy — no code change, no schema migration. Document in worker CLAUDE.md.

**Why denylist over allowlist**: with IMS issuing tokens only to legitimate Adobe-org users, the per-user allowlist creates ongoing maintenance for no security benefit. Denylist is the rare bad-actor escape valve.

**Monitoring**:

- Cloudflare Workers Analytics (built-in) — latency, error rate per endpoint.
- E2B dashboard — sandbox count, hours used, spend per team.
- `GET /api/cloud/_admin/stats` — admin-only endpoint gated by an additional `ADMIN_USER_IDS` env list. Returns aggregate counts (total cones, cap utilization, recent errors). No PII beyond aggregates.
- `wrangler tail --env production` for live incident debugging.

## Explicit non-goals (v1)

- **Sharing**: joinUrls remain bearer-grade (anyone with the URL can attach). No per-recipient invite or revocation UI. Users can copy-paste at their own discretion.
- **Scheduled actions**: no auto-pause at clock times, no kill-after-idle. E2B's auto-pause-on-cap is the only automation.
- **Cone cloning / forking**: snapshot-and-copy is out.
- **Per-user cost visibility**: no $ display in dashboard. Aggregate visible via e2b dashboard for admins only.
- **Real-time updates**: dashboard polls. No SSE / WS push.
- **Multiple templates**: only `slicc`. No thin/fat/GPU variants.
- **Mobile UI**: desktop-only. The follower view (existing webapp) works on mobile already; the cone-management dashboard is desktop-first.
- **Persistent audit log**: no per-user "who created what when" trail beyond ephemeral Workers logs.
- **Backend-service fallback**: if e2b SDK turns out to be Workers-incompatible during implementation, the spec migrates to a dedicated Node backend service. Captured here as a known fallback; not the design intent.
