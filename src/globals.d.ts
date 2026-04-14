import type { SerializedQueueEntry, HistoryEntry, PartialProgress, LogEntry } from './types';

declare global {
  interface Uint8Array {
    toHex(): string;
    toBase64(): string;
  }

  interface Uint8ArrayConstructor {
    fromHex(hex: string): Uint8Array;
    fromBase64(base64: string): Uint8Array;
  }
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
    writeMarkdown: (filePath: string, content: string) => Promise<string>;
    openMarkdownFile: (defaultPath?: string) => Promise<{ filePath: string; content: string | null; error?: string } | null>;
    saveFileAs: (opts: {
      defaultPath?: string;
      content: string | ArrayBuffer;
      filters?: { name: string; extensions: string[] }[];
      isBinary?: boolean;
    }) => Promise<string | null>;
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
