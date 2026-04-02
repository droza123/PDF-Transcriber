import { useState, useRef, useEffect } from 'react';
import { Search, Trash2, Info, AlertTriangle, XCircle, CheckCircle } from 'lucide-react';
import type { LogEntry } from '../types';

type LevelFilter = 'all' | 'info' | 'success' | 'issues';

interface LogProps {
  entries: LogEntry[];
  onClear: () => void;
}

const LEVEL_ICON: Record<LogEntry['level'], typeof Info> = {
  info: Info,
  warn: AlertTriangle,
  error: XCircle,
  success: CheckCircle,
};

const LEVEL_COLOR: Record<LogEntry['level'], string> = {
  info: 'text-blue-400',
  warn: 'text-yellow-400',
  error: 'text-p-error',
  success: 'text-green-400',
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function Log({ entries, onClear }: LogProps) {
  const [search, setSearch] = useState('');
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all');
  const [confirmClear, setConfirmClear] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries.length]);

  const filtered = entries.filter(e => {
    if (search && !e.fileName.toLowerCase().includes(search.toLowerCase()) && !e.message.toLowerCase().includes(search.toLowerCase())) {
      return false;
    }
    if (levelFilter === 'info') return e.level === 'info';
    if (levelFilter === 'success') return e.level === 'success';
    if (levelFilter === 'issues') return e.level === 'warn' || e.level === 'error';
    return true;
  });

  function handleClear() {
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    onClear();
    setConfirmClear(false);
  }

  if (entries.length === 0) {
    return (
      <div className="text-center py-8 text-p-text-dim text-sm">
        No log entries yet. Events will appear here during conversion.
      </div>
    );
  }

  const filterButtons: { key: LevelFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'info', label: 'Info' },
    { key: 'success', label: 'Success' },
    { key: 'issues', label: 'Errors' },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Header: search + level filters + clear */}
      <div className="flex items-center gap-2 px-1 mb-2 shrink-0">
        <div className="flex-1 relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-p-text-dim" />
          <input
            type="text"
            placeholder="Search log..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-xs rounded-md bg-p-surface border border-p-border text-p-text placeholder:text-p-text-dim focus:outline-none focus:border-p-accent tab-transition"
          />
        </div>
        <button
          onClick={handleClear}
          className={`flex items-center gap-1 text-xs px-2 py-1.5 rounded shrink-0 tab-transition ${
            confirmClear
              ? 'bg-p-error/15 text-p-error font-medium'
              : 'text-p-text-dim hover:text-p-error hover:bg-p-surface-hover'
          }`}
          title={confirmClear ? 'Click again to confirm' : 'Clear log'}
        >
          <Trash2 className="w-3 h-3" />
          {confirmClear ? 'Confirm?' : 'Clear'}
        </button>
      </div>

      {/* Level filter buttons */}
      <div className="flex items-center gap-1 px-1 mb-2 shrink-0">
        {filterButtons.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setLevelFilter(key)}
            className={`text-[11px] px-2 py-1 rounded-md tab-transition ${
              levelFilter === key
                ? 'bg-p-accent/15 text-p-accent font-medium'
                : 'text-p-text-dim hover:text-p-text hover:bg-p-surface-hover'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Log entries */}
      {filtered.length === 0 ? (
        <div className="text-center py-6 text-p-text-dim text-sm">
          No matching entries
        </div>
      ) : (
        <div className="space-y-0.5 overflow-y-auto flex-1">
          {filtered.map(entry => {
            const Icon = LEVEL_ICON[entry.level];
            const color = LEVEL_COLOR[entry.level];
            return (
              <div key={entry.id} className="flex items-start gap-2 px-2 py-1.5 rounded-lg hover:bg-p-surface-hover">
                <Icon className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${color}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-p-text truncate">{entry.message}</p>
                  <p className="text-[10px] text-p-text-dim truncate">
                    {formatTime(entry.timestamp)} &middot; {entry.fileName}
                  </p>
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
