import { useState, useEffect, useCallback, useRef, useMemo, memo, startTransition } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Check, Download, FolderOpen, Hash, Table2, BookOpen, Footprints, Search, X, ChevronDown, ChevronUp, Columns2, FileText, Loader2, Radio } from 'lucide-react';
import type { ConversionJob } from '../types';
import { downloadMarkdown, showInFolder, exportAsHtml, exportAsJson, exportAsDocx } from '../lib/download';

interface PreviewProps {
  job?: ConversionJob;
  markdown?: string;
  fileName?: string;
  savedPath?: string | null;
  sourcePath?: string | null;
}

const INITIAL_CHUNKS = 10;
const CHUNKS_PER_LOAD = 10;

/** A single chunk of markdown, memoized so it never re-renders unless content changes. */
const MarkdownChunk = memo(function MarkdownChunk({ content }: { content: string }) {
  return (
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
      {content}
    </ReactMarkdown>
  );
});

export default function Preview({ job, markdown: externalMd, fileName: externalName, savedPath: externalSavedPath, sourcePath: externalSourcePath }: PreviewProps) {
  const [tab, setTab] = useState<'raw' | 'rendered'>('rendered');
  const [copied, setCopied] = useState(false);
  const [sideBySide, setSideBySide] = useState(false);
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const findInputRef = useRef<HTMLInputElement>(null);

  const md = job?.markdown ?? externalMd ?? '';
  const fileName = job?.fileName ?? externalName ?? 'document.pdf';
  const resolvedSavedPath = job?.savedPath ?? externalSavedPath ?? null;
  const resolvedSourcePath = job?.sourcePath ?? externalSourcePath ?? null;

  // Extract YAML frontmatter for styled rendering
  const { frontmatter, body } = useMemo(() => {
    const fmMatch = md.match(/^---\n([\s\S]*?)\n---\n?/);
    if (fmMatch) {
      return { frontmatter: fmMatch[1], body: md.slice(fmMatch[0].length) };
    }
    return { frontmatter: '', body: md };
  }, [md]);

  // Replace HTML comments with backtick-wrapped code so ReactMarkdown renders them
  const renderedBody = useMemo(() =>
    body
      .replace(/<!--\s*(page:\s*.+?)\s*-->/g, '`<!-- $1 -->`')
      .replace(/<!--\s*(Document Outline)\s*-->/g, '`<!-- $1 -->`'),
    [body],
  );

  // Split renderedBody into chunks by page markers for progressive rendering
  const chunks = useMemo(() => {
    const split = renderedBody.split(/(?=`<!-- page:)/);
    if (split.length > 1) return split.filter(Boolean);
    // Fallback: split by double newlines into ~50KB groups
    const parts: string[] = [];
    const paragraphs = renderedBody.split(/\n\n/);
    let current = '';
    for (const p of paragraphs) {
      if (current.length + p.length > 50000 && current.length > 0) {
        parts.push(current);
        current = p;
      } else {
        current += (current ? '\n\n' : '') + p;
      }
    }
    if (current) parts.push(current);
    return parts.length > 0 ? parts : [renderedBody];
  }, [renderedBody]);

  // Progressive chunk loading
  const [loadedCount, setLoadedCount] = useState(INITIAL_CHUNKS);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const renderedAreaRef = useRef<HTMLDivElement>(null);
  const [avgChunkHeight, setAvgChunkHeight] = useState(0);

  // Reset loaded count and scroll position when document changes
  useEffect(() => {
    setLoadedCount(INITIAL_CHUNKS);
    setAvgChunkHeight(0);
    contentRef.current?.scrollTo(0, 0);
  }, [md]);

  // Measure rendered chunk area to estimate total document height
  useEffect(() => {
    if (renderedAreaRef.current && loadedCount > 0) {
      const h = renderedAreaRef.current.offsetHeight;
      setAvgChunkHeight(h / loadedCount);
    }
  }, [loadedCount]);

  // IntersectionObserver to load more chunks on scroll
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || loadedCount >= chunks.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setLoadedCount(prev => Math.min(prev + CHUNKS_PER_LOAD, chunks.length));
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadedCount, chunks.length]);

  function handleCopy() {
    navigator.clipboard.writeText(md);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // ── Find in page ───────────────────────────────────────────────────────────
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

  // When find opens, force-load all chunks so TreeWalker can find everything
  useEffect(() => {
    if (findOpen && findText && loadedCount < chunks.length) {
      startTransition(() => setLoadedCount(chunks.length));
    }
  }, [findOpen, findText, loadedCount, chunks.length]);

  // Count matches in the raw markdown (memoized)
  const findMatchCount = useMemo(() => {
    if (!findText) return 0;
    const escaped = findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return (md.match(new RegExp(escaped, 'gi')) || []).length;
  }, [md, findText]);

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
      const docOrderIndex = i;
      mark.style.background = docOrderIndex === findActiveIndex ? '#d4a853' : '#f5deb3';
      mark.style.color = '#000';
      mark.style.borderRadius = '2px';
      range.surroundContents(mark);
    }

    // Scroll active match into view
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

  // ── Side-by-side PDF ─────────────────────────────────────────────────────────
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

  // Quality stats (memoized)
  const stats = useMemo(() => ({
    pageMarkers: (md.match(/<!-- page: .+? -->/g) || []).length,
    headings: (md.match(/^#{1,6}\s+\S/gm) || []).length,
    tables: (md.match(/^\|.+\|$/gm) || []).length,
    footnotes: (md.match(/\[\^\w+\]/g) || []).length,
  }), [md]);

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-p-border shrink-0 relative z-10">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setTab('rendered')}
            className={`tab-underline text-xs tab-transition ${
              tab === 'rendered' ? 'tab-underline-active' : 'text-p-text-dim hover:text-p-text'
            }`}
          >
            Rendered
          </button>
          <button
            onClick={() => setTab('raw')}
            className={`tab-underline text-xs tab-transition ${
              tab === 'raw' ? 'tab-underline-active' : 'text-p-text-dim hover:text-p-text'
            }`}
          >
            Raw Markdown
          </button>
          {resolvedSourcePath && (
            <button
              onClick={() => setSideBySide(!sideBySide)}
              className={`tab-underline text-xs tab-transition ${
                sideBySide ? 'tab-underline-active' : 'text-p-text-dim hover:text-p-text'
              }`}
              title="Side-by-side with PDF"
            >
              <Columns2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => { setFindOpen(true); setTimeout(() => findInputRef.current?.focus(), 50); }}
            className="btn-ghost"
            title="Find (Ctrl+F)"
          >
            <Search className="w-3 h-3" />
          </button>
          <button
            onClick={handleCopy}
            className="btn-ghost"
          >
            {copied ? <Check className="w-3 h-3 text-p-success" /> : <Copy className="w-3 h-3" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          {resolvedSavedPath && (
            <button
              onClick={() => showInFolder(resolvedSavedPath)}
              className="btn-ghost"
            >
              <FolderOpen className="w-3 h-3" />
              Show in folder
            </button>
          )}
          {/* Export dropdown */}
          <div className="relative">
            <button
              onClick={() => setExportOpen(!exportOpen)}
              className="btn-ghost"
            >
              <Download className="w-3 h-3" />
              Export
              <ChevronDown className="w-3 h-3" />
            </button>
            {exportOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setExportOpen(false)} />
                <div className="absolute right-0 top-full mt-1 z-20 bg-p-surface border border-p-border rounded-xl shadow-xl py-1.5 min-w-[160px]">
                  <button
                    onClick={() => { downloadMarkdown(fileName, md); setExportOpen(false); }}
                    className="w-full text-left px-3 py-2 text-xs text-p-text hover:bg-p-surface-hover tab-transition"
                  >
                    Download .md
                  </button>
                  <button
                    onClick={() => { exportAsHtml(fileName, md); setExportOpen(false); }}
                    className="w-full text-left px-3 py-2 text-xs text-p-text hover:bg-p-surface-hover tab-transition"
                  >
                    Export .html
                  </button>
                  <button
                    onClick={() => { exportAsJson(fileName, md); setExportOpen(false); }}
                    className="w-full text-left px-3 py-2 text-xs text-p-text hover:bg-p-surface-hover tab-transition"
                  >
                    Export .json
                  </button>
                  <button
                    onClick={() => { exportAsDocx(fileName, md, setExporting); setExportOpen(false); }}
                    className="w-full text-left px-3 py-2 text-xs text-p-text hover:bg-p-surface-hover tab-transition"
                  >
                    Export .docx
                  </button>
                  <button
                    onClick={() => { exportAsDocx(fileName, md, setExporting, 'logos'); setExportOpen(false); }}
                    className="w-full text-left px-3 py-2 text-xs text-p-text hover:bg-p-surface-hover tab-transition"
                  >
                    Export .docx (Logos/Verbum)
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
            className="flex-1 px-2 py-1 text-xs bg-p-bg border border-p-border rounded-md text-p-text placeholder:text-p-text-dim focus:outline-none focus:border-p-accent focus:shadow-[0_0_0_3px_var(--p-accent-glow)]"
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
          <Hash className="w-3 h-3" /> {stats.pageMarkers} pages
        </span>
        <span className="flex items-center gap-1" title="Headings found">
          <BookOpen className="w-3 h-3" /> {stats.headings} headings
        </span>
        <span className="flex items-center gap-1" title="Table rows found">
          <Table2 className="w-3 h-3" /> {stats.tables} table rows
        </span>
        <span className="flex items-center gap-1" title="Footnote references found">
          <Footprints className="w-3 h-3" /> {stats.footnotes} footnotes
        </span>
        <span className="ml-auto">{(md.length / 1024).toFixed(1)} KB</span>
      </div>

      {/* Live preview banner */}
      {job?.status === 'converting' && md && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-b border-p-accent/20 bg-p-accent/5 shrink-0">
          <Radio className="w-3.5 h-3.5 text-p-accent animate-pulse" />
          <span className="text-xs text-p-accent font-medium">
            Live preview
          </span>
          <span className="text-xs text-p-text-dim">
            {job.currentBatch > 0 && job.totalBatches > 0
              ? `${job.currentBatch} of ${job.totalBatches} ${job.translationLanguage ? 'chunks' : 'batches'} complete`
              : 'Receiving...'}
          </span>
        </div>
      )}

      {/* Content */}
      <div className={`flex-1 overflow-hidden ${sideBySide ? 'flex' : ''}`}>
        {/* PDF pane */}
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
              <div ref={renderedAreaRef}>
                {chunks.slice(0, loadedCount).map((chunk, i) => (
                  <MarkdownChunk key={i} content={chunk} />
                ))}
              </div>
              {loadedCount < chunks.length && (
                <>
                  <div ref={sentinelRef} className="flex items-center justify-center py-4 gap-2">
                    <Loader2 className="w-4 h-4 text-p-accent animate-spin" />
                    <span className="text-xs text-p-text-dim">
                      Loading more ({loadedCount} of {chunks.length} sections)...
                    </span>
                  </div>
                  {avgChunkHeight > 0 && (
                    <div style={{ height: avgChunkHeight * (chunks.length - loadedCount) }} />
                  )}
                </>
              )}
            </article>
          )}
        </div>
      </div>

      {/* DOCX export overlay */}
      {exporting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 modal-backdrop">
          <div className="rounded-xl bg-p-bg border border-p-border shadow-2xl p-6 flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 text-p-accent animate-spin" />
            <span className="text-sm text-p-text">Exporting to Word...</span>
          </div>
        </div>
      )}
    </div>
  );
}
