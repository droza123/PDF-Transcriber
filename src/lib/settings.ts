export type ExportFormat = 'md' | 'html' | 'docx' | 'docx-logos';
export type FileNaming = 'overwrite' | 'unique';

export interface AppSettings {
  modelPriority: string[];
  batchSize: number;
  outputNotes: string;
  autoExportFormats: ExportFormat[];
  preventSleep: boolean;
  fileNaming: FileNaming;
}

const STORAGE_KEY = 'app_settings';

const DEFAULTS: AppSettings = {
  modelPriority: ['gemini-3.1-flash-lite', 'gemini-3.1-flash-lite-preview', 'gemini-3-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash'],
  batchSize: 5,
  outputNotes: '',
  autoExportFormats: ['md'],
  preventSleep: true,
  fileNaming: 'overwrite',
};

export function getSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw);

    // Migration: old format had `model: string` instead of `modelPriority: string[]`
    if ('model' in parsed && !('modelPriority' in parsed)) {
      const oldModel: string = parsed.model;
      parsed.modelPriority = [oldModel, ...DEFAULT_MODELS.filter(m => m !== oldModel)];
      delete parsed.model;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
    }

    return { ...DEFAULTS, ...parsed };
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(partial: Partial<AppSettings>): void {
  const current = getSettings();
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...partial }));
}

/** Return the first (highest-priority) model name. */
export function getPrimaryModel(): string {
  const { modelPriority } = getSettings();
  return modelPriority[0] ?? DEFAULT_MODELS[0];
}

export const DEFAULT_MODELS = ['gemini-3.1-flash-lite', 'gemini-3.1-flash-lite-preview', 'gemini-3-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash'];

/**
 * Initialize model priority from available models returned by Google's API.
 * Uses DEFAULT_MODELS as the preferred order — only models that actually exist
 * are included. Called once after the API key is first configured.
 */
export function initializeModelPriority(availableModels: string[]): void {
  // Only initialize if the user hasn't customized model priority.
  // Check whether the saved modelPriority differs from the built-in defaults —
  // if it does, the user has reordered or changed it and we shouldn't overwrite.
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.modelPriority && JSON.stringify(parsed.modelPriority) !== JSON.stringify(DEFAULTS.modelPriority)) {
        return; // user has customized — don't touch
      }
    } catch { /* proceed with initialization */ }
  }

  const available = new Set(availableModels);
  const priority = DEFAULT_MODELS.filter(m => available.has(m));
  if (priority.length > 0) {
    saveSettings({ modelPriority: priority });
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
