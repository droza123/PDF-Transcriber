import { useState, useMemo } from 'react';
import { Search, Trash2, Info, AlertTriangle, XCircle, CheckCircle, ChevronDown, ChevronRight } from 'lucide-react';
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
  info: 'text-p-accent',
  warn: 'text-p-warning',
  error: 'text-p-error',
  success: 'text-p-success',
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

interface LogGroup {
  jobId: string;
  fileName: string;
  entries: LogEntry[];
  latestTimestamp: number;
  hasErrors: boolean;
}

export default function Log({ entries, onClear }: LogProps) {
  const [search, setSearch] = useState('');
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all');
  const [confirmClear, setConfirmClear] = useState(false);
  const [collapsedJobs, setCollapsedJobs] = useState<Set<string>>(new Set());

  // Filter entries
  const filtered = useMemo(() => entries.filter(e => {
    if (search && !e.fileName.toLowerCase().includes(search.toLowerCase()) && !e.message.toLowerCase().includes(search.toLowerCase())) {
      return false;
    }
    if (levelFilter === 'info') return e.level === 'info';
    if (levelFilter === 'success') return e.level === 'success';
    if (levelFilter === 'issues') return e.level === 'warn' || e.level === 'error';
    return true;
  }), [entries, search, levelFilter]);

  // Group by jobId, sorted newest-first
  const groups = useMemo(() => {
    const map = new Map<string, LogGroup>();
    for (const entry of filtered) {
      let group = map.get(entry.jobId);
      if (!group) {
        group = { jobId: entry.jobId, fileName: entry.fileName, entries: [], latestTimestamp: 0, hasErrors: false };
        map.set(entry.jobId, group);
      }
      group.entries.push(entry);
      if (entry.timestamp > group.latestTimestamp) group.latestTimestamp = entry.timestamp;
      if (entry.level === 'error' || entry.level === 'warn') group.hasErrors = true;
    }
    const sorted = [...map.values()].sort((a, b) => b.latestTimestamp - a.latestTimestamp);
    // Reverse entries within each group so newest is on top
    for (const g of sorted) g.entries.reverse();
    return sorted;
  }, [filtered]);

  // Auto-collapse: only the latest group is expanded by default
  const latestJobId = groups.length > 0 ? groups[0].jobId : null;

  function toggleGroup(jobId: string) {
    setCollapsedJobs(prev => {
      const next = new Set(prev);
      if (isExpanded(jobId)) {
        next.add(jobId);
        next.delete('_open_' + jobId);
      } else {
        next.delete(jobId);
        next.add('_open_' + jobId);
      }
      return next;
    });
  }

  function isExpanded(jobId: string): boolean {
    if (collapsedJobs.has(jobId)) return false;
    if (collapsedJobs.has('_open_' + jobId)) return true;
    return jobId === latestJobId;
  }

  function handleClear() {
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    onClear();
    setConfirmClear(false);
    setCollapsedJobs(new Set());
  }

  if (entries.length === 0) {
    return (
      <div className="text-center py-10 text-p-text-dim text-sm">
        <p className="mb-1" style={{ fontFamily: 'var(--font-display)' }}>No log entries</p>
        <p className="text-xs text-p-text-dim/60">Events will appear here during conversion</p>
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
      {/* Header: search + clear */}
      <div className="flex items-center gap-2 px-1 mb-2 shrink-0">
        <div className="flex-1 relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-p-text-dim" />
          <input
            type="text"
            placeholder="Search log..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg bg-p-surface border border-p-border text-p-text placeholder:text-p-text-dim focus:outline-none focus:border-p-accent focus:shadow-[0_0_0_3px_var(--p-accent-glow)] tab-transition"
          />
        </div>
        <button
          onClick={handleClear}
          className={`btn-ghost ${
            confirmClear
              ? '!bg-p-error/12 !text-p-error font-medium'
              : ''
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
            className={`text-[11px] px-2.5 py-1 rounded-md tab-transition ${
              levelFilter === key
                ? 'bg-p-accent/12 text-p-accent font-medium'
                : 'text-p-text-dim hover:text-p-text hover:bg-p-surface-hover'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Grouped log entries */}
      {groups.length === 0 ? (
        <div className="text-center py-6 text-p-text-dim text-sm">
          No matching entries
        </div>
      ) : (
        <div className="space-y-1 overflow-y-auto flex-1">
          {groups.map(group => {
            const expanded = isExpanded(group.jobId);
            const errorCount = group.entries.filter(e => e.level === 'error' || e.level === 'warn').length;
            return (
              <div key={group.jobId} className="rounded-lg border border-p-border-subtle overflow-hidden">
                {/* Group header */}
                <button
                  onClick={() => toggleGroup(group.jobId)}
                  className="flex items-center gap-1.5 w-full px-2.5 py-2 text-left hover:bg-p-surface-hover tab-transition"
                >
                  {expanded
                    ? <ChevronDown className="w-3 h-3 text-p-text-dim shrink-0" />
                    : <ChevronRight className="w-3 h-3 text-p-text-dim shrink-0" />
                  }
                  <span className="text-xs font-medium text-p-text truncate flex-1" title={group.fileName}>{group.fileName}</span>
                  {errorCount > 0 && (
                    <span className="badge badge-error shrink-0">
                      {errorCount}
                    </span>
                  )}
                  <span className="text-[10px] text-p-text-dim shrink-0">
                    {group.entries.length}
                  </span>
                </button>

                {/* Group entries */}
                {expanded && (
                  <div className="border-t border-p-border-subtle">
                    {group.entries.map(entry => {
                      const Icon = LEVEL_ICON[entry.level];
                      const color = LEVEL_COLOR[entry.level];
                      return (
                        <div key={entry.id} className="flex items-start gap-2 px-2.5 py-1.5 hover:bg-p-surface-hover">
                          <Icon className={`w-3 h-3 shrink-0 mt-0.5 ${color}`} />
                          <div className="flex-1 min-w-0">
                            <p className="text-[11px] text-p-text truncate" title={entry.message}>{entry.message}</p>
                            <p className="text-[10px] text-p-text-dim">{formatTime(entry.timestamp)}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
