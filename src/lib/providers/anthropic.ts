import Anthropic from '@anthropic-ai/sdk';
import type { Provider, ProviderCallOptions, ProviderModel, ProviderResult } from './types';
import { getSecret } from '../secretStore';

/**
 * Models that accept server-side refusal fallbacks (`fallbacks: "default"`).
 * If the model's safety classifiers decline a request, the API re-runs it on
 * Anthropic's recommended fallback model within the same call.
 */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

type BetaContent = Anthropic.Beta.Messages.BetaContentBlockParam;

export class AnthropicProvider implements Provider {
  readonly id = 'anthropic' as const;
  readonly displayName = 'Anthropic';
  readonly keyPlaceholder = 'Paste your Anthropic API key';
  readonly keyHelpUrl = 'https://platform.claude.com/settings/keys';
  readonly keyHelpSteps = [
    'Claude Console',
    'Sign in or create an account',
    'Go to Settings > API keys',
    'Create a key scoped to a single workspace and paste it above',
  ];
  readonly defaultModels = [
    'claude-opus-5-5',
    'claude-sonnet-5-5',
  ];
  readonly batchDelayMs = 1000;

  async validateKey(key: string): Promise<{ valid: boolean; error?: string }> {
    try {
      await this._client(key).models.list({ limit: 1 });
      return { valid: true };
    } catch (e: any) {
      return { valid: false, error: e?.error?.error?.message || e?.message || 'Connection failed' };
    }
  }

  async fetchModels(key: string): Promise<ProviderModel[]> {
    try {
      const models: ProviderModel[] = [];
      // Newest first, as returned by the API.
      for await (const m of this._client(key).models.list({ limit: 100 })) {
        if (!/claude/i.test(m.id)) continue;
        models.push({ id: m.id, displayName: m.display_name || m.id, contextLength: m.max_input_tokens ?? undefined });
      }
      return models;
    } catch {
      return [];
    }
  }

  async call(pdfBlob: Blob, options: ProviderCallOptions): Promise<ProviderResult> {
    const { model, prompt, promptParts } = options;

    options.onStreamProgress?.('uploading', 0);
    const base64 = new Uint8Array(await pdfBlob.arrayBuffer()).toBase64();
    const document: BetaContent = {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: base64 },
    };

    // With promptParts, the instructions and outline that are identical for
    // every batch of this document come first and are cached, so later
    // batches pay the cache-read price for them instead of the full price.
    const content: BetaContent[] = promptParts
      ? [
          { type: 'text', text: promptParts.stable, cache_control: { type: 'ephemeral' } },
          document,
          { type: 'text', text: promptParts.volatile },
        ]
      : [document, { type: 'text', text: prompt }];

    console.log(`[anthropic] Sending ${(pdfBlob.size / 1024 / 1024).toFixed(1)} MB PDF to ${model}`);
    return this._stream(content, options);
  }

  async callText(options: ProviderCallOptions): Promise<ProviderResult> {
    return this._stream([{ type: 'text', text: options.prompt }], options);
  }

  private async _stream(content: BetaContent[], options: ProviderCallOptions): Promise<ProviderResult> {
    const { model, maxOutputTokens, abortSignal, onStreamProgress } = options;
    const client = this._client(this._getKey());
    if (abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    onStreamProgress?.('streaming', 0);

    const useFallbacks = FALLBACK_MODELS.has(model);
    let message: Anthropic.Beta.Messages.BetaMessage;
    try {
      const stream = client.beta.messages.stream(
        {
          model,
          max_tokens: maxOutputTokens,
          messages: [{ role: 'user', content }],
          ...(useFallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
        },
        { signal: abortSignal },
      );
      let chars = 0;
      stream.on('text', delta => {
        chars += delta.length;
        onStreamProgress?.('streaming', chars);
      });
      message = await stream.finalMessage();
    } catch (e) {
      if (abortSignal?.aborted || e instanceof Anthropic.APIUserAbortError) {
        throw new DOMException('Cancelled', 'AbortError');
      }
      throw e;
    }

    if (message.stop_reason === 'refusal') {
      // Every model in the server-side fallback chain declined. Treated as
      // persistent so the orchestrator moves on to the next model in the list.
      const category = message.stop_details?.category;
      const error: any = new Error(`Request declined by ${message.model}${category ? ` (${category})` : ''}`);
      error.refusal = true;
      throw error;
    }
    if (message.stop_reason === 'max_tokens') {
      console.warn(`[anthropic] Output hit max_tokens (${maxOutputTokens}); the result may be truncated`);
    }

    // After a mid-stream fallback the fallback model continues the declined
    // model's partial text, so every text block belongs to the output.
    const text = message.content
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');

    const u = message.usage;
    console.log(
      `[anthropic] ${message.model}: ${text.length} chars; input ${u.input_tokens}, ` +
        `cache write ${u.cache_creation_input_tokens ?? 0}, cache read ${u.cache_read_input_tokens ?? 0}, ` +
        `output ${u.output_tokens} tokens`,
    );
    return { text, modelUsed: message.model };
  }

  isRateLimitError(error: any): boolean {
    return (
      error?.status === 429 ||
      error?.error?.error?.type === 'rate_limit_error' ||
      /429|rate.?limit/i.test(error?.message || '')
    );
  }

  isPersistentError(error: any): boolean {
    if (error?.refusal) return true;
    const status = error?.status;
    if (status === 401 || status === 403 || status === 404 || status === 400) return true;
    if (/not.?found|invalid.?model|permission.?denied|unauthorized|authentication/i.test(error?.message || '')) return true;
    return false;
  }

  isOverloadedError(error: any): boolean {
    return (
      error?.status === 503 ||
      error?.status === 529 ||
      error?.error?.error?.type === 'overloaded_error' ||
      /503|529|overloaded|service.?unavailable/i.test(error?.message || '')
    );
  }

  summarizeError(error: any): string {
    if (error?.refusal) return 'request declined';
    if (this.isRateLimitError(error)) return 'rate limited';
    if (this.isOverloadedError(error)) return 'API overloaded';
    const status = error?.status;
    if (status === 401 || status === 403) return 'auth error';
    if (status === 404) return 'model not found';
    if (status === 400) return 'bad request';
    if (status >= 500) return `server error (${status})`;
    return error?.message?.slice(0, 60) || 'unknown error';
  }

  /** Retries are handled by the orchestrator, so the SDK's own are off. */
  private _client(apiKey: string): Anthropic {
    return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 0 });
  }

  private _getKey(): string {
    const key = getSecret('provider_api_key_anthropic') || null;
    if (!key) throw new Error('Anthropic API key is required. Configure it in the settings above.');
    return key;
  }
}
