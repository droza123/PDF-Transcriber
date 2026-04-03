import { useState, useRef, useCallback } from 'react';
import { Upload, FileUp, Languages } from 'lucide-react';
import { getSettings, saveSettings } from '../lib/settings';

interface FileDropZoneProps {
  onFilesAdded: (files: File[]) => void;
  disabled?: boolean;
}

export default function FileDropZone({ onFilesAdded, disabled }: FileDropZoneProps) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Translation state — synced with settings
  const settings = getSettings();
  const [transEnabled, setTransEnabled] = useState(settings.translationEnabled);
  const [transLang, setTransLang] = useState(settings.translationLanguage);
  const languages = settings.translationLanguages;

  function toggleTranslation() {
    const next = !transEnabled;
    setTransEnabled(next);
    saveSettings({ translationEnabled: next });
  }

  function changeLanguage(lang: string) {
    setTransLang(lang);
    saveSettings({ translationLanguage: lang, translationEnabled: true });
    setTransEnabled(true);
  }

  const handleFiles = useCallback(
    (fileList: FileList | null) => {
      if (!fileList) return;
      const pdfs = Array.from(fileList).filter(f => f.type === 'application/pdf');
      if (pdfs.length > 0) {
        onFilesAdded(pdfs);
      }
    },
    [onFilesAdded],
  );

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (!disabled) handleFiles(e.dataTransfer.files);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    if (!disabled) setDragOver(true);
  }

  return (
    <div className="space-y-2">
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={() => setDragOver(false)}
        className={`
          relative flex flex-col items-center justify-center gap-3 p-8
          border-2 border-dashed rounded-xl cursor-pointer tab-transition
          ${dragOver
            ? 'border-p-accent bg-p-accent/5'
            : 'border-p-border hover:border-p-text-dim hover:bg-p-surface/50'
          }
          ${disabled ? 'opacity-50 pointer-events-none' : ''}
        `}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,application/pdf"
          multiple
          className="hidden"
          onChange={e => { handleFiles(e.target.files); e.target.value = ''; }}
        />
        {dragOver ? (
          <FileUp className="w-10 h-10 text-p-accent" />
        ) : (
          <Upload className="w-10 h-10 text-p-text-dim" />
        )}
        <div className="text-center">
          <p className="text-sm font-medium text-p-text">
            Drop PDFs here or click to browse
          </p>
          <p className="text-xs text-p-text-dim mt-1">
            Select one or more PDF files for batch conversion
          </p>
        </div>
      </div>

      {/* Translation selector */}
      {languages.length > 0 && (
        <div
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs"
          onClick={e => e.stopPropagation()}
        >
          <button
            onClick={toggleTranslation}
            className={`flex items-center gap-1.5 px-2 py-1 rounded-md tab-transition ${
              transEnabled
                ? 'bg-sky-400/15 text-sky-400'
                : 'text-p-text-dim hover:text-p-text hover:bg-p-surface-hover'
            }`}
            title={transEnabled ? 'Translation enabled — click to disable' : 'Enable translation'}
          >
            <Languages className="w-3.5 h-3.5" />
            Translate
          </button>
          {transEnabled && (
            <select
              value={transLang}
              onChange={e => changeLanguage(e.target.value)}
              className="rounded-md border border-p-border bg-p-bg px-2 py-1 text-xs text-p-text focus:outline-none focus:border-p-accent"
              onClick={e => e.stopPropagation()}
            >
              <option value="">Select language...</option>
              {languages.map(lang => (
                <option key={lang} value={lang}>{lang}</option>
              ))}
            </select>
          )}
        </div>
      )}
    </div>
  );
}
