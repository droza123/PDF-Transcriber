import { Sun, Moon, FileText, Settings2 } from 'lucide-react';
import { hasApiKey, getApiKey } from '../lib/apiKey';
import { getSettings } from '../lib/settings';
import { getAllProviders } from '../lib/providers/registry';

interface HeaderProps {
  theme: 'dark' | 'light';
  keyPresent: boolean;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
}

export default function Header({ theme, keyPresent, onToggleTheme, onOpenSettings }: HeaderProps) {
  const activeProvider = keyPresent
    ? getAllProviders().find(p => p.id === getSettings().activeProvider)
    : null;
  const key = keyPresent ? getApiKey() : null;
  const maskedKey = key ? '\u2022\u2022\u2022\u2022' + key.slice(-4) : null;

  return (
    <header className="flex items-center justify-between px-6 py-3 border-b border-p-border">
      <div className="flex items-center gap-3">
        <FileText className="w-6 h-6 text-p-accent" />
        <div>
          <h1 className="text-lg font-semibold text-p-text">PDF Transcriber</h1>
          <p className="text-xs text-p-text-muted">AI-powered batch conversion to Markdown, Word, and HTML <span className="text-p-text-dim">v{__APP_VERSION__}</span></p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {/* Provider status */}
        {keyPresent && activeProvider ? (
          <button
            onClick={onOpenSettings}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs border border-p-border bg-p-surface hover:border-p-accent/50 tab-transition"
            title="Change provider settings"
          >
            <span className="text-p-text font-medium">{activeProvider.displayName}</span>
            {maskedKey && <span className="font-mono text-p-text-dim">{maskedKey}</span>}
          </button>
        ) : (
          <button
            onClick={onOpenSettings}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-p-accent text-white hover:bg-p-accent-bright tab-transition"
          >
            Set up API
          </button>
        )}
        <button
          onClick={onOpenSettings}
          className="p-2 rounded-lg text-p-text-muted hover:text-p-text hover:bg-p-surface-hover tab-transition"
          title="Settings"
        >
          <Settings2 className="w-4 h-4" />
        </button>
        <button
          onClick={onToggleTheme}
          className="p-2 rounded-lg text-p-text-muted hover:text-p-text hover:bg-p-surface-hover tab-transition"
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        >
          {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
      </div>
    </header>
  );
}
