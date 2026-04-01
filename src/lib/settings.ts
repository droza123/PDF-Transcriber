export interface AppSettings {
  model: string;
  batchSize: number;
  outputNotes: string;
}

const STORAGE_KEY = 'app_settings';

const DEFAULTS: AppSettings = {
  model: 'gemini-2.5-flash',
  batchSize: 10,
  outputNotes: '',
};

export function getSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(partial: Partial<AppSettings>): void {
  const current = getSettings();
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...partial }));
}

export const DEFAULT_MODELS = ['gemini-3-flash-preview', 'gemini-2.5-flash'];
