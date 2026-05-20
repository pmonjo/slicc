import { afterEach, describe, expect, it, vi } from 'vitest';
import { getApiProvider } from '@earendil-works/pi-ai';

// The register() call in the built-in module registers 'bedrock-camp-converse'.
import {
  register,
  config,
  streamSimpleBedrockCamp,
} from '../../../src/providers/built-in/bedrock-camp.js';

// Call register manually since built-in modules use explicit registration
register();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('bedrock-camp built-in provider', () => {
  it('exports a valid ProviderConfig', () => {
    expect(config).toBeDefined();
    expect(config.id).toBe('bedrock-camp');
    expect(config.name).toBe('AWS Bedrock (CAMP)');
    expect(config.requiresApiKey).toBe(true);
    expect(config.requiresBaseUrl).toBe(true);
  });

  it('registers bedrock-camp-converse in the API provider registry', () => {
    const provider = getApiProvider('bedrock-camp-converse' as any);
    expect(provider).toBeDefined();
    expect(provider!.api).toBe('bedrock-camp-converse');
  });

  it('registers both stream and streamSimple functions', () => {
    const provider = getApiProvider('bedrock-camp-converse' as any);
    expect(typeof provider!.stream).toBe('function');
    expect(typeof provider!.streamSimple).toBe('function');
  });

  it('passes the request payload and resolved model to onPayload before sending the converse request', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: {
          message: {
            content: [{ text: 'hello from bedrock camp' }],
          },
        },
        usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
        stopReason: 'end_turn',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const payloads: unknown[] = [];
    const models: unknown[] = [];
    const argCounts: number[] = [];
    const stream = streamSimpleBedrockCamp(
      {
        id: 'anthropic.claude-sonnet-4-6',
        provider: 'bedrock-camp',
        api: 'bedrock-camp-converse',
        baseUrl: 'https://bedrock-runtime.us-west-2.amazonaws.com',
        maxTokens: 200000,
        input: ['text', 'image'],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      } as any,
      {
        messages: [{ role: 'user', content: 'Say hello' }],
      } as any,
      {
        apiKey: 'ABSK-test',
        onPayload(...args: unknown[]) {
          argCounts.push(args.length);
          payloads.push(args[0]);
          models.push(args[1]);
        },
      }
    );

    const result = await stream.result();

    expect(result.stopReason).toBe('stop');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Provider now issues a plain cross-origin fetch — CLI mode's
    // CORS routing is handled by `llm-proxy-sw.ts` which rewrites the
    // request at the SW layer before it leaves the page. Extension mode
    // bypasses CORS via host_permissions.
    expect(fetchMock).toHaveBeenCalledWith(
      'https://bedrock-runtime.us-west-2.amazonaws.com/model/anthropic.claude-sonnet-4-6/converse',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer ABSK-test',
          'Content-Type': 'application/json',
        }),
      })
    );
    expect(payloads).toHaveLength(1);
    expect(models).toHaveLength(1);
    expect(argCounts).toEqual([2]);
    expect(models[0]).toMatchObject({
      id: 'anthropic.claude-sonnet-4-6',
      api: 'bedrock-camp-converse',
    });
    expect(payloads[0]).toEqual(
      expect.objectContaining({
        modelId: 'anthropic.claude-sonnet-4-6',
        messages: [
          {
            role: 'user',
            content: [{ text: 'Say hello' }, { cachePoint: { type: 'default' } }],
          },
        ],
      })
    );
  });

  it.each([
    ['us.anthropic.claude-opus-4-6', 'max'],
    ['us.anthropic.claude-opus-4-7', 'max'],
    ['global.anthropic.claude-opus-4-7', 'max'],
    ['us.anthropic.claude-sonnet-4-6', 'high'],
    ['us.anthropic.claude-sonnet-4-7', 'high'],
    ['us.anthropic.claude-haiku-4-7', 'high'],
  ])(
    'uses adaptive thinking (not type.enabled) for Claude 4.6+ models (%s)',
    async (modelId, expectedEffort) => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          output: { message: { content: [{ text: 'ok' }] } },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          stopReason: 'end_turn',
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      let captured: any;
      const stream = streamSimpleBedrockCamp(
        {
          id: modelId,
          provider: 'amazon-bedrock',
          api: 'bedrock-camp-converse',
          baseUrl: 'https://bedrock-runtime.us-west-2.amazonaws.com',
          maxTokens: 128_000,
          input: ['text'],
          reasoning: true,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        } as any,
        { messages: [{ role: 'user', content: 'hi' }] } as any,
        {
          apiKey: 'ABSK-test',
          reasoning: 'xhigh',
          onPayload(payload: unknown) {
            captured = payload;
          },
        }
      );

      await stream.result();

      expect(captured.additionalModelRequestFields).toEqual({
        thinking: { type: 'adaptive' },
        output_config: { effort: expectedEffort },
      });
      expect(captured.additionalModelRequestFields.thinking.type).not.toBe('enabled');
    }
  );

  it('keeps legacy thinking.type=enabled for pre-4.6 Claude models', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        output: { message: { content: [{ text: 'ok' }] } },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        stopReason: 'end_turn',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    let captured: any;
    const stream = streamSimpleBedrockCamp(
      {
        id: 'us.anthropic.claude-sonnet-4-5',
        provider: 'amazon-bedrock',
        api: 'bedrock-camp-converse',
        baseUrl: 'https://bedrock-runtime.us-west-2.amazonaws.com',
        maxTokens: 64_000,
        input: ['text'],
        reasoning: true,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      } as any,
      { messages: [{ role: 'user', content: 'hi' }] } as any,
      {
        apiKey: 'ABSK-test',
        reasoning: 'medium',
        onPayload(payload: unknown) {
          captured = payload;
        },
      }
    );

    await stream.result();

    expect(captured.additionalModelRequestFields.thinking.type).toBe('enabled');
    expect(captured.additionalModelRequestFields.thinking.budget_tokens).toBeGreaterThan(0);
  });
});
