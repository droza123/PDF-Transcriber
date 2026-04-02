import { useState, useEffect } from 'react';
import { X, Save, GripVertical } from 'lucide-react';
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getSettings, saveSettings, DEFAULT_MODELS } from '../lib/settings';
import { getCachedModels } from '../lib/apiKey';

interface SettingsProps {
  open: boolean;
  onClose: () => void;
}

function SortableModelItem({
  model,
  index,
  onToggle,
  canRemove,
}: {
  model: string;
  index: number;
  onToggle: (model: string) => void;
  canRemove: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: model });
  const isDragging = !!transform;
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.95 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-p-surface-hover group"
    >
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab text-p-text-dim hover:text-p-text-muted shrink-0"
      >
        <GripVertical className="w-3.5 h-3.5" />
      </button>
      <input
        type="checkbox"
        checked
        onChange={() => canRemove && onToggle(model)}
        className="shrink-0 accent-p-accent"
        title={canRemove ? 'Deselect model' : 'At least one model must be selected'}
      />
      <span className="flex-1 text-sm text-p-text truncate">{model}</span>
      <span className="text-xs font-medium text-p-accent bg-p-accent/10 rounded-full px-2 py-0.5 shrink-0">
        {index + 1}
      </span>
    </div>
  );
}

export default function Settings({ open, onClose }: SettingsProps) {
  const [modelPriority, setModelPriority] = useState<string[]>([]);
  const [batchSize, setBatchSize] = useState(10);
  const [outputNotes, setOutputNotes] = useState('');

  useEffect(() => {
    if (open) {
      const s = getSettings();
      setModelPriority(s.modelPriority);
      setBatchSize(s.batchSize);
      setOutputNotes(s.outputNotes);
    }
  }, [open]);

  if (!open) return null;

  const cached = getCachedModels();
  const availableModels = cached.length > 0 ? cached : DEFAULT_MODELS;
  // Include any models from priority that aren't in the available list (e.g. deprecated)
  const allModels = [...new Set([...modelPriority, ...availableModels])];
  const unselected = allModels.filter(m => !modelPriority.includes(m));

  function toggleModel(model: string) {
    setModelPriority(prev => {
      if (prev.includes(model)) {
        if (prev.length <= 1) return prev;
        return prev.filter(m => m !== model);
      }
      return [...prev, model];
    });
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setModelPriority(prev => {
        const oldIndex = prev.indexOf(String(active.id));
        const newIndex = prev.indexOf(String(over.id));
        if (oldIndex === -1 || newIndex === -1) return prev;
        const updated = [...prev];
        const [moved] = updated.splice(oldIndex, 1);
        updated.splice(newIndex, 0, moved);
        return updated;
      });
    }
  }

  const handleSave = () => {
    saveSettings({ modelPriority, batchSize, outputNotes });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg max-h-[90vh] rounded-xl bg-p-bg border border-p-border shadow-lg p-6 overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold text-p-text">Settings</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-p-text-muted hover:text-p-text hover:bg-p-surface-hover tab-transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-4">
          {/* Model Priority */}
          <div>
            <label className="block text-sm font-medium text-p-text mb-1">Model priority</label>
            <p className="text-xs text-p-text-dim mb-2">
              Models are tried in order during conversion. If one fails, the next is used. Drag to reorder.
            </p>
            <div className="rounded-lg border border-p-border bg-p-bg-deep overflow-y-auto max-h-48">
              {/* Selected models — sortable */}
              <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={modelPriority} strategy={verticalListSortingStrategy}>
                  {modelPriority.map((model, i) => (
                    <SortableModelItem
                      key={model}
                      model={model}
                      index={i}
                      onToggle={toggleModel}
                      canRemove={modelPriority.length > 1}
                    />
                  ))}
                </SortableContext>
              </DndContext>

              {/* Unselected models — static */}
              {unselected.length > 0 && (
                <>
                  {modelPriority.length > 0 && (
                    <div className="border-t border-p-border-subtle" />
                  )}
                  {unselected.map(model => (
                    <div
                      key={model}
                      className="flex items-center gap-2 px-2 py-1.5 hover:bg-p-surface-hover"
                    >
                      {/* Spacer to align with drag handle width */}
                      <div className="w-3.5 shrink-0" />
                      <input
                        type="checkbox"
                        checked={false}
                        onChange={() => toggleModel(model)}
                        className="shrink-0 accent-p-accent"
                      />
                      <span className="flex-1 text-sm text-p-text-muted truncate">{model}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>

          {/* Batch size */}
          <div>
            <label className="block text-sm font-medium text-p-text mb-1.5">Batch size</label>
            <select
              value={batchSize}
              onChange={(e) => setBatchSize(Number(e.target.value))}
              className="w-full rounded-lg border border-p-border bg-p-bg px-3 py-2 text-sm text-p-text tab-transition focus:outline-none focus:border-p-accent"
            >
              {[5, 10, 15, 20].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>

          {/* Output notes */}
          <div>
            <label className="block text-sm font-medium text-p-text mb-1.5">Output notes</label>
            <textarea
              value={outputNotes}
              onChange={(e) => setOutputNotes(e.target.value)}
              placeholder="Additional instructions for the AI (optional)"
              rows={3}
              className="w-full rounded-lg border border-p-border bg-p-bg px-3 py-2 text-sm text-p-text placeholder:text-p-text-dim tab-transition focus:outline-none focus:border-p-accent resize-none"
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-p-text-muted hover:text-p-text hover:bg-p-surface-hover tab-transition"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-p-accent text-white hover:opacity-90 tab-transition"
          >
            <Save className="w-4 h-4" />
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
