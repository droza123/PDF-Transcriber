import type { ProviderId } from './providers/types';

export type ExportFormat = 'md' | 'html' | 'json' | 'docx' | 'docx-logos';
export type FileNaming = 'overwrite' | 'unique';
/** How the Custom provider sends PDFs to the API. */
export type CustomPdfMode = 'images' | 'pdf';

/** Pipeline stages that can carry their own model priority override. */
export type PipelineStage = 'scan' | 'transcribe' | 'translate';

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

export const DEFAULT_OPENAI_MODELS = [
  'gpt-5-mini',
  'gpt-5.4-nano',
  'gpt-5.4-mini',
];

export const DEFAULT_MISTRAL_MODELS = [
  'mistral-ocr-latest',
  'mistral-small-latest',
];

/** Per-provider default model lists. */
export const PROVIDER_DEFAULT_MODELS: Record<ProviderId, string[]> = {
  gemini: DEFAULT_GEMINI_MODELS,
  anthropic: DEFAULT_ANTHROPIC_MODELS,
  openrouter: DEFAULT_OPENROUTER_MODELS,
  openai: DEFAULT_OPENAI_MODELS,
  mistral: DEFAULT_MISTRAL_MODELS,
  custom: [],
};

/** A built-in preset for the Custom provider (hardcoded, not user-editable). */
export interface CustomPreset {
  id: string;
  name: string;
  baseUrl: string;
  keyHelpUrl: string;
  keyHelpSteps: string[];
  /** Default PDF input mode for this preset. */
  pdfMode: CustomPdfMode;
}

/** A user-saved configuration for the Custom provider. */
export interface CustomConfig {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  /** How PDFs are sent — 'images' (page screenshots) or 'pdf' (base64 document). */
  pdfMode?: CustomPdfMode;
}

export const CUSTOM_PRESETS: CustomPreset[] = [
  {
    id: 'nvidia-nim',
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    keyHelpUrl: 'https://build.nvidia.com/explore/discover',
    keyHelpSteps: [
      'NVIDIA Build',
      'Sign in or create an NVIDIA account',
      'Click "Get API Key" on any model page',
      'Copy the key and paste it above',
    ],
    pdfMode: 'images',
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyHelpUrl: 'https://console.groq.com/keys',
    keyHelpSteps: [
      'Groq Console',
      'Sign in or create an account',
      'Go to API Keys',
      'Create a new key and paste it above',
    ],
    pdfMode: 'images',
  },
];

export interface AppSettings {
  /** @deprecated Use scanProvider / transcribeProvider / translateProvider instead. */
  activeProvider: ProviderId;
  /** Provider used for document structure scanning (prescan). */
  scanProvider: ProviderId;
  /** Provider used for PDF-to-markdown transcription. */
  transcribeProvider: ProviderId;
  /** Provider used for markdown translation. */
  translateProvider: ProviderId;
  providerModelPriority: Record<ProviderId, string[]>;
  /**
   * Optional per-stage model priority overrides. When
   * stageModelPriority[stage][provider] exists (non-empty), it is used for
   * that stage instead of providerModelPriority[provider].
   */
  stageModelPriority: Partial<Record<PipelineStage, Partial<Record<ProviderId, string[]>>>>;
  openrouterAutoFreeModels: boolean;
  batchSize: number;
  outputNotes: string;
  autoExportFormats: ExportFormat[];
  preventSleep: boolean;
  headingCleanupEnabled: boolean;
  fileNaming: FileNaming;
  translationEnabled: boolean;
  translationLanguage: string;
  translationLanguages: string[];
  exportTranscriptionWithTranslation: boolean;
  customBaseUrl: string;
  customModels: string[];
  customSavedConfigs: CustomConfig[];
  customActiveConfigId: string;
  /** How the Custom provider sends PDFs — 'images' (page screenshots) or 'pdf' (base64 document). */
  customPdfMode: CustomPdfMode;
  /**
   * Last folder a user picked through a Save As / Open dialog. Hidden — no UI
   * surface — used to seed the next dialog's defaultPath when the currently
   * previewed file doesn't supply one.
   */
  lastBrowsedDir: string;
}

