export interface ConversionJob {
  id: string;
  file: File;
  fileName: string;
  sourcePath: string | null;
  savedPath: string | null;
  status: 'queued' | 'converting' | 'done' | 'error';
  phase: 'scanning' | 'converting';
  progress: number;
  currentBatch: number;
  totalBatches: number;
  totalPages: number;
  statusMessage: string;
  activeModel?: string;
  streamPhase?: 'uploading' | 'processing' | 'streaming';
  streamChars?: number;
  errorDetail?: string;
  markdown: string | null;
  error: string | null;
  exportErrors?: string;
  translationLanguage?: string;
  startedAt: number | null;
  completedAt: number | null;
  sourceMarkdown?: string; // when set, translate this text instead of processing PDF
  resumeFrom?: number; // batch number to resume from (set during rehydration)
  previousConversion?: { date: number }; // set if this file was already converted before
}

/** Serializable subset of ConversionJob for queue persistence. */
export interface SerializedQueueEntry {
  id: string;
  fileName: string;
  sourcePath: string;
  status: 'queued' | 'interrupted';
  totalPages: number;
  totalBatches: number;
  completedBatches: number;
  addedAt: number;
}

/** A completed conversion stored in history. */
export interface HistoryEntry {
  id: string;
  fileName: string;
  sourcePath: string;
  savedPath: string;
  totalPages: number;
  convertedAt: number;
  durationMs: number;
  translationLanguage?: string;
}

/** Intermediate progress saved after each batch. */
export interface PartialProgress {
  jobId: string;
  fileName: string;
  sourcePath: string;
  outline: string;
  totalPages: number;
  totalBatches: number;
  completedBatches: number;
  results: string[];
}

/** A single entry in the conversion log. */
export interface LogEntry {
  id: string;
  timestamp: number;
  jobId: string;
  fileName: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

export function createJob(file: File): ConversionJob {
  // Use Electron's webUtils.getPathForFile (exposed via preload) to get the full path
  const sourcePath = window.electronAPI?.getFilePath(file) || null;
  return {
    id: crypto.randomUUID(),
    file,
    fileName: file.name,
    sourcePath,
    savedPath: null,
    status: 'queued',
    phase: 'scanning',
    progress: 0,
    currentBatch: 0,
    totalBatches: 0,
    totalPages: 0,
    statusMessage: 'Queued',
    markdown: null,
    error: null,
    startedAt: null,
    completedAt: null,
  };
}
