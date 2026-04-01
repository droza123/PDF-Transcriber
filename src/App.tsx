import { useState, useCallback, useEffect, useRef } from 'react';
import type { ConversionJob } from './types';
import { createJob } from './types';
import { hasApiKey } from './lib/apiKey';
import { convertFile } from './lib/convert';
import { saveMarkdownToSource, canSaveToSource } from './lib/download';
import Header from './components/Header';
import ApiKeyInput from './components/ApiKeyInput';
import FileDropZone from './components/FileDropZone';
import Queue from './components/Queue';
import Preview from './components/Preview';

export default function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    (localStorage.getItem('theme') as 'dark' | 'light') || 'dark',
  );
  const [keyPresent, setKeyPresent] = useState(hasApiKey);
  const [jobs, setJobs] = useState<ConversionJob[]>([]);
  const [previewJobId, setPreviewJobId] = useState<string | null>(null);
  const processingRef = useRef(false);

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme(t => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  const updateJob = useCallback((id: string, update: Partial<ConversionJob>) => {
    setJobs(prev => prev.map(j => (j.id === id ? { ...j, ...update } : j)));
  }, []);

  // Process queue sequentially
  const processQueue = useCallback(async () => {
    if (processingRef.current) return;
    processingRef.current = true;

    while (true) {
      // Find next queued job from current state
      let nextJob: ConversionJob | undefined;
      setJobs(prev => {
        nextJob = prev.find(j => j.status === 'queued');
        return prev;
      });

      // Need to await state update
      await new Promise(resolve => setTimeout(resolve, 0));

      // Re-read after state settles
      let currentJobs: ConversionJob[] = [];
      setJobs(prev => {
        currentJobs = prev;
        return prev;
      });
      await new Promise(resolve => setTimeout(resolve, 0));

      nextJob = currentJobs.find(j => j.status === 'queued');
      if (!nextJob) break;

      const jobId = nextJob.id;

      try {
        const markdown = await convertFile(nextJob.file, update => {
          updateJob(jobId, update);
        });

        // Auto-save to source folder if possible
        let savedPath: string | null = null;
        if (nextJob.sourcePath && canSaveToSource()) {
          try {
            savedPath = await saveMarkdownToSource(nextJob.sourcePath, markdown);
          } catch {
            // Save failed — user can still download manually
          }
        }

        updateJob(jobId, {
          status: 'done',
          progress: 100,
          markdown,
          savedPath,
          statusMessage: savedPath ? 'Saved' : 'Done',
          completedAt: Date.now(),
        });
      } catch (error: any) {
        updateJob(jobId, {
          status: 'error',
          error: error.message || 'Conversion failed',
          statusMessage: 'Error',
          completedAt: Date.now(),
        });
      }
    }

    processingRef.current = false;
  }, [updateJob]);

  const addFiles = useCallback(
    (files: File[]) => {
      const newJobs = files.map(createJob);
      setJobs(prev => [...prev, ...newJobs]);
      // Kick queue processing after state update
      setTimeout(processQueue, 50);
    },
    [processQueue],
  );

  const removeJob = useCallback(
    (id: string) => {
      setJobs(prev => prev.filter(j => j.id !== id));
      if (previewJobId === id) setPreviewJobId(null);
    },
    [previewJobId],
  );

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
              }
            : j,
        ),
      );
      setTimeout(processQueue, 50);
    },
    [processQueue],
  );

  const clearCompleted = useCallback(() => {
    setJobs(prev => prev.filter(j => j.status !== 'done'));
    setPreviewJobId(null);
  }, []);

  const togglePreview = useCallback((id: string) => {
    setPreviewJobId(prev => (prev === id ? null : id));
  }, []);

  const previewJob = jobs.find(j => j.id === previewJobId && j.status === 'done');

  return (
    <div className="flex flex-col h-screen bg-p-bg">
      <Header theme={theme} onToggleTheme={toggleTheme} hasKey={keyPresent} />

      <div className="flex-1 flex overflow-hidden">
        {/* Left panel: controls + queue */}
        <div className="w-full lg:w-[420px] flex flex-col border-r border-p-border overflow-auto">
          <div className="p-4 space-y-4">
            <ApiKeyInput onKeyChanged={() => setKeyPresent(hasApiKey())} />
            <FileDropZone onFilesAdded={addFiles} disabled={!keyPresent} />
          </div>
          <div className="flex-1 px-4 pb-4 overflow-auto">
            <Queue
              jobs={jobs}
              previewJobId={previewJobId}
              onRemove={removeJob}
              onRetry={retryJob}
              onPreview={togglePreview}
              onClearCompleted={clearCompleted}
            />
          </div>
        </div>

        {/* Right panel: preview */}
        <div className="hidden lg:flex flex-1 flex-col bg-p-bg-deep">
          {previewJob ? (
            <Preview job={previewJob} />
          ) : (
            <div className="flex-1 flex items-center justify-center text-p-text-dim text-sm">
              {jobs.some(j => j.status === 'done')
                ? 'Click the eye icon on a completed file to preview'
                : 'Converted markdown will appear here'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