const STORAGE_KEY = 'app_settings';

const DEFAULTS: AppSettings = {
  activeProvider: 'gemini',
  scanProvider: 'gemini',
  transcribeProvider: 'gemini',
  translateProvider: 'gemini',
  providerModelPriority: {
    gemini: [...DEFAULT_GEMINI_MODELS],
    anthropic: [...DEFAULT_ANTHROPIC_MODELS],
    openrouter: [...DEFAULT_OPENROUTER_MODELS],
    openai: [...DEFAULT_OPENAI_MODELS],
    mistral: [...DEFAULT_MISTRAL_MODELS],
    custom: [],
  },
  stageModelPriority: {},
  openrouterAutoFreeModels: true,
  batchSize: 5,
  outputNotes: '',
  autoExportFormats: ['md'],
  preventSleep: true,
  headingCleanupEnabled: true,
  fileNaming: 'overwrite',
  translationEnabled: false,
  translationLanguage: '',
  translationLanguages: [...DEFAULT_TRANSLATION_LANGUAGES],
  exportTranscriptionWithTranslation: true,
  customBaseUrl: 'http://localhost:11434/v1',
  customModels: [],
  customSavedConfigs: [],
  customActiveConfigId: 'manual',
  customPdfMode: 'images',
  lastBrowsedDir: '',
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
      if (!parsed.providerModelPriority.openai) {
        parsed.providerModelPriority.openai = [...DEFAULT_OPENAI_MODELS];
      }
      if (!parsed.providerModelPriority.mistral) {
        parsed.providerModelPriority.mistral = [...DEFAULT_MISTRAL_MODELS];
      }
      if (!parsed.providerModelPriority.custom) {
        parsed.providerModelPriority.custom = [];
      }
    }

    // Ensure custom preset fields exist
    if (!('customSavedConfigs' in parsed)) {
      parsed.customSavedConfigs = [];
    }
    if (!('customActiveConfigId' in parsed)) {
      parsed.customActiveConfigId = 'manual';
    }

    // Ensure openrouterAutoFreeModels exists
    if (!('openrouterAutoFreeModels' in parsed)) {
      parsed.openrouterAutoFreeModels = true;
    }

    // Migrate activeProvider → role-based providers
    if ('activeProvider' in parsed && !('scanProvider' in parsed)) {
      parsed.scanProvider = parsed.activeProvider;
      parsed.transcribeProvider = parsed.activeProvider;
      parsed.translateProvider = parsed.activeProvider;
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

/** @deprecated Use role-specific getters instead. */
export function getActiveModelPriority(): string[] {
  return getTranscribeModelPriority();
}

/** @deprecated Use role-specific getters instead. */
export function getPrimaryModel(): string {
  return getTranscribePrimaryModel();
}

// ── Role-based model priority getters ─────────────────────────────────────

function modelPriorityFor(provider: ProviderId, stage?: PipelineStage): string[] {
  const settings = getSettings();
  if (stage) {
    const override = settings.stageModelPriority?.[stage]?.[provider];
    if (override && override.length > 0) return override;
  }
  const priority = settings.providerModelPriority[provider];
  if (priority && priority.length > 0) return priority;
  return PROVIDER_DEFAULT_MODELS[provider] || [];
}

export function getScanModelPriority(): string[] {
  return modelPriorityFor(getSettings().scanProvider, 'scan');
}
export function getScanPrimaryModel(): string {
  return getScanModelPriority()[0] ?? '';
}

export function getTranscribeModelPriority(): string[] {
  return modelPriorityFor(getSettings().transcribeProvider, 'transcribe');
}
export function getTranscribePrimaryModel(): string {
  return getTranscribeModelPriority()[0] ?? '';
}

export function getTranslateModelPriority(): string[] {
  return modelPriorityFor(getSettings().translateProvider, 'translate');
}
export function getTranslatePrimaryModel(): string {
  return getTranslateModelPriority()[0] ?? '';
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
