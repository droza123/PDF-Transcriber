import { useState } from 'react';
import { Eye, EyeOff, Save, X, Trash2, ChevronDown, ChevronRight, ExternalLink, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { getApiKey, setApiKey, clearApiKey, hasApiKey, validateAndFetchModels } from '../lib/apiKey';
import { getSettings, saveSettings, initializeModelPriority } from '../lib/settings';
import { getAllProviders } from '../lib/providers/registry';
import type { ProviderId } from '../lib/providers/types';

interface ApiKeyInputProps {
  onKeyChanged: () => void;
}

const PROVIDER_DESCRIPTIONS: Record<ProviderId, string> = {
  gemini: 'Free tier available. Fast models optimized for PDFs.',
  anthropic: 'High quality output. Native PDF support.',
  openrouter: 'Access 100s of models with one key. Free models available.',
};

export default function ApiKeyInput({ onKeyChanged }: ApiKeyInputProps) {
  const settings = getSettings();
  const [activeTab, setActiveTab] = useState<ProviderId>(settings.activeProvider);
  const [expanded, setExpanded] = useState(!hasApiKey());
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<'success' | 'error' | null>(null);
  const [validationError, setValidationError] = useState('');

  const providers = getAllProviders();
  const activeProvider = providers.find(p => p.id === activeTab);
  const currentKey = getApiKey(activeTab);
  const maskedKey = currentKey ? '\u2022\u2022\u2022\u2022\u2022\u2022' + currentKey.slice(-4) : null;

  // Which providers have keys configured?
  const configuredCount = providers.filter(p => hasApiKey(p.id)).length;

  function switchTab(id: ProviderId) {
    setActiveTab(id);
    setEditing(false);
    setValue('');
    setValidationResult(null);
    setValidationError('');
  }

  async function handleSave() {
    const key = value.trim();
    if (!key) return;

    setValidating(true);
    setValidationResult(null);
    setValidationError('');

    const result = await validateAndFetchModels(activeTab, key);

    if (result.valid) {
      setApiKey(activeTab, key);
      // Switch active provider to the one we just configured
      saveSettings({ activeProvider: activeTab });
      setValue('');
      setEditing(false);
      setValidating(false);
      setValidationResult('success');
      onKeyChanged();
      if (result.models.length > 0) initializeModelPriority(activeTab, result.models);
      setTimeout(() => setValidationResult(null), 3000);
    } else {
      setValidating(false);
      setValidationResult('error');
      setValidationError(result.error || 'Invalid key');
    }
  }

  function handleClear() {
    clearApiKey(activeTab);
    setEditing(false);
    setValue('');
    setValidationResult(null);
    onKeyChanged();
  }

  function handleCancel() {
    setEditing(false);
    setValue('');
    setValidationResult(null);
    setValidationError('');
  }

  // Determine header label
  const activeProviderName = activeProvider?.displayName ?? 'API';
  const headerLabel = configuredCount > 0
    ? `${activeProviderName}`
    : 'API Provider';

  return (
    <div className="border border-p-border rounded-lg bg-p-surface">
      {/* Collapsible header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-4 py-3 text-sm text-p-text-muted hover:text-p-text tab-transition"
      >
        {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        <span>{headerLabel}</span>
        {maskedKey && <span className="ml-auto text-xs font-mono text-p-text-dim">{maskedKey}</span>}
        {!hasApiKey() && <span className="ml-auto text-xs text-p-error">Not configured</span>}
      </button>

      {expanded && (
        <div className="px-4 pb-4 pt-1">
          {/* Provider tabs */}
          <div className="flex gap-1 mb-3">
            {providers.map(p => {
              const isActive = p.id === activeTab;
              const hasKey = hasApiKey(p.id);
              const isCurrentProvider = p.id === settings.activeProvider;
              return (
                <button
                  key={p.id}
                  onClick={() => switchTab(p.id)}
                  className={`px-2.5 py-1 text-xs rounded-md tab-transition ${
                    isActive
                      ? 'bg-p-accent/15 text-p-accent font-medium'
                      : 'text-p-text-dim hover:text-p-text hover:bg-p-surface-hover'
                  }`}
                >
                  {p.displayName}
                  {hasKey && !isActive && (
                    <span className="ml-1 text-p-success">&#x2713;</span>
                  )}
                  {isCurrentProvider && (
                    <span className="ml-1 text-p-accent" title="Active provider">&#x25CF;</span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Key input area for active tab */}
          {!editing ? (
            <div className="flex items-center gap-2">
              {currentKey ? (
                <>
                  {validationResult === 'success' ? (
                    <span className="text-sm text-p-success flex items-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Key verified
                    </span>
                  ) : (
                    <span className="text-sm text-p-success">Key configured</span>
                  )}
                  <button
                    onClick={() => { setEditing(true); setValue(''); setValidationResult(null); }}
                    className="text-xs px-2 py-1 rounded bg-p-surface-hover text-p-text-muted hover:text-p-text tab-transition"
                  >
                    Change
                  </button>
                  <button
                    onClick={handleClear}
                    className="text-xs px-2 py-1 rounded text-p-error hover:bg-p-surface-hover tab-transition"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                  {activeTab !== settings.activeProvider && (
                    <button
                      onClick={() => { saveSettings({ activeProvider: activeTab }); onKeyChanged(); }}
                      className="text-xs px-2 py-1 rounded bg-p-accent/15 text-p-accent hover:bg-p-accent/25 tab-transition ml-auto"
                    >
                      Use this provider
                    </button>
                  )}
                </>
              ) : (
                <div className="space-y-3">
                  <button
                    onClick={() => setEditing(true)}
                    className="text-sm px-3 py-1.5 rounded-lg bg-p-accent text-white hover:bg-p-accent-bright tab-transition"
                  >
                    Enter API Key
                  </button>
                  {activeProvider && (
                    <div className="text-xs text-p-text-dim leading-relaxed space-y-1.5">
                      <p>{PROVIDER_DESCRIPTIONS[activeTab]}</p>
                      <ol className="list-decimal list-inside space-y-1 pl-1">
                        {activeProvider.keyHelpSteps.map((step, i) => (
                          <li key={i}>
                            {i === 0 ? (
                              <>
                                Go to{' '}
                                <a
                                  href={activeProvider.keyHelpUrl}
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
                      {activeTab === 'gemini' && (
                        <p className="text-p-text-dim/70">The free tier is generous and sufficient for most use.</p>
                      )}
                      {activeTab === 'openrouter' && (
                        <p className="text-p-text-dim/70">Many free models are available. The app auto-selects the best free ones.</p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={value}
                    onChange={e => { setValue(e.target.value); setValidationResult(null); }}
                    onKeyDown={e => e.key === 'Enter' && !validating && handleSave()}
                    placeholder={activeProvider?.keyPlaceholder ?? 'Paste your API key'}
                    className="w-full px-3 py-2 pr-8 text-sm font-mono rounded-lg bg-p-bg border border-p-border text-p-text placeholder:text-p-text-dim focus:outline-none focus:border-p-accent"
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
                  onClick={handleSave}
                  disabled={!value.trim() || validating}
                  className="p-2 rounded-lg bg-p-success/20 text-p-success hover:bg-p-success/30 disabled:opacity-30 tab-transition"
                >
                  {validating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                </button>
                <button
                  onClick={handleCancel}
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
          )}
        </div>
      )}
    </div>
  );
}
