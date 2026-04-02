import { GoogleGenAI } from '@google/genai';

const STORAGE_KEY = 'gemini_api_key';

export function getApiKey(): string | null {
  return localStorage.getItem(STORAGE_KEY) || process.env.GEMINI_API_KEY || null;
}

export function setApiKey(key: string): void {
  localStorage.setItem(STORAGE_KEY, key);
}

export function clearApiKey(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function hasApiKey(): boolean {
  return !!getApiKey();
}

/** Validate an API key by making a lightweight models.get call. */
export async function validateApiKey(key: string): Promise<{ valid: boolean; error?: string }> {
  try {
    const ai = new GoogleGenAI({ apiKey: key });
    await ai.models.get({ model: 'gemini-2.5-flash' });
    return { valid: true };
  } catch (e: any) {
    return { valid: false, error: e.message || 'Invalid API key' };
  }
}

/** Fetch available models from the Gemini REST API. */
export async function fetchAvailableModels(key: string): Promise<string[]> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
    );
    if (!res.ok) return [];
    const data = await res.json();
    const models: string[] = (data.models || [])
      .filter((m: any) =>
        m.supportedGenerationMethods?.includes('generateContent') &&
        /flash|pro/i.test(m.name) &&
        // Only v2+ models handle PDFs well
        /gemini-(2|3|4)/i.test(m.name) &&
        // Exclude thinking/embedding/vision-only variants
        !/thinking|embedding|aqa|text|tts/i.test(m.name),
      )
      .map((m: any) => m.name.replace('models/', ''))
      .sort()
      .reverse();
    localStorage.setItem('available_models', JSON.stringify(models));
    return models;
  } catch {
    return [];
  }
}

/** Get cached available models. */
export function getCachedModels(): string[] {
  try {
    return JSON.parse(localStorage.getItem('available_models') || '[]');
  } catch {
    return [];
  }
}
