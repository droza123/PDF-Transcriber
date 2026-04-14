import { useState, useEffect } from 'react';
import { X, GripVertical, RefreshCw, Info, Eye, EyeOff, Trash2, ExternalLink, Loader2, CheckCircle2, AlertTriangle, Cpu, FileOutput, SlidersHorizontal, ArrowRight } from 'lucide-react';
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getSettings, saveSettings, initializeModelPriority, PROVIDER_DEFAULT_MODELS, DEFAULT_TRANSLATION_LANGUAGES, getSessionSkippedModels, CUSTOM_PRESETS, type ExportFormat, type FileNaming, type CustomConfig, type CustomPdfMode } from '../lib/settings';
import { getCachedModels, getApiKey, setApiKey, clearApiKey, hasApiKey, validateAndFetchModels, getCustomConfigApiKey, setCustomConfigApiKey, clearCustomConfigApiKey } from '../lib/apiKey';
import { getAllProviders, getProvider } from '../lib/providers/registry';
import type { ProviderId, ProviderModel } from '../lib/providers/types';
import { OpenRouterProvider } from '../lib/providers/openrouter';

interface SettingsProps {
  open: boolean;
  onClose: () => void;
  /** If set, override the initially-selected provider tab when the modal opens. */
  initialProvider?: ProviderId | null;
}

