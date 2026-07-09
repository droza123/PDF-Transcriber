/**
 * AI heading correction — a post-transcription pass that repairs the Markdown
 * heading structure against the prescan outline (the authority), using the
 * scan-stage model. The model sees the full document (so it can find genuine
 * section titles transcribed as plain text) but may only emit EDIT COMMANDS,
 * never document text — so body prose physically cannot be altered. Every
 * command is validated and applied in code; commands that fail their guard
 * are dropped and counted, and an unparseable response degrades to a no-op.
 */
import { callTextWithRetry } from './providers/orchestrator';
import type { Provider } from './providers/types';

export interface HeadingCorrectionOptions {
  provider?: Provider;
  models?: string[];
  abortSignal?: AbortSignal;
  skipModels?: Set<string>;
  onRetry?: (attempt: number, delaySec: number, reason?: string) => void;
  onModelSkip?: (skippedModel: string, nextModel: string | null, reason: string) => void;
  onModelStart?: (model: string) => void;
  onStreamProgress?: (phase: 'uploading' | 'processing' | 'streaming', charsReceived: number) => void;
  onError?: (model: string, reason: string, action: string) => void;
  /** Chunk-level progress ("Heading correction: analyzing part 2/3..."). */
  onProgress?: (statusMessage: string) => void;
}

export interface HeadingCorrectionStats {
  releveled: number;
  demoted: number;
  merged: number;
  promoted: number;
  retitled: number;
  inserted: number;
  /** Commands the model emitted that failed a code-side guard. */
  rejected: number;
  /** Headings present before the pass. */
  totalHeadings: number;
}

export interface HeadingCorrectionResult {
  correctedMarkdown: string;
  changed: boolean;
  stats: HeadingCorrectionStats;
  /** One-line structural summary of the corrected document. */
  report: string;
}

/** ~tokens per chunk stays comfortably inside model context; output is tiny. */
const CHUNK_TARGET_WORDS = 20000;

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const PAGE_MARKER_RE = /^\s*<!--\s*page:\s*(\S+)\s*-->/i;
const FOOTNOTE_DEF_RE = /^\[\^[^\]]+\]:/;

// ── Outline parsing ──────────────────────────────────────────────────────────

interface OutlineEntry {
  level: number;
  text: string;
  norm: string;
  /** Printed page number for this entry, if the prescan captured one. */
  page: string | null;
}

/**
 * Normalize heading text for fuzzy matching (same spirit as convert.ts):
 * lowercase, collapse whitespace, strip bold markers, trailing page numbers,
 * and leading section numbering.
 */
