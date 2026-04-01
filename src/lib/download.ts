import JSZip from 'jszip';
import type { ConversionJob } from '../types';

declare global {
  interface Window {
    electronAPI?: {
      saveMarkdown: (sourcePdfPath: string, content: string) => Promise<string>;
      showInFolder: (filePath: string) => Promise<void>;
    };
  }
}

/** Save markdown file next to the source PDF (Electron only). Returns the saved path. */
export async function saveMarkdownToSource(
  sourcePdfPath: string,
  content: string,
): Promise<string> {
  return window.electronAPI!.saveMarkdown(sourcePdfPath, content);
}

/** Reveal a file in the system file explorer (Electron only). */
export function showInFolder(filePath: string): void {
  window.electronAPI?.showInFolder(filePath);
}

/** Whether the Electron file-save API is available. */
export function canSaveToSource(): boolean {
  return !!window.electronAPI;
}

/** Download a single markdown file (browser fallback). */
export function downloadMarkdown(fileName: string, content: string): void {
  const mdName = fileName.replace(/\.pdf$/i, '.md');
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = mdName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Download all completed jobs as a ZIP file. */
export async function downloadAllAsZip(jobs: ConversionJob[]): Promise<void> {
  const doneJobs = jobs.filter(j => j.status === 'done' && j.markdown);
  if (doneJobs.length === 0) return;

  const zip = new JSZip();
  for (const job of doneJobs) {
    const mdName = job.fileName.replace(/\.pdf$/i, '.md');
    zip.file(mdName, job.markdown!);
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const date = new Date().toISOString().split('T')[0];
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `converted-pdfs-${date}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
