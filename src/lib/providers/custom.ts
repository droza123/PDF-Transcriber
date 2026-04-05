import type { Provider, ProviderCallOptions, ProviderModel, ProviderResult } from './types';
import { getSettings } from '../settings';
import { pdfToImages } from '../pdfImages';

export class CustomProvider implements Provider {
  readonly id = 'custom' as const;
  readonly displayName = 'Custom';
  readonly keyPlaceholder = 'API key (leave empty for local servers)';
  readonly keyHelpUrl = '';
  readonly keyHelpSteps = [
    'Local servers (Ollama, LM Studio) usually don\u2019t need a key \u2014 leave it empty',
    'Cloud providers (Together AI, Groq, etc.) require a key from their dashboard',
    'Set the base URL below to match your provider\u2019s OpenAI-compatible endpoint',
  ];
  readonly defaultModels: string[] = [];
  readonly batchDelayMs = 1000;

  private _getBaseUrl(): string {
    return getSettings().customBaseUrl || 'http://localhost:11434/v1';
  }

  async validateKey(key: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const baseUrl = this._getBaseUrl();
      const headers: Record<string, string> = {};
      if (key) headers['Authorization'] = `Bearer ${key}`;

      const res = await fetch(`${baseUrl}/models`, { headers });
      if (res.ok) return { valid: true };
      // For local servers without auth, a 401 just means key isn't needed
      if (!key && (res.status === 401 || res.status === 403)) return { valid: true };
      const data = await res.json().catch(() => ({}));
      return { valid: false, error: data?.error?.message || `HTTP ${res.status}` };
    } catch (e: any) {
      // If no key and connection fails, it's a connectivity issue
      return { valid: false, error: e.message || 'Connection failed' };
    }
  }

  async fetchModels(key: string): Promise<ProviderModel[]> {
    try {
      const baseUrl = this._getBaseUrl();
      const headers: Record<string, string> = {};
      if (key) headers['Authorization'] = `Bearer ${key}`;

      const res = await fetch(`${baseUrl}/models`, { headers });
      if (!res.ok) return this._getFallbackModels();
      const data = await res.json();
      const rawModels: { id: string; name?: string }[] = data.data || data.models || [];

      if (rawModels.length === 0) return this._getFallbackModels();

      return rawModels.map(m => ({
        id: m.id,
        displayName: m.name || m.id,
      }));
    } catch {
      return this._getFallbackModels();
    }
  }

  async call(pdfBlob: Blob, options: ProviderCallOptions): Promise<ProviderResult> {
    const { model, prompt, maxOutputTokens, abortSignal, onStreamProgress } = options;
    const key = this._getKeyOptional();
    const baseUrl = this._getBaseUrl();

    onStreamProgress?.('uploading', 0);

    // Convert PDF pages to images since most local servers (Ollama, LM Studio)
    // only support image_url content, not PDF file uploads
    const imageDataUrls = await pdfToImages(pdfBlob);

    if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');

    console.log(`[custom] Sending ${imageDataUrls.length} page image(s) to ${model} at ${baseUrl}`);
    onStreamProgress?.('streaming', 0);

    const content: any[] = [
      ...imageDataUrls.map(url => ({
        type: 'image_url',
        image_url: { url },
      })),
      { type: 'text', text: prompt },
    ];

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (key) headers['Authorization'] = `Bearer ${key}`;

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        max_tokens: maxOutputTokens,
        stream: true,
        messages: [{ role: 'user', content }],
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

    return this._readStream(res, abortSignal, onStreamProgress, model);
  }

  async callText(options: ProviderCallOptions): Promise<ProviderResult> {
    const { model, prompt, maxOutputTokens, abortSignal, onStreamProgress } = options;
    const key = this._getKeyOptional();
    const baseUrl = this._getBaseUrl();

    if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    onStreamProgress?.('streaming', 0);

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (key) headers['Authorization'] = `Bearer ${key}`;

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
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

    return this._readStream(res, abortSignal, onStreamProgress, model);
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

  summarizeError(error: any): string {
    if (this.isRateLimitError(error)) return 'rate limited';
    const status = error?.status;
    if (status === 401 || status === 403) return 'auth error';
    if (status === 404) return 'model not found';
    if (status === 400) return 'bad request';
    if (status >= 500) return `server error (${status})`;
    return error?.message?.slice(0, 60) || 'unknown error';
  }

  private _getKeyOptional(): string | null {
    return localStorage.getItem('provider_api_key_custom') || null;
  }

  private _getFallbackModels(): ProviderModel[] {
    const { customModels } = getSettings();
    return customModels.map(id => ({ id, displayName: id }));
  }

  private async _readStream(
    res: Response,
    abortSignal: AbortSignal | undefined,
    onStreamProgress: ProviderCallOptions['onStreamProgress'],
    model: string,
  ): Promise<ProviderResult> {
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

    console.log(`[custom] Streaming complete, received ${text.length} chars`);
    return { text, modelUsed: model };
  }
}