export function normalizeHeadingText(text: string): string {
  return text
    .trim()
    .replace(/\*\*/g, '')
    .replace(/\s*\([ivxlcdm\d\s,–-]+\)\s*$/i, '')
    .replace(/\s*[—–-]\s*(?:p\.?\s*)?[ivxlcdm\d]+\s*$/i, '')
    .replace(/^\d+(\.\d+)*\.?\s+/, '')
    .replace(/^[A-Z]\.?\s+/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

/** Pull a trailing printed page number off an outline entry, if present. */
function extractTrailingPage(text: string): { text: string; page: string | null } {
  const patterns = [
    /\s*\(\s*(?:p\.?\s*)?([ivxlcdm]+|\d+)\s*\)\s*$/i,   // "(87)" / "(p. 87)"
    /\s+[—–-]\s*(?:p\.?\s*)?([ivxlcdm]+|\d+)\s*$/i,     // "— 87"
    /,\s*(?:p\.?\s*)?([ivxlcdm]+|\d+)\s*$/i,             // ", 87"
    /\.{3,}\s*([ivxlcdm]+|\d+)\s*$/i,                    // "..... 87" (dot leaders)
    /\s{2,}([ivxlcdm]+|\d+)\s*$/i,                       // "Title   87"
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return { text: text.slice(0, m.index).trim(), page: m[1].toLowerCase() };
  }
  return { text: text.trim(), page: null };
}

/** Parse the prescan outline (markdown headings or indented bullets) into entries. */
export function parseOutlineEntries(outline: string): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  for (const line of outline.split('\n')) {
    let level: number | null = null;
    let raw = '';
    const hm = line.match(/^(#{1,6})\s+(.+)$/);
    if (hm) {
      level = hm[1].length;
      raw = hm[2];
    } else {
      const lm = line.match(/^(\s*)[*-]\s+(.+)$/);
      if (lm) {
        level = Math.min(6, Math.floor(lm[1].length / 2) + 1);
        raw = lm[2];
      }
    }
    if (level == null) continue;
    const { text, page } = extractTrailingPage(raw);
    if (!text) continue;
    entries.push({ level, text, norm: normalizeHeadingText(text), page });
  }
  return entries;
}

// ── Document scanning helpers ────────────────────────────────────────────────

/** 0-based indices of lines inside fenced code blocks (``` ... ```). */
function fencedLineIndices(lines: string[]): Set<number> {
  const fenced = new Set<number>();
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      fenced.add(i);
      inFence = !inFence;
      continue;
    }
    if (inFence) fenced.add(i);
  }
  return fenced;
}

/** Map printed page label (lowercased) → 0-based line index of its marker. */
function pageMarkerIndex(lines: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(PAGE_MARKER_RE);
    if (m && !map.has(m[1].toLowerCase())) map.set(m[1].toLowerCase(), i);
  }
  return map;
}

/** [start, end) 0-based line span of printed page `page`, or null. */
function pageSpan(lines: string[], markers: Map<string, number>, page: string): [number, number] | null {
  const start = markers.get(page.toLowerCase());
  if (start == null) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (PAGE_MARKER_RE.test(lines[i])) { end = i; break; }
  }
  return [start, end];
}

