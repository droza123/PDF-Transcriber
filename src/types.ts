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
  markdown: string | null;
  error: string | null;
  startedAt: number | null;
  completedAt: number | null;
}

export function createJob(file: File): ConversionJob {
  // Electron's File objects have a `path` property with the full filesystem path
  const sourcePath = (file as any).path || null;
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
