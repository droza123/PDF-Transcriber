import { Sun, Moon, FileText, Settings2 } from 'lucide-react';

interface HeaderProps {
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onOpenSettings: () => void;
}

export default function Header({ theme, onToggleTheme, onOpenSettings }: HeaderProps) {
  return (
    <header className="flex items-center justify-between px-6 py-4 border-b border-p-border">
      <div className="flex items-center gap-3">
        <FileText className="w-6 h-6 text-p-accent" />
        <div>
          <h1 className="text-lg font-semibold text-p-text">PDF Transcriber</h1>
          <p className="text-xs text-p-text-muted">AI-powered batch conversion to Markdown, Word, and HTML <span className="text-p-text-dim">v{__APP_VERSION__}</span></p>
        </div>
      </div>
      <div className="flex items-center gap-3">
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
