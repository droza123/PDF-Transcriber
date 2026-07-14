import {
  collectHeadings,
  EXTENDED_ATX_HEADING_RE,
  MAX_HEADING_LEVEL,
  normalizeExtendedHeadingSyntax,
  serializeHeading,
} from './headings';

/**
 * Post-processing pass over joined batch markdown to clean up heading-level
 * issues that originate in per-batch AI transcription:
 *
 *   B6 — markdown artifacts: collapse "## ## Title" to "## Title"
 *   B3 — TOC-as-headings: strip Table-of-Contents entries wrongly emitted as
 *        markdown headings (e.g. "## Chapter 1 ........ 23")
 *   B1 — duplicate headings: drop near-duplicate headings (running-page
 *        headers and batch-boundary repeats) while preserving legitimate
 *        reuse of common headings ("## Introduction", "## Commentary") across
 *        different chapters in scholarly works.
 *
 * All three functions take and return a full markdown string — no AST — in
 * the same style as stripCodeFences / normalizeBlankLines in convert.ts.
 */

/** Native/raw heading-line matcher. Logical metadata+H6 pairs are parsed by
 * `collectHeadings`, which is the canonical iterator used by the UI. */
export const HEADING_LINE_RE = EXTENDED_ATX_HEADING_RE;

/** @deprecated Internal alias kept so the existing cleanup functions compile
 *  without a rename sweep. Points to the same regex as HEADING_LINE_RE. */
const HEADING_RE = HEADING_LINE_RE;

/** Proximity window for B1 (in raw line count). Running headers recur every
 *  ~30-40 lines (one page); batch-boundary repeats are within a few lines.
 *  Legitimate chapter-level reuse ("## Commentary" per chapter) is typically
 *  separated by hundreds-to-thousands of lines. 60 catches the former while
 *  preserving the latter. */
const DUP_WINDOW_LINES = 60;

/**
 * B6 — Collapse markdown-artifact double-heading lines like "## ## Title" or
 * "# ### Title" down to a single heading marker. The OUTER level is kept,
 * which matches the dominant artifact pattern observed in practice (batch
 * prompts prepend their own heading marker on top of content that already
 * started with one).
 */
