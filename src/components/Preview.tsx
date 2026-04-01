import { useState, useEffect, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Check, Download, FolderOpen, Hash, Table2, BookOpen, Footprints, Search, X, ChevronDown, ChevronUp, Columns2, FileText } from 'lucide-react';
import type { ConversionJob } from '../types';
import { downloadMarkdown, showInFolder, exportAsHtml } from '../lib/download';

interface PreviewProps {
  job?: ConversionJob;
  markdown?: string;
  fileName?: string;
  savedPath?: string | null;
  sourcePath?: string | null;
}

export default function Preview({ job, markdown: externalMd, fileName: externalName, savedPath: externalSavedPath, sourcePath: externalSourcePath }: PreviewProps) {
  const [tab, setTab] = useState<'raw' | 'rendered'>('rendered');
  const [copied, setCopied] = useState(false);
  const [sideBySide, setSideBySide] = useState(false);
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState('');
  const [findResult, setFindResult] = useState<{ active: number; total: number } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const findInputRef = useRef<HTMLInputElement>(null);

  const md = job?.markdown ?? externalMd ?? '';
  const fileName = job?.fileName ?? externalName ?? 'document.pdf';
  const resolvedSavedPath = job?.savedPath ?? externalSavedPath ?? null;
  const resolvedSourcePath = job?.sourcePath ?? externalSourcePath ?? null;

  // Extract YAML frontmatter for styled rendering
  let frontmatter = '';
  let body = md;
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fmMatch) {
    frontmatter = fmMatch[1];
    body = md.slice(fmMatch[0].length);
  }

  // Replace HTML comments with backtick-wrapped code so ReactMarkdown renders them
  const renderedBody = body
    .replace(/<!--\s*(page:\s*.+?)\s*-->/g, '`<!-- $1 -->`')
    .replace(/<!--\s*(Document Outline)\s*-->/g, '`<!-- $1 -->`');

  function handleCopy() {
    navigator.clipboard.writeText(md);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // ── F4: Find in page (custom React-based search) ───────────────────────
  const [findActiveIndex, setFindActiveIndex] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setFindOpen(true);
        setTimeout(() => findInputRef.current?.focus(), 50);
      }
      if (e.key === 'Escape' && findOpen) {
        closeFind();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [findOpen]);

  // Count matches in the raw markdown
  const findMatchCount = findText
    ? (md.toLowerCase().match(new RegExp(findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) || []).length
    : 0;

  useEffect(() => {
    setFindActiveIndex(0);
  }, [findText]);

  // Scroll to active match using DOM TreeWalker
  useEffect(() => {
    if (!findText || !contentRef.current || findMatchCount === 0) return;
    const el = contentRef.current;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const escapedTerm = findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escapedTerm, 'gi');
    let matchIndex = 0;

    // Remove old highlights
    el.querySelectorAll('mark[data-find]').forEach(m => {
      const parent = m.parentNode!;
      parent.replaceChild(document.createTextNode(m.textContent || ''), m);
      parent.normalize();
    });

    // Walk text nodes and highlight matches
    const textNodes: { node: Text; start: number }[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.textContent || '';
      let match;
      regex.lastIndex = 0;
      while ((match = regex.exec(text)) !== null) {
        textNodes.push({ node: node as Text, start: match.index });
      }
    }

    // Highlight each match (process in reverse to preserve text offsets)
    for (let i = textNodes.length - 1; i >= 0; i--) {
      const { node: textNode, start } = textNodes[i];
      const range = document.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, start + findText.length);
      const mark = document.createElement('mark');
      mark.setAttribute('data-find', 'true');
      // i is reversed; document-order index for this match is i
      const docOrderIndex = i;
      mark.style.background = docOrderIndex === findActiveIndex ? '#f59e0b' : '#fde68a';
      mark.style.color = '#000';
      mark.style.borderRadius = '2px';
      range.surroundContents(mark);
    }

    // Scroll active match into view
    // Marks are in document order (reverse insertion preserves DOM order)
    const activeMarks = el.querySelectorAll('mark[data-find]');
    const activeEl = activeMarks[findActiveIndex];
    activeEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [findText, findActiveIndex, findMatchCount, tab]);

  // Clean up highlights when closing find
  function closeFind() {
    setFindOpen(false);
    setFindText('');
    setFindActiveIndex(0);
    if (contentRef.current) {
      contentRef.current.querySelectorAll('mark[data-find]').forEach(m => {
        const parent = m.parentNode!;
        parent.replaceChild(document.createTextNode(m.textContent || ''), m);
        parent.normalize();
      });
    }
  }

  function findNext() {
    if (findMatchCount > 0) setFindActiveIndex(i => (i + 1) % findMatchCount);
  }

  function findPrev() {
    if (findMatchCount > 0) setFindActiveIndex(i => (i - 1 + findMatchCount) % findMatchCount);
  }

  // ── F14: Side-by-side PDF ─────────────────────────────────────────────────
  useEffect(() => {
    if (!sideBySide || !resolvedSourcePath) {
      if (pdfBlobUrl) { URL.revokeObjectURL(pdfBlobUrl); setPdfBlobUrl(null); }
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const buffer = await window.electronAPI!.readPdf(resolvedSourcePath);
        if (cancelled) return;
        const blob = new Blob([buffer], { type: 'application/pdf' });
        setPdfBlobUrl(URL.createObjectURL(blob));
      } catch {
        // PDF not available
      }
    })();
    return () => { cancelled = true; };
  }, [sideBySide, resolvedSourcePath]);

  // Clean up blob URL on unmount
  useEffect(() => {
    return () => { if (pdfBlobUrl) URL.revokeObjectURL(pdfBlobUrl); };
  }, [pdfBlobUrl]);

  // Quality stats
  const pageMarkers = (md.match(/<!-- page: .+? -->/g) || []).length;
  const headings = (md.match(/^#{1,6}\s+\S/gm) || []).length;
  const tables = (md.match(/^\|.+\|$/gm) || []).length;
  const footnotes = (md.match(/\[\^\w+\]/g) || []).length;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-p-border shrink-0">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setTab('rendered')}
            className={`px-3 py-1 text-xs rounded-md tab-transition ${
              tab === 'rendered'
                ? 'bg-p-accent/15 text-p-accent font-medium'
                : 'text-p-text-dim hover:text-p-text hover:bg-p-surface-hover'
            }`}
          >
            Rendered
          </button>
          <button
            onClick={() => setTab('raw')}
            className={`px-3 py-1 text-xs rounded-md tab-transition ${
              tab === 'raw'
                ? 'bg-p-accent/15 text-p-accent font-medium'
                : 'text-p-text-dim hover:text-p-text hover:bg-p-surface-hover'
            }`}
          >
            Raw Markdown
          </button>
          {resolvedSourcePath && (
            <button
              onClick={() => setSideBySide(!sideBySide)}
              className={`px-3 py-1 text-xs rounded-md tab-transition ${
                sideBySide
                  ? 'bg-p-accent/15 text-p-accent font-medium'
                  : 'text-p-text-dim hover:text-p-text hover:bg-p-surface-hover'
              }`}
              title="Side-by-side with PDF"
            >
              <Columns2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setFindOpen(true); setTimeout(() => findInputRef.current?.focus(), 50); }}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded text-p-text-dim hover:text-p-text hover:bg-p-surface-hover tab-transition"
            title="Find (Ctrl+F)"
          >
            <Search className="w-3 h-3" />
          </button>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded text-p-text-dim hover:text-p-text hover:bg-p-surface-hover tab-transition"
          >
            {copied ? <Check className="w-3 h-3 text-p-success" /> : <Copy className="w-3 h-3" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          {resolvedSavedPath && (
            <button
              onClick={() => showInFolder(resolvedSavedPath)}
              className="flex items-center gap-1 text-xs px-2 py-1 rounded text-p-text-dim hover:text-p-text hover:bg-p-surface-hover tab-transition"
            >
              <FolderOpen className="w-3 h-3" />
              Show in folder
            </button>
          )}
          {/* Export dropdown */}
          <div className="relative">
            <button
              onClick={() => setExportOpen(!exportOpen)}
              className="flex items-center gap-1 text-xs px-2 py-1 rounded text-p-text-dim hover:text-p-text hover:bg-p-surface-hover tab-transition"
            >
              <Download className="w-3 h-3" />
              Export
              <ChevronDown className="w-3 h-3" />
            </button>
            {exportOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setExportOpen(false)} />
                <div className="absolute right-0 top-full mt-1 z-20 bg-p-surface border border-p-border rounded-lg shadow-lg py-1 min-w-[140px]">
                  <button
                    onClick={() => { downloadMarkdown(fileName, md); setExportOpen(false); }}
                    className="w-full text-left px-3 py-1.5 text-xs text-p-text hover:bg-p-surface-hover tab-transition"
                  >
                    Download .md
                  </button>
                  <button
                    onClick={() => { exportAsHtml(fileName, md); setExportOpen(false); }}
                    className="w-full text-left px-3 py-1.5 text-xs text-p-text hover:bg-p-surface-hover tab-transition"
                  >
                    Export .html
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Find bar */}
      {findOpen && (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-p-border bg-p-surface shrink-0">
          <Search className="w-3.5 h-3.5 text-p-text-dim shrink-0" />
          <input
            ref={findInputRef}
            type="text"
            value={findText}
            onChange={e => setFindText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); findNext(); }
              if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); findPrev(); }
              if (e.key === 'Escape') closeFind();
            }}
            placeholder="Find in document..."
            className="flex-1 px-2 py-1 text-xs bg-p-bg border border-p-border rounded text-p-text placeholder:text-p-text-dim focus:outline-none focus:border-p-accent"
            autoFocus
          />
          <span className="text-xs text-p-text-muted shrink-0">
            {findText ? (findMatchCount > 0 ? `${findActiveIndex + 1} of ${findMatchCount}` : 'No matches') : ''}
          </span>
          <button onClick={findPrev} className="p-1 text-p-text-dim hover:text-p-text" title="Previous (Shift+Enter)">
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
          <button onClick={findNext} className="p-1 text-p-text-dim hover:text-p-text" title="Next (Enter)">
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
          <button onClick={closeFind} className="p-1 text-p-text-dim hover:text-p-text" title="Close (Escape)">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Quality stats */}
      <div className="flex items-center gap-4 px-4 py-2 border-b border-p-border-subtle text-xs text-p-text-dim shrink-0">
        <span className="flex items-center gap-1" title="Page markers found">
          <Hash className="w-3 h-3" /> {pageMarkers} pages
        </span>
        <span className="flex items-center gap-1" title="Headings found">
          <BookOpen className="w-3 h-3" /> {headings} headings
        </span>
        <span className="flex items-center gap-1" title="Table rows found">
          <Table2 className="w-3 h-3" /> {tables} table rows
        </span>
        <span className="flex items-center gap-1" title="Footnote references found">
          <Footprints className="w-3 h-3" /> {footnotes} footnotes
        </span>
        <span className="ml-auto">{(md.length / 1024).toFixed(1)} KB</span>
      </div>

      {/* Content */}
      <div className={`flex-1 overflow-hidden ${sideBySide ? 'flex' : ''}`}>
        {/* PDF pane (F14) */}
        {sideBySide && pdfBlobUrl && (
          <div className="w-1/2 border-r border-p-border">
            <object data={pdfBlobUrl} type="application/pdf" className="w-full h-full">
              <p className="p-4 text-sm text-p-text-dim">PDF preview not available</p>
            </object>
          </div>
        )}

        {/* Markdown pane */}
        <div ref={contentRef} className={`${sideBySide ? 'w-1/2' : 'flex-1'} overflow-auto p-4 h-full`}>
          {tab === 'raw' ? (
            <pre className="text-xs font-mono leading-relaxed whitespace-pre-wrap break-words text-p-text">
              {md}
            </pre>
          ) : (
            <article className="prose prose-sm prose-pdf max-w-none">
              {frontmatter && (
                <pre className="frontmatter-block">{frontmatter}</pre>
              )}
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  code({ children, className, ...props }) {
                    const text = String(children).trim();
                    if (!className && /^<!--\s*(page:|Document Outline)/.test(text)) {
                      return <code className="comment-marker" {...props}>{children}</code>;
                    }
                    return <code className={className} {...props}>{children}</code>;
                  },
                }}
              >
                {renderedBody}
              </ReactMarkdown>
            </article>
          )}
        </div>
      </div>
    </div>
  );
}
