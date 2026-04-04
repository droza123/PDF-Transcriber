import { useState, useEffect } from 'react';
import { X, Save, GripVertical, RefreshCw, Info } from 'lucide-react';
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getSettings, saveSettings, PROVIDER_DEFAULT_MODELS, DEFAULT_TRANSLATION_LANGUAGES, getSessionSkippedModels, type ExportFormat, type FileNaming } from '../lib/settings';
import { getCachedModels, getApiKey, hasApiKey, validateAndFetchModels } from '../lib/apiKey';
import { getAllProviders, getProvider } from '../lib/providers/registry';
import type { ProviderId, ProviderModel } from '../lib/providers/types';
import { OpenRouterProvider } from '../lib/providers/openrouter';

interface SettingsProps {
  open: boolean;
  onClose: () => void;
}

/** Returns a React element showing pricing info for a model, or null. */
function getPricingBadge(modelId: string, modelData: ProviderModel[]): React.ReactNode {
  const data = modelData.find(m => m.id === modelId);
  if (!data) return null;
  if (data.isFree) {
    return (
      <span className="text-[10px] font-medium text-green-400 bg-green-400/10 rounded-full px-1.5 py-0.5 shrink-0">
        Free
      </span>
    );
  }
  if (data.pricePerMTokens != null && data.pricePerMTokens > 0) {
    const price = data.pricePerMTokens < 1
      ? `$${data.pricePerMTokens.toFixed(2)}/M`
      : `$${data.pricePerMTokens.toFixed(0)}/M`;
    return (
      <span className="text-[10px] font-medium text-p-text-dim bg-p-surface-hover rounded-full px-1.5 py-0.5 shrink-0">
        {price}
      </span>
    );
  }
  return null;
}

function SkippedBadge({ reason }: { reason: string }) {
  const label = reason === 'rate limited' ? 'Rate limited' : 'Skipped';
  const detail = reason === 'rate limited'
    ? `This model was rate limited during this session and will be skipped for remaining batches. Restart the app to retry.`
    : `This model was skipped due to: ${reason}. It will not be used for remaining batches. Restart the app to retry.`;
  return (
    <span
      title={detail}
      className="text-xs font-medium text-amber-400 bg-amber-400/10 rounded-full px-2 py-0.5 shrink-0 cursor-help"
    >
      {label}
    </span>
  );
}

function SortableModelItem({
  model,
  index,
  onToggle,
  canRemove,
  skipReason,
  pricingBadge,
}: {
  model: string;
  index: number;
  onToggle: (model: string) => void;
  canRemove: boolean;
  skipReason?: string;
  pricingBadge?: React.ReactNode;
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
      {pricingBadge}
      {skipReason && <SkippedBadge reason={skipReason} />}
      <span className="text-xs font-medium text-p-accent bg-p-accent/10 rounded-full px-2 py-0.5 shrink-0">
        {index + 1}
      </span>
    </div>
  );
}

