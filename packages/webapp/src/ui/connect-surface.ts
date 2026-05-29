/**
 * Minimal provider-login + accounts + model-picker UI for connect mode.
 * Reuses the existing provider settings dialog and model selector.
 */

import {
  showProviderSettings,
  getAllAvailableModels,
  getSelectedModelId,
  setSelectedModelId,
  getSelectedProvider,
  getAccounts,
  getProviderConfig,
} from './provider-settings.js';

export async function mountConnectSurface(root: HTMLElement): Promise<void> {
  while (root.firstChild) root.removeChild(root.firstChild);
  root.className = 'connect-surface';

  // Title
  const title = document.createElement('h1');
  title.className = 'connect-surface__title';
  title.textContent = 'Configure Provider';
  root.appendChild(title);

  // Description
  const desc = document.createElement('p');
  desc.className = 'connect-surface__desc';
  desc.textContent = 'Add a provider account and select a model to continue.';
  root.appendChild(desc);

  // Accounts section
  const accountsSection = document.createElement('div');
  accountsSection.className = 'connect-surface__accounts';
  root.appendChild(accountsSection);

  // Model selector section
  const modelSection = document.createElement('div');
  modelSection.className = 'connect-surface__models';
  root.appendChild(modelSection);

  // Render accounts
  function renderAccounts() {
    while (accountsSection.firstChild) accountsSection.removeChild(accountsSection.firstChild);

    const accounts = getAccounts();
    if (accounts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'connect-surface__empty';
      empty.textContent = 'No accounts configured.';
      accountsSection.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.className = 'connect-surface__accounts-list';

      for (const account of accounts) {
        const config = getProviderConfig(account.providerId);
        const row = document.createElement('div');
        row.className = 'connect-surface__account-row';

        const info = document.createElement('div');
        info.className = 'connect-surface__account-info';

        const name = document.createElement('div');
        name.className = 'connect-surface__account-name';
        name.textContent = config.name;
        info.appendChild(name);

        const detail = document.createElement('div');
        detail.className = 'connect-surface__account-detail';
        if (account.userName) {
          detail.textContent = account.userName;
        } else if (account.accessToken) {
          detail.textContent = 'Logged in';
        } else {
          detail.textContent = account.apiKey ? '••••••••' : 'No credentials';
        }
        info.appendChild(detail);

        row.appendChild(info);
        list.appendChild(row);
      }
      accountsSection.appendChild(list);
    }

    // Add account button
    const addBtn = document.createElement('button');
    addBtn.className = 'connect-surface__add-btn';
    addBtn.textContent = accounts.length === 0 ? 'Add Provider' : 'Manage Accounts';
    addBtn.onclick = async () => {
      const changed = await showProviderSettings();
      if (changed) {
        renderAccounts();
        renderModels();
      }
    };
    accountsSection.appendChild(addBtn);
  }

  // Render models
  function renderModels() {
    while (modelSection.firstChild) modelSection.removeChild(modelSection.firstChild);

    const groups = getAllAvailableModels();
    if (groups.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'connect-surface__empty';
      empty.textContent = 'No models available. Add a provider account first.';
      modelSection.appendChild(empty);
      return;
    }

    const title = document.createElement('h2');
    title.className = 'connect-surface__section-title';
    title.textContent = 'Select Model';
    modelSection.appendChild(title);

    const currentModelId = getSelectedModelId();
    const currentProvider = getSelectedProvider();

    // Flatten all models with their provider info
    const allModels: Array<{
      providerId: string;
      providerName: string;
      id: string;
      name: string;
    }> = [];
    for (const group of groups) {
      for (const model of group.models) {
        allModels.push({
          providerId: group.providerId,
          providerName: group.providerName,
          id: model.id,
          name: model.name,
        });
      }
    }

    const modelList = document.createElement('div');
    modelList.className = 'connect-surface__model-list';

    for (const model of allModels) {
      const isSelected = model.id === currentModelId && model.providerId === currentProvider;
      const btn = document.createElement('button');
      btn.className = 'connect-surface__model-btn';
      if (isSelected) btn.classList.add('connect-surface__model-btn--selected');

      const modelName = document.createElement('span');
      modelName.className = 'connect-surface__model-name';
      modelName.textContent = model.name;
      btn.appendChild(modelName);

      const providerName = document.createElement('span');
      providerName.className = 'connect-surface__model-provider';
      providerName.textContent = model.providerName;
      btn.appendChild(providerName);

      btn.onclick = () => {
        setSelectedModelId(`${model.providerId}:${model.id}`);
        renderModels();
      };

      modelList.appendChild(btn);
    }

    modelSection.appendChild(modelList);
  }

  // Initial render
  renderAccounts();
  renderModels();

  // Add minimal styling
  const style = document.createElement('style');
  style.textContent = `
    .connect-surface {
      padding: 2rem;
      max-width: 600px;
      margin: 0 auto;
    }
    .connect-surface__title {
      font-size: 1.5rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
      color: var(--s2-content-default, #333);
    }
    .connect-surface__desc {
      color: var(--s2-content-secondary, #666);
      margin-bottom: 2rem;
    }
    .connect-surface__section-title {
      font-size: 1.125rem;
      font-weight: 600;
      margin-bottom: 1rem;
      color: var(--s2-content-default, #333);
    }
    .connect-surface__accounts {
      margin-bottom: 2rem;
    }
    .connect-surface__accounts-list {
      margin-bottom: 1rem;
    }
    .connect-surface__account-row {
      display: flex;
      align-items: center;
      padding: 0.75rem 1rem;
      background: var(--s2-bg-layer-2, #f5f5f5);
      border-radius: var(--s2-radius-default, 6px);
      margin-bottom: 0.5rem;
      border: 1px solid var(--s2-border-subtle, #e0e0e0);
    }
    .connect-surface__account-info {
      flex: 1;
    }
    .connect-surface__account-name {
      font-weight: 600;
      color: var(--s2-content-default, #333);
    }
    .connect-surface__account-detail {
      font-size: 0.875rem;
      color: var(--s2-content-secondary, #666);
      font-family: monospace;
    }
    .connect-surface__add-btn {
      padding: 0.5rem 1rem;
      background: var(--s2-primary, #0066cc);
      color: white;
      border: none;
      border-radius: var(--s2-radius-default, 6px);
      cursor: pointer;
      font-size: 0.875rem;
      font-weight: 600;
    }
    .connect-surface__add-btn:hover {
      background: var(--s2-primary-hover, #0052a3);
    }
    .connect-surface__empty {
      color: var(--s2-content-disabled, #999);
      font-style: italic;
      margin-bottom: 1rem;
    }
    .connect-surface__model-list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .connect-surface__model-btn {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 1rem;
      background: var(--s2-bg-layer-2, #f5f5f5);
      border: 1px solid var(--s2-border-subtle, #e0e0e0);
      border-radius: var(--s2-radius-default, 6px);
      cursor: pointer;
      text-align: left;
    }
    .connect-surface__model-btn:hover {
      background: var(--s2-bg-layer-3, #ebebeb);
    }
    .connect-surface__model-btn--selected {
      border-color: var(--s2-primary, #0066cc);
      background: var(--s2-primary-bg, #e6f0ff);
    }
    .connect-surface__model-name {
      font-weight: 600;
      color: var(--s2-content-default, #333);
    }
    .connect-surface__model-provider {
      font-size: 0.75rem;
      color: var(--s2-content-secondary, #666);
      margin-left: 0.5rem;
    }
  `;
  document.head.appendChild(style);
}
