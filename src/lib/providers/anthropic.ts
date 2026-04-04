import type { Provider, ProviderCallOptions, ProviderModel, ProviderResult } from './types';

const API_BASE = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';

export class AnthropicProvider implements Provider {
  readonly id = 'anthropic' as const;
  readonly displayName = 'Anthropic';
  readonly keyPlaceholder = 'Paste your Anthropic API key';
  readonly keyHelpUrl = 'https://console.anthropic.com/settings/keys';
  readonly keyHelpSteps = [
    'Anthropic Console',
    'Sign in or create an account',
    'Go to Settings > API Keys',
    'Create a new key and paste it above',
  ];
  readonly defaultModels = [
    'claude-sonnet-4-20250514',
    'claude-haiku-35-20241022',
  ];
  readonly batchDelayMs = 1000;

  async validateKey(key: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const res = await fetch(`${API_BASE}/v1/models`, {
        headers: {
          'x-api-key': key,
          'anthropic-version': API_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
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
      const res = await fetch(`${API_BASE}/v1/models?limit=100`, {
        headers: {
          'x-api-key': key,
          'anthropic-version': API_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
      });
      if (!res.ok) return [];
      const data = await res.json();
      const models: ProviderModel[] = (data.data || [])
        .filter((m: any) => /claude/i.test(m.id) && !/image|embed/i.test(m.id))
        .map((m: any) => ({
          id: m.id,
          displayName: m.display_name || m.id,
        }));
      return models;
    } catch {
      return [];
    }
  }

  async call(pdfBlob: Blob, options: ProviderCallOptions): Promise<ProviderResult> {
    const { model, prompt, maxOutputTokens, abortSignal, onStreamProgress } = options;
    const key = this._getKey();

    onStreamProgress?.('uploading', 0);

    // Convert PDF blob to base64
    const arrayBuffer = await pdfBlob.arrayBuffer();
    const base64 = btoa(
      new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), ''),
    );

    if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');

    console.log(`[anthropic] Sending ${(pdfBlob.size / 1024 / 1024).toFixed(1)} MB PDF as base64 to ${model}`);
    onStreamProgress?.('streaming', 0);

    const res = await fetch(`${API_BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': API_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxOutputTokens,
        stream: true,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: 'application/pdf',
                  data: base64,
                },
              },
              {
                type: 'text',
                text: prompt,
              },
            ],
          },
        ],
      }),
      signal: abortSignal,
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      const error: any = new Error(errorData?.error?.message || `HTTP ${res.status}`);
      error.status = res.status;
      error.type = errorData?.error?.type;
      throw error;
    }

    // Parse SSE stream
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let buffer = '';

    while (true) {
      if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') continue;

        try {
          const event = JSON.parse(data);

          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            text += event.delta.text;
            onStreamProgress?.('streaming', text.length);
          }

          if (event.type === 'error') {
            const error: any = new Error(event.error?.message || 'Stream error');
            error.status = event.error?.type === 'rate_limit_error' ? 429 : 500;
            throw error;
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue; // Skip malformed JSON
          throw e;
        }
      }
    }

    console.log(`[anthropic] Streaming complete, received ${text.length} chars`);
    return { text, modelUsed: model };
  }

  async callText(options: ProviderCallOptions): Promise<ProviderResult> {
    const { model, prompt, maxOutputTokens, abortSignal, onStreamProgress } = options;
    const key = this._getKey();

    if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    onStreamProgress?.('streaming', 0);

    const res = await fetch(`${API_BASE}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': API_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
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
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const event = JSON.parse(data);
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            text += event.delta.text;
            onStreamProgress?.('streaming', text.length);
          }
          if (event.type === 'error') {
            const error: any = new Error(event.error?.message || 'Stream error');
            error.status = event.error?.type === 'rate_limit_error' ? 429 : 500;
            throw error;
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
      error?.type === 'rate_limit_error' ||
      /429|rate.?limit/i.test(error?.message || '')
    );
  }

  isPersistentError(error: any): boolean {
    const status = error?.status;
    if (status === 401 || status === 403 || status === 404 || status === 400) return true;
    if (/not.?found|invalid.?model|permission.?denied|unauthorized|authentication/i.test(error?.message || '')) return true;
    return false;
  }

  summarizeError(error: any): string {
    if (this.isRateLimitError(error)) return 'rate limited';
    const status = error?.status;
    if (status === 401 || status === 403) return 'auth error';
    if (status === 404) return 'model not found';
    if (status === 400) return 'bad request';
    if (status === 529) return 'API overloaded';
    if (status >= 500) return `server error (${status})`;
    return error?.message?.slice(0, 60) || 'unknown error';
  }

  private _getKey(): string {
    const key = localStorage.getItem('provider_api_key_anthropic') || null;
    if (!key) throw new Error('Anthropic API key is required. Configure it in the settings above.');
    return key;
  }
}
