import { Archive, Pause, Play } from 'lucide-react';
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { ConversionJob } from '../types';
import QueueItem from './QueueItem';

interface QueueProps {
  jobs: ConversionJob[];
  previewJobId: string | null;
  paused: boolean;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  onPreview: (id: string) => void;
  onCancel: (id: string) => void;
  onArchiveCompleted: () => void;
  onTogglePause: () => void;
  onReorder: (activeId: string, overId: string) => void;
}

export default function Queue({
  jobs,
  previewJobId,
  paused,
  onRemove,
  onRetry,
  onPreview,
  onCancel,
  onArchiveCompleted,
  onTogglePause,
  onReorder,
}: QueueProps) {
  const doneCount = jobs.filter(j => j.status === 'done').length;
  const activeJob = jobs.find(j => j.status === 'converting');

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      onReorder(String(active.id), String(over.id));
    }
  }

  if (jobs.length === 0) {
    return (
      <div className="text-center py-8 text-p-text-dim text-sm">
        No files in queue. Drop some PDFs above to get started.
      </div>
    );
  }

  const jobIds = jobs.map(j => j.id);

  return (
    <div>
      <div className="flex items-center justify-end gap-2 px-1 mb-2">
        <button
          onClick={onTogglePause}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded text-p-text-dim hover:text-p-text hover:bg-p-surface-hover tab-transition"
        >
          {paused ? (
            <>
              <Play className="w-3 h-3" />
              Resume
            </>
          ) : (
            <Pause className="w-3 h-3" />
          )}
        </button>
        {doneCount > 0 && (
          <button
            onClick={onArchiveCompleted}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded text-p-text-dim hover:text-p-text hover:bg-p-surface-hover tab-transition"
          >
            <Archive className="w-3 h-3" />
            Archive done ({doneCount})
          </button>
        )}
      </div>

      <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={jobIds} strategy={verticalListSortingStrategy}>
          {jobs.map(job => (
            <QueueItem
              key={job.id}
              job={job}
              isActive={job.id === activeJob?.id}
              isPreview={job.id === previewJobId}
              onRemove={onRemove}
              onRetry={onRetry}
              onPreview={onPreview}
              onCancel={onCancel}
            />
          ))}
        </SortableContext>
      </DndContext>
    </div>
  );
}