/** A line a PROMOTE/INSERT must never target: markers, notes, quotes, lists, tables. */
function isProtectedLine(line: string): boolean {
  const t = line.trim();
  return t === ''
    || PAGE_MARKER_RE.test(t)
    || FOOTNOTE_DEF_RE.test(t)
    || t.startsWith('>')
    || t.startsWith('|')
    || /^([*+-]|\d+[.)])\s/.test(t)
    || /^(```|~~~)/.test(t);
}

// ── Chunking ─────────────────────────────────────────────────────────────────

/** Split the document into [startLine, endLine) ranges of ~CHUNK_TARGET_WORDS words, breaking at blank lines. */
function chunkRanges(lines: string[]): [number, number][] {
  const ranges: [number, number][] = [];
  let start = 0;
  let words = 0;
  for (let i = 0; i < lines.length; i++) {
    words += lines[i] ? lines[i].split(/\s+/).length : 0;
    if (words >= CHUNK_TARGET_WORDS && lines[i].trim() === '') {
      ranges.push([start, i + 1]);
      start = i + 1;
      words = 0;
    }
  }
  if (start < lines.length) ranges.push([start, lines.length]);
  return ranges.length > 0 ? ranges : [[0, lines.length]];
}

// ── Prompt ───────────────────────────────────────────────────────────────────

function buildPrompt(
  numberedChunk: string,
  outline: string | null,
  chunkNum: number,
  totalChunks: number,
): string {
  const chunkNote = totalChunks > 1
    ? `\nThis is part ${chunkNum} of ${totalChunks} of the document; line numbers are absolute within the whole document. Sections may begin before this part and continue after it — only correct what you can see.`
    : '';

  const authority = outline
    ? `1. AUTHORITATIVE OUTLINE — the document's real structure, from a separate structural prescan of the source PDF. Entries may carry printed page numbers:

${outline}

2. The transcribed Markdown. Each line is prefixed with its line number and a pipe ("42|"). Lines like "<!-- page: N -->" mark where printed page N begins.`
    : `The transcribed Markdown. Each line is prefixed with its line number and a pipe ("42|"). Lines like "<!-- page: N -->" mark where printed page N begins.
There is NO external outline for this document — derive the correct hierarchy from the document's own signals: numbering patterns (1, 1.1, 1.1.1 / I, II / A, B), "Part/Chapter/Section" labels, and consistency of the existing levels.`;

  const insertRules = outline
    ? `PROMOTE|<line>|<level>            — a genuine section title from the outline was transcribed as plain or bold text; make it a heading
RETITLE|<line>|<corrected text>   — a heading's text is garbled; replace it with the outline's wording (keep the line's level)
INSERT|<after-line>|<level>|<text> — a section title from the outline is entirely missing from the text; insert it as a new heading after the given line`
    : `PROMOTE|<line>|<level>            — a line that is unmistakably a section title (e.g. "3.2 The Second Vision" as bold or plain text) was transcribed without heading syntax; make it a heading`;

  const guardRules = outline
    ? `- A heading present in the Markdown but absent from the outline is NOT automatically wrong — printed TOCs are often abbreviated. Keep it (emit nothing) unless it is clearly a running header, TOC echo, or another false heading.
- PROMOTE only when the outline lists that title and the text shows it without heading syntax.
- RETITLE only to match an outline entry's wording.
- INSERT only when the title appears NOWHERE in the Markdown, not even as plain text (if it exists as text, use PROMOTE). Place it where that section actually begins — use the outline's page number together with the <!-- page: N --> markers to find the location, and the section's opening words to pick the exact paragraph boundary. If you cannot determine the position confidently, do NOT insert — skipping is correct.`
    : `- Without an external outline, be extra conservative: only correct clear internal inconsistencies (e.g. "2.3" nested shallower than "2.2.1", a chapter at a deeper level than its own sections, an obvious running header repeated across pages).`;

  return `You are auditing the Markdown heading structure of a transcribed book. The transcription model may have used wrong heading levels, marked running headers or table-of-contents echoes as headings, split one heading across two lines, or failed to mark genuine section titles as headings.
${chunkNote}
${authority}

Your job is to make the heading structure correct. Body text is NOT yours to edit — you output ONLY edit commands, never document text.

Available commands, one per line, pipe-delimited:
RELEVEL|<line>|<level>            — a real heading at the wrong depth; set its level (1-6)
DEMOTE|<line>                     — a false heading (running header, TOC echo, figure caption, page banner); convert it to plain text
MERGE|<line>                      — a heading accidentally split across two adjacent heading lines; merge this line's text into the adjacent heading
${insertRules}

Rules:
- Be conservative. When unsure, emit NO command for that line — a missed fix is better than a wrong one.
- Only emit commands for real discrepancies; correct headings need nothing.
${guardRules}
- Never target page markers, footnote definitions ("[^N]: ..."), block quotes, list items, or table rows.
- Avoid level 6 unless the structure genuinely requires a sixth level.
- Inline list labels like "a)", "b)", "c)" inside an argument are not headings.

Output ONLY the commands, one per line. If no changes are needed, output exactly: NONE

DOCUMENT:
${numberedChunk}`;
}

// ── Command parsing & application ────────────────────────────────────────────

type Command =
  | { action: 'relevel'; line: number; level: number }
  | { action: 'demote'; line: number }
  | { action: 'merge'; line: number }
  | { action: 'promote'; line: number; level: number }
  | { action: 'retitle'; line: number; text: string }
  | { action: 'insert'; afterLine: number; level: number; text: string };