export function cleanMarkdownArtifacts(markdown: string): string {
  return markdown.replace(/^(#{1,9})\s+#{1,9}\s+(.+)$/gm, '$1 $2');
}

/**
 * B3 — Strip headings emitted from a Table-of-Contents section. Detects a
 * "Contents" / "Table of Contents" heading, enters TOC mode, and drops
 * subsequent heading lines that look like TOC entries (trailing page
 * number). Exits TOC mode on any of these signals that real body content
 * has begun:
 *
 *   1. A <!-- page: N --> marker (strongest signal).
 *   2. A heading at the same or shallower level than the TOC header.
 *   3. A heading WITHOUT a trailing page number (likely a body heading).
 *
 * Supports English, German, Spanish/Italian, French, and Japanese TOC labels.
 */
export function removeTocHeadings(markdown: string): string {
  const TOC_LABEL = /^(Contents|Table of Contents|Inhaltsverzeichnis|Índice|Indice|Table des matières|Sommaire|目次)\s*$/i;
  const TRAILING_PAGE_NUM = /[.\s\-\u2013\u2014\u2026]+\d+\s*$/;
  const PAGE_MARKER = /^\s*<!--\s*page:\s*\S+\s*-->/i;

  const lines = markdown.split('\n');
  const headingsByStart = new Map(collectHeadings(markdown).map(h => [h.startLineIndex, h]));
  const out: string[] = [];
  let inToc = false;
  let tocLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = headingsByStart.get(i);
    const keepHeading = () => {
      if (!heading) return;
      out.push(...lines.slice(heading.startLineIndex, heading.lineIndex + 1));
      i = heading.lineIndex;
    };

    if (!inToc) {
      if (heading && TOC_LABEL.test(heading.text.trim())) {
        inToc = true;
        tocLevel = heading.level;
        i = heading.lineIndex;
        continue;
      }
      if (heading) keepHeading(); else out.push(line);
      continue;
    }

    if (PAGE_MARKER.test(line)) {
      inToc = false;
      out.push(line);
      continue;
    }

    if (heading) {
      const level = heading.level;
      const headingText = heading.text.trim();
      if (level <= tocLevel) {
        inToc = false;
        keepHeading();
        continue;
      }
      if (TRAILING_PAGE_NUM.test(headingText)) {
        i = heading.lineIndex;
        continue;
      }
      inToc = false;
      keepHeading();
      continue;
    }

    out.push(line);
  }

  return out.join('\n');
}

/**
 * B1 — Proximity-based duplicate heading removal. Drops a heading only when
 * an identical `level:text` heading appeared within DUP_WINDOW_LINES of the
 * current line AND under the same immediate parent heading. This catches:
 *
 *   - Running page headers the model echoed as H1/H2 on every page.
 *   - Batch-boundary repeats (section title re-emitted at the start of the
 *     next batch).
 *
 * …without destroying legitimate reuse of common subsection names across
 * chapters in scholarly works — e.g. "## Commentary" under "# Matthew 1"
 * and "## Commentary" under "# Matthew 2" are kept because their parents
 * differ, even if proximity is close.
 */
export function removeDuplicateHeadings(markdown: string): string {
  const lines = markdown.split('\n');
  interface Seen { lineIdx: number; level: number; text: string; parent: string; }
  const seen: Seen[] = [];
  const drop = new Set<number>();
  const headings = collectHeadings(markdown);

  for (const heading of headings) {
    const i = heading.startLineIndex;
    const level = heading.level;
    const headingText = heading.text.trim();
    let parent = '';
    for (let j = seen.length - 1; j >= 0; j--) {
      if (drop.has(seen[j].lineIdx)) continue;
      if (seen[j].level < level) {
        parent = `${seen[j].level}:${seen[j].text}`;
        break;
      }
    }

    let duplicate = false;
    for (let j = seen.length - 1; j >= 0; j--) {
      const prev = seen[j];
      if (i - prev.lineIdx > DUP_WINDOW_LINES) break;
      if (drop.has(prev.lineIdx)) continue;
      if (prev.level === level && prev.text === headingText && prev.parent === parent) {
        duplicate = true;
        break;
      }
    }

    if (duplicate) drop.add(i);
    else seen.push({ lineIdx: i, level, text: headingText, parent });
  }

  if (drop.size === 0) return markdown;
  const headingsByStart = new Map(headings.map(h => [h.startLineIndex, h]));
  const removeLines = new Set<number>();
  for (const start of drop) {
    const heading = headingsByStart.get(start);
    if (!heading) continue;
    for (let i = heading.startLineIndex; i <= heading.lineIndex; i++) removeLines.add(i);
  }
  return lines.filter((_, i) => !removeLines.has(i)).join('\n');
}

/**
 * B7 — Flatten heading-shaped lines that live INSIDE a `<!-- Document Outline -->`
 * block. The outline block is generated by a separate prescan and is the
 * model's own table of contents — it commonly emits entries as `# Title
 * (page N)`, `## 1.1 …`, etc. Those are TOC entries, not document headings,
 * but because the body-cleanup pass intentionally skips the outline block
 * (see convert.ts), they pollute heading counts AND the outline sidebar.
 *
 * Convert each such line into a bullet list item indented by its heading
 * level so the visible hierarchy is preserved without the `#` markers.
 *
 * The block boundary ends at the first of:
 *   - a line containing only `---` (the separator written by convert.ts),
 *   - a `<!-- page: N -->` marker (start of body),
 *   - end of document.
 */
export function flattenOutlineHeadings(markdown: string): string {
  const OUTLINE_START = /^<!--\s*Document Outline\s*-->\s*$/i;
  const OUTLINE_END = /^(---|\*\*\*|<!--\s*page:)/i;
  const lines = markdown.split('\n');
  const headingsByStart = new Map(collectHeadings(markdown).map(h => [h.startLineIndex, h]));
  const out: string[] = [];
  let inOutline = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!inOutline) {
      if (OUTLINE_START.test(trimmed)) inOutline = true;
      out.push(line);
      continue;
    }
    if (OUTLINE_END.test(trimmed)) {
      inOutline = false;
      out.push(line);
      continue;
    }

    const heading = headingsByStart.get(i);
    if (heading) {
      const indent = '  '.repeat(Math.max(0, heading.level - 1));
      out.push(`${indent}- ${heading.text}`);
      i = heading.lineIndex;
      continue;
    }
    out.push(line);
  }

  return out.join('\n');
}

