import { Archive, Trash2 } from 'lucide-react';
import type { ConversionJob } from '../types';
import { downloadAllAsZip } from '../lib/download';
import QueueItem from './QueueItem';

interface QueueProps {
  jobs: ConversionJob[];
  previewJobId: string | null;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  onPreview: (id: string) => void;
  onClearCompleted: () => void;
}

export default function Queue({
  jobs,
  previewJobId,
  onRemove,
  onRetry,
  onPreview,
  onClearCompleted,
}: QueueProps) {
  const doneCount = jobs.filter(j => j.status === 'done').length;
  const activeJob = jobs.find(j => j.status === 'converting');

  if (jobs.length === 0) {
    return (
      <div className="text-center py-8 text-p-text-dim text-sm">
        No files in queue. Drop some PDFs above to get started.
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between px-1 mb-2">
        <h2 className="text-sm font-medium text-p-text-muted">
          Queue ({jobs.length} file{jobs.length !== 1 ? 's' : ''})
        </h2>
        {doneCount > 0 && (
          <div className="flex items-center gap-2">
            <button
              onClick={onClearCompleted}
              className="flex items-center gap-1 text-xs px-2 py-1 rounded text-p-text-dim hover:text-p-text hover:bg-p-surface-hover tab-transition"
            >
              <Trash2 className="w-3 h-3" />
              Clear done
            </button>
            {doneCount >= 2 && (
              <button
                onClick={() => downloadAllAsZip(jobs)}
                className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-p-accent/10 text-p-accent hover:bg-p-accent/20 tab-transition"
              >
                <Archive className="w-3 h-3" />
                ZIP all ({doneCount})
              </button>
            )}
          </div>
        )}
      </div>

      {jobs.map(job => (
        <QueueItem
          key={job.id}
          job={job}
          isActive={job.id === activeJob?.id}
          isPreview={job.id === previewJobId}
          onRemove={onRemove}
          onRetry={onRetry}
          onPreview={onPreview}
        />
      ))}
    </div>
  );
}
