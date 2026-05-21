/**
 * MCP OAuth — RFC 9728 (Protected Resource Metadata) + RFC 8414
 * (Authorization Server Metadata) discovery, RFC 7591 Dynamic Client
 * Registration, PKCE (S256/plain), authorization-code grant and refresh-token
 * rotation.
 *
 * All network calls go through an injected `fetch`-shaped function so unit
 * tests can drop in a stub. The runtime helpers in `provider.ts` default to
 * a thin wrapper over `createProxiedFetch()` so requests inherit the
 * webapp's CORS-bypassing transport.
 */

import { createLogger } from '../../core/logger.js';

const log = createLogger('mcp-oauth');

// ── Types ───────────────────────────────────────────────────────────

/** Minimal subset of an RFC 9728 Protected Resource Metadata document. */
export interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

/** Minimal subset of an RFC 8414 Authorization Server Metadata document. */
export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  grant_types_supported?: string[];
}

/** Normalized endpoint bundle returned by {@link discoverAuth}. */
export interface DiscoveredAuth {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  supportedScopes?: string[];
  codeChallengeMethods?: string[];
  grantTypes?: string[];
  issuer: string;
}

export interface DynamicRegistrationResult {
  clientId: string;
  registrationClientUri?: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
}

/** Minimal fetch shape we depend on — compatible with the global `fetch`. */
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
  headers?: { get(name: string): string | null };
}>;

// ── Discovery (RFC 9728 + RFC 8414) ─────────────────────────────────

/**
 * Discover the authorization server endpoints for an MCP server.
 *
 * 1. If `resourceMetadataUrl` is not provided, fetch
 *    `<serverOrigin>/.well-known/oauth-protected-resource` (RFC 9728).
 * 2. Pick the first `authorization_servers` entry.
 * 3. Fetch `<authServer>/.well-known/oauth-authorization-server` (RFC 8414)
 *    and return the normalized endpoint bundle.
 */
export async function discoverAuth(
  serverUrl: string,
  resourceMetadataUrl: string | undefined,
  fetchImpl: FetchLike
): Promise<DiscoveredAuth> {
  const prmUrl =
    resourceMetadataUrl ?? `${new URL(serverUrl).origin}/.well-known/oauth-protected-resource`;
  log.debug('Fetching PRM', { prmUrl });
  const prmRes = await fetchImpl(prmUrl, { headers: { Accept: 'application/json' } });
  if (!prmRes.ok) {
    throw new Error(`PRM fetch failed: ${prmRes.status} ${prmRes.statusText} (${prmUrl})`);
  }
  const prm = (await prmRes.json()) as ProtectedResourceMetadata;
  const asList = prm.authorization_servers ?? [];
  if (asList.length === 0) {
    throw new Error(`PRM at ${prmUrl} lists no authorization_servers`);
  }
  const asBase = asList[0].replace(/\/+$/, '');
  const asmUrl = `${asBase}/.well-known/oauth-authorization-server`;
  log.debug('Fetching ASM', { asmUrl });
  const asmRes = await fetchImpl(asmUrl, { headers: { Accept: 'application/json' } });
  if (!asmRes.ok) {
    throw new Error(`ASM fetch failed: ${asmRes.status} ${asmRes.statusText} (${asmUrl})`);
  }
  const asm = (await asmRes.json()) as AuthorizationServerMetadata;
  if (!asm.authorization_endpoint || !asm.token_endpoint) {
    throw new Error(`ASM at ${asmUrl} is missing required endpoints`);
  }
  return {
    issuer: asm.issuer || asBase,
    authorizationEndpoint: asm.authorization_endpoint,
    tokenEndpoint: asm.token_endpoint,
    registrationEndpoint: asm.registration_endpoint,
    supportedScopes: asm.scopes_supported ?? prm.scopes_supported,
    codeChallengeMethods: asm.code_challenge_methods_supported,
    grantTypes: asm.grant_types_supported,
  };
}

// ── Dynamic Client Registration (RFC 7591) ─────────────────────────

/**
 * Register a public client with the authorization server. Uses
 * `token_endpoint_auth_method: 'none'` (public client + PKCE).
 */
export async function dynamicRegister(
  asMetadata: DiscoveredAuth,
  redirectUri: string,
  fetchImpl: FetchLike
): Promise<DynamicRegistrationResult> {
  if (!asMetadata.registrationEndpoint) {
    throw new Error('Authorization server does not advertise a registration_endpoint (RFC 7591)');
  }
  const body = JSON.stringify({
    client_name: 'SLICC',
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
  const res = await fetchImpl(asMetadata.registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body,
  });
  if (!res.ok) {
    throw new Error(`DCR failed: ${res.status} ${res.statusText}`);
  }
  const reg = (await res.json()) as { client_id?: string; registration_client_uri?: string };
  if (!reg.client_id) throw new Error('DCR response missing client_id');
  return { clientId: reg.client_id, registrationClientUri: reg.registration_client_uri };
}

// ── PKCE ────────────────────────────────────────────────────────────

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  method: 'S256' | 'plain';
}

