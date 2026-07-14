/**
 * Shared heading model for the renderer pipeline.
 *
 * CommonMark and HTML have only six native heading levels. PDF Transcriber
 * preserves levels 7-9 in Markdown with a metadata comment immediately before
 * an H6 fallback:
 *
 *   <!-- heading-level: 7 -->
 *   ###### Deep heading
 *
 * Standard Markdown readers still see a heading; this app recovers the exact
 * level for correction, navigation, editing, HTML/JSON, and DOCX export.
 */

export const MARKDOWN_HEADING_LEVELS = 6;
export const MAX_HEADING_LEVEL = 9;

export const HEADING_LEVEL_META_RE = /^\s*<!--\s*heading-level:\s*([7-9])\s*-->\s*$/i;

/** Accept native ATX headings and raw 7-9 hash headings as an import fallback. */
export const EXTENDED_ATX_HEADING_RE = /^(#{1,9})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;

export interface ParsedHeading {
  /** Logical document depth (1-9). */
  level: number;
  /** Heading text with optional ATX closing hashes removed. */
  text: string;
  /** Zero-based line containing the visible ATX heading. */
  lineIndex: number;
  /** First line occupied by this logical heading (metadata line for levels 7-9). */
  startLineIndex: number;
  /** Native Markdown fallback level used by the visible ATX line. */
  markdownLevel: number;
}

function headingMatch(line: string): RegExpMatchArray | null {
  return line.match(EXTENDED_ATX_HEADING_RE);
}

function isFence(line: string): boolean {
  return /^\s*(```|~~~)/.test(line);
}

/** Serialize one logical heading using portable Markdown. */
export function serializeHeading(level: number, text: string): string {
  const clamped = Math.max(1, Math.min(MAX_HEADING_LEVEL, Math.trunc(level)));
  if (clamped <= MARKDOWN_HEADING_LEVELS) {
    return `${'#'.repeat(clamped)} ${text}`;
  }
  return `<!-- heading-level: ${clamped} -->\n${'#'.repeat(MARKDOWN_HEADING_LEVELS)} ${text}`;
}

/**
 * Parse every logical heading, skipping fenced code blocks. Metadata+H6 pairs
 * count as one heading. Raw 7-9 hash headings are accepted so model output and
 * old files can be normalized without losing structure.
 */
export function collectHeadings(markdownBody: string): ParsedHeading[] {
  const lines = markdownBody.split('\n');
  const headings: ParsedHeading[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    if (isFence(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const meta = lines[i].match(HEADING_LEVEL_META_RE);
    if (meta && i + 1 < lines.length) {
      const next = headingMatch(lines[i + 1]);
      if (next && next[1].length <= MARKDOWN_HEADING_LEVELS) {
        headings.push({
          level: Number(meta[1]),
          text: next[2],
          lineIndex: i + 1,
          startLineIndex: i,
          markdownLevel: next[1].length,
        });
        i++;
        continue;
      }
    }

    const match = headingMatch(lines[i]);
    if (!match) continue;
    headings.push({
      level: match[1].length,
      text: match[2],
      lineIndex: i,
      startLineIndex: i,
      markdownLevel: Math.min(match[1].length, MARKDOWN_HEADING_LEVELS),
    });
  }

  return headings;
}

export function countHeadings(markdownBody: string): number {
  return collectHeadings(markdownBody).length;
}

/** Convert raw 7-9 hash headings and non-canonical metadata pairs to the format above. */
export function normalizeExtendedHeadingSyntax(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isFence(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    const meta = line.match(HEADING_LEVEL_META_RE);
    if (meta && i + 1 < lines.length) {
      const next = headingMatch(lines[i + 1]);
      if (next) {
        out.push(...serializeHeading(Number(meta[1]), next[2]).split('\n'));
        i++;
        continue;
      }
    }

    const match = headingMatch(line);
    if (match && match[1].length > MARKDOWN_HEADING_LEVELS) {
      out.push(...serializeHeading(match[1].length, match[2]).split('\n'));
      continue;
    }

    out.push(line);
  }

  return out.join('\n');
}

/**
 * Remark plugin: turn metadata+H6 pairs into a styled heading-role element
 * while retaining parsed inline Markdown children. Native levels stay h1-h6.
 */
export function remarkExtendedHeadings() {
  return (tree: any) => {
    const transform = (parent: any) => {
      if (!Array.isArray(parent?.children)) return;
      for (let i = 0; i < parent.children.length; i++) {
        const node = parent.children[i];
        const meta = node?.type === 'html' && typeof node.value === 'string'
          ? node.value.match(HEADING_LEVEL_META_RE)
          : null;
        const next = parent.children[i + 1];
        if (meta && next?.type === 'heading' && next.depth === MARKDOWN_HEADING_LEVELS) {
          const level = Number(meta[1]);
          next.data = {
            ...(next.data || {}),
            hName: 'div',
            hProperties: {
              ...(next.data?.hProperties || {}),
              role: 'heading',
              'aria-level': level,
              'data-heading-level': level,
              className: ['extended-heading', `extended-heading-${level}`],
            },
          };
          parent.children.splice(i, 1);
          i--;
          continue;
        }
        transform(node);
      }
    };
    transform(tree);
  };
}
