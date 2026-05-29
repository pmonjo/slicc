import { describe, it, expect } from 'vitest';
import { applyConeConfigDelta } from '../src/operations/resume.js';

describe('applyConeConfigDelta (read-modify-write of both files)', () => {
  it('merges upserts/deletes, returns new file contents + names index', () => {
    const existingConeConfig = JSON.stringify({
      model: 'adobe:claude-opus-4-6',
      accounts: [{ providerId: 'adobe', kind: 'oauth', accessToken: 'old' }],
    });
    const existingSecretsEnv = 'GITHUB_TOKEN=gt\nGITHUB_TOKEN_DOMAINS=github.com\n';
    const out = applyConeConfigDelta(existingConeConfig, existingSecretsEnv, {
      upsert: {
        accounts: [{ providerId: 'adobe', kind: 'oauth', accessToken: 'fresh' }],
        secrets: [{ name: 'NEW', value: 'n', domains: ['x.com'] }],
      },
      delete: { secretNames: ['GITHUB_TOKEN'] },
    });
    expect(JSON.parse(out.coneConfigJson).accounts[0].accessToken).toBe('fresh');
    expect(out.secretsEnv).toContain('NEW=n');
    expect(out.secretsEnv).not.toContain('GITHUB_TOKEN=gt');
    expect(out.index.secretNames).toEqual(['NEW']);
  });

  it('synthesizes from secrets.env when cone-config.json is missing (pre-feature cone)', () => {
    const out = applyConeConfigDelta(
      null,
      'ADOBE_IMS_TOKEN=abc\nADOBE_IMS_TOKEN_DOMAINS=adobe-llm-proxy.example\n',
      { upsert: { accounts: [{ providerId: 'adobe', kind: 'oauth', accessToken: 'abc' }] } }
    );
    expect(JSON.parse(out.coneConfigJson).model).toBe('adobe:claude-opus-4-6');
    expect(JSON.parse(out.coneConfigJson).accounts[0].providerId).toBe('adobe');
  });
});
