import type { Provider, ProviderCallOptions, ProviderModel, ProviderResult } from './types';

const API_BASE = 'https://openrouter.ai/api/v1';
const MODELS_CACHE_KEY = 'openrouter_models_cache';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Raw model data from OpenRouter API. */
interface OpenRouterModelData {
  id: string;
  name: string;
  pricing: { prompt: string; completion: string };
  context_length: number;
  architecture?: { modality?: string };
  top_provider?: { is_moderated?: boolean };
}

export class OpenRouterProvider implements Provider {
  readonly id = 'openrouter' as const;
  readonly displayName = 'OpenRouter';
  readonly keyPlaceholder = 'Paste your OpenRouter API key';
  readonly keyHelpUrl = 'https://openrouter.ai/keys';
  readonly keyHelpSteps = [
    'OpenRouter',
    'Sign in or create an account',
    'Go to Keys in your dashboard',
    'Create a new key and paste it above',
  ];
  readonly defaultModels: string[] = [];
  readonly batchDelayMs = 1000;

  async validateKey(key: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/auth/key`, {
        headers: { 'Authorization': `Bearer ${key}` },
      });
      if (res.ok) return { valid: true };
      const data = await res.json().catch(() => ({}));
      return { valid: false, error: data?.error?.message || `HTTP ${res.status}` };
    } catch (e: any) {
      return { valid: false, error: e.message || 'Connection failed' };
    }
  }

  async fetchModels(key: string): Promise<ProviderModel[]> {
    try {
      const res = await fetch(`${API_BASE}/models`, {
        headers: { 'Authorization': `Bearer ${key}` },
      });
      if (!res.ok) return [];
      const data = await res.json();
      const rawModels: OpenRouterModelData[] = data.data || [];

      // Filter to models that produce text-only output.
      // OpenRouter handles PDF input for all models via its file-parser plugin,
      // so we don't need to require image/vision capability on the input side.
      // Modality format is "input_types->output_types", e.g. "text+image->text".
      const textOutputModels = rawModels.filter(m => {
        const modality = m.architecture?.modality || '';
        const [, outputSide] = modality.split('->');
        if (!outputSide) return false;
        return outputSide.trim() === 'text';
      });

      const models: ProviderModel[] = textOutputModels.map(m => {
        const promptPrice = parseFloat(m.pricing?.prompt || '0');
        const completionPrice = parseFloat(m.pricing?.completion || '0');
        const isFree = promptPrice === 0 && completionPrice === 0;
        return {
          id: m.id,
          displayName: m.name || m.id,
          isFree,
          pricePerMTokens: promptPrice * 1_000_000,
          contextLength: m.context_length,
        };
      });

      // Sort: free first, then by context length (larger = more capable)
      models.sort((a, b) => {
        if (a.isFree && !b.isFree) return -1;
        if (!a.isFree && b.isFree) return 1;
        return (b.contextLength || 0) - (a.contextLength || 0);
      });

      // Cache the full model list with timestamp
      this._cacheModels(models);

      return models;
    } catch {
      return [];
    }
  }

  /**
   * Get the current top free vision-capable models from OpenRouter.
   * Used by the auto-select feature. Returns cached data if fresh enough,
   * otherwise fetches from API.
   */
  async getTopFreeModels(key: string, count = 5): Promise<string[]> {
    let models = this._getCachedModels();

    // If cache is stale or empty, fetch fresh data
    if (models.length === 0) {
      models = await this.fetchModels(key);
    }

    return models
      .filter(m => m.isFree)
      .slice(0, count)
      .map(m => m.id);
  }

  async call(pdfBlob: Blob, options: ProviderCallOptions): Promise<ProviderResult> {
    const { model, prompt, maxOutputTokens, abortSignal, onStreamProgress } = options;
    const key = this._getKey();

    onStreamProgress?.('uploading', 0);

    // Encode PDF as base64 and send directly — OpenRouter handles PDF parsing
    // for all models via its file-parser plugin (no image conversion needed).
    const arrayBuffer = await pdfBlob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const base64 = btoa(binary);

    if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');

    const sizeMB = (pdfBlob.size / 1024 / 1024).toFixed(1);
    console.log(`[openrouter] Sending ${sizeMB} MB PDF as base64 to ${model}`);
    onStreamProgress?.('streaming', 0);

    const content: any[] = [
      {
        type: 'file',
        file: {
          filename: 'document.pdf',
          file_data: `data:application/pdf;base64,${base64}`,
        },
      },
      { type: 'text', text: prompt },
    ];

    const res = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
        'HTTP-Referer': 'http://localhost:3001/',
        'X-Title': 'PDF Transcriber',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxOutputTokens,
        stream: true,
        messages: [
          {
            role: 'user',
            content,
          },
        ],
      }),
      signal: abortSignal,
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      const error: any = new Error(
        errorData?.error?.message || `HTTP ${res.status}`,
      );
      error.status = res.status;
      error.code = errorData?.error?.code;
      throw error;
    }

    // Parse SSE stream (OpenAI-compatible format)
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let buffer = '';

    while (true) {
      if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        try {
          const event = JSON.parse(data);

          // Check for error in stream
          if (event.error) {
            const error: any = new Error(event.error.message || 'Stream error');
            error.status = event.error.code || 500;
            throw error;
          }

          const delta = event.choices?.[0]?.delta?.content;
          if (delta) {
            text += delta;
            onStreamProgress?.('streaming', text.length);
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }

    console.log(`[openrouter] Streaming complete, received ${text.length} chars`);
    return { text, modelUsed: model };
  }

  async callText(options: ProviderCallOptions): Promise<ProviderResult> {
    const { model, prompt, maxOutputTokens, abortSignal, onStreamProgress } = options;
    const key = this._getKey();

    if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    onStreamProgress?.('streaming', 0);

    const res = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
        'HTTP-Referer': 'http://localhost:3001/',
        'X-Title': 'PDF Transcriber',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxOutputTokens,
        stream: true,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: abortSignal,
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      const error: any = new Error(errorData?.error?.message || `HTTP ${res.status}`);
      error.status = res.status;
      error.code = errorData?.error?.code;
      throw error;
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let buffer = '';

    while (true) {
      if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const event = JSON.parse(data);
          if (event.error) {
            const error: any = new Error(event.error.message || 'Stream error');
            error.status = event.error.code || 500;
            throw error;
          }
          const delta = event.choices?.[0]?.delta?.content;
          if (delta) {
            text += delta;
            onStreamProgress?.('streaming', text.length);
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }

    return { text, modelUsed: model };
  }

  isRateLimitError(error: any): boolean {
    return (
      error?.status === 429 ||
      error?.code === 429 ||
      /429|rate.?limit/i.test(error?.message || '')
    );
  }

  isPersistentError(error: any): boolean {
    const status = error?.status;
    if (status === 401 || status === 403 || status === 404 || status === 400) return true;
    if (/not.?found|invalid.?model|permission.?denied|unauthorized|bad.?request/i.test(error?.message || '')) return true;
    return false;
  }

  isOverloadedError(error: any): boolean {
    return error?.status === 503 || /503|overloaded|service.?unavailable/i.test(error?.message || '');
  }

  summarizeError(error: any): string {
    if (this.isRateLimitError(error)) return 'rate limited';
    if (this.isOverloadedError(error)) return 'service overloaded (503)';
    const status = error?.status;
    if (status === 401 || status === 403) return 'auth error';
    if (status === 404) return 'model not found';
    if (status === 400) return 'bad request';
    if (status === 402) return 'insufficient credits';
    if (status >= 500) return `server error (${status})`;
    return error?.message?.slice(0, 60) || 'unknown error';
  }

  // ── Caching ──

  private _cacheModels(models: ProviderModel[]): void {
    try {
      localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify({
        timestamp: Date.now(),
        models,
      }));
    } catch { /* storage full, ignore */ }
  }

  _getCachedModels(): ProviderModel[] {
    try {
      const raw = localStorage.getItem(MODELS_CACHE_KEY);
      if (!raw) return [];
      const { timestamp, models } = JSON.parse(raw);
      // Check if cache is still fresh
      if (Date.now() - timestamp > CACHE_TTL_MS) return [];
      return models;
    } catch {
      return [];
    }
  }

  private _getKey(): string {
    const key = localStorage.getItem('provider_api_key_openrouter') || null;
    if (!key) throw new Error('OpenRouter API key is required. Configure it in the settings above.');
    return key;
  }
}
