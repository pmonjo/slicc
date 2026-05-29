import { describe, it, expect } from 'vitest';
import {
  assembleBundle,
  validateModelHasAccount,
  assembleDelta,
} from '../../cloud/cone-config-client.js';

describe('assembleBundle', () => {
  it('builds {model, accounts, secrets} from selected localStorage accounts + secret rows', () => {
    const accounts = [
      { providerId: 'anthropic', apiKey: 'k', accessToken: '' },
      { providerId: 'adobe', apiKey: '', accessToken: 't', tokenExpiresAt: 5 },
    ];
    const bundle = assembleBundle({
      model: 'anthropic:claude-opus-4-6',
      selectedProviderIds: ['anthropic'],
      allAccounts: accounts,
      secretRows: [{ name: 'GITHUB_TOKEN', value: 'g', domains: 'github.com' }],
    });
    expect(bundle.accounts).toEqual([{ providerId: 'anthropic', kind: 'apikey', apiKey: 'k' }]);
    expect(bundle.secrets).toEqual([{ name: 'GITHUB_TOKEN', value: 'g', domains: ['github.com'] }]);
  });

  it('drops a flat secret with no domains (would be unusable by the fetch-proxy)', () => {
    const bundle = assembleBundle({
      model: 'm',
      selectedProviderIds: [],
      allAccounts: [],
      secretRows: [
        { name: 'NO_DOM', value: 'v', domains: '' },
        { name: 'OK', value: 'v', domains: 'x.com' },
      ],
    });
    expect(bundle.secrets).toEqual([{ name: 'OK', value: 'v', domains: ['x.com'] }]);
  });

  it('skips a selected account with no credential (cleared/logged-out token)', () => {
    const bundle = assembleBundle({
      model: 'm',
      selectedProviderIds: ['adobe', 'anthropic'],
      allAccounts: [
        { providerId: 'adobe', apiKey: '', accessToken: '' }, // logged out
        { providerId: 'anthropic', apiKey: 'k', accessToken: '' },
      ],
      secretRows: [],
    });
    expect(bundle.accounts).toEqual([{ providerId: 'anthropic', kind: 'apikey', apiKey: 'k' }]);
  });
});

describe('validateModelHasAccount (F6 strict)', () => {
  it('passes when the model provider has a selected account', () => {
    expect(validateModelHasAccount('anthropic:x', ['anthropic'], [])).toBe(true);
  });
  it('fails when the model provider has no selected account', () => {
    expect(validateModelHasAccount('openai:x', ['anthropic'], [])).toBe(false);
  });
  it('passes for auth-optional providers', () => {
    expect(validateModelHasAccount('local:x', [], ['local'])).toBe(true);
  });
});

describe('assembleDelta', () => {
  it('produces upserts for new/changed and deletes for removed keys', () => {
    const delta = assembleDelta({
      model: 'openai:x',
      upsertAccounts: [{ providerId: 'openai', apiKey: 'k', accessToken: '' }],
      upsertSecretRows: [{ name: 'NEW', value: 'n', domains: 'x.com' }],
      deleteProviderIds: ['adobe'],
      deleteSecretNames: ['OLD'],
    });
    expect(delta).toEqual({
      model: 'openai:x',
      upsert: {
        accounts: [{ providerId: 'openai', kind: 'apikey', apiKey: 'k' }],
        secrets: [{ name: 'NEW', value: 'n', domains: ['x.com'] }],
      },
      delete: { providerIds: ['adobe'], secretNames: ['OLD'] },
    });
  });
  it('omits empty sections', () => {
    expect(
      assembleDelta({
        model: '',
        upsertAccounts: [],
        upsertSecretRows: [],
        deleteProviderIds: [],
        deleteSecretNames: [],
      })
    ).toEqual({});
  });
});
