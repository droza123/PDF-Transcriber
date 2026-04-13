import type { SerializedQueueEntry, HistoryEntry, PartialProgress, LogEntry } from './types';

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      GEMINI_API_KEY?: string;
    }
  }

  const __APP_VERSION__: string;

  interface ElectronAPI {
    getFilePath: (file: File) => string;
    saveMarkdown: (sourcePdfPath: string, content: string, unique?: boolean) => Promise<string>;
    showInFolder: (filePath: string) => Promise<void>;
    saveFile: (sourcePdfPath: string, data: string | ArrayBuffer, extension: string, unique?: boolean) => Promise<string>;
    saveInternalMarkdown: (jobId: string, content: string) => Promise<string>;
    loadInternalMarkdown: (jobId: string) => Promise<string | null>;
    saveQueue: (entries: SerializedQueueEntry[]) => Promise<void>;
    loadQueue: () => Promise<SerializedQueueEntry[]>;
    saveProgress: (progress: PartialProgress) => Promise<void>;
    loadProgress: (jobId: string) => Promise<PartialProgress | null>;
    deleteProgress: (jobId: string) => Promise<void>;
    saveHistory: (entries: HistoryEntry[]) => Promise<void>;
    loadHistory: () => Promise<HistoryEntry[]>;
    saveLog: (entries: LogEntry[]) => Promise<void>;
    loadLog: () => Promise<LogEntry[]>;
    readMarkdown: (mdPath: string) => Promise<string | null>;
    openMarkdownFile: () => Promise<{ filePath: string; content: string | null; error?: string } | null>;
    readPdf: (pdfPath: string) => Promise<ArrayBuffer>;
    fileExists: (filePath: string) => Promise<boolean>;
    convertMarkdownToDocx: (markdown: string, format?: string) => Promise<ArrayBuffer>;
    startPowerBlock: (preventSleep?: boolean) => Promise<number>;
    stopPowerBlock: () => Promise<void>;
    findInPage: (text: string, options?: { findNext?: boolean; forward?: boolean }) => Promise<void>;
    findInPageStop: (action?: string) => Promise<void>;
    onFindInPageResult: (callback: (result: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean }) => void) => () => void;
  }

  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
