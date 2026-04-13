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

/** Matches a markdown heading line; capped at H6 to match DOCX export limits. */
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

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
  return markdown.replace(/^(#{1,6})\s+#{1,6}\s+(.+)$/gm, '$1 $2');
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
  // Trailing page number: requires at least one separator (space/dot/dash/ellipsis) before the digits.
  const TRAILING_PAGE_NUM = /[.\s\-\u2013\u2014\u2026]+\d+\s*$/;
  const PAGE_MARKER = /^\s*<!--\s*page:\s*\S+\s*-->/i;

  const lines = markdown.split('\n');
  const out: string[] = [];
  let inToc = false;
  let tocLevel = 0;

  for (const line of lines) {
    if (!inToc) {
      const m = line.match(HEADING_RE);
      if (m && TOC_LABEL.test(m[2].trim())) {
        // Drop the "Contents" heading itself and enter TOC mode.
        inToc = true;
        tocLevel = m[1].length;
        continue;
      }
      out.push(line);
      continue;
    }

    // --- In TOC mode ---

    if (PAGE_MARKER.test(line)) {
      inToc = false;
      out.push(line);
      continue;
    }

    const m = line.match(HEADING_RE);
    if (m) {
      const level = m[1].length;
      const text = m[2].trim();

      if (level <= tocLevel) {
        // Back to the same or higher level as the TOC header → real body starts.
        inToc = false;
        out.push(line);
        continue;
      }

      if (TRAILING_PAGE_NUM.test(text)) {
        // TOC-style entry: drop it.
        continue;
      }

      // Heading deeper than TOC but with no trailing page number — assume body, exit.
      inToc = false;
      out.push(line);
      continue;
    }

    // Non-heading line inside TOC: keep (typically the plain-text TOC
    // entries the prompt asks for, or whitespace). They aren't a quality
    // problem — we're only stripping heading-shaped TOC entries.
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

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADING_RE);
    if (!m) continue;

    const level = m[1].length;
    const text = m[2].trim();

    // Resolve the nearest preceding KEPT heading with a smaller level — that's the parent.
    let parent = '';
    for (let j = seen.length - 1; j >= 0; j--) {
      if (drop.has(seen[j].lineIdx)) continue;
      if (seen[j].level < level) {
        parent = `${seen[j].level}:${seen[j].text}`;
        break;
      }
    }

    // Look back through prior headings within the window for a same-key match
    // under the same parent — that's a duplicate we should drop.
    let duplicate = false;
    for (let j = seen.length - 1; j >= 0; j--) {
      const prev = seen[j];
      if (i - prev.lineIdx > DUP_WINDOW_LINES) break; // out of window; headings are ordered
      if (drop.has(prev.lineIdx)) continue;
      if (prev.level === level && prev.text === text && prev.parent === parent) {
        duplicate = true;
        break;
      }
    }

    if (duplicate) {
      drop.add(i);
    } else {
      seen.push({ lineIdx: i, level, text, parent });
    }
  }

  if (drop.size === 0) return markdown;
  return lines.filter((_, i) => !drop.has(i)).join('\n');
}

/**
 * Compose the three heading-cleanup passes in the order recommended by the
 * PDFTranscriber recommendations doc (§C): markdown-artifact fixup first so
 * the other passes see well-formed heading lines; TOC removal next so
 * dedup doesn't have to walk through TOC noise; dedup last.
 */
export function cleanHeadings(markdown: string): string {
  let out = markdown;
  out = cleanMarkdownArtifacts(out);
  out = removeTocHeadings(out);
  out = removeDuplicateHeadings(out);
  return out;
}
