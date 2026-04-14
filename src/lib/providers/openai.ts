import type { Provider, ProviderCallOptions, ProviderModel, ProviderResult } from './types';

const API_BASE = 'https://api.openai.com/v1';

export class OpenAIProvider implements Provider {
  readonly id = 'openai' as const;
  readonly displayName = 'OpenAI';
  readonly keyPlaceholder = 'Paste your OpenAI API key';
  readonly keyHelpUrl = 'https://platform.openai.com/api-keys';
  readonly keyHelpSteps = [
    'OpenAI Platform',
    'Sign in or create an account',
    'Go to API Keys in your dashboard',
    'Create a new secret key and paste it above',
  ];
  readonly defaultModels = ['gpt-5-mini', 'gpt-5.4-nano', 'gpt-5.4-mini'];
  readonly batchDelayMs = 1000;

  async validateKey(key: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/models`, {
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
      const rawModels: { id: string; owned_by?: string }[] = data.data || [];

      // Filter to GPT and o-series models
      const relevant = rawModels.filter(m =>
        /^(gpt-|o\d)/.test(m.id) && !/instruct|embed|whisper|tts|dall/i.test(m.id),
      );

      return relevant.map(m => ({
        id: m.id,
        displayName: m.id,
      }));
    } catch {
      return [];
    }
  }

  async call(pdfBlob: Blob, options: ProviderCallOptions): Promise<ProviderResult> {
    const { model, prompt, maxOutputTokens, abortSignal, onStreamProgress } = options;
    const key = this._getKey();

    onStreamProgress?.('uploading', 0);

    const arrayBuffer = await pdfBlob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const base64 = btoa(binary);

    if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');

    const sizeMB = (pdfBlob.size / 1024 / 1024).toFixed(1);
    console.log(`[openai] Sending ${sizeMB} MB PDF as base64 to ${model}`);
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
      },
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

    console.log(`[openai] Streaming complete, received ${text.length} chars`);
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

  private _getKey(): string {
    const key = localStorage.getItem('provider_api_key_openai') || null;
    if (!key) throw new Error('OpenAI API key is required. Configure it in the settings above.');
    return key;
  }
}
