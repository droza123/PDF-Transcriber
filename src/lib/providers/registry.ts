import type { Provider, ProviderId } from './types';
import { GeminiProvider } from './gemini';
import { AnthropicProvider } from './anthropic';
import { OpenRouterProvider } from './openrouter';
import { getSettings } from '../settings';

const providers: Record<ProviderId, Provider> = {
  gemini: new GeminiProvider(),
  anthropic: new AnthropicProvider(),
  openrouter: new OpenRouterProvider(),
};

export function getProvider(id: ProviderId): Provider {
  const p = providers[id];
  if (!p) throw new Error(`Provider "${id}" is not available yet.`);
  return p;
}

export function getActiveProvider(): Provider {
  const { activeProvider } = getSettings();
  return getProvider(activeProvider);
}

export function getAllProviders(): Provider[] {
  return Object.values(providers).filter(Boolean);
}

export function isProviderAvailable(id: ProviderId): boolean {
  return !!providers[id];
}

/** Register a provider (used by later phases to add Anthropic/OpenRouter). */
export function registerProvider(provider: Provider): void {
  providers[provider.id] = provider;
}
