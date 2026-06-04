// Cross-platform replacement for packages/cloudflare-worker/scripts/publish-worker.sh.
// Inlines build-template.sh and verify-template.sh so no bash interpreter is required.
import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

const WRANGLER_CONFIG = 'packages/cloudflare-worker/wrangler.jsonc'
const MAX_ATTEMPTS = 6
const SLEEP_BETWEEN_S = 15

function run(cmd, opts = {}) {
  execSync(cmd, { stdio: 'inherit', ...opts })
}

function putSecret(name, value) {
  run(`npx wrangler secret put ${name} --config ${WRANGLER_CONFIG}`, {
    input: value + '\n',
    stdio: ['pipe', 'inherit', 'inherit'],
  })
}

// 1. Build e2b template (replaces build-template.sh)
console.log('[publish-worker] Building and pushing e2b template...')
if (!existsSync('dist/node-server/index.js')) {
  console.error("[publish-worker] dist/node-server/index.js not found. Run 'npm run build' first.")
  process.exit(1)
}
if (!existsSync('dist/ui/index.html')) {
  console.error("[publish-worker] dist/ui/index.html not found. Run 'npm run build' first.")
  process.exit(1)
}
if (!process.env.E2B_API_KEY) {
  console.error('[publish-worker] E2B_API_KEY not set.')
  process.exit(1)
}
run('npx tsx packages/dev-tools/e2b-template/template.ts')

// 2. Verify e2b template boots (replaces verify-template.sh + its inline node script)
console.log('[publish-worker] Verifying e2b template boots...')
{
  const { Sandbox } = await import('e2b')
  const MAX_CREATE_ATTEMPTS = 3
  const CREATE_TIMEOUT_MS = 120_000
  const POST_CREATE_TIMEOUT_MS = 10_000
  const BACKOFF_MS = 5_000

  let sbx
  for (let attempt = 1; attempt <= MAX_CREATE_ATTEMPTS; attempt++) {
    try {
      sbx = await Sandbox.create('slicc', {
        lifecycle: { onTimeout: 'kill' },
        requestTimeoutMs: CREATE_TIMEOUT_MS,
      })
      console.log(`[publish-worker] Created sandbox ${sbx.sandboxId} (attempt ${attempt})`)
      break
    } catch (err) {
      const msg = err?.message ?? String(err)
      console.error(`[publish-worker] Sandbox.create attempt ${attempt} failed: ${msg}`)
      if (attempt === MAX_CREATE_ATTEMPTS) {
        console.error(`[publish-worker] Sandbox.create failed after ${MAX_CREATE_ATTEMPTS} attempts`)
        process.exit(1)
      }
      await new Promise((r) => setTimeout(r, BACKOFF_MS * attempt))
    }
  }

  const start = Date.now()
  let joinJson = null
  while (Date.now() - start < 60_000) {
    try {
      const text = await sbx.files.read('/tmp/slicc-join.json', {
        requestTimeoutMs: POST_CREATE_TIMEOUT_MS,
      })
      joinJson = JSON.parse(text)
      if (joinJson.joinUrl) break
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }

  await sbx.kill({ requestTimeoutMs: POST_CREATE_TIMEOUT_MS })
  if (!joinJson?.joinUrl) {
    console.error('[publish-worker] /tmp/slicc-join.json never produced joinUrl')
    process.exit(1)
  }
  console.log('[publish-worker] Template verified OK:', joinJson.joinUrl)
}

// 3. Upload secrets
console.log('[publish-worker] Uploading worker secrets...')
const { CLOUDFLARE_TURN_API_TOKEN, GITHUB_CLIENT_SECRET, E2B_API_KEY } = process.env
putSecret('CLOUDFLARE_TURN_API_TOKEN', CLOUDFLARE_TURN_API_TOKEN)
putSecret('GITHUB_CLIENT_SECRET', GITHUB_CLIENT_SECRET)
putSecret('E2B_API_KEY', E2B_API_KEY)

// 4. Deploy
console.log('[publish-worker] Deploying worker...')
run(`npx wrangler deploy --config ${WRANGLER_CONFIG}`)

// 5. Smoke tests with retry
console.log(`[publish-worker] Running deployed smoke tests (up to ${MAX_ATTEMPTS} attempts)...`)
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  try {
    run(`npx vitest run --project cloudflare-worker packages/cloudflare-worker/tests/deployed.test.ts`)
    console.log(`[publish-worker] Smoke test passed on attempt ${attempt}.`)
    process.exit(0)
  } catch {
    if (attempt === MAX_ATTEMPTS) {
      console.error(`[publish-worker] Smoke test failed after ${MAX_ATTEMPTS} attempts.`)
      process.exit(1)
    }
    console.log(
      `[publish-worker] Smoke test failed on attempt ${attempt}; waiting ${SLEEP_BETWEEN_S}s for edge propagation...`,
    )
    await new Promise((r) => setTimeout(r, SLEEP_BETWEEN_S * 1000))
  }
}
