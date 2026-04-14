import { Sun, Moon, Settings2 } from 'lucide-react';
import { hasApiKey } from '../lib/apiKey';
import { getSettings } from '../lib/settings';
import { getAllProviders } from '../lib/providers/registry';
import appIcon from '../../build/icon.png';

interface HeaderProps {
  theme: 'dark' | 'light';
  keyPresent: boolean;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
}

export default function Header({ theme, keyPresent, onToggleTheme, onOpenSettings }: HeaderProps) {
  const settings = getSettings();
  const allProviders = getAllProviders();
  // Show unique provider names used across all roles
  const roleIds = new Set([settings.scanProvider, settings.transcribeProvider, settings.translateProvider]);
  const roleProviders = keyPresent
    ? allProviders.filter(p => roleIds.has(p.id))
    : [];
  const providerLabel = roleProviders.map(p => p.displayName).join(' / ');

  return (
    <header className="flex items-center justify-between px-6 py-3.5 border-b border-p-border bg-p-bg/80 backdrop-blur-sm relative z-10">
      <div className="flex items-center gap-3.5">
        <img src={appIcon} alt="PDF Transcriber" className="w-8 h-8 rounded-lg" />
        <div>
          <h1 className="text-[17px] font-semibold text-p-text tracking-tight" style={{ fontFamily: 'var(--font-display)' }}>
            PDF Transcriber
          </h1>
          <p className="text-[11px] text-p-text-dim">
            v{__APP_VERSION__}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        {/* Provider status */}
        {keyPresent && providerLabel ? (
          <button
            onClick={onOpenSettings}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs border border-p-border hover:border-p-accent/40 bg-p-surface/50 tab-transition group"
            title="Change provider settings"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-p-success shrink-0" />
            <span className="text-p-text-muted group-hover:text-p-text font-medium tab-transition">{providerLabel}</span>
          </button>
        ) : (
          <button
            onClick={onOpenSettings}
            className="btn-primary text-xs py-1.5"
          >
            Set up API
          </button>
        )}
        <button
          onClick={onOpenSettings}
          className="p-2 rounded-lg text-p-text-dim hover:text-p-accent hover:bg-p-surface-hover tab-transition"
          title="Settings"
        >
          <Settings2 className="w-4 h-4" />
        </button>
        <button
          onClick={onToggleTheme}
          className="p-2 rounded-lg text-p-text-dim hover:text-p-accent hover:bg-p-surface-hover tab-transition"
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        >
          {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
      </div>
    </header>
  );
}
