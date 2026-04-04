import { Settings2, Sparkles, Zap } from 'lucide-react';

interface WelcomeProps {
  onOpenSettings: () => void;
}

export default function Welcome({ onOpenSettings }: WelcomeProps) {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="max-w-md space-y-6 text-center">
        <h2 className="text-xl font-semibold text-p-text">Get Started</h2>
        <p className="text-sm text-p-text-muted leading-relaxed">
          Choose an AI provider to begin transcribing PDFs to Markdown, Word, and HTML.
        </p>

        <div className="text-left space-y-4">
          <div className="rounded-lg border border-p-border bg-p-surface p-4">
            <div className="flex items-center gap-2 mb-2">
              <Zap className="w-4 h-4 text-green-400" />
              <h3 className="text-sm font-medium text-p-text">Free options (recommended)</h3>
            </div>
            <div className="text-xs text-p-text-dim leading-relaxed space-y-1.5 pl-6">
              <p><span className="text-p-text-muted font-medium">Google Gemini</span> — generous free tier, fast models optimized for PDFs. Recommended starting point.</p>
              <p><span className="text-p-text-muted font-medium">OpenRouter</span> — access hundreds of models with one key. Many free models available.</p>
            </div>
          </div>

          <div className="rounded-lg border border-p-border bg-p-surface p-4">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="w-4 h-4 text-amber-400" />
              <h3 className="text-sm font-medium text-p-text">Quality options</h3>
            </div>
            <div className="text-xs text-p-text-dim leading-relaxed space-y-1.5 pl-6">
              <p><span className="text-p-text-muted font-medium">Anthropic</span> — premium quality output with native PDF support.</p>
              <p><span className="text-p-text-muted font-medium">Gemini Pro / OpenRouter paid</span> — more capable models for complex layouts.</p>
            </div>
          </div>
        </div>

        <p className="text-xs text-p-text-dim/70">
          The free options are usually more than good enough for most documents.
        </p>

        <button
          onClick={onOpenSettings}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium bg-p-accent text-white hover:bg-p-accent-bright tab-transition"
        >
          <Settings2 className="w-4 h-4" />
          Open Settings
        </button>
      </div>
    </div>
  );
}
