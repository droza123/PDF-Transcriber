import type { ConversionJob, HistoryEntry } from '../types';
import { getSettings, saveSettings } from './settings';

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

/**
 * Strip whatever extension is on `fileName` and append `newExt` (must include
 * the leading dot). Used by the export helpers — historically they assumed
 * the filename always ended in `.pdf`, but the Preview now also serves
 * already-converted history items and externally opened `.md` files, so a
 * simple `.replace(/\.pdf$/i, ext)` is a no-op for those and the wrong
 * extension ends up on the saved file.
 */
function withExtension(fileName: string, newExt: string): string {
  return fileName.replace(/\.[^./\\]+$/, '') + newExt;
}

/** Cross-platform `path.dirname` for renderer use. */
function dirOf(filePath: string | null | undefined): string {
  if (!filePath) return '';
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return idx > 0 ? filePath.slice(0, idx) : '';
}

/** Resolve the starting directory for a Save As / Open dialog. Prefer the
 *  caller-supplied directory (the previewed file's folder); fall back to the
 *  last folder the user browsed to via a dialog. */
function resolveDefaultDir(preferred?: string | null): string | undefined {
  if (preferred) return preferred;
  const last = getSettings().lastBrowsedDir;
  return last || undefined;
}

/** Update the persisted "last browsed folder" from a freshly-saved file path. */
export function rememberBrowsedDir(filePath: string | null | undefined): void {
  const dir = dirOf(filePath);
  if (dir) saveSettings({ lastBrowsedDir: dir });
}

/** Save (Electron) or download (browser fallback) a file. In Electron it pops
 *  a native Save As dialog seeded with `<defaultDir>/<fileName>`. */
async function saveOrDownload(
  data: string | ArrayBuffer,
  fileName: string,
  mimeType: string,
  filters: { name: string; extensions: string[] }[],
  defaultDir?: string | null,
  isBinary = false,
): Promise<void> {
  if (window.electronAPI?.saveFileAs) {
    const dir = resolveDefaultDir(defaultDir);
    const defaultPath = dir ? `${dir.replace(/[\\/]+$/, '')}/${fileName}` : fileName;
    const saved = await window.electronAPI.saveFileAs({
      defaultPath,
      content: data,
      filters,
      isBinary,
    });
    if (saved) rememberBrowsedDir(saved);
    return;
  }
  // Browser fallback — no real file picker, drops into the Downloads folder.
  const blob = isBinary ? new Blob([data]) : new Blob([data], { type: mimeType });
  downloadBlob(blob, fileName);
}

/** Download / Save a single markdown file. */
export async function downloadMarkdown(fileName: string, content: string, defaultDir?: string | null): Promise<void> {
  await saveOrDownload(
    content,
    withExtension(fileName, '.md'),
    'text/markdown;charset=utf-8',
    [{ name: 'Markdown', extensions: ['md'] }, { name: 'All Files', extensions: ['*'] }],
    defaultDir,
  );
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

// ── JSON export ─────────────────────────────────────────────────────────────

/** Build a structured JSON string from markdown content. */
export function buildJsonExport(markdownContent: string): string {
  // Extract YAML frontmatter
  const metadata: Record<string, string | number> = {};
  let body = markdownContent;
  const fmMatch = markdownContent.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fmMatch) {
    for (const line of fmMatch[1].split('\n')) {
      const idx = line.indexOf(': ');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      let val: string | number = line.slice(idx + 2).trim();
      // Unquote strings
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      // Parse numbers
      const num = Number(val);
      if (!isNaN(num) && val !== '') val = num;
      metadata[key] = val;
    }
    body = markdownContent.slice(fmMatch[0].length);
  }

  // Extract outline section
  let outline: string | null = null;
  const outlineMatch = body.match(/<!--\s*Document Outline\s*-->\n\n([\s\S]*?)\n\n---\n/);
  if (outlineMatch) {
    outline = outlineMatch[1].trim();
    body = body.slice(0, outlineMatch.index!) + body.slice(outlineMatch.index! + outlineMatch[0].length);
  }

  // Split body into sections by headings
  const sections: { level: number; heading: string | null; content: string }[] = [];
  const headingRegex = /^(#{1,6})\s+(.+)$/gm;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = headingRegex.exec(body)) !== null) {
    // Content before this heading
    const contentBefore = body.slice(lastIndex, match.index).trim();
    if (lastIndex === 0 && contentBefore) {
      sections.push({ level: 0, heading: null, content: contentBefore });
    } else if (sections.length > 0 && contentBefore) {
      sections[sections.length - 1].content = contentBefore;
    }
    sections.push({ level: match[1].length, heading: match[2], content: '' });
    lastIndex = match.index + match[0].length;
  }

  // Remaining content after last heading
  const remaining = body.slice(lastIndex).trim();
  if (sections.length > 0 && remaining) {
    sections[sections.length - 1].content = remaining;
  } else if (sections.length === 0 && remaining) {
    sections.push({ level: 0, heading: null, content: remaining });
  }

  return JSON.stringify({ metadata, outline, sections }, null, 2);
}

