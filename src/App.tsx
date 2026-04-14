import { useState, useCallback, useEffect, useRef } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ConversionJob, HistoryEntry, LogEntry } from './types';
import { createJob } from './types';
import { hasApiKey, getApiKey } from './lib/apiKey';
import { convertFile } from './lib/convert';
import { translateMarkdown } from './lib/gemini';
import { canSaveToSource, runAutoExport, exportHistoryAsCsv, rememberBrowsedDir } from './lib/download';
import { getSettings, saveSettings, addSessionSkippedModel, getTranslateModelPriority } from './lib/settings';
import { getProvider, getTranslateProvider } from './lib/providers/registry';
import type { ProviderId } from './lib/providers/types';
import { OpenRouterProvider } from './lib/providers/openrouter';
import Header from './components/Header';
import Welcome from './components/Welcome';
import FileDropZone from './components/FileDropZone';
import Queue from './components/Queue';
import History from './components/History';
import Log from './components/Log';
import Preview from './components/Preview';
import Settings from './components/Settings';

export default function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    (localStorage.getItem('theme') as 'dark' | 'light') || 'dark',
  );
  const [keyPresent, setKeyPresent] = useState(hasApiKey);
  const [jobs, setJobs] = useState<ConversionJob[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [sidebarTab, setSidebarTab] = useState<'queue' | 'history' | 'log'>('queue');
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [previewJobId, setPreviewJobId] = useState<string | null>(null);
  const [previewSource, setPreviewSource] = useState<'queue' | 'history' | 'opened'>('queue');
  const [historyMarkdown, setHistoryMarkdown] = useState<string | null>(null);
  const [openedFile, setOpenedFile] = useState<{ filePath: string; fileName: string; content: string } | null>(null);
  const [historySearch, setHistorySearch] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialProvider, setSettingsInitialProvider] = useState<ProviderId | null>(null);
  const [paused, setPaused] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    parseInt(localStorage.getItem('sidebar_width') || '420', 10),
  );
  const isDraggingRef = useRef(false);
  const pausedRef = useRef(false);
  const processingRef = useRef(false);
  const historyRef = useRef(history);
  historyRef.current = history;
  const abortControllers = useRef<Map<string, AbortController>>(new Map());

  // ── Theme ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme(t => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  // ── Sidebar resize ────────────────────────────────────────────────────────
  useEffect(() => {
    localStorage.setItem('sidebar_width', String(sidebarWidth));
  }, [sidebarWidth]);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const onMove = (ev: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const newWidth = Math.min(600, Math.max(280, startWidth + (ev.clientX - startX)));
      setSidebarWidth(newWidth);
    };
    const onUp = () => {
      isDraggingRef.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [sidebarWidth]);

  const handleSeparatorDoubleClick = useCallback(() => {
    setSidebarCollapsed(prev => !prev);
  }, []);

  // ── Job updates ────────────────────────────────────────────────────────────
  const updateJob = useCallback((id: string, update: Partial<ConversionJob>) => {
    setJobs(prev => prev.map(j => (j.id === id ? { ...j, ...update } : j)));
  }, []);

  // ── Rehydrate state on mount ──────────────────────────────────────────────
  useEffect(() => {
    async function rehydrate() {
      if (!window.electronAPI) return;

      const savedHistory = await window.electronAPI.loadHistory();
      setHistory(savedHistory);

      const savedLog = await window.electronAPI.loadLog();
      setLogEntries(savedLog);

      const savedQueue = await window.electronAPI.loadQueue();
      if (savedQueue.length === 0) return;

      const rehydratedJobs: ConversionJob[] = [];
      for (const entry of savedQueue) {
        // For markdown-based translations, load the source markdown from internal storage
        let sourceMarkdown: string | undefined;
        if (entry.hasSourceMarkdown || entry.sourceMarkdown) {
          const loaded = await window.electronAPI.loadInternalMarkdown(`translate-src-${entry.id}`);
          if (loaded) {
            sourceMarkdown = loaded;
          } else if (entry.sourceMarkdown) {
            // Backward compat: old queue entries may still have inline sourceMarkdown
            sourceMarkdown = entry.sourceMarkdown;
          } else {
            // Source markdown was lost — skip this job
            continue;
          }
        } else {
          const exists = await window.electronAPI.fileExists(entry.sourcePath);
          if (!exists) continue;
        }

        const progress = await window.electronAPI.loadProgress(entry.id);

        rehydratedJobs.push({
          id: entry.id,
          file: null as any,
          fileName: entry.fileName,
          sourcePath: entry.sourcePath,
          savedPath: null,
          status: 'queued',
          phase: progress ? 'converting' : 'scanning',
          progress: progress ? Math.round((progress.completedBatches / progress.totalBatches) * 100) : 0,
          currentBatch: progress?.completedBatches ?? 0,
          totalBatches: entry.totalBatches || 0,
          totalPages: entry.totalPages || 0,
          statusMessage: progress
            ? `Resumable (${progress.completedBatches}/${progress.totalBatches} chunks done)`
            : 'Queued',
          markdown: progress?.results.length ? progress.results.join('\n\n') : null,
          error: null,
          startedAt: null,
          completedAt: null,
          resumeFrom: progress?.completedBatches,
          translationLanguage: entry.translationLanguage,
          sourceMarkdown,
        });
      }

      if (rehydratedJobs.length > 0) {
        setJobs(rehydratedJobs);
      }
    }
    rehydrate();
  }, []);

  // ── OpenRouter auto-select free models on startup ─────────────────────
  useEffect(() => {
    async function autoRefreshOpenRouterModels() {
      const settings = getSettings();
      if (settings.scanProvider !== 'openrouter' && settings.transcribeProvider !== 'openrouter' && settings.translateProvider !== 'openrouter') return;
      if (!settings.openrouterAutoFreeModels) return;
      const key = getApiKey('openrouter');
      if (!key) return;

      try {
        const provider = getProvider('openrouter') as OpenRouterProvider;
        const topFree = await provider.getTopFreeModels(key);
        if (topFree.length > 0) {
          const current = getSettings();
          const updated = { ...current.providerModelPriority, openrouter: topFree };
          saveSettings({ providerModelPriority: updated });
          console.log(`[openrouter] Auto-selected ${topFree.length} free models`);
        }
      } catch (e) {
        console.warn('[openrouter] Auto-refresh failed:', e);
      }
    }
    autoRefreshOpenRouterModels();
  }, []);

  // ── Eager persistence: queue + auto-archive done jobs to history ────────
  const persistQueueRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(persistQueueRef.current);
    persistQueueRef.current = setTimeout(() => {
      // Auto-archive done jobs to history so they survive app close
      const doneJobs = jobs.filter(j => j.status === 'done' && j.savedPath && j.sourcePath);
      if (doneJobs.length > 0) {
        const hKey = (path: string, lang?: string) => lang ? `${path}::${lang}` : path;
        const existingKeys = new Set(historyRef.current.map(h => hKey(h.sourcePath, h.translationLanguage)));
        const newEntries: HistoryEntry[] = doneJobs
          .filter(j => !existingKeys.has(hKey(j.sourcePath!, j.translationLanguage)))
          .map(j => ({
            id: j.id,
            fileName: j.fileName,
            sourcePath: j.sourcePath!,
            savedPath: j.savedPath!,
            totalPages: j.totalPages,
            convertedAt: j.completedAt!,
            durationMs: (j.completedAt ?? 0) - (j.startedAt ?? 0),
            translationLanguage: j.translationLanguage || undefined,
          }));
        if (newEntries.length > 0) {
          setHistory(prev => [...newEntries, ...prev].sort((a, b) => b.convertedAt - a.convertedAt));
        }
      }

      // Save unfinished jobs to queue.json (queued, converting, or errored)
      const entries = jobs
        .filter(j => j.status === 'queued' || j.status === 'converting' || j.status === 'error')
        .map(j => ({
          id: j.id,
          fileName: j.fileName,
          sourcePath: j.sourcePath!,
          status: (j.status === 'error' ? 'queued' : j.status === 'converting' ? 'interrupted' : 'queued') as 'queued' | 'interrupted',
          totalPages: j.totalPages,
          totalBatches: j.totalBatches,
          completedBatches: j.currentBatch,
          addedAt: j.startedAt ?? Date.now(),
          translationLanguage: j.translationLanguage || undefined,
          hasSourceMarkdown: !!j.sourceMarkdown || undefined,
        }));
      window.electronAPI?.saveQueue(entries);
    }, 500);
  }, [jobs]);

  // ── Eager persistence: history ────────────────────────────────────────────
  const historyInitialized = useRef(false);
  useEffect(() => {
    if (!historyInitialized.current) {
      historyInitialized.current = true;
      return;
    }
    window.electronAPI?.saveHistory(history);
  }, [history]);

  // Persist log
  const logInitialized = useRef(false);
  useEffect(() => {
    if (!logInitialized.current) {
      logInitialized.current = true;
      return;
    }
    window.electronAPI?.saveLog(logEntries);
  }, [logEntries]);

  const addLogEntry = useCallback((jobId: string, fileName: string, level: LogEntry['level'], message: string) => {
    setLogEntries(prev => [...prev, {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      jobId,
      fileName,
      level,
      message,
    }]);
  }, []);

  // ── Process queue sequentially ────────────────────────────────────────────
  const processQueue = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;

    // Prevent OS from suspending the app while processing
    await window.electronAPI?.startPowerBlock(getSettings().preventSleep);

    while (true) {
      // Check if paused
      if (pausedRef.current) break;

      // Read state twice with delay to ensure React has flushed updates
      let nextJob: ConversionJob | undefined;
      setJobs(prev => {
        nextJob = prev.find(j => j.status === 'queued');
        return prev;
      });
      await new Promise(resolve => setTimeout(resolve, 50));

      let currentJobs: ConversionJob[] = [];
      setJobs(prev => {
        currentJobs = prev;
        return prev;
      });
      await new Promise(resolve => setTimeout(resolve, 50));

      nextJob = currentJobs.find(j => j.status === 'queued');
      if (!nextJob) break;

      const jobId = nextJob.id;

      // Create AbortController for this job
      const controller = new AbortController();
      abortControllers.current.set(jobId, controller);

      try {
        const fileName = nextJob.fileName;
        const conversionStart = Date.now();
        let lastActiveModel = '';
        let markdown: string;

        const skipModels = new Set<string>();
        const commonStreamOpts = {
          onModelStart: (model: string) => { updateJob(jobId, { activeModel: model }); if (model !== lastActiveModel) { addLogEntry(jobId, fileName, 'info', `Using model: ${model}`); lastActiveModel = model; } },
          onModelSkip: (skippedModel: string, nextModel: string | null, reason: string) => {
            addSessionSkippedModel(skippedModel, reason);
            const msg = nextModel ? `Skipping ${skippedModel} (${reason}), trying ${nextModel}...` : `Skipping ${skippedModel} (${reason}), no more models`;
            updateJob(jobId, { statusMessage: msg });
          },
          onStreamProgress: (phase: 'uploading' | 'processing' | 'streaming', charsReceived: number) => { updateJob(jobId, { streamPhase: phase, streamChars: charsReceived }); },
          onError: (model: string, reason: string, action: string) => { updateJob(jobId, { errorDetail: `${model}: ${reason} (${action})` }); addLogEntry(jobId, fileName, 'error', `${model}: ${reason} (${action})`); },
          abortSignal: controller.signal,
          skipModels,
        };

        if (nextJob.sourceMarkdown) {
          // ── Markdown-based translation (from history) ───────────────────
          addLogEntry(jobId, fileName, 'info', `Translating to ${nextJob.translationLanguage}`);
          updateJob(jobId, { status: 'converting', phase: 'converting', statusMessage: `Translating to ${nextJob.translationLanguage}...`, startedAt: Date.now() });

          // Load partial translation progress for resume
          let translateResumeChunk: number | undefined;
          let translateResumeResults: string[] | undefined;
          if (nextJob.resumeFrom && nextJob.resumeFrom > 0) {
            const progress = await window.electronAPI?.loadProgress(jobId);
            if (progress && progress.results.length > 0) {
              translateResumeChunk = progress.completedBatches;
              translateResumeResults = progress.results;
              addLogEntry(jobId, fileName, 'info', `Resuming translation from chunk ${progress.completedBatches + 1}`);
            }
          }

          markdown = await translateMarkdown(nextJob.sourceMarkdown, nextJob.translationLanguage!, {
            provider: getTranslateProvider(),
            models: getTranslateModelPriority(),
            ...commonStreamOpts,
            resumeFromChunk: translateResumeChunk,
            resumeResults: translateResumeResults,
            onProgress: ({ currentChunk, totalChunks, statusMessage }) => {
              updateJob(jobId, { currentBatch: currentChunk, totalBatches: totalChunks, statusMessage, progress: Math.round((currentChunk / totalChunks) * 100) });
              addLogEntry(jobId, fileName, 'info', statusMessage);
            },
            onChunkComplete: (completedChunks, totalChunks, results) => {
              window.electronAPI?.saveProgress({
                jobId,
                fileName,
                sourcePath: nextJob.sourcePath || '',
                outline: '', // not used for translation
                totalPages: nextJob.totalPages,
                totalBatches: totalChunks,
                completedBatches: completedChunks,
                results,
              });
              updateJob(jobId, { markdown: results.join('\n\n') });
              if (pausedRef.current) controller.abort();
            },
            onRetry: (attempt, delay, reason) => {
              const msg = reason === 'rate_limited' ? `Rate limited \u2014 retrying in ${delay}s...` : reason === 'overloaded' ? `Service overloaded \u2014 retrying in ${delay}s...` : `Retrying in ${delay}s (attempt ${attempt})...`;
              updateJob(jobId, { statusMessage: msg });
            },
          });
        } else {
          // ── PDF conversion (with optional two-pass translation) ─────────

          // Optimization: if translating and a transcription already exists in history,
          // skip the PDF conversion and go straight to translation.
          let existingTranscription: string | null = null;
          if (nextJob.translationLanguage && nextJob.sourcePath) {
            const existingEntry = historyRef.current.find(
              h => h.sourcePath === nextJob.sourcePath && !h.translationLanguage,
            );
            if (existingEntry) {
              let md = await window.electronAPI?.readMarkdown(existingEntry.savedPath) ?? null;
              if (!md) md = await window.electronAPI?.loadInternalMarkdown(existingEntry.id) ?? null;
              if (md) {
                existingTranscription = md;
                addLogEntry(jobId, fileName, 'info', 'Using existing transcription from history');
                updateJob(jobId, { status: 'converting', phase: 'converting', statusMessage: `Translating to ${nextJob.translationLanguage}...`, startedAt: Date.now() });
              }
            }
          }

          let transcription: string;

          if (existingTranscription) {
            transcription = existingTranscription;
          } else {
            // Full PDF conversion needed
            let fileObj = nextJob.file;
            if (!fileObj || !(fileObj instanceof File) || fileObj.size === 0) {
              if (!nextJob.sourcePath) throw new Error('Source PDF path not available');
              const buffer = await window.electronAPI!.readPdf(nextJob.sourcePath);
              fileObj = new File([buffer], nextJob.fileName, { type: 'application/pdf' });
            }

            let resumeFrom = undefined;
            if (nextJob.resumeFrom && nextJob.resumeFrom > 0) {
              resumeFrom = (await window.electronAPI?.loadProgress(jobId)) ?? undefined;
            }

            addLogEntry(jobId, fileName, 'info', `Started converting ${fileName}`);

            transcription = await convertFile({
            file: fileObj,
            jobId,
            sourcePath: nextJob.sourcePath || '',
            onProgress: update => {
              updateJob(jobId, update);
              if (update.activeModel && update.activeModel !== lastActiveModel) {
                addLogEntry(jobId, fileName, 'info', `Using model: ${update.activeModel}`);
              }
              if (update.activeModel) lastActiveModel = update.activeModel;
              if (update.statusMessage?.startsWith('Scanning document')) {
                addLogEntry(jobId, fileName, 'info', 'Scanning document structure...');
              }
              if (update.statusMessage?.startsWith('Structure scan complete')) {
                addLogEntry(jobId, fileName, 'success', update.statusMessage);
              }
              if (update.statusMessage?.startsWith('Heading correction:') || update.statusMessage?.startsWith('Heading remap:')) {
                addLogEntry(jobId, fileName, 'info', update.statusMessage);
              }
              if (update.statusMessage?.startsWith('Page numbers:')) {
                addLogEntry(jobId, fileName, 'info', update.statusMessage);
              }
              if (update.errorDetail) {
                addLogEntry(jobId, fileName, 'error', update.errorDetail);
              }
            },
            onBatchComplete: async (progress) => {
              await window.electronAPI?.saveProgress(progress);
              updateJob(jobId, { markdown: progress.results.join('\n\n') });
              addLogEntry(jobId, fileName, 'info', `Batch ${progress.completedBatches}/${progress.totalBatches} complete${lastActiveModel ? ` (${lastActiveModel})` : ''}`);
              if (pausedRef.current) {
                controller.abort();
              }
            },
            resumeFrom,
            abortSignal: controller.signal,
          });

            // Save transcription internally (always)
            await window.electronAPI?.saveInternalMarkdown(jobId, transcription);
          }

          // If translating: save transcription (if new), then translate
          if (nextJob.translationLanguage) {
            if (!existingTranscription) {
              // Export transcription if setting is on (skip if reusing existing)
              const { exportTranscriptionWithTranslation } = getSettings();
              let transcriptionSavedPath: string | null = null;
              if (exportTranscriptionWithTranslation && nextJob.sourcePath && canSaveToSource()) {
                try {
                  const txResult = await runAutoExport(nextJob.sourcePath, nextJob.fileName, transcription, jobId);
                  transcriptionSavedPath = txResult.savedPath;
                } catch { /* best effort */ }
              }

              // Create transcription history entry
              // Read totalPages from current job state (nextJob is stale — captured before convertFile updated it)
              let currentTotalPages = nextJob.totalPages;
              setJobs(prev => { const j = prev.find(x => x.id === jobId); if (j) currentTotalPages = j.totalPages; return prev; });
              await new Promise(resolve => setTimeout(resolve, 50));
              const txEntry: HistoryEntry = {
                id: crypto.randomUUID(),
                fileName,
                sourcePath: nextJob.sourcePath!,
                savedPath: transcriptionSavedPath || '',
                totalPages: currentTotalPages,
                convertedAt: Date.now(),
                durationMs: Date.now() - conversionStart,
              };
              setHistory(prev => [txEntry, ...prev].sort((a, b) => b.convertedAt - a.convertedAt));

              addLogEntry(jobId, fileName, 'success', 'Transcription complete. Starting translation...');
            }

            updateJob(jobId, { progress: 0, currentBatch: 0, totalBatches: 0, streamPhase: undefined, streamChars: 0, statusMessage: `Translating to ${nextJob.translationLanguage}...` });

            // Phase 2: Translate the transcription
            markdown = await translateMarkdown(transcription, nextJob.translationLanguage, {
              provider: getTranslateProvider(),
              models: getTranslateModelPriority(),
              ...commonStreamOpts,
              onProgress: ({ currentChunk, totalChunks, statusMessage }) => {
                updateJob(jobId, { currentBatch: currentChunk, totalBatches: totalChunks, statusMessage, progress: Math.round((currentChunk / totalChunks) * 100) });
                addLogEntry(jobId, fileName, 'info', statusMessage);
              },
              onChunkComplete: (completedChunks, totalChunks, results) => {
                window.electronAPI?.saveProgress({
                  jobId,
                  fileName,
                  sourcePath: nextJob.sourcePath || '',
                  outline: '', // not used for translation
                  totalPages: nextJob.totalPages,
                  totalBatches: totalChunks,
                  completedBatches: completedChunks,
                  results,
                });
                updateJob(jobId, { markdown: results.join('\n\n') });
                if (pausedRef.current) controller.abort();
              },
              onRetry: (attempt, delay, reason) => {
                const msg = reason === 'rate_limited' ? `Rate limited \u2014 retrying in ${delay}s...` : reason === 'overloaded' ? `Service overloaded \u2014 retrying in ${delay}s...` : `Retrying in ${delay}s (attempt ${attempt})...`;
                updateJob(jobId, { statusMessage: msg });
              },
            });
          } else {
            markdown = transcription;
          }
        }

        // Clean up progress file
        await window.electronAPI?.deleteProgress(jobId);

        // Auto-export to selected formats
        let savedPath: string | null = null;
        let saveError = '';
        if (nextJob.sourcePath && canSaveToSource()) {
          try {
            const result = await runAutoExport(nextJob.sourcePath, nextJob.fileName, markdown, jobId, nextJob.translationLanguage);
            savedPath = result.savedPath;
            if (result.errors.length > 0) {
              saveError = result.errors.join('; ');
            }
          } catch (e: any) {
            saveError = e.message || 'save failed';
          }
        }

        // Log completion and export results
        const duration = Math.round((Date.now() - conversionStart) / 1000);
        addLogEntry(jobId, fileName, 'success', `Completed in ${duration}s`);
        if (saveError) {
          addLogEntry(jobId, fileName, 'warn', `Export issues: ${saveError}`);
        }

        updateJob(jobId, {
          status: 'done',
          progress: 100,
          markdown,
          savedPath,
          exportErrors: saveError || undefined,
          statusMessage: saveError
            ? savedPath ? 'Saved (some exports failed)' : `Done (${saveError})`
            : savedPath ? 'Saved' : 'Done',
          completedAt: Date.now(),
        });
      } catch (error: any) {
        const isCancelled = error.name === 'AbortError';
        const isPaused = isCancelled && pausedRef.current;

        if (isPaused) {
          addLogEntry(jobId, nextJob.fileName, 'info', 'Paused by user');
          // Re-queue the job with partial progress for later resume
          const progress = await window.electronAPI?.loadProgress(jobId);
          updateJob(jobId, {
            status: 'queued',
            phase: progress ? 'converting' : 'scanning',
            progress: progress ? Math.round((progress.completedBatches / progress.totalBatches) * 100) : 0,
            currentBatch: progress?.completedBatches ?? 0,
            statusMessage: progress
              ? `Paused (${progress.completedBatches}/${progress.totalBatches} batches done)`
              : 'Paused',
            error: null,
            completedAt: null,
            resumeFrom: progress?.completedBatches,
          });
        } else if (isCancelled) {
          addLogEntry(jobId, nextJob.fileName, 'info', 'Cancelled by user');
          updateJob(jobId, {
            status: 'error',
            error: 'Cancelled by user',
            statusMessage: 'Cancelled',
            completedAt: Date.now(),
          });
        } else {
          addLogEntry(jobId, nextJob.fileName, 'error', error.message || 'Conversion failed');
          updateJob(jobId, {
            status: 'error',
            error: error.message || 'Conversion failed',
            statusMessage: 'Error',
            completedAt: Date.now(),
          });
        }
      } finally {
        abortControllers.current.delete(jobId);
      }
    }

    // Allow OS suspension again when queue is idle
    await window.electronAPI?.stopPowerBlock();
    processingRef.current = false;
  }, [updateJob, addLogEntry]);

  // ── Kick queue when jobs appear ───────────────────────────────────────────
  const prevJobCount = useRef(0);
  useEffect(() => {
    if (jobs.length > prevJobCount.current && jobs.some(j => j.status === 'queued')) {
      setTimeout(processQueue, 50);
    }
    prevJobCount.current = jobs.length;
  }, [jobs.length, processQueue]);

  // ── Actions ───────────────────────────────────────────────────────────────

  // F2: Duplicate detection in addFiles (composite key: sourcePath + translationLanguage)
  const addFiles = useCallback(
    (files: File[]) => {
      const { translationEnabled, translationLanguage } = getSettings();
      const transLang = translationEnabled && translationLanguage ? translationLanguage : undefined;
      const historyKey = (path: string, lang?: string) => lang ? `${path}::${lang}` : path;
      const historyMap = new Map(historyRef.current.map(h => [historyKey(h.sourcePath, h.translationLanguage), h]));
      const newJobs = files.map(f => {
        const job = createJob(f);
        if (transLang) job.translationLanguage = transLang;
        const key = job.sourcePath ? historyKey(job.sourcePath, transLang) : null;
        const prev = key ? historyMap.get(key) : null;
        if (prev) {
          job.previousConversion = { date: prev.convertedAt };
        }
        return job;
      });
      setJobs(prev => [...prev, ...newJobs]);
      setTimeout(processQueue, 50);
    },
    [processQueue],
  );

  const removeJob = useCallback(
    (id: string) => {
      setJobs(prev => prev.filter(j => j.id !== id));
      window.electronAPI?.deleteProgress(id);
      if (previewJobId === id && previewSource === 'queue') setPreviewJobId(null);
    },
    [previewJobId, previewSource],
  );

  // F7: Cancel a running conversion
  const cancelJob = useCallback((id: string) => {
    const controller = abortControllers.current.get(id);
    if (controller) controller.abort();
  }, []);

  const retryJob = useCallback(
    async (id: string) => {
      // Retry should ALWAYS try to continue from saved progress if any exists —
      // never silently delete progress or restart from scratch. If the user
      // truly wants to start over, they can remove the job (X button) and
      // re-add it. This applies equally to failures and manual cancels.
      const progress = await window.electronAPI?.loadProgress(id);
      setJobs(prev =>
        prev.map(j => {
          if (j.id !== id) return j;
          if (progress && progress.completedBatches > 0) {
            // Saved progress exists — resume from the last completed batch.
            return {
              ...j,
              status: 'queued' as const,
              phase: 'converting' as const,
              progress: Math.round((progress.completedBatches / progress.totalBatches) * 100),
              currentBatch: progress.completedBatches,
              totalBatches: progress.totalBatches,
              statusMessage: `Queued (resuming from ${progress.completedBatches}/${progress.totalBatches})`,
              error: null,
              startedAt: null,
              completedAt: null,
              resumeFrom: progress.completedBatches,
              markdown: progress.results.length ? progress.results.join('\n\n') : j.markdown,
            };
          }
          // No saved progress (failure before any batch completed, or progress
          // never persisted) — queue fresh. We deliberately do NOT call
          // deleteProgress here: if a file does exist it will be overwritten
          // by the first onBatchComplete of the new run, and if it doesn't
          // there's nothing to delete. Avoiding the delete prevents a race
          // where a momentarily-unreadable progress file gets nuked.
          return {
            ...j,
            status: 'queued' as const,
            phase: 'scanning' as const,
            progress: 0,
            currentBatch: 0,
            statusMessage: 'Queued (retry)',
            error: null,
            markdown: null,
            startedAt: null,
            completedAt: null,
            resumeFrom: undefined,
          };
        }),
      );
      setTimeout(processQueue, 50);
    },
    [processQueue],
  );

  const archiveCompleted = useCallback(() => {
    setJobs(prev => {
      const doneJobs = prev.filter(j => j.status === 'done' && j.savedPath);
      if (doneJobs.length > 0) {
        const hKey = (path: string, lang?: string) => lang ? `${path}::${lang}` : path;
        const newEntries: HistoryEntry[] = doneJobs.map(j => ({
          id: j.id,
          fileName: j.fileName,
          sourcePath: j.sourcePath!,
          savedPath: j.savedPath!,
          totalPages: j.totalPages,
          convertedAt: j.completedAt!,
          durationMs: (j.completedAt ?? 0) - (j.startedAt ?? 0),
          translationLanguage: j.translationLanguage || undefined,
        }));

        setHistory(prevHistory => {
          const sourceMap = new Map(prevHistory.map(h => [hKey(h.sourcePath, h.translationLanguage), h]));
          for (const entry of newEntries) sourceMap.set(hKey(entry.sourcePath, entry.translationLanguage), entry);
          return Array.from(sourceMap.values()).sort((a, b) => b.convertedAt - a.convertedAt);
        });
      }
      return prev.filter(j => j.status !== 'done');
    });
    if (previewSource === 'queue') setPreviewJobId(null);
  }, [previewSource]);

  // F6: Pause/Resume
  const togglePause = useCallback(() => {
    const newPaused = !pausedRef.current;
    pausedRef.current = newPaused;
    setPaused(newPaused);
    if (!newPaused) {
      // Resume: kick queue
      setTimeout(processQueue, 50);
    }
  }, [processQueue]);

  const togglePreview = useCallback((id: string) => {
    setPreviewSource('queue');
    setPreviewJobId(prev => (prev === id ? null : id));
    setHistoryMarkdown(null);
    setOpenedFile(null);
  }, []);

  // ── History actions ───────────────────────────────────────────────────────
  const previewHistoryItem = useCallback(async (entry: HistoryEntry) => {
    setPreviewSource('history');
    setPreviewJobId(entry.id);
    setOpenedFile(null);
    let content = entry.savedPath
      ? await window.electronAPI?.readMarkdown(entry.savedPath)
      : null;
    if (!content) {
      content = await window.electronAPI?.loadInternalMarkdown(entry.id) ?? null;
    }
    setHistoryMarkdown(content ?? `_Markdown not found for this conversion_`);
  }, []);

  const deleteHistoryItem = useCallback((id: string) => {
    setHistory(prev => prev.filter(h => h.id !== id));
    if (previewJobId === id && previewSource === 'history') {
      setPreviewJobId(null);
      setHistoryMarkdown(null);
    }
  }, [previewJobId, previewSource]);

  const clearHistory = useCallback(() => {
    setHistory([]);
    if (previewSource === 'history') {
      setPreviewJobId(null);
      setHistoryMarkdown(null);
    }
  }, [previewSource]);

  // F3: Re-convert from History
  const reconvertFromHistory = useCallback(async (entry: HistoryEntry) => {
    if (!window.electronAPI) return;
    const exists = await window.electronAPI.fileExists(entry.sourcePath);
    if (!exists) {
      // Show error inline — create a temporary error job
      const errorJob: ConversionJob = {
        id: crypto.randomUUID(),
        file: null as any,
        fileName: entry.fileName,
        sourcePath: entry.sourcePath,
        savedPath: null,
        status: 'error',
        phase: 'scanning',
        progress: 0,
        currentBatch: 0,
        totalBatches: 0,
        totalPages: 0,
        statusMessage: 'Error',
        markdown: null,
        error: `Source PDF not found: ${entry.sourcePath}`,
        startedAt: null,
        completedAt: Date.now(),
      };
      setJobs(prev => [...prev, errorJob]);
      setSidebarTab('queue');
      return;
    }

    const buffer = await window.electronAPI.readPdf(entry.sourcePath);
    const file = new File([buffer], entry.fileName, { type: 'application/pdf' });
    const job = createJob(file);
    // Manually set sourcePath since file was constructed from buffer
    job.sourcePath = entry.sourcePath;
    setJobs(prev => [...prev, job]);
    setSidebarTab('queue');
    setTimeout(processQueue, 50);
  }, [processQueue]);

  // Translate from existing markdown in history
  const translateFromHistory = useCallback(async (entry: HistoryEntry, language: string) => {
    if (!window.electronAPI) return;

    // Load existing markdown
    let md = await window.electronAPI.readMarkdown(entry.savedPath);
    if (!md) md = await window.electronAPI.loadInternalMarkdown(entry.id) ?? null;
    if (!md) {
      const errorJob: ConversionJob = {
        id: crypto.randomUUID(),
        file: null as any,
        fileName: entry.fileName,
        sourcePath: entry.sourcePath,
        savedPath: null,
        status: 'error',
        phase: 'scanning',
        progress: 0,
        currentBatch: 0,
        totalBatches: 0,
        totalPages: entry.totalPages,
        statusMessage: 'Error',
        markdown: null,
        error: `Markdown file not found for translation. Re-transcribe first.`,
        startedAt: null,
        completedAt: Date.now(),
      };
      setJobs(prev => [...prev, errorJob]);
      setSidebarTab('queue');
      return;
    }

    const job: ConversionJob = {
      id: crypto.randomUUID(),
      file: null as any,
      fileName: entry.fileName,
      sourcePath: entry.sourcePath,
      savedPath: null,
      status: 'queued',
      phase: 'converting',
      progress: 0,
      currentBatch: 0,
      totalBatches: 0,
      totalPages: entry.totalPages,
      statusMessage: `Queued (translate to ${language})`,
      markdown: null,
      error: null,
      startedAt: null,
      completedAt: null,
      sourceMarkdown: md,
      translationLanguage: language,
    };
    // Persist the source markdown separately so queue.json doesn't bloat
    window.electronAPI?.saveInternalMarkdown(`translate-src-${job.id}`, md);
    setJobs(prev => [...prev, job]);
    setSidebarTab('queue');
    setTimeout(processQueue, 50);
  }, [processQueue]);

  // F13: Reorder queue (drag-and-drop)
  const reorderJobs = useCallback((activeId: string, overId: string) => {
    setJobs(prev => {
      const oldIndex = prev.findIndex(j => j.id === activeId);
      const newIndex = prev.findIndex(j => j.id === overId);
      if (oldIndex === -1 || newIndex === -1) return prev;
      const updated = [...prev];
      const [moved] = updated.splice(oldIndex, 1);
      updated.splice(newIndex, 0, moved);
      return updated;
    });
  }, []);

  // F5: Export history
  const handleExportHistory = useCallback(() => {
    exportHistoryAsCsv(history);
  }, [history]);

  // Persist a cleaned-up version of an opened markdown file back to disk and
  // refresh the visible preview content.
  const handleSaveCleanedOpened = useCallback(async (content: string) => {
    if (!openedFile || !window.electronAPI?.writeMarkdown) return;
    await window.electronAPI.writeMarkdown(openedFile.filePath, content);
    setOpenedFile({ ...openedFile, content });
  }, [openedFile]);

  // Persist a cleaned-up version of a history entry's markdown. Updates the
  // exported .md file (if any) AND the internal copy used for preview.
  const handleSaveCleanedHistory = useCallback(async (content: string) => {
    if (!previewJobId) return;
    const entry = historyRef.current.find(h => h.id === previewJobId);
    if (!entry) return;
    if (entry.savedPath && window.electronAPI?.writeMarkdown) {
      try { await window.electronAPI.writeMarkdown(entry.savedPath, content); } catch { /* keep going */ }
    }
    await window.electronAPI?.saveInternalMarkdown(entry.id, content);
    setHistoryMarkdown(content);
  }, [previewJobId]);

  // Open an external markdown file for viewing / exporting (no API key needed).
  // `defaultDir` (optional) seeds the picker — preview passes the previewed
  // file's folder; we fall back to the persisted last-browsed folder.
  const handleOpenMarkdown = useCallback(async (defaultDir?: string | null) => {
    if (!window.electronAPI?.openMarkdownFile) return;
    const seedDir = defaultDir || getSettings().lastBrowsedDir || undefined;
    const result = await window.electronAPI.openMarkdownFile(seedDir);
    if (!result || !result.content) return;
    const fileName = result.filePath.split(/[\\/]/).pop() || 'document.md';
    setOpenedFile({ filePath: result.filePath, fileName, content: result.content });
    setPreviewSource('opened');
    setPreviewJobId(null);
    setHistoryMarkdown(null);
    rememberBrowsedDir(result.filePath);
  }, []);

  // ── Derived state ─────────────────────────────────────────────────────────
  const previewJob = jobs.find(j => j.id === previewJobId && (j.status === 'done' || (j.status === 'converting' && j.markdown)));
  const previewHistoryEntry = history.find(h => h.id === previewJobId);

  const showQueuePreview = previewSource === 'queue' && previewJob;
  const showHistoryPreview = previewSource === 'history' && previewHistoryEntry && historyMarkdown;
  const showOpenedPreview = previewSource === 'opened' && openedFile;

  return (
    <div className="flex flex-col h-screen bg-p-bg noise-bg">
      <Header
        theme={theme}
        keyPresent={keyPresent}
        onToggleTheme={toggleTheme}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div className="flex-1 flex overflow-hidden">
        {/* Left panel: controls + queue/history */}
        <div
          className="flex flex-col overflow-hidden sidebar-transition"
          style={{ width: sidebarCollapsed ? 0 : sidebarWidth, minWidth: sidebarCollapsed ? 0 : 280 }}
        >
          {!sidebarCollapsed && (
            <>
              <div className="px-4 pt-4 pb-4 shrink-0">
                <FileDropZone onFilesAdded={addFiles} disabled={!keyPresent} />
              </div>

              {/* Tab bar */}
              <div className="flex items-center gap-4 px-4 pb-1 border-b border-p-border-subtle shrink-0">
                <button
                  onClick={() => setSidebarTab('queue')}
                  className={`tab-underline text-xs tab-transition ${
                    sidebarTab === 'queue' ? 'tab-underline-active' : 'text-p-text-dim hover:text-p-text'
                  }`}
                >
                  Queue{jobs.length > 0 ? ` (${jobs.length})` : ''}
                </button>
                <button
                  onClick={() => setSidebarTab('history')}
                  className={`tab-underline text-xs tab-transition ${
                    sidebarTab === 'history' ? 'tab-underline-active' : 'text-p-text-dim hover:text-p-text'
                  }`}
                >
                  History{history.length > 0 ? ` (${history.length})` : ''}
                </button>
                <button
                  onClick={() => setSidebarTab('log')}
                  className={`tab-underline text-xs tab-transition ${
                    sidebarTab === 'log' ? 'tab-underline-active' : 'text-p-text-dim hover:text-p-text'
                  }`}
                >
                  Log{logEntries.length > 0 ? ` (${logEntries.length})` : ''}
                </button>
              </div>

              {/* Tab content */}
              <div className="flex-1 px-4 pt-3 pb-4 overflow-auto">
                {sidebarTab === 'queue' ? (
                  <Queue
                    jobs={jobs}
                    previewJobId={previewSource === 'queue' ? previewJobId : null}
                    paused={paused}
                    onRemove={removeJob}
                    onRetry={retryJob}
                    onPreview={togglePreview}
                    onCancel={cancelJob}
                    onArchiveCompleted={archiveCompleted}
                    onTogglePause={togglePause}
                    onReorder={reorderJobs}
                  />
                ) : sidebarTab === 'history' ? (
                  <History
                    entries={history}
                    searchQuery={historySearch}
                    onSearchChange={setHistorySearch}
                    activeId={previewSource === 'history' ? previewJobId : null}
                    onPreview={previewHistoryItem}
                    onShowInFolder={(entry) => window.electronAPI?.showInFolder(entry.savedPath)}
                    onDelete={deleteHistoryItem}
                    onClearAll={clearHistory}
                    onReconvert={reconvertFromHistory}
                    onTranslate={translateFromHistory}
                    onExport={handleExportHistory}
                  />
                ) : (
                  <Log
                    entries={logEntries}
                    onClear={() => setLogEntries([])}
                  />
                )}
              </div>
            </>
          )}
        </div>

        {/* Drag handle / separator */}
        <div
          className={`hidden lg:flex items-center justify-center separator-handle ${
            sidebarCollapsed ? 'w-6 cursor-pointer bg-p-surface/50' : 'w-2 cursor-col-resize'
          }`}
          onMouseDown={sidebarCollapsed ? undefined : handleDragStart}
          onDoubleClick={handleSeparatorDoubleClick}
          onClick={sidebarCollapsed ? () => setSidebarCollapsed(false) : undefined}
          title={sidebarCollapsed ? 'Expand sidebar' : 'Drag to resize, double-click to collapse'}
        >
          {sidebarCollapsed && (
            <ChevronRight className="w-3.5 h-3.5 text-p-text-dim" />
          )}
        </div>

        {/* Right panel: preview */}
        <div className={`hidden lg:flex flex-1 flex-col min-w-0 ${showQueuePreview || showHistoryPreview || showOpenedPreview ? 'bg-p-bg-deep' : 'paper-bg'}`}>
          {showOpenedPreview ? (
            <Preview
              markdown={openedFile!.content}
              fileName={openedFile!.fileName}
              savedPath={openedFile!.filePath}
              sourcePath={null}
              onOpenMarkdown={window.electronAPI?.openMarkdownFile ? handleOpenMarkdown : undefined}
              onSaveCleaned={window.electronAPI?.writeMarkdown ? handleSaveCleanedOpened : undefined}
            />
          ) : !keyPresent ? (
            <Welcome
              onOpenSettings={() => setSettingsOpen(true)}
              onSelectProvider={(provider) => {
                setSettingsInitialProvider(provider);
                setSettingsOpen(true);
              }}
            />
          ) : showQueuePreview ? (
            <Preview
              job={previewJob}
              onOpenMarkdown={window.electronAPI?.openMarkdownFile ? handleOpenMarkdown : undefined}
            />
          ) : showHistoryPreview ? (
            <Preview
              markdown={historyMarkdown!}
              fileName={previewHistoryEntry!.fileName}
              savedPath={previewHistoryEntry!.savedPath}
              sourcePath={previewHistoryEntry!.sourcePath}
              onOpenMarkdown={window.electronAPI?.openMarkdownFile ? handleOpenMarkdown : undefined}
              onSaveCleaned={handleSaveCleanedHistory}
            />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-p-text-dim text-sm relative z-10 gap-4">
              <p style={{ fontFamily: 'var(--font-display)' }}>
                {jobs.some(j => j.status === 'done') || history.length > 0
                  ? 'Select an item to preview'
                  : 'Converted markdown will appear here'}
              </p>
              {window.electronAPI?.openMarkdownFile && (
                <button
                  onClick={() => handleOpenMarkdown()}
                  className="btn-ghost text-xs"
                  title="Open an existing markdown file to view or export"
                >
                  Open markdown file...
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Settings modal */}
      <Settings
        open={settingsOpen}
        onClose={() => { setSettingsOpen(false); setSettingsInitialProvider(null); setKeyPresent(hasApiKey()); }}
        initialProvider={settingsInitialProvider}
      />
    </div>
  );
}
