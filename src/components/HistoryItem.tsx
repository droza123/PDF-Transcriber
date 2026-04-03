import { Eye, FolderOpen, Trash2, FileText, RefreshCw } from 'lucide-react';
import type { HistoryEntry } from '../types';

interface HistoryItemProps {
  entry: HistoryEntry;
  isActive: boolean;
  onPreview: (entry: HistoryEntry) => void;
  onShowInFolder: (entry: HistoryEntry) => void;
  onDelete: (id: string) => void;
  onReconvert: (entry: HistoryEntry) => void;
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

export default function HistoryItem({ entry, isActive, onPreview, onShowInFolder, onDelete, onReconvert }: HistoryItemProps) {
  return (
    <div
      className={`
        flex items-center gap-3 px-3 py-2.5 rounded-lg tab-transition
        ${isActive ? 'bg-p-accent/10 border border-p-accent/30' : 'hover:bg-p-surface-hover'}
      `}
    >
      <FileText className="w-4 h-4 text-p-text-dim shrink-0" />

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-p-text truncate" title={entry.fileName}>{entry.fileName}</p>
        <p className="text-xs text-p-text-muted truncate">
          {formatDate(entry.convertedAt)}
          {' \u00b7 '}
          {entry.totalPages} pages
          {' \u00b7 '}
          {formatDuration(entry.durationMs)}
        </p>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={() => onPreview(entry)}
          className="p-1.5 rounded text-p-text-dim hover:text-p-accent hover:bg-p-surface-hover tab-transition"
          title="Preview"
        >
          <Eye className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => onReconvert(entry)}
          className="p-1.5 rounded text-p-text-dim hover:text-p-accent hover:bg-p-surface-hover tab-transition"
          title="Re-convert"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => onShowInFolder(entry)}
          className="p-1.5 rounded text-p-text-dim hover:text-p-success hover:bg-p-surface-hover tab-transition"
          title="Show in folder"
        >
          <FolderOpen className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => onDelete(entry.id)}
          className="p-1.5 rounded text-p-text-dim hover:text-p-error hover:bg-p-surface-hover tab-transition"
          title="Remove from history"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
