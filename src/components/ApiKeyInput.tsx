import { useState } from 'react';
import { Eye, EyeOff, Save, X, Trash2, ChevronDown, ChevronRight, ExternalLink, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { getApiKey, setApiKey, clearApiKey, validateApiKey, fetchAvailableModels } from '../lib/apiKey';
import { initializeModelPriority } from '../lib/settings';

interface ApiKeyInputProps {
  onKeyChanged: () => void;
}

export default function ApiKeyInput({ onKeyChanged }: ApiKeyInputProps) {
  const currentKey = getApiKey();
  const [expanded, setExpanded] = useState(!currentKey);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<'success' | 'error' | null>(null);
  const [validationError, setValidationError] = useState('');

  const maskedKey = currentKey
    ? '\u2022\u2022\u2022\u2022\u2022\u2022' + currentKey.slice(-4)
    : null;

  async function handleSave() {
    const key = value.trim();
    if (!key) return;

    setValidating(true);
    setValidationResult(null);
    setValidationError('');

    const result = await validateApiKey(key);

    if (result.valid) {
      setApiKey(key);
      setValue('');
      setEditing(false);
      setValidating(false);
      setValidationResult('success');
      onKeyChanged();
      // Fetch available models and set initial priority based on what exists
      fetchAvailableModels(key).then(models => {
        if (models.length > 0) initializeModelPriority(models);
      });
      setTimeout(() => setValidationResult(null), 3000);
    } else {
      setValidating(false);
      setValidationResult('error');
      setValidationError(result.error || 'Invalid key');
    }
  }

  function handleClear() {
    clearApiKey();
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

  return (
    <div className="border border-p-border rounded-lg bg-p-surface">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-4 py-3 text-sm text-p-text-muted hover:text-p-text tab-transition"
      >
        {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        <span>Gemini API Key</span>
        {maskedKey && <span className="ml-auto text-xs font-mono text-p-text-dim">{maskedKey}</span>}
        {!currentKey && <span className="ml-auto text-xs text-p-error">Not configured</span>}
      </button>

      {expanded && (
        <div className="px-4 pb-4 pt-1">
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
                </>
              ) : (
                <div className="space-y-3">
                  <button
                    onClick={() => setEditing(true)}
                    className="text-sm px-3 py-1.5 rounded-lg bg-p-accent text-white hover:bg-p-accent-bright tab-transition"
                  >
                    Enter API Key
                  </button>
                  <div className="text-xs text-p-text-dim leading-relaxed space-y-1.5">
                    <p>To use this app you need a free Gemini API key:</p>
                    <ol className="list-decimal list-inside space-y-1 pl-1">
                      <li>
                        Go to{' '}
                        <a
                          href="https://aistudio.google.com/apikey"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-p-accent hover:text-p-accent-bright inline-flex items-center gap-0.5"
                        >
                          Google AI Studio <ExternalLink className="w-3 h-3 inline" />
                        </a>
                      </li>
                      <li>Sign in with your Google account</li>
                      <li>Click <strong className="text-p-text-muted">Create API Key</strong></li>
                      <li>Copy the key and paste it above</li>
                    </ol>
                    <p className="text-p-text-dim/70">The free tier is generous and sufficient for most use.</p>
                  </div>
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
                    placeholder="Paste your Gemini API key"
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
