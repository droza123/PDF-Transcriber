import type { ProviderId } from './providers/types';

export type ExportFormat = 'md' | 'html' | 'docx' | 'docx-logos';
export type FileNaming = 'overwrite' | 'unique';

export const DEFAULT_TRANSLATION_LANGUAGES = [
  'English', 'Spanish', 'French', 'German', 'Portuguese', 'Italian',
  'Chinese (Simplified)', 'Japanese', 'Korean', 'Arabic', 'Russian',
];

export const DEFAULT_GEMINI_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-3.1-flash-lite-preview',
  'gemini-3-flash',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
];

export const DEFAULT_ANTHROPIC_MODELS = [
  'claude-sonnet-4-20250514',
  'claude-haiku-35-20241022',
];

export const DEFAULT_OPENROUTER_MODELS: string[] = [];

/** Per-provider default model lists. */
export const PROVIDER_DEFAULT_MODELS: Record<ProviderId, string[]> = {
  gemini: DEFAULT_GEMINI_MODELS,
  anthropic: DEFAULT_ANTHROPIC_MODELS,
  openrouter: DEFAULT_OPENROUTER_MODELS,
};

export interface AppSettings {
  activeProvider: ProviderId;
  providerModelPriority: Record<ProviderId, string[]>;
  openrouterAutoFreeModels: boolean;
  batchSize: number;
  outputNotes: string;
  autoExportFormats: ExportFormat[];
  preventSleep: boolean;
  fileNaming: FileNaming;
  translationEnabled: boolean;
  translationLanguage: string;
  translationLanguages: string[];
  exportTranscriptionWithTranslation: boolean;
}

const STORAGE_KEY = 'app_settings';

const DEFAULTS: AppSettings = {
  activeProvider: 'gemini',
  providerModelPriority: {
    gemini: [...DEFAULT_GEMINI_MODELS],
    anthropic: [...DEFAULT_ANTHROPIC_MODELS],
    openrouter: [...DEFAULT_OPENROUTER_MODELS],
  },
  openrouterAutoFreeModels: true,
  batchSize: 5,
  outputNotes: '',
  autoExportFormats: ['md'],
  preventSleep: true,
  fileNaming: 'overwrite',
  translationEnabled: false,
  translationLanguage: '',
  translationLanguages: [...DEFAULT_TRANSLATION_LANGUAGES],
  exportTranscriptionWithTranslation: true,
};

export function getSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw);

    // ── Migration: old single-provider format ──────────────────────────────

    // Migrate old `model: string` → modelPriority
    if ('model' in parsed && !('modelPriority' in parsed)) {
      const oldModel: string = parsed.model;
      parsed.modelPriority = [oldModel, ...DEFAULT_GEMINI_MODELS.filter(m => m !== oldModel)];
      delete parsed.model;
    }

    // Migrate old `modelPriority: string[]` → providerModelPriority
    if ('modelPriority' in parsed && !('providerModelPriority' in parsed)) {
      const oldPriority: string[] = parsed.modelPriority;
      parsed.providerModelPriority = {
        gemini: oldPriority.length > 0 ? oldPriority : [...DEFAULT_GEMINI_MODELS],
        anthropic: [...DEFAULT_ANTHROPIC_MODELS],
        openrouter: [...DEFAULT_OPENROUTER_MODELS],
      };
      delete parsed.modelPriority;
    }

    // Ensure activeProvider exists (default to gemini for existing users)
    if (!('activeProvider' in parsed)) {
      parsed.activeProvider = 'gemini';
    }

    // Ensure providerModelPriority has all providers
    if (parsed.providerModelPriority) {
      if (!parsed.providerModelPriority.gemini) {
        parsed.providerModelPriority.gemini = [...DEFAULT_GEMINI_MODELS];
      }
      if (!parsed.providerModelPriority.anthropic) {
        parsed.providerModelPriority.anthropic = [...DEFAULT_ANTHROPIC_MODELS];
      }
      if (!parsed.providerModelPriority.openrouter) {
        parsed.providerModelPriority.openrouter = [...DEFAULT_OPENROUTER_MODELS];
      }
    }

    // Ensure openrouterAutoFreeModels exists
    if (!('openrouterAutoFreeModels' in parsed)) {
      parsed.openrouterAutoFreeModels = true;
    }

    // Migration: add English and trim translation languages to new defaults
    if (parsed.translationLanguages && !parsed.translationLanguages.includes('English')) {
      parsed.translationLanguages = [...DEFAULT_TRANSLATION_LANGUAGES];
    }

    // Persist migrations
    localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));

    return { ...DEFAULTS, ...parsed };
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(partial: Partial<AppSettings>): void {
  const current = getSettings();
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...partial }));
}

/** Return the model priority list for the active provider. */
export function getActiveModelPriority(): string[] {
  const { activeProvider, providerModelPriority } = getSettings();
  const priority = providerModelPriority[activeProvider];
  if (priority && priority.length > 0) return priority;
  return PROVIDER_DEFAULT_MODELS[activeProvider] || [];
}

/** Return the first (highest-priority) model name for the active provider. */
export function getPrimaryModel(): string {
  const models = getActiveModelPriority();
  return models[0] ?? '';
}

/** Convenience alias kept for backward compat with convert.ts frontmatter. */
export const DEFAULT_MODELS = DEFAULT_GEMINI_MODELS;

/**
 * Initialize model priority for a provider from its available models.
 * Only updates if the user hasn't customized the priority for that provider.
 */
export function initializeModelPriority(provider: ProviderId, availableModels: string[]): void {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      const current = parsed.providerModelPriority?.[provider];
      const defaults = PROVIDER_DEFAULT_MODELS[provider];
      // If user has customized, don't overwrite
      if (current && current.length > 0 && JSON.stringify(current) !== JSON.stringify(defaults)) {
        return;
      }
    } catch { /* proceed */ }
  }

  const available = new Set(availableModels);
  const defaults = PROVIDER_DEFAULT_MODELS[provider];
  const priority = defaults.filter(m => available.has(m));
  if (priority.length > 0) {
    const settings = getSettings();
    settings.providerModelPriority[provider] = priority;
    saveSettings({ providerModelPriority: settings.providerModelPriority });
  }
}

// ── Session-level skipped model tracking (not persisted across app restarts) ──

const sessionSkippedModels = new Map<string, string>();

export function getSessionSkippedModels(): ReadonlyMap<string, string> {
  return sessionSkippedModels;
}

export function addSessionSkippedModel(model: string, reason: string): void {
  sessionSkippedModels.set(model, reason);
}
