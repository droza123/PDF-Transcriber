/**
 * Storage for API keys.
 *
 * In the desktop app, keys are encrypted by the main process with the OS
 * keychain (Electron safeStorage) and written to secrets.json; this module
 * keeps a decrypted copy in memory so lookups stay synchronous. Where secure
 * storage is unavailable (plain browser / dev server, or Linux without a
 * keyring) keys stay in localStorage, as before.
 *
 * initSecretStore() must finish before the app reads any key.
 */

type Backend = 'secure' | 'local';

let backend: Backend = 'local';
const cache = new Map<string, string>();

/** localStorage names that hold API keys (the old Gemini name included). */
function isSecretName(name: string): boolean {
  return name.startsWith('provider_api_key_') || name === 'gemini_api_key';
}

export async function initSecretStore(): Promise<void> {
  const secrets = window.electronAPI?.secrets;
  if (!secrets) return;

  try {
    if (!(await secrets.available())) return;
    const stored = await secrets.loadAll();
    for (const [name, value] of Object.entries(stored)) cache.set(name, value);
    backend = 'secure';
  } catch (e) {
    console.error('[secrets] Secure storage unavailable, keeping keys in localStorage:', e);
    return;
  }

  // Move keys saved by earlier versions out of localStorage. Each key is
  // removed from localStorage only once its encrypted copy is written.
  const legacyNames: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const name = localStorage.key(i);
    if (name && isSecretName(name)) legacyNames.push(name);
  }
  for (const name of legacyNames) {
    const value = localStorage.getItem(name);
    const target = name === 'gemini_api_key' ? 'provider_api_key_gemini' : name;
    try {
      if (value && !cache.has(target)) {
        await secrets.set(target, value);
        cache.set(target, value);
      }
      localStorage.removeItem(name);
    } catch (e) {
      console.error(`[secrets] Could not migrate ${name}; leaving it in localStorage:`, e);
    }
  }
  if (legacyNames.length > 0) {
    console.log(`[secrets] Moved ${legacyNames.length} API key(s) to encrypted storage`);
  }
}

export function getSecret(name: string): string | null {
  if (backend === 'secure') {
    // A key whose encrypted write failed is left in localStorage (see setSecret).
    return cache.get(name) ?? localStorage.getItem(name);
  }
  return localStorage.getItem(name);
}

export function setSecret(name: string, value: string): void {
  if (backend === 'local') {
    localStorage.setItem(name, value);
    return;
  }
  cache.set(name, value);
  window.electronAPI!.secrets.set(name, value).then(
    () => localStorage.removeItem(name),
    e => {
      // Don't lose the key: keep it unencrypted rather than only in memory.
      console.error(`[secrets] Encrypted save of ${name} failed; storing it in localStorage:`, e);
      localStorage.setItem(name, value);
    },
  );
}

export function removeSecret(name: string): void {
  localStorage.removeItem(name);
  if (backend === 'local') return;
  cache.delete(name);
  window.electronAPI!.secrets.delete(name).catch(e => {
    console.error(`[secrets] Could not delete ${name} from encrypted storage:`, e);
  });
}
