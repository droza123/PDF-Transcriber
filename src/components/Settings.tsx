import { useState, useEffect } from 'react';
import { X, Save } from 'lucide-react';
import { getSettings, saveSettings, DEFAULT_MODELS } from '../lib/settings';
import { getCachedModels } from '../lib/apiKey';

interface SettingsProps {
  open: boolean;
  onClose: () => void;
}

export default function Settings({ open, onClose }: SettingsProps) {
  const [model, setModel] = useState('');
  const [batchSize, setBatchSize] = useState(10);
  const [outputNotes, setOutputNotes] = useState('');

  useEffect(() => {
    if (open) {
      const s = getSettings();
      setModel(s.model);
      setBatchSize(s.batchSize);
      setOutputNotes(s.outputNotes);
    }
  }, [open]);

  if (!open) return null;

  const cached = getCachedModels();
  const modelOptions = [...(cached.length > 0 ? cached : DEFAULT_MODELS)];

  // Ensure current model is in the list
  if (model && !modelOptions.includes(model)) {
    modelOptions.unshift(model);
  }

  const handleSave = () => {
    saveSettings({ model, batchSize, outputNotes });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl bg-p-bg border border-p-border shadow-lg p-6"
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
          {/* Model */}
          <div>
            <label className="block text-sm font-medium text-p-text mb-1.5">Model</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full rounded-lg border border-p-border bg-p-bg px-3 py-2 text-sm text-p-text tab-transition focus:outline-none focus:border-p-accent"
            >
              {modelOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
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
