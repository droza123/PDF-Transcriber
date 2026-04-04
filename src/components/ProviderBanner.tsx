import { Settings2 } from 'lucide-react';
import { hasApiKey, getApiKey } from '../lib/apiKey';
import { getSettings } from '../lib/settings';
import { getAllProviders } from '../lib/providers/registry';

interface ProviderBannerProps {
  onOpenSettings: () => void;
}

export default function ProviderBanner({ onOpenSettings }: ProviderBannerProps) {
  const anyKeyConfigured = getAllProviders().some(p => hasApiKey(p.id));

  if (!anyKeyConfigured) {
    // Mode A: No keys configured — guided setup
    return (
      <div className="border border-p-border rounded-lg bg-p-surface">
        <div className="px-4 py-4 space-y-3">
          <h3 className="text-sm font-semibold text-p-text">Get Started</h3>
          <p className="text-xs text-p-text-muted leading-relaxed">
            Choose an AI provider to begin transcribing PDFs.
          </p>

          <div className="space-y-2">
            <div>
              <p className="text-xs font-medium text-p-text-muted mb-1">Free options (recommended)</p>
              <div className="text-xs text-p-text-dim leading-relaxed space-y-0.5 pl-2">
                <p><span className="text-p-text-muted font-medium">Google Gemini</span> — generous free tier, fast models optimized for PDFs.</p>
                <p><span className="text-p-text-muted font-medium">OpenRouter</span> — access hundreds of models, many available for free.</p>
              </div>
            </div>

            <div>
              <p className="text-xs font-medium text-p-text-muted mb-1">Quality options</p>
              <div className="text-xs text-p-text-dim leading-relaxed space-y-0.5 pl-2">
                <p><span className="text-p-text-muted font-medium">Anthropic</span> — premium quality output with native PDF support.</p>
                <p><span className="text-p-text-muted font-medium">Gemini Pro / OpenRouter paid</span> — more capable models for complex layouts.</p>
              </div>
            </div>
          </div>

          <p className="text-[11px] text-p-text-dim/70 leading-relaxed">
            The free options are usually more than good enough for most documents.
          </p>

          <button
            onClick={onOpenSettings}
            className="flex items-center gap-2 w-full justify-center px-4 py-2 rounded-lg text-sm font-medium bg-p-accent text-white hover:bg-p-accent-bright tab-transition"
          >
            <Settings2 className="w-4 h-4" />
            Open Settings
          </button>
        </div>
      </div>
    );
  }

  // Mode B: At least one key configured — compact status
  const settings = getSettings();
  const activeProvider = getAllProviders().find(p => p.id === settings.activeProvider);
  const key = getApiKey();
  const maskedKey = key ? '\u2022\u2022\u2022\u2022\u2022\u2022' + key.slice(-4) : null;

  return (
    <button
      onClick={onOpenSettings}
      className="flex items-center gap-2 w-full px-4 py-2.5 border border-p-border rounded-lg bg-p-surface text-left hover:border-p-accent/50 tab-transition group"
    >
      <div className="flex-1 min-w-0">
        <span className="text-sm text-p-text font-medium">{activeProvider?.displayName ?? 'Provider'}</span>
        {maskedKey && (
          <span className="ml-2 text-xs font-mono text-p-text-dim">{maskedKey}</span>
        )}
      </div>
      <Settings2 className="w-4 h-4 text-p-text-dim group-hover:text-p-text shrink-0" />
    </button>
  );
}
