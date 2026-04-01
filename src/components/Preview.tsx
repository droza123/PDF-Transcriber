import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Copy, Check, Download, FolderOpen, Hash, Table2, BookOpen, Footprints } from 'lucide-react';
import type { ConversionJob } from '../types';
import { downloadMarkdown, showInFolder } from '../lib/download';

interface PreviewProps {
  job: ConversionJob;
}

export default function Preview({ job }: PreviewProps) {
  const [tab, setTab] = useState<'raw' | 'rendered'>('rendered');
  const [copied, setCopied] = useState(false);

  const md = job.markdown || '';

  function handleCopy() {
    navigator.clipboard.writeText(md);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

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
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded text-p-text-dim hover:text-p-text hover:bg-p-surface-hover tab-transition"
          >
            {copied ? <Check className="w-3 h-3 text-p-success" /> : <Copy className="w-3 h-3" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          {job.savedPath && (
            <button
              onClick={() => showInFolder(job.savedPath!)}
              className="flex items-center gap-1 text-xs px-2 py-1 rounded text-p-text-dim hover:text-p-text hover:bg-p-surface-hover tab-transition"
            >
              <FolderOpen className="w-3 h-3" />
              Show in folder
            </button>
          )}
          <button
            onClick={() => downloadMarkdown(job.fileName, md)}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded text-p-text-dim hover:text-p-text hover:bg-p-surface-hover tab-transition"
          >
            <Download className="w-3 h-3" />
            {job.savedPath ? 'Save as\u2026' : 'Download'}
          </button>
        </div>
      </div>

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
      <div className="flex-1 overflow-auto p-4">
        {tab === 'raw' ? (
          <pre className="text-xs font-mono leading-relaxed whitespace-pre-wrap break-words text-p-text">
            {md}
          </pre>
        ) : (
          <article className="prose prose-sm prose-pdf max-w-none">
            <ReactMarkdown>{md}</ReactMarkdown>
          </article>
        )}
      </div>
    </div>
  );
}