/** Pick the strongest supported PKCE method (S256 preferred). */
export function pickPkceMethod(supported: string[] | undefined): 'S256' | 'plain' {
  if (!supported || supported.length === 0) return 'S256';
  if (supported.includes('S256')) return 'S256';
  if (supported.includes('plain')) return 'plain';
  return 'S256';
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Generate a PKCE verifier + challenge pair using the chosen method. */
export async function generatePkce(method: 'S256' | 'plain'): Promise<PkcePair> {
  const rand = new Uint8Array(32);
  crypto.getRandomValues(rand);
  const codeVerifier = base64UrlEncode(rand);
  if (method === 'plain') {
    return { codeVerifier, codeChallenge: codeVerifier, method };
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  return { codeVerifier, codeChallenge: base64UrlEncode(new Uint8Array(digest)), method };
}

// ── Authorization-code flow ─────────────────────────────────────────

export interface RunAuthFlowOptions {
  asMetadata: DiscoveredAuth;
  clientId: string;
  redirectUri: string;
  scope?: string;
  /** Opens the authorize URL, returns the captured redirect URL or null. */
  launcher: (authorizeUrl: string) => Promise<string | null>;
  fetchImpl: FetchLike;
}

/** Extract `?code=...` from a redirect URL. */
export function extractCodeFromUrl(url: string): { code: string | null; state: string | null } {
  try {
    const parsed = new URL(url);
    return {
      code: parsed.searchParams.get('code'),
      state: parsed.searchParams.get('state'),
    };
  } catch {
    return { code: null, state: null };
  }
}

/**
 * Run the full PKCE authorization-code flow against the discovered AS:
 * build the authorize URL, launch the browser flow, capture the code,
 * exchange at the token endpoint. Returns the token bundle on success.
 */
export async function runAuthFlow(opts: RunAuthFlowOptions): Promise<TokenResponse> {
  const method = pickPkceMethod(opts.asMetadata.codeChallengeMethods);
  const pkce = await generatePkce(method);
  const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: pkce.method,
    state,
  });
  if (opts.scope) params.set('scope', opts.scope);
  const authorizeUrl = `${opts.asMetadata.authorizationEndpoint}?${params.toString()}`;

  const redirectUrl = await opts.launcher(authorizeUrl);
  if (!redirectUrl) throw new Error('MCP OAuth flow cancelled or timed out');
  const { code, state: returnedState } = extractCodeFromUrl(redirectUrl);
  if (!code) throw new Error('MCP OAuth redirect missing `code` parameter');
  if (returnedState && returnedState !== state) {
    throw new Error('MCP OAuth state mismatch — possible CSRF');
  }
  return exchangeCode({
    tokenEndpoint: opts.asMetadata.tokenEndpoint,
    clientId: opts.clientId,
    code,
    codeVerifier: pkce.codeVerifier,
    redirectUri: opts.redirectUri,
    fetchImpl: opts.fetchImpl,
  });
}

// ── Token exchange + refresh ────────────────────────────────────────

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

function parseTokenResponse(raw: RawTokenResponse): TokenResponse {
  if (raw.error || !raw.access_token) {
    throw new Error(
      `Token endpoint error: ${raw.error ?? 'no_access_token'}${raw.error_description ? ` — ${raw.error_description}` : ''}`
    );
  }
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    expiresAt: raw.expires_in ? Date.now() + raw.expires_in * 1000 : undefined,
    scope: raw.scope,
    tokenType: raw.token_type,
  };
}

export interface ExchangeCodeOptions {
  tokenEndpoint: string;
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  fetchImpl: FetchLike;
}

/** Exchange an authorization code for an access token (RFC 6749 §4.1). */
export async function exchangeCode(opts: ExchangeCodeOptions): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    code_verifier: opts.codeVerifier,
  }).toString();
  const res = await opts.fetchImpl(opts.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });
  const raw = (await res.json()) as RawTokenResponse;
  if (!res.ok && !raw.access_token) {
    throw new Error(
      `Token exchange failed: ${res.status} ${res.statusText}${raw.error ? ` (${raw.error})` : ''}`
    );
  }
  return parseTokenResponse(raw);
}

export interface RefreshTokenOptions {
  tokenEndpoint: string;
  clientId: string;
  refreshToken: string;
  scope?: string;
  fetchImpl: FetchLike;
}

/** Rotate an access token using a refresh_token grant (RFC 6749 §6). */
export async function refreshAccessToken(opts: RefreshTokenOptions): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
  });
  if (opts.scope) body.set('scope', opts.scope);
  const res = await opts.fetchImpl(opts.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  const raw = (await res.json()) as RawTokenResponse;
  if (!res.ok && !raw.access_token) {
    throw new Error(
      `Token refresh failed: ${res.status} ${res.statusText}${raw.error ? ` (${raw.error})` : ''}`
    );
  }
  return parseTokenResponse(raw);
}