function parseCommands(responseText: string): Command[] {
  const commands: Command[] = [];
  for (const raw of responseText.split('\n')) {
    const line = raw.trim().replace(/^[-*]\s+/, '');
    if (!line || /^NONE$/i.test(line)) continue;
    const parts = line.split('|').map(p => p.trim());
    const action = parts[0]?.toUpperCase();
    const n = parseInt(parts[1], 10);
    if (isNaN(n) || n < 1) continue;
    switch (action) {
      case 'RELEVEL': {
        const level = parseInt(parts[2], 10);
        if (level >= 1 && level <= 6) commands.push({ action: 'relevel', line: n, level });
        break;
      }
      case 'DEMOTE': commands.push({ action: 'demote', line: n }); break;
      case 'MERGE': case 'MERGE_UP': commands.push({ action: 'merge', line: n }); break;
      case 'PROMOTE': {
        const level = parseInt(parts[2], 10);
        if (level >= 1 && level <= 6) commands.push({ action: 'promote', line: n, level });
        break;
      }
      case 'RETITLE': {
        const text = parts.slice(2).join('|');
        if (text) commands.push({ action: 'retitle', line: n, text });
        break;
      }
      case 'INSERT': {
        const level = parseInt(parts[2], 10);
        const text = parts.slice(3).join('|');
        if (level >= 1 && level <= 6 && text) commands.push({ action: 'insert', afterLine: n, level, text });
        break;
      }
    }
  }
  return commands;
}

