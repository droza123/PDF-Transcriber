import { useState } from 'react';
import { Eye, EyeOff, Save, X, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { getApiKey, setApiKey, clearApiKey } from '../lib/apiKey';

interface ApiKeyInputProps {
  onKeyChanged: () => void;
}

export default function ApiKeyInput({ onKeyChanged }: ApiKeyInputProps) {
  const currentKey = getApiKey();
  const [expanded, setExpanded] = useState(!currentKey);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [showKey, setShowKey] = useState(false);

  const maskedKey = currentKey
    ? '••••••' + currentKey.slice(-4)
    : null;

  function handleSave() {
    if (value.trim()) {
      setApiKey(value.trim());
      setValue('');
      setEditing(false);
      onKeyChanged();
    }
  }

  function handleClear() {
    clearApiKey();
    setEditing(false);
    setValue('');
    onKeyChanged();
  }

  function handleCancel() {
    setEditing(false);
    setValue('');
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
                  <span className="text-sm text-p-success">Key configured</span>
                  <button
                    onClick={() => { setEditing(true); setValue(''); }}
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
                <button
                  onClick={() => setEditing(true)}
                  className="text-sm px-3 py-1.5 rounded-lg bg-p-accent text-white hover:bg-p-accent-bright tab-transition"
                >
                  Enter API Key
                </button>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={value}
                  onChange={e => setValue(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSave()}
                  placeholder="Paste your Gemini API key"
                  className="w-full px-3 py-2 pr-8 text-sm font-mono rounded-lg bg-p-bg border border-p-border text-p-text placeholder:text-p-text-dim focus:outline-none focus:border-p-accent"
                  autoFocus
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
                disabled={!value.trim()}
                className="p-2 rounded-lg bg-p-success/20 text-p-success hover:bg-p-success/30 disabled:opacity-30 tab-transition"
              >
                <Save className="w-4 h-4" />
              </button>
              <button
                onClick={handleCancel}
                className="p-2 rounded-lg text-p-text-muted hover:bg-p-surface-hover tab-transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
