export type ExportFormat = 'md' | 'html' | 'docx' | 'docx-logos';

export interface AppSettings {
  modelPriority: string[];
  batchSize: number;
  outputNotes: string;
  autoExportFormats: ExportFormat[];
}

const STORAGE_KEY = 'app_settings';

const DEFAULTS: AppSettings = {
  modelPriority: ['gemini-2.5-flash', 'gemini-3-flash-preview'],
  batchSize: 10,
  outputNotes: '',
  autoExportFormats: ['md'],
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

export const DEFAULT_MODELS = ['gemini-3-flash-preview', 'gemini-2.5-flash'];