/** Returns a React element showing pricing info for a model, or null. */
function getPricingBadge(modelId: string, modelData: ProviderModel[]): React.ReactNode {
  const data = modelData.find(m => m.id === modelId);
  if (!data) return null;
  if (data.isFree) {
    return (
      <span className="badge badge-free shrink-0">
        Free
      </span>
    );
  }
  if (data.pricePerMTokens != null && data.pricePerMTokens > 0) {
    const price = data.pricePerMTokens < 1
      ? `$${data.pricePerMTokens.toFixed(2)}/M`
      : `$${data.pricePerMTokens.toFixed(0)}/M`;
    return (
      <span className="badge text-p-text-dim bg-p-surface-hover shrink-0">
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
      className="badge badge-warning shrink-0 cursor-help"
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
  onDelete,
}: {
  model: string;
  index: number;
  onToggle: (model: string) => void;
  canRemove: boolean;
  skipReason?: string;
  pricingBadge?: React.ReactNode;
  onDelete?: (model: string) => void;
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
      {!onDelete && (
        <input
          type="checkbox"
          checked
          onChange={() => canRemove && onToggle(model)}
          className="shrink-0 accent-p-accent"
          title={canRemove ? 'Deselect model' : 'At least one model must be selected'}
        />
      )}
      <span className="flex-1 text-sm text-p-text truncate">{model}</span>
      {pricingBadge}
      {skipReason && <SkippedBadge reason={skipReason} />}
      <span className="badge badge-accent shrink-0">
        {index + 1}
      </span>
      {onDelete && (
        <button
          onClick={() => onDelete(model)}
          className="text-p-text-dim hover:text-p-error shrink-0 opacity-0 group-hover:opacity-100 tab-transition"
          title="Remove model"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

type SettingsTab = 'provider' | 'output' | 'advanced';

export default function Settings({ open, onClose, initialProvider }: SettingsProps) {
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('provider');
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>('gemini');
  const [modelPriority, setModelPriority] = useState<string[]>([]);
  const [batchSize, setBatchSize] = useState(10);
  const [outputNotes, setOutputNotes] = useState('');
  const [autoExportFormats, setAutoExportFormats] = useState<ExportFormat[]>(['md']);
  const [fileNaming, setFileNaming] = useState<FileNaming>('overwrite');
  const [preventSleep, setPreventSleep] = useState(false);
  const [headingCleanupEnabled, setHeadingCleanupEnabled] = useState(true);
  const [translationEnabled, setTranslationEnabled] = useState(false);
  const [translationLanguage, setTranslationLanguage] = useState('');
  const [translationLanguages, setTranslationLanguages] = useState<string[]>([]);
  const [newLanguage, setNewLanguage] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [cachedModels, setCachedModels] = useState<string[]>([]);
  const [skippedModels, setSkippedModels] = useState<ReadonlyMap<string, string>>(new Map());
  // API key input
  const [editingKey, setEditingKey] = useState(false);
  const [keyValue, setKeyValue] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<'success' | 'error' | null>(null);
  const [validationError, setValidationError] = useState('');
  // OpenRouter-specific
  const [autoFreeModels, setAutoFreeModels] = useState(true);
  const [freeOnlyFilter, setFreeOnlyFilter] = useState(true);
  const [openrouterModelData, setOpenrouterModelData] = useState<ProviderModel[]>([]);
  const [exportTranscription, setExportTranscription] = useState(true);
  // Custom provider config
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [customModels, setCustomModels] = useState<string[]>([]);
  const [newCustomModel, setNewCustomModel] = useState('');
  const [customConnected, setCustomConnected] = useState(false);
  const [customActiveConfigId, setCustomActiveConfigId] = useState('manual');
  const [customSavedConfigs, setCustomSavedConfigs] = useState<CustomConfig[]>([]);
  const [savingConfig, setSavingConfig] = useState(false);
  const [saveConfigName, setSaveConfigName] = useState('');
  const [customPdfMode, setCustomPdfMode] = useState<CustomPdfMode>('images');
  // Role assignment
  const [scanProvider, setScanProviderState] = useState<ProviderId>('gemini');
  const [transcribeProvider, setTranscribeProviderState] = useState<ProviderId>('gemini');
  const [translateProvider, setTranslateProviderState] = useState<ProviderId>('gemini');

  useEffect(() => {
    if (open) {
      setSettingsTab('provider');
      const s = getSettings();
      setScanProviderState(s.scanProvider || s.activeProvider);
      setTranscribeProviderState(s.transcribeProvider || s.activeProvider);
      setTranslateProviderState(s.translateProvider || s.activeProvider);
      const provider = initialProvider || s.transcribeProvider || s.activeProvider;
      setSelectedProvider(provider);
      setModelPriority(s.providerModelPriority[provider] || []);
      setBatchSize(s.batchSize);
      setOutputNotes(s.outputNotes);
      setAutoExportFormats(s.autoExportFormats);
      setFileNaming(s.fileNaming);
      setPreventSleep(s.preventSleep);
      setHeadingCleanupEnabled(s.headingCleanupEnabled);
      setTranslationEnabled(s.translationEnabled);
      setTranslationLanguage(s.translationLanguage);
      setTranslationLanguages(s.translationLanguages);
      setCachedModels(getCachedModels(provider));
      setSkippedModels(new Map(getSessionSkippedModels()));
      setAutoFreeModels(s.openrouterAutoFreeModels);
      setExportTranscription(s.exportTranscriptionWithTranslation);
      setFreeOnlyFilter(true);
      setCustomBaseUrl(s.customBaseUrl || 'http://localhost:11434/v1');
      setCustomModels(s.customModels || []);
      setCustomConnected((s.customModels || []).length > 0);
      setCustomActiveConfigId(s.customActiveConfigId || 'manual');
      setCustomSavedConfigs(s.customSavedConfigs || []);
      setSavingConfig(false);
      setSaveConfigName('');
      setCustomPdfMode(s.customPdfMode || 'images');
      // Reset key editing state
      setEditingKey(false);
      setKeyValue('');
      setShowKey(false);
      setValidationResult(null);
      setValidationError('');
      // Load cached OpenRouter model data for pricing badges
      if (provider === 'openrouter') {
        const orProvider = getProvider('openrouter') as OpenRouterProvider;
        setOpenrouterModelData(orProvider._getCachedModels());
      }
    }
  }, [open]);

  async function handleRefreshModels() {
    const key = selectedProvider === 'custom'
      ? getCustomConfigApiKey(customActiveConfigId)
      : getApiKey(selectedProvider);
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

  async function handleCustomConnect() {
    if (!customBaseUrl.trim()) return;
    // Only persist the URL for manual mode — presets/saved configs store their own URLs
    if (customActiveConfigId === 'manual') {
      saveSettings({ customBaseUrl: customBaseUrl.trim() });
    }
    setRefreshing(true);
    const provider = getProvider('custom');
    const key = getCustomConfigApiKey(customActiveConfigId) || '';
    const models = await provider.fetchModels(key);
    if (models.length > 0) {
      const ids = models.map(m => m.id);
      setCachedModels(ids);
      setModelPriority(ids);
      setCustomModels(ids);
      setCustomConnected(true);
      const settings = getSettings();
      saveSettings({
        customModels: ids,
        providerModelPriority: { ...settings.providerModelPriority, custom: ids },
      });
      // Also update saved config if one is active
      if (customActiveConfigId !== 'manual' && !CUSTOM_PRESETS.find(p => p.id === customActiveConfigId)) {
        const updated = customSavedConfigs.map(c =>
          c.id === customActiveConfigId ? { ...c, models: ids } : c,
        );
        setCustomSavedConfigs(updated);
        saveSettings({ customSavedConfigs: updated });
      }
    }
    setRefreshing(false);
  }

  function handleCustomConfigSwitch(configId: string) {
    // Save current state if in manual mode
    if (customActiveConfigId === 'manual') {
      saveSettings({ customBaseUrl, customModels });
    }

    setCustomActiveConfigId(configId);
    saveSettings({ customActiveConfigId: configId });

    // Load the new config's state
    if (configId === 'manual') {
      const s = getSettings();
      setCustomBaseUrl(s.customBaseUrl || 'http://localhost:11434/v1');
      const models = s.customModels || [];
      setCustomModels(models);
      setModelPriority(s.providerModelPriority.custom || []);
      setCustomConnected(models.length > 0);
      setCustomPdfMode(s.customPdfMode || 'images');
    } else {
      // Preset or saved config — load its values into local state for display
      // but do NOT write them into the manual config settings (customBaseUrl etc.)
      // so that manual mode retains its own independent values.
      const preset = CUSTOM_PRESETS.find(p => p.id === configId);
      const saved = customSavedConfigs.find(c => c.id === configId);
      setCustomBaseUrl(preset?.baseUrl || saved?.baseUrl || '');
      setCustomPdfMode(preset?.pdfMode || saved?.pdfMode || 'images');

      if (saved) {
        setCustomModels(saved.models);
        setModelPriority(saved.models);
        const settings = getSettings();
        saveSettings({ providerModelPriority: { ...settings.providerModelPriority, custom: saved.models } });
        setCustomConnected(saved.models.length > 0);
      } else {
        // Built-in preset — keep existing models or empty
        setCustomConnected(false);
      }
    }

    // Reset key state on config switch
    setEditingKey(false);
    setKeyValue('');
    setValidationResult(null);
  }

  function handlePdfModeChange(mode: CustomPdfMode) {
    if (customActiveConfigId === 'manual') {
      saveSettings({ customPdfMode: mode });
    } else if (!CUSTOM_PRESETS.find(p => p.id === customActiveConfigId)) {
      // Saved config — persist into its pdfMode field
      const updated = customSavedConfigs.map(c =>
        c.id === customActiveConfigId ? { ...c, pdfMode: mode } : c,
      );
      setCustomSavedConfigs(updated);
      saveSettings({ customSavedConfigs: updated });
    }
    // For built-in presets: only local state changes (resets on config switch)
  }

  function handleSaveConfig() {
    const name = saveConfigName.trim();
    if (!name) return;
    const id = Date.now().toString(36);
    const newConfig: CustomConfig = {
      id,
      name,
      baseUrl: customBaseUrl,
      models: [...customModels],
      pdfMode: customPdfMode,
    };

    // Copy current API key to the new config's key slot
    const currentKey = getCustomConfigApiKey('manual');
    if (currentKey) {
      setCustomConfigApiKey(id, currentKey);
    }

    const updated = [...customSavedConfigs, newConfig];
    setCustomSavedConfigs(updated);
    saveSettings({ customSavedConfigs: updated });
    setSavingConfig(false);
    setSaveConfigName('');

    // Switch to the new saved config
    handleCustomConfigSwitch(id);
  }

  function handleDeleteSavedConfig(configId: string) {
    clearCustomConfigApiKey(configId);
    const updated = customSavedConfigs.filter(c => c.id !== configId);
    setCustomSavedConfigs(updated);
    saveSettings({ customSavedConfigs: updated });
    if (customActiveConfigId === configId) {
      handleCustomConfigSwitch('manual');
    }
  }

  function handleProviderChange(id: ProviderId) {
    // Save current model priority for the old provider (config tab only — no longer sets activeProvider)
    const settings = getSettings();
    const updatedPriority = { ...settings.providerModelPriority, [selectedProvider]: modelPriority };
    saveSettings({ providerModelPriority: updatedPriority });

    setSelectedProvider(id);
    const newPriority = updatedPriority[id] || PROVIDER_DEFAULT_MODELS[id] || [];
    setModelPriority(newPriority);
    setCachedModels(getCachedModels(id));
    // Reset key editing state on provider switch
    setEditingKey(false);
    setKeyValue('');
    setValidationResult(null);
    setValidationError('');

    // Load OpenRouter model data for pricing badges
    if (id === 'openrouter') {
      const orProvider = getProvider('openrouter') as OpenRouterProvider;
      setOpenrouterModelData(orProvider._getCachedModels());
    } else {
      setOpenrouterModelData([]);
    }

    // Load custom provider config
    if (id === 'custom') {
      const s = getSettings();
      setCustomBaseUrl(s.customBaseUrl || 'http://localhost:11434/v1');
      setCustomModels(s.customModels || []);
      setCustomActiveConfigId(s.customActiveConfigId || 'manual');
      setCustomSavedConfigs(s.customSavedConfigs || []);
    }
  }

  async function handleAutoFreeToggle(enabled: boolean) {
    setAutoFreeModels(enabled);
    saveSettings({ openrouterAutoFreeModels: enabled });
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
        const settings = getSettings();
        saveSettings({ providerModelPriority: { ...settings.providerModelPriority, openrouter: topFree } });
      }
      setRefreshing(false);
    }
  }

  async function handleKeySave() {
    const key = keyValue.trim();
    if (!key) return;
    setValidating(true);
    setValidationResult(null);
    setValidationError('');

    const result = await validateAndFetchModels(selectedProvider, key);
    if (result.valid) {
      // For custom provider, store key per-config
      if (selectedProvider === 'custom') {
        setCustomConfigApiKey(customActiveConfigId, key);
      } else {
        setApiKey(selectedProvider, key);
      }
      setKeyValue('');
      setEditingKey(false);
      setValidating(false);
      setValidationResult('success');
      if (result.models.length > 0) {
        initializeModelPriority(selectedProvider, result.models);
        setCachedModels(result.models);
        // Refresh model priority from what was just initialized
        const s = getSettings();
        setModelPriority(s.providerModelPriority[selectedProvider] || result.models.slice(0, 5));
      }
      setTimeout(() => setValidationResult(null), 3000);
    } else {
      setValidating(false);
      setValidationResult('error');
      setValidationError(result.error || 'Invalid key');
    }
  }

  function handleKeyClear() {
    if (selectedProvider === 'custom') {
      clearCustomConfigApiKey(customActiveConfigId);
    } else {
      clearApiKey(selectedProvider);
    }
    setEditingKey(false);
    setKeyValue('');
    setValidationResult(null);
  }

  function deleteCustomModel(model: string) {
    setModelPriority(prev => {
      const next = prev.filter(m => m !== model);
      const nextCustom = customModels.filter(m => m !== model);
      setCustomModels(nextCustom);
      const settings = getSettings();
      saveSettings({
        customModels: nextCustom,
        providerModelPriority: { ...settings.providerModelPriority, custom: next },
      });
      return next;
    });
  }

  // Debounce outputNotes saves
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => saveSettings({ outputNotes }), 300);
    return () => clearTimeout(timer);
  }, [outputNotes]);

  // Debounce customBaseUrl saves (only in manual mode to avoid overwriting
  // the user's manual URL when a preset sets customBaseUrl state)
  useEffect(() => {
    if (!open || customActiveConfigId !== 'manual') return;
    const timer = setTimeout(() => saveSettings({ customBaseUrl }), 300);
    return () => clearTimeout(timer);
  }, [customBaseUrl, customActiveConfigId]);

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
      let next: string[];
      if (prev.includes(model)) {
        if (prev.length <= 1) return prev;
        next = prev.filter(m => m !== model);
      } else {
        next = [...prev, model];
      }
      const settings = getSettings();
      const save: Partial<typeof settings> = { providerModelPriority: { ...settings.providerModelPriority, [selectedProvider]: next } };
      if (selectedProvider === 'custom') {
        const nextCustom = next;
        setCustomModels(nextCustom);
        save.customModels = nextCustom;
      }
      saveSettings(save);
      return next;
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
        const settings = getSettings();
        saveSettings({ providerModelPriority: { ...settings.providerModelPriority, [selectedProvider]: updated } });
        return updated;
      });
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 modal-backdrop"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[90vh] rounded-xl bg-p-bg border border-p-border shadow-2xl p-6 overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-p-text" style={{ fontFamily: 'var(--font-display)' }}>Settings</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-p-text-dim hover:text-p-accent hover:bg-p-surface-hover tab-transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab bar */}
        <div className="flex items-center gap-5 border-b border-p-border-subtle mb-4">
          <button
            onClick={() => setSettingsTab('provider')}
            className={`tab-underline text-xs tab-transition flex items-center gap-1.5 ${
              settingsTab === 'provider' ? 'tab-underline-active' : 'text-p-text-dim hover:text-p-text'
            }`}
          >
            <Cpu className="w-3.5 h-3.5" />
            Provider
          </button>
          <button
            onClick={() => setSettingsTab('output')}
            className={`tab-underline text-xs tab-transition flex items-center gap-1.5 ${
              settingsTab === 'output' ? 'tab-underline-active' : 'text-p-text-dim hover:text-p-text'
            }`}
          >
            <FileOutput className="w-3.5 h-3.5" />
            Output
          </button>
          <button
            onClick={() => setSettingsTab('advanced')}
            className={`tab-underline text-xs tab-transition flex items-center gap-1.5 ${
              settingsTab === 'advanced' ? 'tab-underline-active' : 'text-p-text-dim hover:text-p-text'
            }`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            Advanced
          </button>
        </div>

        <div className="space-y-4">
          {/* ═══ PROVIDER TAB ═══ */}
          {settingsTab === 'provider' && <>
          {/* Provider & API Key */}
          <div>
            <label className="section-label block mb-1">Provider</label>
            <p className="text-xs text-p-text-dim mb-2">
              Free options are usually more than good enough for most documents.
            </p>
            <div className="flex gap-1.5 mb-3">
              {getAllProviders().map(p => {
                const isSelected = p.id === selectedProvider;
                const keyConfigured = hasApiKey(p.id);
                const roles: string[] = [];
                if (p.id === scanProvider) roles.push('S');
                if (p.id === transcribeProvider) roles.push('T');
                if (p.id === translateProvider) roles.push('Tr');
                return (
                  <button
                    key={p.id}
                    onClick={() => handleProviderChange(p.id)}
                    className={`flex-1 px-3 py-2.5 text-xs rounded-lg border tab-transition relative ${
                      isSelected
                        ? 'border-p-accent bg-p-accent/8 text-p-accent font-medium shadow-[0_0_0_1px_var(--p-accent-glow)]'
                        : 'border-p-border bg-p-bg text-p-text-muted hover:text-p-text hover:border-p-accent/40'
                    }`}
                  >
                    {p.displayName}
                    {keyConfigured && (
                      <span className="ml-1 text-p-success">&#x2713;</span>
                    )}
                    {roles.length > 0 && (
                      <span className="absolute -top-1.5 -right-1 text-[8px] font-bold text-p-accent bg-p-bg border border-p-accent/40 rounded px-0.5 leading-tight">
                        {roles.join('·')}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Role assignment */}
            <div className="flex gap-2 mb-3">
              {([
                ['scanProvider', 'Scan', scanProvider, (v: ProviderId) => { setScanProviderState(v); saveSettings({ scanProvider: v }); }],
                ['transcribeProvider', 'Transcribe', transcribeProvider, (v: ProviderId) => { setTranscribeProviderState(v); saveSettings({ transcribeProvider: v }); }],
                ['translateProvider', 'Translate', translateProvider, (v: ProviderId) => { setTranslateProviderState(v); saveSettings({ translateProvider: v }); }],
              ] as [string, string, ProviderId, (v: ProviderId) => void][]).map(([key, label, value, onChange]) => (
                <div key={key} className="flex-1">
                  <label className="text-[10px] text-p-text-dim block mb-0.5">{label}</label>
                  <select
                    value={value}
                    onChange={e => onChange(e.target.value as ProviderId)}
                    className="w-full px-2 py-1 text-xs rounded-md bg-p-bg border border-p-border text-p-text focus:border-p-accent focus:outline-none"
                  >
                    {getAllProviders().filter(p => hasApiKey(p.id)).map(p => (
                      <option key={p.id} value={p.id}>{p.displayName}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            {/* Provider description */}
            {(() => {
              const provider = getAllProviders().find(p => p.id === selectedProvider);
              if (!provider) return null;
              const descriptions: Record<ProviderId, string> = {
                gemini: 'Generous free tier with fast models optimized for PDFs. Recommended starting point.',
                openrouter: 'Access hundreds of models with one key. Many free models available \u2014 the app auto-selects the best ones.',
                anthropic: 'Premium quality output with native PDF support. Requires a paid API key.',
                openai: 'Direct access to OpenAI GPT and o-series models. Requires a paid API key.',
                mistral: 'Dedicated OCR model for accurate PDF extraction. Free tier limited to ~2 requests/minute.',
                custom: 'Connect to any OpenAI-compatible API (Ollama, LM Studio, etc.). Configure the endpoint and models below.',
              };
              return (
                <p className="text-xs text-p-text-dim mb-3">{descriptions[selectedProvider]}</p>
              );
            })()}

            {/* Custom provider config — shown before API key so user picks config first */}
            {selectedProvider === 'custom' && (
              <div className="section-divider space-y-3">
                {/* Config selector pills */}
                <div>
                  <label className="section-label block mb-1">Configuration</label>
                  <div className="flex flex-wrap gap-1.5">
                    {/* Manual option */}
                    <button
                      onClick={() => handleCustomConfigSwitch('manual')}
                      className={`px-2.5 py-1 text-xs rounded-md border tab-transition ${
                        customActiveConfigId === 'manual'
                          ? 'border-p-accent bg-p-accent/8 text-p-accent font-medium'
                          : 'border-p-border bg-p-bg text-p-text-muted hover:text-p-text hover:border-p-accent/40'
                      }`}
                    >
                      Manual
                    </button>
                    {/* Built-in presets */}
                    {CUSTOM_PRESETS.map(preset => (
                      <button
                        key={preset.id}
                        onClick={() => handleCustomConfigSwitch(preset.id)}
                        className={`px-2.5 py-1 text-xs rounded-md border tab-transition ${
                          customActiveConfigId === preset.id
                            ? 'border-p-accent bg-p-accent/8 text-p-accent font-medium'
                            : 'border-p-border bg-p-bg text-p-text-muted hover:text-p-text hover:border-p-accent/40'
                        }`}
                      >
                        {preset.name}
                      </button>
                    ))}
                    {/* User-saved configs */}
                    {customSavedConfigs.map(cfg => (
                      <div key={cfg.id} className="flex items-center gap-0.5">
                        <button
                          onClick={() => handleCustomConfigSwitch(cfg.id)}
                          className={`px-2.5 py-1 text-xs rounded-l-md border tab-transition ${
                            customActiveConfigId === cfg.id
                              ? 'border-p-accent bg-p-accent/8 text-p-accent font-medium'
                              : 'border-p-border bg-p-bg text-p-text-muted hover:text-p-text hover:border-p-accent/40'
                          }`}
                        >
                          {cfg.name}
                        </button>
                        <button
                          onClick={() => handleDeleteSavedConfig(cfg.id)}
                          className="px-1 py-1 text-xs rounded-r-md border border-l-0 border-p-border bg-p-bg text-p-text-dim hover:text-p-error hover:border-p-error/40 tab-transition"
                          title="Delete saved configuration"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Base URL */}
                <div>
                  <label className="section-label block mb-1">Base URL</label>
                  {customActiveConfigId === 'manual' ? (
                    <>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={customBaseUrl}
                          onChange={e => setCustomBaseUrl(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && handleCustomConnect()}
                          placeholder="http://localhost:11434/v1"
                          className="flex-1 input-base"
                        />
                        <button
                          onClick={handleCustomConnect}
                          disabled={refreshing || !customBaseUrl.trim()}
                          className="p-2 rounded-lg bg-p-accent/12 text-p-accent hover:bg-p-accent/20 disabled:opacity-30 tab-transition"
                          title="Connect and fetch models"
                        >
                          {refreshing ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                        </button>
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <p className="text-[10px] text-p-text-dim/60">
                          Ollama: localhost:11434/v1 &middot; LM Studio: localhost:1234/v1
                        </p>
                        {customConnected && (
                          <span className="text-xs text-p-success flex items-center gap-1 shrink-0">
                            <CheckCircle2 className="w-3 h-3" /> Connected
                          </span>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="flex-1 px-3 py-2 text-sm font-mono rounded-lg bg-p-bg-deep border border-p-border text-p-text-muted truncate">
                        {(() => {
                          const preset = CUSTOM_PRESETS.find(p => p.id === customActiveConfigId);
                          if (preset) return preset.baseUrl;
                          const saved = customSavedConfigs.find(c => c.id === customActiveConfigId);
                          return saved?.baseUrl || '';
                        })()}
                      </span>
                      <button
                        onClick={handleCustomConnect}
                        disabled={refreshing}
                        className="p-2 rounded-lg bg-p-accent/12 text-p-accent hover:bg-p-accent/20 disabled:opacity-30 tab-transition"
                        title="Connect and fetch models"
                      >
                        {refreshing ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                      </button>
                      {customConnected && (
                        <span className="text-xs text-p-success flex items-center gap-1 shrink-0">
                          <CheckCircle2 className="w-3 h-3" /> Connected
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* Save configuration (manual mode only) */}
                {customActiveConfigId === 'manual' && customModels.length > 0 && (
                  <div>
                    {savingConfig ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={saveConfigName}
                          onChange={e => setSaveConfigName(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter' && saveConfigName.trim()) handleSaveConfig(); if (e.key === 'Escape') setSavingConfig(false); }}
                          placeholder="Configuration name..."
                          className="flex-1 input-base py-1.5"
                          autoFocus
                        />
                        <button
                          onClick={handleSaveConfig}
                          disabled={!saveConfigName.trim()}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-p-accent/12 text-p-accent hover:bg-p-accent/20 disabled:opacity-30 tab-transition"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => setSavingConfig(false)}
                          className="p-1.5 rounded-lg text-p-text-muted hover:bg-p-surface-hover tab-transition"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setSavingConfig(true)}
                        className="text-xs text-p-accent hover:text-p-accent-bright tab-transition"
                      >
                        Save current configuration...
                      </button>
                    )}
                  </div>
                )}

                {/* PDF input mode */}
                <div>
                  <label className="section-label block mb-1">PDF input mode</label>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => { setCustomPdfMode('images'); handlePdfModeChange('images'); }}
                      className={`flex-1 px-2.5 py-1.5 text-xs rounded-lg border tab-transition ${
                        customPdfMode === 'images'
                          ? 'border-p-accent bg-p-accent/8 text-p-accent font-medium'
                          : 'border-p-border bg-p-bg text-p-text-muted hover:text-p-text hover:border-p-accent/40'
                      }`}
                    >
                      Page images
                    </button>
                    <button
                      onClick={() => { setCustomPdfMode('pdf'); handlePdfModeChange('pdf'); }}
                      className={`flex-1 px-2.5 py-1.5 text-xs rounded-lg border tab-transition ${
                        customPdfMode === 'pdf'
                          ? 'border-p-accent bg-p-accent/8 text-p-accent font-medium'
                          : 'border-p-border bg-p-bg text-p-text-muted hover:text-p-text hover:border-p-accent/40'
                      }`}
                    >
                      PDF document
                    </button>
                  </div>
                  <p className="text-[10px] text-p-text-dim/60 mt-1">
                    {customPdfMode === 'images'
                      ? 'Renders each page as an image. Works with most local servers (Ollama, LM Studio).'
                      : 'Sends the PDF file directly. Use for cloud APIs that accept PDF input (Groq, etc.).'}
                  </p>
                </div>
              </div>
            )}

            {/* API Key input */}
            {(() => {
              const currentKey = selectedProvider === 'custom'
                ? getCustomConfigApiKey(customActiveConfigId)
                : getApiKey(selectedProvider);
              const maskedKey = currentKey ? '\u2022\u2022\u2022\u2022\u2022\u2022' + currentKey.slice(-4) : null;
              const provider = getAllProviders().find(p => p.id === selectedProvider);
              // For custom presets, override help steps from the preset
              const activePreset = selectedProvider === 'custom'
                ? CUSTOM_PRESETS.find(p => p.id === customActiveConfigId)
                : null;
              const helpSteps = activePreset ? activePreset.keyHelpSteps : provider?.keyHelpSteps;
              const helpUrl = activePreset ? activePreset.keyHelpUrl : provider?.keyHelpUrl;

              if (editingKey) {
                return (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <div className="relative flex-1">
                        <input
                          type={showKey ? 'text' : 'password'}
                          value={keyValue}
                          onChange={e => { setKeyValue(e.target.value); setValidationResult(null); }}
                          onKeyDown={e => e.key === 'Enter' && !validating && handleKeySave()}
                          placeholder={provider?.keyPlaceholder ?? 'Paste your API key'}
                          className="w-full px-3 py-2 pr-8 text-sm font-mono rounded-lg bg-p-bg border border-p-border text-p-text placeholder:text-p-text-dim focus:outline-none focus:border-p-accent focus:shadow-[0_0_0_3px_var(--p-accent-glow)]"
                          autoFocus
                          disabled={validating}
                        />
                        <button
                          onClick={() => setShowKey(!showKey)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-p-text-dim hover:text-p-text"
                        >
                          {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                      <button
                        onClick={handleKeySave}
                        disabled={!keyValue.trim() || validating}
                        className="p-2 rounded-lg bg-p-success/20 text-p-success hover:bg-p-success/30 disabled:opacity-30 tab-transition"
                      >
                        {validating ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                      </button>
                      <button
                        onClick={() => { setEditingKey(false); setKeyValue(''); setValidationResult(null); }}
                        disabled={validating}
                        className="p-2 rounded-lg text-p-text-muted hover:bg-p-surface-hover tab-transition"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    {validationResult === 'error' && (
                      <p className="text-xs text-p-error flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" /> {validationError}
                      </p>
                    )}
                  </div>
                );
              }

              if (currentKey) {
                return (
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-p-text-dim">{maskedKey}</span>
                    {validationResult === 'success' ? (
                      <span className="text-xs text-p-success flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" /> Verified
                      </span>
                    ) : (
                      <span className="text-xs text-p-success">Configured</span>
                    )}
                    <button
                      onClick={() => { setEditingKey(true); setKeyValue(''); setValidationResult(null); }}
                      className="text-xs px-2 py-1 rounded bg-p-surface-hover text-p-text-muted hover:text-p-text tab-transition"
                    >
                      Change
                    </button>
                    <button
                      onClick={handleKeyClear}
                      className="text-xs px-2 py-1 rounded text-p-error hover:bg-p-surface-hover tab-transition"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              }

              // No key — show setup instructions
              return (
                <div className="space-y-2">
                  <button
                    onClick={() => setEditingKey(true)}
                    className="btn-primary text-sm py-1.5"
                  >
                    Enter API Key
                  </button>
                  {helpSteps && (
                    <div className="text-xs text-p-text-dim leading-relaxed space-y-1">
                      <ol className="list-decimal list-inside space-y-0.5 pl-1">
                        {helpSteps.map((step, i) => (
                          <li key={i}>
                            {i === 0 && helpUrl ? (
                              <>
                                Go to{' '}
                                <a
                                  href={helpUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-p-accent hover:text-p-accent-bright inline-flex items-center gap-0.5"
                                >
                                  {step} <ExternalLink className="w-3 h-3 inline" />
                                </a>
                              </>
                            ) : (
                              step
                            )}
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          {/* Model Priority */}
          <div className="section-divider">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-1.5">
                <label className="section-label">Model priority</label>
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
                      onDelete={selectedProvider === 'custom' ? deleteCustomModel : undefined}
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

            {/* Add model input for custom provider */}
            {selectedProvider === 'custom' && (
              <div className="flex items-center gap-2 mt-2">
                <input
                  type="text"
                  value={newCustomModel}
                  onChange={e => setNewCustomModel(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && newCustomModel.trim()) {
                      const name = newCustomModel.trim();
                      if (!modelPriority.includes(name)) {
                        const next = [...modelPriority, name];
                        setModelPriority(next);
                        setCustomModels(next);
                        const settings = getSettings();
                        saveSettings({
                          customModels: next,
                          providerModelPriority: { ...settings.providerModelPriority, custom: next },
                        });
                      }
                      setNewCustomModel('');
                    }
                  }}
                  placeholder="Add a model name..."
                  className="flex-1 input-base py-1.5"
                />
                <button
                  onClick={() => {
                    const name = newCustomModel.trim();
                    if (name && !modelPriority.includes(name)) {
                      const next = [...modelPriority, name];
                      setModelPriority(next);
                      setCustomModels(next);
                      const settings = getSettings();
                      saveSettings({
                        customModels: next,
                        providerModelPriority: { ...settings.providerModelPriority, custom: next },
                      });
                    }
                    setNewCustomModel('');
                  }}
                  disabled={!newCustomModel.trim()}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-p-accent/12 text-p-accent hover:bg-p-accent/20 disabled:opacity-30 tab-transition"
                >
                  Add
                </button>
              </div>
            )}
          </div>

          </>}

          {/* ═══ OUTPUT TAB ═══ */}
          {settingsTab === 'output' && <>
          {/* Batch size */}
          <div>
            <label className="section-label block mb-1.5">Batch size</label>
            <select
              value={batchSize}
              onChange={(e) => { const n = Number(e.target.value); setBatchSize(n); saveSettings({ batchSize: n }); }}
              className="input-base"
            >
              {[1, 2, 3, 5, 10, 15, 20].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>

          {/* Auto-export formats */}
          <div className="section-divider">
            <label className="section-label block mb-1">Auto-export formats</label>
            <p className="text-xs text-p-text-dim mb-2">
              Choose which file formats are saved automatically after conversion. Markdown is always stored internally for re-export.
            </p>
            <div className="space-y-1.5">
              {([
                ['md', 'Markdown (.md)'],
                ['html', 'HTML (.html)'],
                ['json', 'JSON (.json)'],
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
                        setAutoExportFormats(prev => {
                          const next = prev.includes(fmt)
                            ? prev.filter(f => f !== fmt)
                            : [...prev, fmt];
                          saveSettings({ autoExportFormats: next });
                          return next;
                        });
                      }}
                      className="shrink-0 accent-p-accent"
                      title={isLast ? 'At least one format must be selected' : undefined}
                    />
                    <span className="text-sm text-p-text">{label}</span>
                  </label>
                );
              })}
            </div>

            <label className="section-label block mt-3 mb-1.5">If file already exists</label>
            <select
              value={fileNaming}
              onChange={(e) => { const v = e.target.value as FileNaming; setFileNaming(v); saveSettings({ fileNaming: v }); }}
              className="input-base"
            >
              <option value="overwrite">Overwrite existing file</option>
              <option value="unique">Create new file with number suffix</option>
            </select>
          </div>

          {/* Translation export option */}
          <div className="section-divider">
            <label className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-p-surface-hover cursor-pointer">
              <input
                type="checkbox"
                checked={exportTranscription}
                onChange={(e) => { setExportTranscription(e.target.checked); saveSettings({ exportTranscriptionWithTranslation: e.target.checked }); }}
                className="shrink-0 accent-p-accent"
              />
              <span className="text-sm text-p-text">Also export original transcription when translating</span>
            </label>
            <p className="text-xs text-p-text-dim mt-1 px-2">
              When translating, the app first transcribes the PDF, then translates the result. The original transcription is always saved internally. This controls whether it is also exported as files.
            </p>
          </div>

          </>}

          {/* ═══ ADVANCED TAB ═══ */}
          {settingsTab === 'advanced' && <>
          {/* Prevent sleep */}
          <div>
            <label className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-p-surface-hover cursor-pointer">
              <input
                type="checkbox"
                checked={preventSleep}
                onChange={(e) => { setPreventSleep(e.target.checked); saveSettings({ preventSleep: e.target.checked }); }}
                className="shrink-0 accent-p-accent"
              />
              <span className="text-sm text-p-text">Prevent sleep during conversion</span>
            </label>
            <p className="text-xs text-p-text-dim mt-1 px-2">
              Keeps your computer awake while transcriptions are running. Useful for long jobs when you'll be away. The display will also stay on.
            </p>
          </div>

          {/* Heading cleanup */}
          <div className="section-divider">
            <label className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-p-surface-hover cursor-pointer">
              <input
                type="checkbox"
                checked={headingCleanupEnabled}
                onChange={(e) => { setHeadingCleanupEnabled(e.target.checked); saveSettings({ headingCleanupEnabled: e.target.checked }); }}
                className="shrink-0 accent-p-accent"
              />
              <span className="text-sm text-p-text">Heading cleanup</span>
            </label>
            <p className="text-xs text-p-text-dim mt-1 px-2">
              Removes duplicate headings at batch boundaries, Table-of-Contents entries mistakenly emitted as headings, and Markdown artifacts like <code>## ## Title</code>. Recommended for scholarly books.
            </p>
          </div>

          {/* Custom instructions */}
          <div className="section-divider">
            <label className="section-label block mb-1.5">Custom instructions</label>
            <textarea
              value={outputNotes}
              onChange={(e) => setOutputNotes(e.target.value)}
              placeholder="Additional instructions appended to the AI prompt (optional)"
              rows={3}
              className="input-base resize-none"
            />
          </div>

          {/* Translation */}
          <div className="section-divider">
            <label className="section-label block mb-1">Translation languages</label>
            <p className="text-xs text-p-text-dim mb-2">
              Manage the languages available in the translation selector. Toggle translation on/off in the drop zone above the queue.
            </p>
            <div className="rounded-lg border border-p-border bg-p-bg-deep overflow-y-auto max-h-36">
              {translationLanguages.map(lang => (
                <div key={lang} className="flex items-center justify-between px-2 py-1.5 hover:bg-p-surface-hover">
                  <span className="text-sm text-p-text">{lang}</span>
                  <button
                    onClick={() => setTranslationLanguages(prev => { const next = prev.filter(l => l !== lang); saveSettings({ translationLanguages: next }); return next; })}
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
                      setTranslationLanguages(prev => { const next = [...prev, lang]; saveSettings({ translationLanguages: next }); return next; });
                    }
                    setNewLanguage('');
                  }
                }}
                placeholder="Add a language..."
                className="flex-1 input-base py-1.5"
              />
              <button
                onClick={() => {
                  const lang = newLanguage.trim();
                  if (lang && !translationLanguages.includes(lang)) {
                    setTranslationLanguages(prev => { const next = [...prev, lang]; saveSettings({ translationLanguages: next }); return next; });
                  }
                  setNewLanguage('');
                }}
                disabled={!newLanguage.trim()}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-p-accent/12 text-p-accent hover:bg-p-accent/20 disabled:opacity-30 tab-transition"
              >
                Add
              </button>
              {translationLanguages.length !== DEFAULT_TRANSLATION_LANGUAGES.length && (
                <button
                  onClick={() => { const next = [...DEFAULT_TRANSLATION_LANGUAGES]; setTranslationLanguages(next); saveSettings({ translationLanguages: next }); }}
                  className="px-3 py-1.5 rounded-lg text-xs text-p-text-dim hover:text-p-text hover:bg-p-surface-hover tab-transition"
                >
                  Reset
                </button>
              )}
            </div>
          </div>
          </>}
        </div>

      </div>
    </div>
  );
}