/** Export markdown as a JSON file. */
export async function exportAsJson(fileName: string, markdownContent: string, defaultDir?: string | null): Promise<void> {
  const json = buildJsonExport(markdownContent);
  await saveOrDownload(
    json,
    withExtension(fileName, '.json'),
    'application/json;charset=utf-8',
    [{ name: 'JSON', extensions: ['json'] }, { name: 'All Files', extensions: ['*'] }],
    defaultDir,
  );
}

/** Export markdown as a formatted HTML file. */
export async function exportAsHtml(fileName: string, markdownContent: string, defaultDir?: string | null): Promise<void> {
  const title = withExtension(fileName, '');
  const html = await renderMarkdownToHtml(markdownContent, title);
  await saveOrDownload(
    html,
    withExtension(fileName, '.html'),
    'text/html;charset=utf-8',
    [{ name: 'HTML', extensions: ['html', 'htm'] }, { name: 'All Files', extensions: ['*'] }],
    defaultDir,
  );
}

/** Export markdown as a DOCX (Word) file with native footnotes via Electron main process. */
export async function exportAsDocx(
  fileName: string,
  markdownContent: string,
  onExporting?: (exporting: boolean) => void,
  format?: 'standard' | 'logos',
  defaultDir?: string | null,
): Promise<void> {
  try {
    if (!window.electronAPI?.convertMarkdownToDocx) {
      alert('DOCX export requires the desktop app.');
      return;
    }
    onExporting?.(true);
    const buffer = await window.electronAPI.convertMarkdownToDocx(markdownContent, format || 'standard');
    const ext = format === 'logos' ? '.logos.docx' : '.docx';
    await saveOrDownload(
      buffer,
      withExtension(fileName, ext),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      [{ name: 'Word document', extensions: ['docx'] }, { name: 'All Files', extensions: ['*'] }],
      defaultDir,
      true,
    );
  } catch (e: any) {
    console.error('[docx export] Failed:', e);
    alert(`DOCX export failed: ${e.message || 'Unknown error'}`);
  } finally {
    onExporting?.(false);
  }
}

/**
 * Build an effective source path that includes the translation language in the
 * filename. The IPC save handlers derive the output name from this path, so
 * `document.Spanish.pdf` → `document.Spanish.md`, etc.
 */
function effectiveSourcePath(sourcePath: string, translationLanguage?: string): string {
  if (!translationLanguage) return sourcePath;
  const lastDot = sourcePath.lastIndexOf('.');
  if (lastDot === -1) return `${sourcePath}.${translationLanguage}`;
  return `${sourcePath.slice(0, lastDot)}.${translationLanguage}${sourcePath.slice(lastDot)}`;
}

/** Auto-export to all formats selected in settings. Always stores markdown internally. */
export async function runAutoExport(
  sourcePath: string,
  fileName: string,
  markdown: string,
  jobId: string,
  translationLanguage?: string,
): Promise<{ savedPath: string | null; errors: string[] }> {
  const api = window.electronAPI;
  if (!api) return { savedPath: null, errors: [] };

  const { autoExportFormats, fileNaming } = getSettings();
  const unique = fileNaming === 'unique';
  const errors: string[] = [];
  let savedPath: string | null = null;

  // For translations, include the language in the output filename
  const outPath = effectiveSourcePath(sourcePath, translationLanguage);

  // Always store markdown internally for re-export / preview
  try {
    await api.saveInternalMarkdown(jobId, markdown);
  } catch (e: any) {
    errors.push(`internal save: ${e.message}`);
  }

  for (const fmt of autoExportFormats) {
    try {
      switch (fmt) {
        case 'md': {
          savedPath = await api.saveMarkdown(outPath, markdown, unique);
          break;
        }
        case 'html': {
          const title = withExtension(fileName, '');
          const html = await renderMarkdownToHtml(markdown, title);
          await api.saveFile(outPath, html, 'html', unique);
          break;
        }
        case 'json': {
          const json = buildJsonExport(markdown);
          await api.saveFile(outPath, json, 'json', unique);
          break;
        }
        case 'docx': {
          const buffer = await api.convertMarkdownToDocx(markdown, 'standard');
          await api.saveFile(outPath, buffer, 'docx', unique);
          break;
        }
        case 'docx-logos': {
          const buffer = await api.convertMarkdownToDocx(markdown, 'logos');
          await api.saveFile(outPath, buffer, 'logos.docx', unique);
          break;
        }
      }
    } catch (e: any) {
      errors.push(`${fmt}: ${e.message}`);
    }
  }

  return { savedPath, errors };
}
