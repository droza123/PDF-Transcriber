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
