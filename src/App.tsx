import { useState, useCallback, useEffect, useRef } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import type { ConversionJob, HistoryEntry, LogEntry } from './types';
import { createJob } from './types';
import { hasApiKey } from './lib/apiKey';
import { convertFile } from './lib/convert';
import { canSaveToSource, runAutoExport, exportHistoryAsCsv } from './lib/download';
import { getSettings } from './lib/settings';
import Header from './components/Header';
import ApiKeyInput from './components/ApiKeyInput';
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
  const [previewSource, setPreviewSource] = useState<'queue' | 'history'>('queue');
  const [historyMarkdown, setHistoryMarkdown] = useState<string | null>(null);
  const [historySearch, setHistorySearch] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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
        const exists = await window.electronAPI.fileExists(entry.sourcePath);
        if (!exists) continue;

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
            ? `Resumable (${progress.completedBatches}/${progress.totalBatches} batches done)`
            : 'Queued',
          markdown: null,
          error: null,
          startedAt: null,
          completedAt: null,
          resumeFrom: progress?.completedBatches,
        });
      }

      if (rehydratedJobs.length > 0) {
        setJobs(rehydratedJobs);
      }
    }
    rehydrate();
  }, []);

  // ── Eager persistence: queue + auto-archive done jobs to history ────────
  const persistQueueRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(persistQueueRef.current);
    persistQueueRef.current = setTimeout(() => {
      // Auto-archive done jobs to history so they survive app close
      const doneJobs = jobs.filter(j => j.status === 'done' && j.savedPath && j.sourcePath);
      if (doneJobs.length > 0) {
        const existingPaths = new Set(historyRef.current.map(h => h.sourcePath));
        const newEntries: HistoryEntry[] = doneJobs
          .filter(j => !existingPaths.has(j.sourcePath!))
          .map(j => ({
            id: j.id,
            fileName: j.fileName,
            sourcePath: j.sourcePath!,
            savedPath: j.savedPath!,
            totalPages: j.totalPages,
            convertedAt: j.completedAt!,
            durationMs: (j.completedAt ?? 0) - (j.startedAt ?? 0),
          }));
        if (newEntries.length > 0) {
          setHistory(prev => [...newEntries, ...prev].sort((a, b) => b.convertedAt - a.convertedAt));
        }
      }

      // Save only queued/converting jobs to queue.json
      const entries = jobs
        .filter(j => j.status === 'queued' || j.status === 'converting')
        .map(j => ({
          id: j.id,
          fileName: j.fileName,
          sourcePath: j.sourcePath!,
          status: (j.status === 'converting' ? 'interrupted' : 'queued') as 'queued' | 'interrupted',
          totalPages: j.totalPages,
          totalBatches: j.totalBatches,
          completedBatches: j.currentBatch,
          addedAt: j.startedAt ?? Date.now(),
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
        // Reconstruct File object if rehydrated
        let fileObj = nextJob.file;
        if (!fileObj || !(fileObj instanceof File) || fileObj.size === 0) {
          if (!nextJob.sourcePath) throw new Error('Source PDF path not available');
          const buffer = await window.electronAPI!.readPdf(nextJob.sourcePath);
          fileObj = new File([buffer], nextJob.fileName, { type: 'application/pdf' });
        }

        // Load partial progress for resume
        let resumeFrom = undefined;
        if (nextJob.resumeFrom && nextJob.resumeFrom > 0) {
          resumeFrom = (await window.electronAPI?.loadProgress(jobId)) ?? undefined;
        }

        const fileName = nextJob.fileName;
        const conversionStart = Date.now();
        let lastActiveModel = '';
        addLogEntry(jobId, fileName, 'info', `Started converting ${fileName}`);

        const markdown = await convertFile({
          file: fileObj,
          jobId,
          sourcePath: nextJob.sourcePath || '',
          onProgress: update => {
            updateJob(jobId, update);
            // Log model changes (covers scanning + batch phases)
            if (update.activeModel && update.activeModel !== lastActiveModel) {
              addLogEntry(jobId, fileName, 'info', `Using model: ${update.activeModel}`);
            }
            if (update.activeModel) lastActiveModel = update.activeModel;
            // Log key phase transitions
            if (update.statusMessage?.startsWith('Scanning document')) {
              addLogEntry(jobId, fileName, 'info', 'Scanning document structure...');
            }
            if (update.statusMessage?.startsWith('Structure scan complete')) {
              addLogEntry(jobId, fileName, 'success', update.statusMessage);
            }
            // Log every error from the Gemini API
            if (update.errorDetail) {
              addLogEntry(jobId, fileName, 'error', update.errorDetail);
            }
          },
          onBatchComplete: async (progress) => {
            await window.electronAPI?.saveProgress(progress);
            addLogEntry(jobId, fileName, 'info', `Batch ${progress.completedBatches}/${progress.totalBatches} complete${lastActiveModel ? ` (${lastActiveModel})` : ''}`);
            // Check pause between batches — abort if paused
            if (pausedRef.current) {
              controller.abort();
            }
          },
          resumeFrom,
          abortSignal: controller.signal,
          translationLanguage: nextJob.translationLanguage,
        });

        // Clean up progress file
        await window.electronAPI?.deleteProgress(jobId);

        // Auto-export to selected formats
        let savedPath: string | null = null;
        let saveError = '';
        if (nextJob.sourcePath && canSaveToSource()) {
          try {
            const result = await runAutoExport(nextJob.sourcePath, nextJob.fileName, markdown, jobId);
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

  // F2: Duplicate detection in addFiles
  const addFiles = useCallback(
    (files: File[]) => {
      const { translationEnabled, translationLanguage } = getSettings();
      const transLang = translationEnabled && translationLanguage ? translationLanguage : undefined;
      const historyMap = new Map(historyRef.current.map(h => [h.sourcePath, h]));
      const newJobs = files.map(f => {
        const job = createJob(f);
        if (transLang) job.translationLanguage = transLang;
        const prev = job.sourcePath ? historyMap.get(job.sourcePath) : null;
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
    (id: string) => {
      setJobs(prev =>
        prev.map(j =>
          j.id === id
            ? {
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
              }
            : j,
        ),
      );
      window.electronAPI?.deleteProgress(id);
      setTimeout(processQueue, 50);
    },
    [processQueue],
  );

  const archiveCompleted = useCallback(() => {
    setJobs(prev => {
      const doneJobs = prev.filter(j => j.status === 'done' && j.savedPath);
      if (doneJobs.length > 0) {
        const newEntries: HistoryEntry[] = doneJobs.map(j => ({
          id: j.id,
          fileName: j.fileName,
          sourcePath: j.sourcePath!,
          savedPath: j.savedPath!,
          totalPages: j.totalPages,
          convertedAt: j.completedAt!,
          durationMs: (j.completedAt ?? 0) - (j.startedAt ?? 0),
        }));

        setHistory(prevHistory => {
          const sourceMap = new Map(prevHistory.map(h => [h.sourcePath, h]));
          for (const entry of newEntries) sourceMap.set(entry.sourcePath, entry);
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
  }, []);

  // ── History actions ───────────────────────────────────────────────────────
  const previewHistoryItem = useCallback(async (entry: HistoryEntry) => {
    setPreviewSource('history');
    setPreviewJobId(entry.id);
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

  // ── Derived state ─────────────────────────────────────────────────────────
  const previewJob = jobs.find(j => j.id === previewJobId && j.status === 'done');
  const previewHistoryEntry = history.find(h => h.id === previewJobId);

  const showQueuePreview = previewSource === 'queue' && previewJob;
  const showHistoryPreview = previewSource === 'history' && previewHistoryEntry && historyMarkdown;

  return (
    <div className="flex flex-col h-screen bg-p-bg">
      <Header
        theme={theme}
        onToggleTheme={toggleTheme}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div className="flex-1 flex overflow-hidden">
        {/* Left panel: controls + queue/history */}
        <div className={`flex flex-col border-r border-p-border overflow-hidden sidebar-transition ${
          sidebarCollapsed ? 'w-12' : 'w-full lg:w-[420px]'
        }`}>
          {sidebarCollapsed ? (
            <div className="flex flex-col items-center pt-4">
              <button
                onClick={() => setSidebarCollapsed(false)}
                className="p-2.5 rounded-lg text-p-text-muted hover:text-p-text hover:bg-p-surface-hover tab-transition"
                title="Expand sidebar"
              >
                <PanelLeftOpen className="w-5 h-5" />
              </button>
            </div>
          ) : (
            <>
              {/* Collapse button + API key row */}
              <div className="flex items-center gap-2 px-4 pt-4 pb-2 shrink-0">
                <div className="flex-1 min-w-0">
                  <ApiKeyInput onKeyChanged={() => setKeyPresent(hasApiKey())} />
                </div>
                <button
                  onClick={() => setSidebarCollapsed(true)}
                  className="p-2.5 rounded-lg text-p-text-muted hover:text-p-text hover:bg-p-surface-hover tab-transition shrink-0"
                  title="Collapse sidebar"
                >
                  <PanelLeftClose className="w-5 h-5" />
                </button>
              </div>

              <div className="px-4 pb-4 shrink-0">
                <FileDropZone onFilesAdded={addFiles} disabled={!keyPresent} />
              </div>

              {/* Tab bar */}
              <div className="flex items-center gap-1 px-4 pb-2 shrink-0">
                <button
                  onClick={() => setSidebarTab('queue')}
                  className={`px-3 py-1.5 text-xs rounded-md tab-transition ${
                    sidebarTab === 'queue'
                      ? 'bg-p-accent/15 text-p-accent font-medium'
                      : 'text-p-text-dim hover:text-p-text hover:bg-p-surface-hover'
                  }`}
                >
                  Queue{jobs.length > 0 ? ` (${jobs.length})` : ''}
                </button>
                <button
                  onClick={() => setSidebarTab('history')}
                  className={`px-3 py-1.5 text-xs rounded-md tab-transition ${
                    sidebarTab === 'history'
                      ? 'bg-p-accent/15 text-p-accent font-medium'
                      : 'text-p-text-dim hover:text-p-text hover:bg-p-surface-hover'
                  }`}
                >
                  History{history.length > 0 ? ` (${history.length})` : ''}
                </button>
                <button
                  onClick={() => setSidebarTab('log')}
                  className={`px-3 py-1.5 text-xs rounded-md tab-transition ${
                    sidebarTab === 'log'
                      ? 'bg-p-accent/15 text-p-accent font-medium'
                      : 'text-p-text-dim hover:text-p-text hover:bg-p-surface-hover'
                  }`}
                >
                  Log{logEntries.length > 0 ? ` (${logEntries.length})` : ''}
                </button>
              </div>

              {/* Tab content */}
              <div className="flex-1 px-4 pb-4 overflow-auto">
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

        {/* Right panel: preview */}
        <div className="hidden lg:flex flex-1 flex-col bg-p-bg-deep min-w-0">
          {showQueuePreview ? (
            <Preview job={previewJob} />
          ) : showHistoryPreview ? (
            <Preview
              markdown={historyMarkdown!}
              fileName={previewHistoryEntry!.fileName}
              savedPath={previewHistoryEntry!.savedPath}
              sourcePath={previewHistoryEntry!.sourcePath}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-p-text-dim text-sm">
              {jobs.some(j => j.status === 'done') || history.length > 0
                ? 'Select an item to preview'
                : 'Converted markdown will appear here'}
            </div>
          )}
        </div>
      </div>

      {/* Settings modal */}
      <Settings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
