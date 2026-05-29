import { describe, it, expect } from 'vitest';
import { assembleBundle, validateModelHasAccount } from '../../cloud/cone-config-client.js';

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
