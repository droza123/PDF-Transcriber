import JSZip from 'jszip';
import type { ConversionJob, HistoryEntry } from '../types';

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

/** Export history entries as CSV. */
export function exportHistoryAsCsv(entries: HistoryEntry[]): void {
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const rows = [
    'File Name,Source Path,Saved Path,Pages,Converted At,Duration (s)',
    ...entries.map(e =>
      [
        esc(e.fileName),
        esc(e.sourcePath),
        esc(e.savedPath),
        e.totalPages,
        new Date(e.convertedAt).toISOString(),
        Math.round(e.durationMs / 1000),
      ].join(','),
    ),
  ];
  const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
  const date = new Date().toISOString().split('T')[0];
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `conversion-history-${date}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Export markdown as a standalone HTML file. */
export function exportAsHtml(fileName: string, markdownContent: string): void {
  const title = fileName.replace(/\.pdf$/i, '');
  // Simple HTML template with basic styling
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; max-width: 800px; margin: 2em auto; padding: 0 1em; line-height: 1.7; color: #1a1a1a; }
  h1,h2,h3,h4,h5,h6 { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin-top: 1.5em; }
  pre { background: #f4f4f4; padding: 1em; border-radius: 4px; overflow-x: auto; }
  code { background: #f4f4f4; padding: 0.15em 0.3em; border-radius: 3px; font-size: 0.9em; }
  blockquote { border-left: 3px solid #ccc; margin-left: 0; padding-left: 1em; color: #555; }
  table { border-collapse: collapse; width: 100%; } th, td { border: 1px solid #ddd; padding: 0.5em; text-align: left; }
  sup a { color: #2563eb; text-decoration: none; }
  .page-marker { color: #b8976a; font-family: monospace; font-size: 0.85em; }
</style>
</head>
<body>
<pre style="white-space: pre-wrap; font-family: inherit; background: none; padding: 0;">${markdownContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
</body>
</html>`;
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.replace(/\.pdf$/i, '.html');
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
