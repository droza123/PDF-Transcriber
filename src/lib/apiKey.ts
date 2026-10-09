import type { ProviderId } from './providers/types';
import { getSettings } from './settings';
import { getSecret, setSecret, removeSecret } from './secretStore';

function storageKey(provider: ProviderId): string {
  return `provider_api_key_${provider}`;
}

export function getApiKey(provider?: ProviderId): string | null {
  const p = provider ?? getSettings().activeProvider;

  // Migration: move old gemini_api_key to new format on first access
  if (p === 'gemini') {
    const oldKey = getSecret('gemini_api_key');
    if (oldKey) {
      setSecret(storageKey('gemini'), oldKey);
      removeSecret('gemini_api_key');
      return oldKey;
    }
  }

  return getSecret(storageKey(p)) || null;
}

export function setApiKey(provider: ProviderId, key: string): void {
  setSecret(storageKey(provider), key);
}

export function clearApiKey(provider: ProviderId): void {
  removeSecret(storageKey(provider));
}

export function hasApiKey(provider?: ProviderId): boolean {
  const p = provider ?? getSettings().activeProvider;
  // Custom provider doesn't require an API key — treat it as configured
  // if models have been set up (user has connected to a server)
  if (p === 'custom') {
    const { customModels, customActiveConfigId } = getSettings();
    const key = getCustomConfigApiKey(customActiveConfigId);
    return customModels.length > 0 || !!key;
  }
  return !!getApiKey(p);
}

// ── Custom config-specific API key helpers ──

function customConfigStorageKey(configId: string): string {
  return configId === 'manual' ? 'provider_api_key_custom' : `provider_api_key_custom_${configId}`;
}

export function getCustomConfigApiKey(configId: string): string | null {
  return getSecret(customConfigStorageKey(configId)) || null;
}

export function setCustomConfigApiKey(configId: string, key: string): void {
  setSecret(customConfigStorageKey(configId), key);
}

export function clearCustomConfigApiKey(configId: string): void {
  removeSecret(customConfigStorageKey(configId));
}

/** Get cached available models for a provider. */
export function getCachedModels(provider?: ProviderId): string[] {
  const p = provider ?? getSettings().activeProvider;
  try {
    return JSON.parse(localStorage.getItem(`available_models_${p}`) || '[]');
  } catch {
    return [];
  }
}

/** Cache available models for a provider. */
export function setCachedModels(provider: ProviderId, models: string[]): void {
  localStorage.setItem(`available_models_${provider}`, JSON.stringify(models));
}

/**
 * Validate and fetch models using the provider implementation.
 * This is a convenience wrapper — the actual logic lives in each provider.
 */
export async function validateAndFetchModels(
  provider: ProviderId,
  key: string,
): Promise<{
  valid: boolean;
  error?: string;
  models: string[];
}> {
  // Dynamic import to avoid circular deps
  const { getProvider } = await import('./providers/registry');
  const p = getProvider(provider);

  const validation = await p.validateKey(key);
  if (!validation.valid) {
    return { valid: false, error: validation.error, models: [] };
  }

  const providerModels = await p.fetchModels(key);
  const modelIds = providerModels.map(m => m.id);
  setCachedModels(provider, modelIds);

  return { valid: true, models: modelIds };
}