// ── Shared heading iteration ────────────────────────────────────────────────

/** Callback receives: heading index (0-based document order), the `#` prefix
 *  string, the heading text (trailing `#` stripped), and the 0-based line
 *  index within the body lines array. */
export type HeadingVisitor = (
  headingIndex: number,
  hashes: string,
  text: string,
  lineIndex: number,
) => void;

/** Walk all heading lines in a markdown body (frontmatter already stripped),
 *  skipping fenced code blocks, in document order. Uses `HEADING_LINE_RE` so
 *  the indices are consistent with the outline sidebar and
 *  `changeHeadingLevels`. */
export function forEachHeading(body: string, visitor: HeadingVisitor): void {
  collectHeadings(body).forEach((heading, index) => {
    visitor(index, '#'.repeat(heading.level), heading.text, heading.lineIndex);
  });
}

// ── Heading-level rewriting ─────────────────────────────────────────────────

/**
 * Change heading levels for specific headings identified by their document-order
 * index. Takes the FULL markdown string (with frontmatter) and a Map of
 * `headingIndex → newLevel` (1–9). Returns the modified full markdown.
 *
 * All changes are applied in a single pass so multi-select promote/demote is
 * O(n) in document lines, not O(n × changes).
 */
export function changeHeadingLevels(
  fullMarkdown: string,
  changes: Map<number, number>,
): string {
  if (changes.size === 0) return fullMarkdown;

  const fmMatch = fullMarkdown.match(/^---\n([\s\S]*?)\n---\n?/);
  const fmPrefix = fmMatch ? fmMatch[0] : '';
  const body = normalizeExtendedHeadingSyntax(
    fmMatch ? fullMarkdown.slice(fmMatch[0].length) : fullMarkdown,
  );
  const lines = body.split('\n');
  const headings = collectHeadings(body);
  const replacements = new Map<number, { end: number; text: string }>();

  headings.forEach((heading, index) => {
    const newLevel = changes.get(index);
    if (newLevel === undefined) return;
    const clamped = Math.max(1, Math.min(MAX_HEADING_LEVEL, Math.trunc(newLevel)));
    replacements.set(heading.startLineIndex, {
      end: heading.lineIndex,
      text: serializeHeading(clamped, heading.text),
    });
  });

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const replacement = replacements.get(i);
    if (!replacement) {
      out.push(lines[i]);
      continue;
    }
    out.push(...replacement.text.split('\n'));
    i = replacement.end;
  }

  return fmPrefix + out.join('\n');
}

/**
 * Compose all heading-cleanup passes. Order matters:
 *   1. Flatten the Document Outline block first so dedup/TOC passes don't see
 *      its `#`-shaped TOC entries as headings.
 *   2. Markdown-artifact fixup so the remaining passes see well-formed lines.
 *   3. TOC heading removal (a body-level TOC like "## Contents").
 *   4. Duplicate heading removal last.
 */
export function cleanHeadings(markdown: string): string {
  let out = normalizeExtendedHeadingSyntax(markdown);
  out = flattenOutlineHeadings(out);
  out = cleanMarkdownArtifacts(out);
  out = removeTocHeadings(out);
  out = removeDuplicateHeadings(out);
  return out;
}
