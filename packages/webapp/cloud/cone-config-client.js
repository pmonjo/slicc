// Pure bundle-assembly helpers for the /cloud dashboard. No DOM access here.

export function assembleBundle({ model, selectedProviderIds, allAccounts, secretRows }) {
  const selected = new Set(selectedProviderIds);
  const accounts = allAccounts
    .filter((a) => selected.has(a.providerId))
    .map((a) =>
      a.accessToken
        ? {
            providerId: a.providerId,
            kind: 'oauth',
            accessToken: a.accessToken,
            ...(a.refreshToken ? { refreshToken: a.refreshToken } : {}),
            ...(a.tokenExpiresAt ? { tokenExpiresAt: a.tokenExpiresAt } : {}),
            ...(a.userName ? { userName: a.userName } : {}),
          }
        : { providerId: a.providerId, kind: 'apikey', apiKey: a.apiKey }
    );
  const secrets = secretRows
    .filter((r) => r.name && r.value)
    .map((r) => ({
      name: r.name,
      value: r.value,
      domains: r.domains
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean),
    }));
  return { model, accounts, secrets };
}

export function validateModelHasAccount(model, selectedProviderIds, authOptionalProviders) {
  const provider = model.split(':')[0];
  if (authOptionalProviders.includes(provider)) return true;
  return selectedProviderIds.includes(provider);
}

export function assembleDelta({
  model,
  upsertAccounts,
  upsertSecretRows,
  deleteProviderIds,
  deleteSecretNames,
}) {
  const { accounts, secrets } = assembleBundle({
    model: model ?? '',
    selectedProviderIds: upsertAccounts.map((a) => a.providerId),
    allAccounts: upsertAccounts,
    secretRows: upsertSecretRows,
  });
  const delta = {};
  if (model) delta.model = model;
  const upsert = {};
  if (accounts.length) upsert.accounts = accounts;
  if (secrets.length) upsert.secrets = secrets;
  if (Object.keys(upsert).length) delta.upsert = upsert;
  const del = {};
  if (deleteProviderIds.length) del.providerIds = deleteProviderIds;
  if (deleteSecretNames.length) del.secretNames = deleteSecretNames;
  if (Object.keys(del).length) delta.delete = del;
  return delta;
}
