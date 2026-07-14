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
import {
  collectHeadings,
  EXTENDED_ATX_HEADING_RE,
  MAX_HEADING_LEVEL,
  MARKDOWN_HEADING_LEVELS,
  normalizeExtendedHeadingSyntax,
  serializeHeading,
  type ParsedHeading,
} from './headings';

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

const HEADING_RE = EXTENDED_ATX_HEADING_RE;
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

  for (const heading of collectHeadings(outline)) {
    const { text: headingText, page } = extractTrailingPage(heading.text);
    if (headingText) entries.push({
      level: heading.level,
      text: headingText,
      norm: normalizeHeadingText(headingText),
      page,
    });
  }

  for (const line of outline.split('\n')) {
    const lm = line.match(/^(\s*)[*-]\s+(.+)$/);
    if (!lm) continue;
    const level = Math.min(MAX_HEADING_LEVEL, Math.floor(lm[1].length / 2) + 1);
    const { text: headingText, page } = extractTrailingPage(lm[2]);
    if (headingText) entries.push({
      level,
      text: headingText,
      norm: normalizeHeadingText(headingText),
      page,
    });
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
RELEVEL|<line>|<level>            — a real heading at the wrong depth; set its level (1-9)
DEMOTE|<line>                     — a false heading (running header, TOC echo, figure caption, page banner); convert it to plain text
MERGE|<line>                      — a heading accidentally split across two adjacent heading lines; merge this line's text into the adjacent heading
${insertRules}

Rules:
- Be conservative. When unsure, emit NO command for that line — a missed fix is better than a wrong one.
- Only emit commands for real discrepancies; correct headings need nothing.
${guardRules}
- Never target page markers, footnote definitions ("[^N]: ..."), block quotes, list items, or table rows.
- Levels 7-9 use a metadata line immediately followed by an H6 fallback, for example "<!-- heading-level: 7 -->" then "###### Title". Treat that pair as one level-7 heading and target the H6 line number in commands.
- Use levels 7-9 only when the structure genuinely requires that depth.
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
        if (level >= 1 && level <= MAX_HEADING_LEVEL) commands.push({ action: 'relevel', line: n, level });
        break;
      }
      case 'DEMOTE': commands.push({ action: 'demote', line: n }); break;
      case 'MERGE': case 'MERGE_UP': commands.push({ action: 'merge', line: n }); break;
      case 'PROMOTE': {
        const level = parseInt(parts[2], 10);
        if (level >= 1 && level <= MAX_HEADING_LEVEL) commands.push({ action: 'promote', line: n, level });
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
        if (level >= 1 && level <= MAX_HEADING_LEVEL && text) commands.push({ action: 'insert', afterLine: n, level, text });
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

function headingAtVisibleLine(lines: string[], lineIndex: number): ParsedHeading | null {
  return collectHeadings(lines.join('\n')).find(h => h.lineIndex === lineIndex) ?? null;
}

function writeHeadingInPlace(lines: string[], heading: ParsedHeading, level: number, text: string): void {
  if (heading.startLineIndex < heading.lineIndex) {
    lines[heading.startLineIndex] = level > MARKDOWN_HEADING_LEVELS
      ? `<!-- heading-level: ${level} -->`
      : '';
    lines[heading.lineIndex] = level > MARKDOWN_HEADING_LEVELS
      ? `${'#'.repeat(MARKDOWN_HEADING_LEVELS)} ${text}`
      : `${'#'.repeat(level)} ${text}`;
    return;
  }

  // A raw 7-9 hash line is a temporary in-place representation. The final
  // normalization pass expands it into metadata+H6 without shifting command lines.
  lines[heading.lineIndex] = `${'#'.repeat(level)} ${text}`;
}

function clearHeading(lines: string[], heading: ParsedHeading): void {
  for (let i = heading.startLineIndex; i <= heading.lineIndex; i++) lines[i] = '';
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
  const normalizedMarkdown = normalizeExtendedHeadingSyntax(markdown);
  const syntaxNormalized = normalizedMarkdown !== markdown;
  const lines = normalizedMarkdown.split('\n');
  const fenced = fencedLineIndices(lines);
  const markers = pageMarkerIndex(lines);
  const outlineEntries = outline ? parseOutlineEntries(outline) : [];
  const outlineNorms = new Set(outlineEntries.map(e => e.norm));
  const originalHeadings = collectHeadings(normalizedMarkdown).filter(h => !fenced.has(h.lineIndex));
  const headingLineIdx = originalHeadings.map(h => h.lineIndex);
  const totalHeadings = originalHeadings.length;

  const noop = (reason: string): HeadingCorrectionResult => {
    console.log(`[heading-correction] No-op: ${reason}`);
    return {
      correctedMarkdown: normalizedMarkdown,
      changed: syntaxNormalized,
      stats: { releveled: 0, demoted: 0, merged: 0, promoted: 0, retitled: 0, inserted: 0, rejected: 0, totalHeadings },
      report: structuralReport(lines, fenced),
    };
  };

  if (totalHeadings === 0 && outlineEntries.length === 0) {
    return noop('document has no headings and no outline authority');
  }

  const ranges = chunkRanges(lines);
  const commands: Command[] = [];
  try {
    for (let c = 0; c < ranges.length; c++) {
      if (options.abortSignal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const [start, end] = ranges[c];
      if (ranges.length > 1) onProgress?.(`Heading correction: analyzing part ${c + 1}/${ranges.length}...`);
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

  if (commands.length === 0) return noop('model reported no changes needed');

  const out = [...lines];
  const stats: HeadingCorrectionStats = { releveled: 0, demoted: 0, merged: 0, promoted: 0, retitled: 0, inserted: 0, rejected: 0, totalHeadings };
  const reject = () => { stats.rejected++; };
  const presentNorms = new Set(originalHeadings.map(h => normalizeHeadingText(h.text)));
  const lineOk = (n: number) => n >= 1 && n <= out.length && !fenced.has(n - 1);

  const order: Record<Command['action'], number> = { retitle: 0, relevel: 1, merge: 2, demote: 3, promote: 4, insert: 5 };
  commands.sort((a, b) => order[a.action] - order[b.action]);
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
        const heading = headingAtVisibleLine(out, cmd.line - 1);
        if (!heading || !outlineNorms.has(normalizeHeadingText(cmd.text))) { reject(); break; }
        presentNorms.delete(normalizeHeadingText(heading.text));
        writeHeadingInPlace(out, heading, heading.level, cmd.text);
        presentNorms.add(normalizeHeadingText(cmd.text));
        stats.retitled++;
        break;
      }
      case 'relevel': {
        if (!lineOk(cmd.line)) { reject(); break; }
        const heading = headingAtVisibleLine(out, cmd.line - 1);
        if (!heading) { reject(); break; }
        if (heading.level !== cmd.level) {
          writeHeadingInPlace(out, heading, cmd.level, heading.text);
          stats.releveled++;
        }
        break;
      }
      case 'merge': {
        if (!lineOk(cmd.line)) { reject(); break; }
        const headings = collectHeadings(out.join('\n'));
        const pos = headings.findIndex(h => h.lineIndex === cmd.line - 1);
        if (pos < 0) { reject(); break; }
        const current = headings[pos];
        const prev = headings[pos - 1];
        const next = headings[pos + 1];
        const prevAdjacent = prev && out.slice(prev.lineIndex + 1, current.startLineIndex).every(l => l.trim() === '');
        const nextAdjacent = next && out.slice(current.lineIndex + 1, next.startLineIndex).every(l => l.trim() === '');
        if (prevAdjacent && prev) {
          const mergedText = `${prev.text} ${current.text}`;
          writeHeadingInPlace(out, prev, prev.level, mergedText);
          clearHeading(out, current);
          presentNorms.delete(normalizeHeadingText(prev.text));
          presentNorms.delete(normalizeHeadingText(current.text));
          presentNorms.add(normalizeHeadingText(mergedText));
          stats.merged++;
        } else if (nextAdjacent && next) {
          const mergedText = `${current.text} ${next.text}`;
          writeHeadingInPlace(out, next, next.level, mergedText);
          clearHeading(out, current);
          presentNorms.delete(normalizeHeadingText(current.text));
          presentNorms.delete(normalizeHeadingText(next.text));
          presentNorms.add(normalizeHeadingText(mergedText));
          stats.merged++;
        } else reject();
        break;
      }
      case 'demote': {
        if (!lineOk(cmd.line)) { reject(); break; }
        const heading = headingAtVisibleLine(out, cmd.line - 1);
        if (!heading) { reject(); break; }
        presentNorms.delete(normalizeHeadingText(heading.text));
        clearHeading(out, heading);
        out[heading.lineIndex] = `**${heading.text}**`;
        stats.demoted++;
        break;
      }
      case 'promote': {
        if (!lineOk(cmd.line)) { reject(); break; }
        const i = cmd.line - 1;
        if (headingAtVisibleLine(out, i) || isProtectedLine(out[i])) { reject(); break; }
        const headingText = out[i].trim().replace(/^\*\*(.+?)\*\*$/, '$1').trim();
        if (!headingText || headingText.length > 200) { reject(); break; }
        if (outlineEntries.length > 0 && !outlineNorms.has(normalizeHeadingText(headingText))) { reject(); break; }
        out[i] = `${'#'.repeat(cmd.level)} ${headingText}`;
        presentNorms.add(normalizeHeadingText(headingText));
        stats.promoted++;
        break;
      }
      case 'insert': {
        const norm = normalizeHeadingText(cmd.text);
        const entry = outlineEntries.find(e => e.norm === norm);
        if (!entry || presentNorms.has(norm) || cmd.afterLine < 0 || cmd.afterLine > out.length) { reject(); break; }
        const snapped = snapToBlankLine(out, Math.min(cmd.afterLine, out.length - 1));
        if (snapped == null) { reject(); break; }
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

  inserts.sort((a, b) => b.afterIdx - a.afterIdx);
  for (const ins of inserts) {
    const headingLines = serializeHeading(ins.level, ins.text).split('\n');
    if (out[ins.afterIdx]?.trim() === '') out.splice(ins.afterIdx + 1, 0, ...headingLines, '');
    else out.splice(ins.afterIdx + 1, 0, '', ...headingLines, '');
  }

  const applied = stats.releveled + stats.demoted + stats.merged + stats.promoted + stats.retitled + stats.inserted;
  const correctedMarkdown = normalizeExtendedHeadingSyntax(out.join('\n'));
  console.log(`[heading-correction] Applied ${applied} edit(s): ${stats.releveled} releveled, ${stats.demoted} demoted, ${stats.merged} merged, ${stats.promoted} promoted, ${stats.retitled} retitled, ${stats.inserted} inserted; ${stats.rejected} rejected by guards`);

  return {
    correctedMarkdown,
    changed: applied > 0 || syntaxNormalized,
    stats,
    report: structuralReport(correctedMarkdown.split('\n'), fencedLineIndices(correctedMarkdown.split('\n'))),
  };
}

/** One-line structural health summary (level jumps = level increasing by >1). */
function structuralReport(lines: string[], fenced: Set<number>): string {
  const headings = collectHeadings(lines.join('\n')).filter(h => !fenced.has(h.lineIndex));
  let jumps = 0;
  let previous = 0;
  let deepest = 0;
  for (const heading of headings) {
    if (previous > 0 && heading.level > previous + 1) jumps++;
    previous = heading.level;
    deepest = Math.max(deepest, heading.level);
  }
  return `${headings.length} headings, ${jumps} level jump(s), deepest H${deepest || 0}`;
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
