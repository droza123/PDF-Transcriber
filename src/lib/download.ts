import JSZip from 'jszip';
import type { ConversionJob, HistoryEntry } from '../types';

// ── Shared HTML rendering (lazy-loaded to avoid crashing on import) ──────────

const DOCUMENT_CSS = `
  body { font-family: Georgia, 'Times New Roman', serif; max-width: 800px; margin: 2em auto; padding: 0 1em; line-height: 1.7; color: #1a1a1a; }
  h1 { font-size: 1.8em; border-bottom: 1px solid #ddd; padding-bottom: 0.3em; }
  h2 { font-size: 1.4em; border-bottom: 1px solid #eee; padding-bottom: 0.2em; }
  h3 { font-size: 1.2em; }
  h1,h2,h3,h4,h5,h6 { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin-top: 1.5em; }
  pre { background: #f4f4f4; padding: 1em; border-radius: 4px; overflow-x: auto; }
  code { background: #f4f4f4; padding: 0.15em 0.3em; border-radius: 3px; font-size: 0.9em; }
  blockquote { border-left: 3px solid #ccc; margin-left: 0; padding-left: 1em; color: #555; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #ddd; padding: 0.5em; text-align: left; }
  th { background: #f8f8f8; font-weight: 600; }
  sup a { color: #2563eb; text-decoration: none; }
  hr { border: none; border-top: 1px solid #ddd; margin: 2em 0; }
  .footnotes { border-top: 1px solid #ddd; margin-top: 2em; padding-top: 1em; font-size: 0.9em; color: #555; }
  .frontmatter { background: #f4f4f4; border: 1px solid #e0e0e0; border-radius: 6px; padding: 0.8em 1em; font-family: Consolas, 'Courier New', monospace; font-size: 0.85em; color: #555; margin-bottom: 1.5em; white-space: pre-wrap; line-height: 1.6; }
  .page-marker { display: block; color: #b8976a; font-family: Consolas, 'Courier New', monospace; font-size: 0.8em; margin: 1.5em 0 0.5em; }
  .outline-marker { display: block; color: #b8976a; font-family: Consolas, 'Courier New', monospace; font-size: 0.8em; margin: 1em 0 0.5em; }
`;

/** Preprocess markdown for export: extract frontmatter, style comments. */
function preprocessMarkdown(markdown: string): { frontmatterHtml: string; body: string } {
  let frontmatterHtml = '';
  let body = markdown;

  // Extract YAML frontmatter
  const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fmMatch) {
    const escaped = fmMatch[1].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    frontmatterHtml = `<div class="frontmatter">${escaped}</div>`;
    body = markdown.slice(fmMatch[0].length);
  }

  // Replace HTML comments with visible markers (these won't be rendered by ReactMarkdown)
  body = body.replace(
    /<!--\s*(page:\s*.+?)\s*-->/g,
    '<span class="page-marker">&lt;!-- $1 --&gt;</span>',
  );
  body = body.replace(
    /<!--\s*(Document Outline)\s*-->/g,
    '<span class="outline-marker">&lt;!-- $1 --&gt;</span>',
  );

  return { frontmatterHtml, body };
}

/** Render markdown to a full HTML document string. */
async function renderMarkdownToHtml(markdown: string, title: string): Promise<string> {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const ReactMarkdown = (await import('react-markdown')).default;
  const remarkGfm = (await import('remark-gfm')).default;
  const rehypeRaw = (await import('rehype-raw').catch(() => ({ default: undefined }))).default;

  const { frontmatterHtml, body } = preprocessMarkdown(markdown);

  const plugins: any[] = [remarkGfm];
  const rehypePlugins: any[] = rehypeRaw ? [rehypeRaw] : [];

  const renderedBody = renderToStaticMarkup(
    createElement(ReactMarkdown, { remarkPlugins: plugins, rehypePlugins } as any, body),
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>${DOCUMENT_CSS}</style>
</head>
<body>
${frontmatterHtml}
${renderedBody}
</body>
</html>`;
}

// ── File operations ──────────────────────────────────────────────────────────

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

// ── Download helpers ─────────────────────────────────────────────────────────

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Download a single markdown file. */
export function downloadMarkdown(fileName: string, content: string): void {
  const mdName = fileName.replace(/\.pdf$/i, '.md');
  downloadBlob(new Blob([content], { type: 'text/markdown;charset=utf-8' }), mdName);
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
  const date = new Date().toISOString().split('T')[0];
  downloadBlob(
    new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' }),
    `conversion-history-${date}.csv`,
  );
}

/** Export markdown as a formatted HTML file. */
export async function exportAsHtml(fileName: string, markdownContent: string): Promise<void> {
  const title = fileName.replace(/\.pdf$/i, '');
  const html = await renderMarkdownToHtml(markdownContent, title);
  downloadBlob(
    new Blob([html], { type: 'text/html;charset=utf-8' }),
    fileName.replace(/\.pdf$/i, '.html'),
  );
}

/** Export markdown as a DOCX (Word) file with native footnotes via Electron main process. */
export async function exportAsDocx(
  fileName: string,
  markdownContent: string,
  onExporting?: (exporting: boolean) => void,
): Promise<void> {
  try {
    if (!window.electronAPI?.convertMarkdownToDocx) {
      alert('DOCX export requires the desktop app.');
      return;
    }
    onExporting?.(true);
    const buffer = await window.electronAPI.convertMarkdownToDocx(markdownContent);
    downloadBlob(new Blob([buffer]), fileName.replace(/\.pdf$/i, '.docx'));
  } catch (e: any) {
    console.error('[docx export] Failed:', e);
    alert(`DOCX export failed: ${e.message || 'Unknown error'}`);
  } finally {
    onExporting?.(false);
  }
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
  downloadBlob(blob, `converted-pdfs-${date}.zip`);
}
