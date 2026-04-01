import {
  Clock,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  X,
  RefreshCw,
  Eye,
  Download,
  FolderOpen,
  ScanSearch,
} from 'lucide-react';
import type { ConversionJob } from '../types';
import { downloadMarkdown, showInFolder } from '../lib/download';

interface QueueItemProps {
  job: ConversionJob;
  isActive: boolean;
  isPreview: boolean;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  onPreview: (id: string) => void;
}

export default function QueueItem({
  job,
  isActive,
  isPreview,
  onRemove,
  onRetry,
  onPreview,
}: QueueItemProps) {
  const statusIcon = {
    queued: <Clock className="w-4 h-4 text-p-text-dim" />,
    converting:
      job.phase === 'scanning' ? (
        <ScanSearch className="w-4 h-4 text-p-accent animate-pulse" />
      ) : (
        <Loader2 className="w-4 h-4 text-p-accent animate-spin" />
      ),
    done: <CheckCircle2 className="w-4 h-4 text-p-success" />,
    error: <AlertTriangle className="w-4 h-4 text-p-error" />,
  }[job.status];

  const elapsed =
    job.startedAt && job.completedAt
      ? `${Math.round((job.completedAt - job.startedAt) / 1000)}s`
      : job.startedAt
        ? `${Math.round((Date.now() - job.startedAt) / 1000)}s`
        : null;

  return (
    <div
      className={`
        flex items-center gap-3 px-3 py-2.5 rounded-lg tab-transition
        ${isPreview ? 'bg-p-accent/10 border border-p-accent/30' : 'hover:bg-p-surface-hover'}
        ${isActive ? 'bg-p-surface' : ''}
      `}
    >
      {statusIcon}

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-p-text truncate">{job.fileName}</p>
        <p className="text-xs text-p-text-muted truncate">
          {job.statusMessage}
          {elapsed && job.status === 'done' && ` (${elapsed})`}
          {job.status === 'done' && job.totalPages > 0 && ` \u00b7 ${job.totalPages} pages`}
        </p>

        {/* Progress bar */}
        {job.status === 'converting' && job.phase === 'converting' && (
          <div className="mt-1.5 h-1 bg-p-border rounded-full overflow-hidden">
            <div
              className="h-full bg-p-accent rounded-full tab-transition"
              style={{ width: `${job.progress}%` }}
            />
          </div>
        )}

        {/* Error message */}
        {job.status === 'error' && job.error && (
          <p className="text-xs text-p-error mt-1 truncate">{job.error}</p>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0">
        {job.status === 'done' && (
          <>
            <button
              onClick={() => onPreview(job.id)}
              className="p-1.5 rounded text-p-text-dim hover:text-p-accent hover:bg-p-surface-hover tab-transition"
              title="Preview"
            >
              <Eye className="w-3.5 h-3.5" />
            </button>
            {job.savedPath ? (
              <button
                onClick={() => showInFolder(job.savedPath!)}
                className="p-1.5 rounded text-p-text-dim hover:text-p-success hover:bg-p-surface-hover tab-transition"
                title="Show in folder"
              >
                <FolderOpen className="w-3.5 h-3.5" />
              </button>
            ) : (
              <button
                onClick={() => downloadMarkdown(job.fileName, job.markdown!)}
                className="p-1.5 rounded text-p-text-dim hover:text-p-success hover:bg-p-surface-hover tab-transition"
                title="Download"
              >
                <Download className="w-3.5 h-3.5" />
              </button>
            )}
          </>
        )}
        {job.status === 'error' && (
          <button
            onClick={() => onRetry(job.id)}
            className="p-1.5 rounded text-p-text-dim hover:text-p-accent hover:bg-p-surface-hover tab-transition"
            title="Retry"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        )}
        {job.status !== 'converting' && (
          <button
            onClick={() => onRemove(job.id)}
            className="p-1.5 rounded text-p-text-dim hover:text-p-error hover:bg-p-surface-hover tab-transition"
            title="Remove"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
