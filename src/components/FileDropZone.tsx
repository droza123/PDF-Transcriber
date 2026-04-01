import { useState, useRef, useCallback } from 'react';
import { Upload, FileUp } from 'lucide-react';

interface FileDropZoneProps {
  onFilesAdded: (files: File[]) => void;
  disabled?: boolean;
}

export default function FileDropZone({ onFilesAdded, disabled }: FileDropZoneProps) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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
  );
}
