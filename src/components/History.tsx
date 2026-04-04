import { useState, useRef } from 'react';
import { Search, Trash2, Download } from 'lucide-react';
import type { HistoryEntry } from '../types';
import HistoryItem from './HistoryItem';

interface HistoryProps {
  entries: HistoryEntry[];
  searchQuery: string;
  onSearchChange: (query: string) => void;
  activeId: string | null;
  onPreview: (entry: HistoryEntry) => void;
  onShowInFolder: (entry: HistoryEntry) => void;
  onDelete: (id: string) => void;
  onClearAll: () => void;
  onReconvert: (entry: HistoryEntry) => void;
  onTranslate: (entry: HistoryEntry, language: string) => void;
  onExport: () => void;
}

export default function History({
  entries,
  searchQuery,
  onSearchChange,
  activeId,
  onPreview,
  onShowInFolder,
  onDelete,
  onClearAll,
  onReconvert,
  onTranslate,
  onExport,
}: HistoryProps) {
  const [confirmClear, setConfirmClear] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = searchQuery
    ? entries.filter(e => e.fileName.toLowerCase().includes(searchQuery.toLowerCase()))
    : entries;

  function handleClearAll() {
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    onClearAll();
    setConfirmClear(false);
  }

  if (entries.length === 0) {
    return (
      <div className="text-center py-10 text-p-text-dim text-sm">
        <p className="mb-1" style={{ fontFamily: 'var(--font-display)' }}>No history yet</p>
        <p className="text-xs text-p-text-dim/60">Completed conversions appear here after archiving</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full" ref={containerRef}>
      {/* Header: search + export + clear all */}
      <div className="flex items-center gap-2 px-1 mb-2 shrink-0">
        <div className="flex-1 relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-p-text-dim" />
          <input
            type="text"
            placeholder="Search history..."
            value={searchQuery}
            onChange={e => onSearchChange(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg bg-p-surface border border-p-border text-p-text placeholder:text-p-text-dim focus:outline-none focus:border-p-accent focus:shadow-[0_0_0_3px_var(--p-accent-glow)] tab-transition"
          />
        </div>
        {entries.length > 0 && (
          <button
            onClick={onExport}
            className="btn-ghost"
            title="Export history"
          >
            <Download className="w-3 h-3" />
          </button>
        )}
        <button
          onClick={handleClearAll}
          className={`btn-ghost ${
            confirmClear
              ? '!bg-p-error/12 !text-p-error font-medium'
              : ''
          }`}
          title={confirmClear ? 'Click again to confirm' : 'Clear all history'}
        >
          <Trash2 className="w-3 h-3" />
          {confirmClear ? 'Confirm?' : 'Clear all'}
        </button>
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-6 text-p-text-dim text-sm">
          No results for &ldquo;{searchQuery}&rdquo;
        </div>
      ) : (
        <div className="space-y-1">
          {filtered.map(entry => (
            <HistoryItem
              key={entry.id}
              entry={entry}
              isActive={entry.id === activeId}
              onPreview={onPreview}
              onShowInFolder={onShowInFolder}
              onDelete={onDelete}
              onReconvert={onReconvert}
              onTranslate={onTranslate}
            />
          ))}
        </div>
      )}
    </div>
  );
}
