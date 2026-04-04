import {
  Clock,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  X,
  XCircle,
  RefreshCw,
  Eye,
  Download,
  FolderOpen,
  ScanSearch,
  GripVertical,
} from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ConversionJob } from '../types';
import { downloadMarkdown, showInFolder } from '../lib/download';

interface QueueItemProps {
  job: ConversionJob;
  isActive: boolean;
  isPreview: boolean;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  onPreview: (id: string) => void;
  onCancel: (id: string) => void;
}

function formatPrevDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const days = Math.floor(diff / 86400000);

  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

export default function QueueItem({
  job,
  isActive,
  isPreview,
  onRemove,
  onRetry,
  onPreview,
  onCancel,
}: QueueItemProps) {
  const isDraggable = job.status === 'queued';
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: job.id,
    disabled: !isDraggable,
  });
  const isDragging = !!transform;
  const sortableStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.9 : undefined,
  };

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
      ref={setNodeRef}
      style={sortableStyle}
      className={`
        flex items-center gap-3 px-3 py-2.5 mb-1 rounded-lg
        ${isPreview ? 'glow-ring bg-p-accent/8' : 'card-hover'}
        ${isActive ? 'bg-p-surface' : ''}
      `}
    >
      {isDraggable && (
        <button {...attributes} {...listeners} className="cursor-grab text-p-text-dim hover:text-p-text-muted -ml-1 shrink-0">
          <GripVertical className="w-3.5 h-3.5" />
        </button>
      )}
      {statusIcon}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="text-sm font-medium text-p-text truncate" title={job.fileName}>{job.fileName}</p>
          {job.translationLanguage && (
            <span className="badge badge-accent shrink-0">
              {'\u2192'} {job.translationLanguage}
            </span>
          )}
        </div>
        <p className="text-xs text-p-text-muted truncate">
          {job.statusMessage}
          {elapsed && job.status === 'done' && ` (${elapsed})`}
          {job.status === 'done' && job.totalPages > 0 && ` \u00b7 ${job.totalPages} pages`}
        </p>

        {/* Stream progress indicator with model name */}
        {job.status === 'converting' && job.streamPhase && (
          <p className="text-[10px] text-p-text-dim mt-0.5 truncate">
            {job.activeModel && (
              <span className="font-medium text-p-accent">{job.activeModel}</span>
            )}
            {job.activeModel && ' \u27EB '}
            {job.streamPhase === 'uploading' && 'Uploading to model...'}
            {job.streamPhase === 'processing' && 'Waiting for model...'}
            {job.streamPhase === 'streaming' && (
              <>
                {job.streamChars
                  ? <>Receiving... {job.streamChars >= 1000
                      ? `${(job.streamChars / 1000).toFixed(1)}k`
                      : job.streamChars} chars</>
                  : 'Waiting for response...'}
              </>
            )}
          </p>
        )}

        {/* Progress bar */}
        {job.status === 'converting' && job.phase === 'converting' && (
          <div className="mt-1.5 h-1.5 bg-p-border/50 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full progress-shimmer"
              style={{ width: `${job.progress}%` }}
            />
          </div>
        )}

        {/* Error message */}
        {job.status === 'error' && job.error && (
          <p className="text-xs text-p-error mt-1 truncate">{job.error}</p>
        )}

        {/* Export errors */}
        {job.status === 'done' && job.exportErrors && (
          <p className="text-xs text-p-warning mt-0.5 truncate" title={job.exportErrors}>
            Export failed: {job.exportErrors}
          </p>
        )}

        {/* Previous conversion warning */}
        {job.previousConversion && (
          <p className="text-p-warning text-xs mt-0.5">
            Previously converted {formatPrevDate(job.previousConversion.date)}
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-0.5 shrink-0">
        {job.status === 'done' && (
          <>
            <button
              onClick={() => onPreview(job.id)}
              className="p-1.5 rounded-md text-p-text-dim hover:text-p-accent hover:bg-p-surface-hover tab-transition"
              title="Preview"
            >
              <Eye className="w-3.5 h-3.5" />
            </button>
            {job.savedPath ? (
              <button
                onClick={() => showInFolder(job.savedPath!)}
                className="p-1.5 rounded-md text-p-text-dim hover:text-p-success hover:bg-p-surface-hover tab-transition"
                title="Show in folder"
              >
                <FolderOpen className="w-3.5 h-3.5" />
              </button>
            ) : (
              <button
                onClick={() => downloadMarkdown(job.fileName, job.markdown!)}
                className="p-1.5 rounded-md text-p-text-dim hover:text-p-success hover:bg-p-surface-hover tab-transition"
                title="Download"
              >
                <Download className="w-3.5 h-3.5" />
              </button>
            )}
          </>
        )}
        {job.status === 'converting' && (
          <button
            onClick={() => onCancel(job.id)}
            className="p-1.5 rounded-md text-p-text-dim hover:text-p-error tab-transition"
            title="Cancel"
          >
            <XCircle className="w-3.5 h-3.5" />
          </button>
        )}
        {job.status === 'error' && (
          <button
            onClick={() => onRetry(job.id)}
            className="p-1.5 rounded-md text-p-text-dim hover:text-p-accent hover:bg-p-surface-hover tab-transition"
            title="Retry"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        )}
        {job.status !== 'converting' && (
          <button
            onClick={() => onRemove(job.id)}
            className="p-1.5 rounded-md text-p-text-dim hover:text-p-error hover:bg-p-surface-hover tab-transition"
            title="Remove"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
