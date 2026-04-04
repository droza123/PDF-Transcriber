import { Settings2, Sparkles, Zap, ArrowRight } from 'lucide-react';

interface WelcomeProps {
  onOpenSettings: () => void;
  onSelectProvider: (provider: 'gemini' | 'openrouter' | 'anthropic') => void;
}

export default function Welcome({ onOpenSettings, onSelectProvider }: WelcomeProps) {
  return (
    <div className="flex-1 flex items-center justify-center p-8 paper-bg overflow-auto">
      <div className="max-w-lg w-full relative z-10">
        {/* Editorial header */}
        <div className="text-center mb-10">
          <p className="text-xs font-medium tracking-[0.2em] uppercase text-p-accent mb-3">
            Welcome to
          </p>
          <h2
            className="text-3xl font-bold text-p-text mb-3 tracking-tight"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            PDF Transcriber
          </h2>
          <p className="text-sm text-p-text-muted leading-relaxed max-w-sm mx-auto">
            AI-powered batch conversion of PDFs to Markdown, Word, and HTML. Choose a provider to get started.
          </p>
        </div>

        {/* Provider cards */}
        <div className="space-y-3 mb-8">
          <button
            onClick={() => onSelectProvider('gemini')}
            className="w-full text-left rounded-xl border border-p-border bg-p-surface/60 p-5 card-hover cursor-pointer"
          >
            <div className="flex items-start gap-3.5">
              <div className="w-9 h-9 rounded-lg bg-p-success/12 flex items-center justify-center shrink-0 mt-0.5">
                <Zap className="w-4 h-4 text-p-success" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-semibold text-p-text mb-1" style={{ fontFamily: 'var(--font-display)' }}>
                  Free options
                  <span className="ml-2 badge badge-free">Recommended</span>
                </h3>
                <p className="text-xs text-p-text-dim leading-relaxed mb-2.5">
                  Usually more than sufficient for any document. Click to set up.
                </p>
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="badge badge-free">Free</span>
                    <span className="text-xs text-p-text-muted"><span className="font-medium text-p-text">Google Gemini</span> &mdash; fast models optimized for PDFs</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="badge badge-free">Free</span>
                    <span className="text-xs text-p-text-muted"><span className="font-medium text-p-text">OpenRouter</span> &mdash; hundreds of models, many free</span>
                  </div>
                </div>
              </div>
            </div>
          </button>

          <button
            onClick={() => onSelectProvider('anthropic')}
            className="w-full text-left rounded-xl border border-p-border bg-p-surface/60 p-5 card-hover cursor-pointer"
          >
            <div className="flex items-start gap-3.5">
              <div className="w-9 h-9 rounded-lg bg-p-warning/12 flex items-center justify-center shrink-0 mt-0.5">
                <Sparkles className="w-4 h-4 text-p-warning" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-semibold text-p-text mb-1" style={{ fontFamily: 'var(--font-display)' }}>
                  Premium quality
                </h3>
                <p className="text-xs text-p-text-dim leading-relaxed mb-2.5">
                  For complex layouts, tables, or when maximum accuracy matters. Click to set up.
                </p>
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="badge badge-warning">Paid</span>
                    <span className="text-xs text-p-text-muted"><span className="font-medium text-p-text">Anthropic</span> &mdash; premium output, native PDF support</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="badge badge-warning">Paid</span>
                    <span className="text-xs text-p-text-muted"><span className="font-medium text-p-text">Gemini Pro / OpenRouter paid</span> &mdash; large context, complex docs</span>
                  </div>
                </div>
              </div>
            </div>
          </button>
        </div>

        {/* CTA */}
        <div className="text-center">
          <button
            onClick={onOpenSettings}
            className="btn-primary text-sm px-6 py-2.5"
          >
            <Settings2 className="w-4 h-4" />
            Configure Provider
            <ArrowRight className="w-3.5 h-3.5 ml-0.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