export default function Settings({ open, onClose }: SettingsProps) {
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>('gemini');
  const [modelPriority, setModelPriority] = useState<string[]>([]);
  const [batchSize, setBatchSize] = useState(10);
  const [outputNotes, setOutputNotes] = useState('');
  const [autoExportFormats, setAutoExportFormats] = useState<ExportFormat[]>(['md']);
  const [fileNaming, setFileNaming] = useState<FileNaming>('overwrite');
  const [preventSleep, setPreventSleep] = useState(false);
  const [translationEnabled, setTranslationEnabled] = useState(false);
  const [translationLanguage, setTranslationLanguage] = useState('');
  const [translationLanguages, setTranslationLanguages] = useState<string[]>([]);
  const [newLanguage, setNewLanguage] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [cachedModels, setCachedModels] = useState<string[]>([]);
  const [skippedModels, setSkippedModels] = useState<ReadonlyMap<string, string>>(new Map());
  // OpenRouter-specific
  const [autoFreeModels, setAutoFreeModels] = useState(true);
  const [freeOnlyFilter, setFreeOnlyFilter] = useState(true);
  const [openrouterModelData, setOpenrouterModelData] = useState<ProviderModel[]>([]);

  useEffect(() => {
    if (open) {
      const s = getSettings();
      const provider = s.activeProvider;
      setSelectedProvider(provider);
      setModelPriority(s.providerModelPriority[provider] || []);
      setBatchSize(s.batchSize);
      setOutputNotes(s.outputNotes);
      setAutoExportFormats(s.autoExportFormats);
      setFileNaming(s.fileNaming);
      setPreventSleep(s.preventSleep);
      setTranslationEnabled(s.translationEnabled);
      setTranslationLanguage(s.translationLanguage);
      setTranslationLanguages(s.translationLanguages);
      setCachedModels(getCachedModels(provider));
      setSkippedModels(new Map(getSessionSkippedModels()));
      setAutoFreeModels(s.openrouterAutoFreeModels);
      setFreeOnlyFilter(true);
      // Load cached OpenRouter model data for pricing badges
      if (provider === 'openrouter') {
        const orProvider = getProvider('openrouter') as OpenRouterProvider;
        setOpenrouterModelData(orProvider._getCachedModels());
      }
    }
  }, [open]);

  async function handleRefreshModels() {
    const key = getApiKey(selectedProvider);
    if (!key) return;
    setRefreshing(true);
    const result = await validateAndFetchModels(selectedProvider, key);
    if (result.models.length > 0) {
      setCachedModels(result.models);
      setModelPriority(prev => {
        const stillAvailable = prev.filter(m => result.models.includes(m));
        return stillAvailable.length > 0 ? stillAvailable : [result.models[0]];
      });
    }
    setRefreshing(false);
  }

  function handleProviderChange(id: ProviderId) {
    // Save current model priority for the old provider before switching
    const settings = getSettings();
    const updatedPriority = { ...settings.providerModelPriority, [selectedProvider]: modelPriority };
    saveSettings({ providerModelPriority: updatedPriority });

    setSelectedProvider(id);
    const newPriority = updatedPriority[id] || PROVIDER_DEFAULT_MODELS[id] || [];
    setModelPriority(newPriority);
    setCachedModels(getCachedModels(id));

    // Load OpenRouter model data for pricing badges
    if (id === 'openrouter') {
      const orProvider = getProvider('openrouter') as OpenRouterProvider;
      setOpenrouterModelData(orProvider._getCachedModels());
    } else {
      setOpenrouterModelData([]);
    }
  }

  async function handleAutoFreeToggle(enabled: boolean) {
    setAutoFreeModels(enabled);
    if (enabled && selectedProvider === 'openrouter') {
      const key = getApiKey('openrouter');
      if (!key) return;
      setRefreshing(true);
      const orProvider = getProvider('openrouter') as OpenRouterProvider;
      const topFree = await orProvider.getTopFreeModels(key);
      if (topFree.length > 0) {
        setModelPriority(topFree);
        setOpenrouterModelData(orProvider._getCachedModels());
        setCachedModels(topFree);
      }
      setRefreshing(false);
    }
  }

  if (!open) return null;

  const defaultModels = PROVIDER_DEFAULT_MODELS[selectedProvider] || [];
  const availableModels = cachedModels.length > 0 ? cachedModels : defaultModels;
  // Include any models from priority that aren't in the available list (e.g. deprecated)
  const allModels = [...new Set([...modelPriority, ...availableModels])];
  const unselected = allModels.filter(m => !modelPriority.includes(m));

  // For OpenRouter: optionally filter unselected to free-only
  const filteredUnselected = (selectedProvider === 'openrouter' && freeOnlyFilter && !autoFreeModels)
    ? unselected.filter(m => {
        const data = openrouterModelData.find(d => d.id === m);
        return data?.isFree ?? false;
      })
    : unselected;

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
    const settings = getSettings();
    const providerModelPriority = { ...settings.providerModelPriority, [selectedProvider]: modelPriority };
    saveSettings({ activeProvider: selectedProvider, providerModelPriority, openrouterAutoFreeModels: autoFreeModels, batchSize, outputNotes, autoExportFormats, fileNaming, preventSleep, translationEnabled, translationLanguage, translationLanguages });
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
          {/* Active Provider */}
          <div>
            <label className="block text-sm font-medium text-p-text mb-1.5">Active provider</label>
            <div className="flex gap-1.5">
              {getAllProviders().map(p => {
                const isSelected = p.id === selectedProvider;
                const keyConfigured = hasApiKey(p.id);
                return (
                  <button
                    key={p.id}
                    onClick={() => handleProviderChange(p.id)}
                    disabled={!keyConfigured}
                    className={`flex-1 px-3 py-2 text-xs rounded-lg border tab-transition ${
                      isSelected
                        ? 'border-p-accent bg-p-accent/10 text-p-accent font-medium'
                        : keyConfigured
                          ? 'border-p-border bg-p-bg text-p-text-muted hover:text-p-text hover:border-p-accent/50'
                          : 'border-p-border bg-p-bg text-p-text-dim/50 cursor-not-allowed'
                    }`}
                    title={keyConfigured ? undefined : `Configure ${p.displayName} API key first`}
                  >
                    {p.displayName}
                    {!keyConfigured && <span className="block text-[10px] text-p-text-dim/40 mt-0.5">No key</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Model Priority */}
          <div className="border-t border-p-border pt-4">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-1.5">
                <label className="text-sm font-medium text-p-text">Model priority</label>
                <span
                  title="Models are tried in order during conversion. If one fails, the next is used."
                  className="text-p-text-dim hover:text-p-text cursor-help"
                >
                  <Info className="w-3.5 h-3.5" />
                </span>
              </div>
              <button
                onClick={handleRefreshModels}
                disabled={refreshing || !getApiKey(selectedProvider)}
                className="flex items-center gap-1 text-xs text-p-text-dim hover:text-p-text disabled:opacity-30 tab-transition"
                title="Refresh model list"
              >
                <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
                {refreshing ? 'Refreshing...' : 'Refresh'}
              </button>
            </div>

            {/* OpenRouter-specific controls */}
            {selectedProvider === 'openrouter' && (
              <div className="space-y-1.5 mb-2">
                <label className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-p-surface-hover cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoFreeModels}
                    onChange={e => handleAutoFreeToggle(e.target.checked)}
                    className="shrink-0 accent-p-accent"
                  />
                  <span className="text-xs text-p-text">Auto-select top free models</span>
                  <span
                    title="When enabled, the model list is automatically updated with the most popular free models on app startup."
                    className="text-p-text-dim hover:text-p-text cursor-help"
                  >
                    <Info className="w-3 h-3" />
                  </span>
                </label>
                {!autoFreeModels && (
                  <label className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-p-surface-hover cursor-pointer">
                    <input
                      type="checkbox"
                      checked={freeOnlyFilter}
                      onChange={e => setFreeOnlyFilter(e.target.checked)}
                      className="shrink-0 accent-p-accent"
                    />
                    <span className="text-xs text-p-text">Show free models only</span>
                  </label>
                )}
                {autoFreeModels && (
                  <p className="text-[10px] text-p-text-dim/60 px-2">
                    Models are auto-managed. Turn off to customize manually.
                  </p>
                )}
              </div>
            )}

            <p className="text-xs text-p-text-dim mb-1.5">
              {selectedProvider === 'openrouter' && autoFreeModels
                ? 'Auto-managed: top free vision models from OpenRouter.'
                : 'Models are tried in order during conversion. If one fails, the next is used. Drag to reorder.'}
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
                      skipReason={skippedModels.get(model)}
                      pricingBadge={getPricingBadge(model, openrouterModelData)}
                    />
                  ))}
                </SortableContext>
              </DndContext>

              {/* Unselected models — static, with optional free filter */}
              {filteredUnselected.length > 0 && (
                <>
                  {modelPriority.length > 0 && (
                    <div className="border-t border-p-border-subtle" />
                  )}
                  {filteredUnselected.map(model => (
                    <div
                      key={model}
                      className="flex items-center gap-2 px-2 py-1.5 hover:bg-p-surface-hover"
                    >
                      <div className="w-3.5 shrink-0" />
                      <input
                        type="checkbox"
                        checked={false}
                        onChange={() => toggleModel(model)}
                        className="shrink-0 accent-p-accent"
                      />
                      <span className="flex-1 text-sm text-p-text-muted truncate">{model}</span>
                      {getPricingBadge(model, openrouterModelData)}
                      {skippedModels.has(model) && <SkippedBadge reason={skippedModels.get(model)!} />}
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>

          {/* Batch size */}
          <div className="border-t border-p-border pt-4">
            <label className="block text-sm font-medium text-p-text mb-1.5">Batch size</label>
            <select
              value={batchSize}
              onChange={(e) => setBatchSize(Number(e.target.value))}
              className="w-full rounded-lg border border-p-border bg-p-bg px-3 py-2 text-sm text-p-text tab-transition focus:outline-none focus:border-p-accent"
            >
              {[1, 2, 3, 5, 10, 15, 20].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>

          {/* Auto-export formats */}
          <div className="border-t border-p-border pt-4">
            <label className="block text-sm font-medium text-p-text mb-1">Auto-export formats</label>
            <p className="text-xs text-p-text-dim mb-2">
              Choose which file formats are saved automatically after conversion. Markdown is always stored internally for re-export.
            </p>
            <div className="space-y-1.5">
              {([
                ['md', 'Markdown (.md)'],
                ['html', 'HTML (.html)'],
                ['docx', 'Word (.docx)'],
                ['docx-logos', 'Word \u2014 Logos/Verbum (.docx)'],
              ] as const).map(([fmt, label]) => {
                const checked = autoExportFormats.includes(fmt);
                const isLast = checked && autoExportFormats.length === 1;
                return (
                  <label key={fmt} className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-p-surface-hover cursor-pointer">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={isLast}
                      onChange={() => {
                        setAutoExportFormats(prev =>
                          prev.includes(fmt)
                            ? prev.filter(f => f !== fmt)
                            : [...prev, fmt],
                        );
                      }}
                      className="shrink-0 accent-p-accent"
                      title={isLast ? 'At least one format must be selected' : undefined}
                    />
                    <span className="text-sm text-p-text">{label}</span>
                  </label>
                );
              })}
            </div>

            <label className="block text-sm font-medium text-p-text mt-3 mb-1.5">If file already exists</label>
            <select
              value={fileNaming}
              onChange={(e) => setFileNaming(e.target.value as FileNaming)}
              className="w-full rounded-lg border border-p-border bg-p-bg px-3 py-2 text-sm text-p-text tab-transition focus:outline-none focus:border-p-accent"
            >
              <option value="overwrite">Overwrite existing file</option>
              <option value="unique">Create new file with number suffix</option>
            </select>
          </div>

          {/* Prevent sleep */}
          <div className="border-t border-p-border pt-4">
            <label className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-p-surface-hover cursor-pointer">
              <input
                type="checkbox"
                checked={preventSleep}
                onChange={(e) => setPreventSleep(e.target.checked)}
                className="shrink-0 accent-p-accent"
              />
              <span className="text-sm font-medium text-p-text">Prevent sleep during conversion</span>
            </label>
            <p className="text-xs text-p-text-dim mt-1 px-2">
              Keeps your computer awake while transcriptions are running. Useful for long jobs when you'll be away. The display will also stay on.
            </p>
          </div>

          {/* Custom instructions */}
          <div className="border-t border-p-border pt-4">
            <label className="block text-sm font-medium text-p-text mb-1.5">Custom instructions</label>
            <textarea
              value={outputNotes}
              onChange={(e) => setOutputNotes(e.target.value)}
              placeholder="Additional instructions appended to the AI prompt (optional)"
              rows={3}
              className="w-full rounded-lg border border-p-border bg-p-bg px-3 py-2 text-sm text-p-text placeholder:text-p-text-dim tab-transition focus:outline-none focus:border-p-accent resize-none"
            />
          </div>

          {/* Translation */}
          <div className="border-t border-p-border pt-4">
            <label className="block text-sm font-medium text-p-text mb-1">Translation languages</label>
            <p className="text-xs text-p-text-dim mb-2">
              Manage the languages available in the translation selector. Toggle translation on/off in the drop zone above the queue.
            </p>
            <div className="rounded-lg border border-p-border bg-p-bg-deep overflow-y-auto max-h-36">
              {translationLanguages.map(lang => (
                <div key={lang} className="flex items-center justify-between px-2 py-1.5 hover:bg-p-surface-hover">
                  <span className="text-sm text-p-text">{lang}</span>
                  <button
                    onClick={() => setTranslationLanguages(prev => prev.filter(l => l !== lang))}
                    className="text-xs text-p-text-dim hover:text-p-error px-1"
                    title="Remove language"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
              {translationLanguages.length === 0 && (
                <p className="text-xs text-p-text-dim px-2 py-2">No languages configured.</p>
              )}
            </div>
            <div className="flex items-center gap-2 mt-2">
              <input
                type="text"
                value={newLanguage}
                onChange={e => setNewLanguage(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && newLanguage.trim()) {
                    const lang = newLanguage.trim();
                    if (!translationLanguages.includes(lang)) {
                      setTranslationLanguages(prev => [...prev, lang]);
                    }
                    setNewLanguage('');
                  }
                }}
                placeholder="Add a language..."
                className="flex-1 rounded-lg border border-p-border bg-p-bg px-3 py-1.5 text-sm text-p-text placeholder:text-p-text-dim focus:outline-none focus:border-p-accent"
              />
              <button
                onClick={() => {
                  const lang = newLanguage.trim();
                  if (lang && !translationLanguages.includes(lang)) {
                    setTranslationLanguages(prev => [...prev, lang]);
                  }
                  setNewLanguage('');
                }}
                disabled={!newLanguage.trim()}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-p-accent/10 text-p-accent hover:bg-p-accent/20 disabled:opacity-30 tab-transition"
              >
                Add
              </button>
              {translationLanguages.length !== DEFAULT_TRANSLATION_LANGUAGES.length && (
                <button
                  onClick={() => setTranslationLanguages([...DEFAULT_TRANSLATION_LANGUAGES])}
                  className="px-3 py-1.5 rounded-lg text-xs text-p-text-dim hover:text-p-text hover:bg-p-surface-hover tab-transition"
                >
                  Reset
                </button>
              )}
            </div>
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
