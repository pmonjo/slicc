import { describe, it, expect } from 'vitest';
import {
  CHERRY_PROTOCOL_VERSION,
  isCherryEnvelope,
  acceptEnvelope,
  type CherryEnvelope,
} from '../../src/cdp/cherry-host-protocol.js';

const make = (over: Partial<CherryEnvelope> = {}): CherryEnvelope =>
  ({
    cherry: CHERRY_PROTOCOL_VERSION,
    channelId: 'cherry-abc',
    kind: 'cdp.request',
    id: 1,
    method: 'Page.enable',
    ...over,
  }) as CherryEnvelope;

describe('isCherryEnvelope', () => {
  it('accepts a well-formed envelope', () => {
    expect(isCherryEnvelope(make())).toBe(true);
  });
  it('rejects wrong protocol version', () => {
    expect(isCherryEnvelope({ ...make(), cherry: 999 })).toBe(false);
  });
  it('rejects non-objects', () => {
    expect(isCherryEnvelope(null)).toBe(false);
    expect(isCherryEnvelope('x')).toBe(false);
  });
});

describe('acceptEnvelope three-factor pinning', () => {
  const expectedSource = {} as MessageEventSource;
  const ctx = {
    allowOrigins: ['https://host.example'],
    expectedSource,
    channelId: 'cherry-abc',
  };

  it('accepts matching origin + source + channelId', () => {
    const ev = {
      origin: 'https://host.example',
      source: expectedSource,
      data: make(),
    } as MessageEvent;
    expect(acceptEnvelope(ev, ctx)).toBe(true);
  });

  it('rejects foreign origin', () => {
    const ev = {
      origin: 'https://evil.example',
      source: expectedSource,
      data: make(),
    } as MessageEvent;
    expect(acceptEnvelope(ev, ctx)).toBe(false);
  });

  it('rejects mismatched source', () => {
    const ev = {
      origin: 'https://host.example',
      source: {} as MessageEventSource,
      data: make(),
    } as MessageEvent;
    expect(acceptEnvelope(ev, ctx)).toBe(false);
  });

  it('rejects mismatched channelId', () => {
    const ev = {
      origin: 'https://host.example',
      source: expectedSource,
      data: make({ channelId: 'cherry-other' }),
    } as MessageEvent;
    expect(acceptEnvelope(ev, ctx)).toBe(false);
  });

  it('accepts pre-handshake when ctx.channelId is null', () => {
    const ev = {
      origin: 'https://host.example',
      source: expectedSource,
      data: make({ kind: 'handshake.hello', channelId: 'cherry-new' }),
    } as MessageEvent;
    expect(acceptEnvelope(ev, { ...ctx, channelId: null })).toBe(true);
  });
});
