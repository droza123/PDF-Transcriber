import { useState } from 'react';
import { Eye, FolderOpen, Trash2, FileText, RefreshCw, Languages } from 'lucide-react';
import type { HistoryEntry } from '../types';
import { getSettings } from '../lib/settings';

interface HistoryItemProps {
  entry: HistoryEntry;
  isActive: boolean;
  onPreview: (entry: HistoryEntry) => void;
  onShowInFolder: (entry: HistoryEntry) => void;
  onDelete: (id: string) => void;
  onReconvert: (entry: HistoryEntry) => void;
  onTranslate?: (entry: HistoryEntry, language: string) => void;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const days = Math.floor(diff / 86400000);

  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export default function HistoryItem({ entry, isActive, onPreview, onShowInFolder, onDelete, onReconvert, onTranslate }: HistoryItemProps) {
  const [showLangPicker, setShowLangPicker] = useState(false);
  const isTranscription = !entry.translationLanguage;

  return (
    <div
      className={`
        group rounded-lg
        ${isActive ? 'glow-ring bg-p-accent/8' : 'card-hover'}
      `}
    >
      {/* Main row */}
      <div className="relative flex items-center gap-3 px-3 py-2.5 overflow-hidden">
        <FileText className="w-4 h-4 text-p-text-dim shrink-0" />

        {/* Text content — fills all space between icon and eye */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-medium text-p-text truncate" title={entry.fileName}>{entry.fileName}</p>
            {entry.translationLanguage && (
              <span className="badge badge-accent shrink-0">{'\u2192'} {entry.translationLanguage}</span>
            )}
          </div>
          <p className="text-xs text-p-text-muted truncate">
            {formatDate(entry.convertedAt)}
            {entry.totalPages > 0 && <>{' \u00b7 '}{entry.totalPages} pages</>}
            {' \u00b7 '}
            {formatDuration(entry.durationMs)}
          </p>
        </div>

        {/* Hover actions — overlay from the right with gradient fade */}
        <div className="absolute right-10 top-0 bottom-0 flex items-center gap-0.5 pr-1 pl-6 opacity-0 group-hover:opacity-100 tab-transition"
          style={{ background: `linear-gradient(to right, transparent, var(${isActive ? '--p-bg' : '--p-surface-hover'}) 24px)` }}
        >
          <button
            onClick={() => onDelete(entry.id)}
            className="p-1.5 rounded-md text-p-text-dim hover:text-p-error hover:bg-p-surface-hover tab-transition"
            title="Remove from history"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onReconvert(entry)}
            className="p-1.5 rounded-md text-p-text-dim hover:text-p-accent hover:bg-p-surface-hover tab-transition"
            title="Re-convert"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          {isTranscription && onTranslate && (
            <button
              onClick={() => setShowLangPicker(!showLangPicker)}
              className={`p-1.5 rounded-md tab-transition ${
                showLangPicker
                  ? 'text-p-accent bg-p-accent/10'
                  : 'text-p-text-dim hover:text-p-accent hover:bg-p-surface-hover'
              }`}
              title="Translate from this transcription"
            >
              <Languages className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            onClick={() => onShowInFolder(entry)}
            className="p-1.5 rounded-md text-p-text-dim hover:text-p-success hover:bg-p-surface-hover tab-transition"
            title="Show in folder"
          >
            <FolderOpen className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Eye button — always visible, far right */}
        <button
          onClick={() => onPreview(entry)}
          className="p-1.5 rounded-md text-p-text-dim hover:text-p-accent hover:bg-p-surface-hover tab-transition shrink-0"
          title="Preview"
        >
          <Eye className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Language picker — separate row below, not affected by overlay */}
      {showLangPicker && (
        <div className="flex flex-wrap gap-1 px-3 pb-2.5 pt-0.5">
          {getSettings().translationLanguages.map(lang => (
            <button
              key={lang}
              onClick={() => {
                setShowLangPicker(false);
                onTranslate?.(entry, lang);
              }}
              className="px-2.5 py-1 text-[11px] rounded-full bg-p-accent/10 text-p-accent hover:bg-p-accent/20 tab-transition"
            >
              {lang}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