/** Move an insertion point down to the next blank line (paragraph boundary), within a small window. */
function snapToBlankLine(lines: string[], idx: number, maxSlide = 20): number | null {
  for (let i = idx; i < Math.min(lines.length, idx + maxSlide); i++) {
    if (lines[i].trim() === '') return i;
    if (HEADING_RE.test(lines[i])) return i - 1 >= 0 ? i - 1 : 0; // land just before the next heading
  }
  return null;
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Correct the heading structure of `markdown` against `outline` (the prescan
 * authority; pass null for no-authority mode). Uses the provider/models in
 * `options` — callers pass the scan stage's provider and model priority.
 * Never throws for model/parse failures: degrades to a no-op result.
 */
export async function correctHeadings(
  markdown: string,
  outline: string | null,
  options: HeadingCorrectionOptions = {},
): Promise<HeadingCorrectionResult> {
  const { onProgress, ...callOptions } = options;
  const lines = markdown.split('\n');
  const fenced = fencedLineIndices(lines);
  const markers = pageMarkerIndex(lines);
  const outlineEntries = outline ? parseOutlineEntries(outline) : [];
  const outlineNorms = new Set(outlineEntries.map(e => e.norm));

  const headingLineIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!fenced.has(i) && HEADING_RE.test(lines[i])) headingLineIdx.push(i);
  }
  const totalHeadings = headingLineIdx.length;

  const noop = (reason: string): HeadingCorrectionResult => {
    console.log(`[heading-correction] No-op: ${reason}`);
    return {
      correctedMarkdown: markdown,
      changed: false,
      stats: { releveled: 0, demoted: 0, merged: 0, promoted: 0, retitled: 0, inserted: 0, rejected: 0, totalHeadings },
      report: structuralReport(lines, fenced),
    };
  };

  // Nothing to anchor on: a heading-less document with no outline authority.
  if (totalHeadings === 0 && outlineEntries.length === 0) {
    return noop('document has no headings and no outline authority');
  }

  // Gather commands (one model call per chunk; long books get several).
  const ranges = chunkRanges(lines);
  const commands: Command[] = [];
  try {
    for (let c = 0; c < ranges.length; c++) {
      if (options.abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const [start, end] = ranges[c];
      if (ranges.length > 1) {
        onProgress?.(`Heading correction: analyzing part ${c + 1}/${ranges.length}...`);
      }
      const numbered = lines.slice(start, end).map((l, i) => `${start + i + 1}|${l}`).join('\n');
      const prompt = buildPrompt(numbered, outline, c + 1, ranges.length);
      const result = await callTextWithRetry(prompt, callOptions);
      commands.push(...parseCommands(result.text));
    }
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    console.warn(`[heading-correction] Model call failed, keeping transcription as-is: ${e?.message}`);
    return noop(`model call failed (${e?.message})`);
  }

  if (commands.length === 0) {
    return noop('model reported no changes needed');
  }

  // ── Apply with guards ──────────────────────────────────────────────────────
  const out = [...lines];
  const stats: HeadingCorrectionStats = { releveled: 0, demoted: 0, merged: 0, promoted: 0, retitled: 0, inserted: 0, rejected: 0, totalHeadings };
  const reject = () => { stats.rejected++; };

  // Track texts promoted/present so INSERT can't duplicate them.
  const presentNorms = new Set<string>();
  for (const idx of headingLineIdx) {
    const m = out[idx].match(HEADING_RE);
    if (m) presentNorms.add(normalizeHeadingText(m[2]));
  }

  const lineOk = (n: number) => n >= 1 && n <= out.length && !fenced.has(n - 1);

  // Order matters: text fixes before level fixes, structure changes last.
  const order: Record<Command['action'], number> = { retitle: 0, relevel: 1, merge: 2, demote: 3, promote: 4, insert: 5 };
  commands.sort((a, b) => order[a.action] - order[b.action]);

  // De-duplicate: keep the last command per (action, line) pair.
  const seen = new Set<string>();
  const deduped: Command[] = [];
  for (let i = commands.length - 1; i >= 0; i--) {
    const cmd = commands[i];
    const key = cmd.action === 'insert' ? `insert:${normalizeHeadingText(cmd.text)}` : `${cmd.action}:${cmd.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.unshift(cmd);
  }

  const inserts: { afterIdx: number; level: number; text: string }[] = [];

  for (const cmd of deduped) {
    switch (cmd.action) {
      case 'retitle': {
        if (!lineOk(cmd.line)) { reject(); break; }
        const i = cmd.line - 1;
        const m = out[i].match(HEADING_RE);
        if (!m) { reject(); break; }
        // Only allowed against the outline's wording.
        if (!outlineNorms.has(normalizeHeadingText(cmd.text))) { reject(); break; }
        presentNorms.delete(normalizeHeadingText(m[2]));
        out[i] = `${m[1]} ${cmd.text}`;
        presentNorms.add(normalizeHeadingText(cmd.text));
        stats.retitled++;
        break;
      }
      case 'relevel': {
        if (!lineOk(cmd.line)) { reject(); break; }
        const i = cmd.line - 1;
        const m = out[i].match(HEADING_RE);
        if (!m) { reject(); break; }
        if (m[1].length !== cmd.level) {
          out[i] = '#'.repeat(cmd.level) + ' ' + m[2];
          stats.releveled++;
        }
        break;
      }
      case 'merge': {
        if (!lineOk(cmd.line)) { reject(); break; }
        const i = cmd.line - 1;
        const m = out[i].match(HEADING_RE);
        if (!m) { reject(); break; }
        // Find the adjacent heading (previous non-blank preferred, else next).
        let prev = i - 1;
        while (prev >= 0 && out[prev].trim() === '') prev--;
        let next = i + 1;
        while (next < out.length && out[next].trim() === '') next++;
        const prevM = prev >= 0 ? out[prev].match(HEADING_RE) : null;
        const nextM = next < out.length ? out[next].match(HEADING_RE) : null;
        if (prevM) {
          out[prev] = `${prevM[1]} ${prevM[2]} ${m[2]}`;
          out[i] = '';
          stats.merged++;
        } else if (nextM) {
          out[next] = `${nextM[1]} ${m[2]} ${nextM[2]}`;
          out[i] = '';
          stats.merged++;
        } else {
          reject();
        }
        break;
      }
      case 'demote': {
        if (!lineOk(cmd.line)) { reject(); break; }
        const i = cmd.line - 1;
        const m = out[i].match(HEADING_RE);
        if (!m) { reject(); break; }
        presentNorms.delete(normalizeHeadingText(m[2]));
        out[i] = `**${m[2]}**`;
        stats.demoted++;
        break;
      }
      case 'promote': {
        if (!lineOk(cmd.line)) { reject(); break; }
        const i = cmd.line - 1;
        if (HEADING_RE.test(out[i]) || isProtectedLine(out[i])) { reject(); break; }
        const text = out[i].trim().replace(/^\*\*(.+?)\*\*$/, '$1').trim();
        if (!text || text.length > 200) { reject(); break; }
        // With an outline, a promotion must correspond to a real outline entry.
        if (outlineEntries.length > 0 && !outlineNorms.has(normalizeHeadingText(text))) { reject(); break; }
        out[i] = '#'.repeat(cmd.level) + ' ' + text;
        presentNorms.add(normalizeHeadingText(text));
        stats.promoted++;
        break;
      }
      case 'insert': {
        // Only with authority, only for outline entries missing everywhere.
        const norm = normalizeHeadingText(cmd.text);
        const entry = outlineEntries.find(e => e.norm === norm);
        if (!entry) { reject(); break; }
        if (presentNorms.has(norm)) { reject(); break; }
        if (cmd.afterLine < 0 || cmd.afterLine > out.length) { reject(); break; }
        // Snap to a paragraph boundary near the requested point.
        const snapped = snapToBlankLine(out, Math.min(cmd.afterLine, out.length - 1));
        if (snapped == null) { reject(); break; }
        // Page-span guard: when the outline knows the printed page and the
        // document has that page's marker, the insertion must land on that page.
        if (entry.page) {
          const span = pageSpan(out, markers, entry.page);
          if (span && (snapped < span[0] || snapped >= span[1])) { reject(); break; }
        }
        inserts.push({ afterIdx: snapped, level: cmd.level, text: entry.text });
        presentNorms.add(norm);
        stats.inserted++;
        break;
      }
    }
  }

  // Apply inserts bottom-up so earlier indices stay valid. Skip the leading
  // blank when the anchor line is already blank (snapToBlankLine's usual case).
  inserts.sort((a, b) => b.afterIdx - a.afterIdx);
  for (const ins of inserts) {
    const heading = '#'.repeat(ins.level) + ' ' + ins.text;
    if (out[ins.afterIdx]?.trim() === '') {
      out.splice(ins.afterIdx + 1, 0, heading, '');
    } else {
      out.splice(ins.afterIdx + 1, 0, '', heading, '');
    }
  }

  const applied = stats.releveled + stats.demoted + stats.merged + stats.promoted + stats.retitled + stats.inserted;
  const correctedMarkdown = out.join('\n');
  console.log(`[heading-correction] Applied ${applied} edit(s): ${stats.releveled} releveled, ${stats.demoted} demoted, ${stats.merged} merged, ${stats.promoted} promoted, ${stats.retitled} retitled, ${stats.inserted} inserted; ${stats.rejected} rejected by guards`);

  return {
    correctedMarkdown,
    changed: applied > 0,
    stats,
    report: structuralReport(correctedMarkdown.split('\n'), fencedLineIndices(correctedMarkdown.split('\n'))),
  };
}

/** One-line structural health summary (level jumps = level increasing by >1). */
function structuralReport(lines: string[], fenced: Set<number>): string {
  let count = 0, h6 = 0, jumps = 0, prev = 0;
  for (let i = 0; i < lines.length; i++) {
    if (fenced.has(i)) continue;
    const m = lines[i].match(HEADING_RE);
    if (!m) continue;
    count++;
    const level = m[1].length;
    if (level === 6) h6++;
    if (prev > 0 && level > prev + 1) jumps++;
    prev = level;
  }
  return `${count} headings, ${jumps} level jump(s), ${h6} H6`;
}

/** Format the stats for a status/log line. */
export function formatCorrectionStats(stats: HeadingCorrectionStats, report: string): string {
  const parts: string[] = [];
  if (stats.releveled) parts.push(`${stats.releveled} releveled`);
  if (stats.demoted) parts.push(`${stats.demoted} demoted`);
  if (stats.merged) parts.push(`${stats.merged} merged`);
  if (stats.promoted) parts.push(`${stats.promoted} promoted`);
  if (stats.retitled) parts.push(`${stats.retitled} retitled`);
  if (stats.inserted) parts.push(`${stats.inserted} inserted`);
  if (stats.rejected) parts.push(`${stats.rejected} rejected`);
  const changes = parts.length > 0 ? parts.join(', ') : 'no changes needed';
  return `Heading correction: ${changes} — ${report}`;
}
