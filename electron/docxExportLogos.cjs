/**
 * Markdown-to-DOCX converter optimized for Logos/Verbum Personal Books.
 *
 * Differences from the standard export:
 * - Times New Roman font (Logos default)
 * - Page markers as [[@Page:N]] milestones (enables page-parallel scrolling)
 * - Headings wrapped with {{field-on:Heading}} / {{field-off:Heading}} tags
 * - No metadata block or document outline section
 * - Footnotes use standard Word footnotes (Logos reads them natively)
 */

async function convertMarkdownToDocxLogos(markdown) {
  const docx = await import('docx');
  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel,
    FootnoteReferenceRun, BorderStyle,
    Table, TableRow, TableCell, WidthType, AlignmentType,
  } = docx;

  // ── Parse frontmatter ────────────────────────────────────────────────────
  let frontmatter = {};
  let body = markdown;
  const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fmMatch) {
    body = markdown.slice(fmMatch[0].length);
    for (const line of fmMatch[1].split('\n')) {
      const m = line.match(/^(\w+):\s*"?(.+?)"?\s*$/);
      if (m) frontmatter[m[1]] = m[2];
    }
  }

  // ── Strip document outline section ───────────────────────────────────────
  // Remove everything between <!-- Document Outline --> and the next ---
  body = body.replace(/<!--\s*Document Outline\s*-->[\s\S]*?---\n?/, '');

  // ── Extract footnote definitions ─────────────────────────────────────────
  const footnoteMap = new Map();
  const fnDefRegex = /^\[\^(\w+)\]:\s*(.+)$/gm;
  let fnMatch;
  while ((fnMatch = fnDefRegex.exec(body)) !== null) {
    footnoteMap.set(fnMatch[1], fnMatch[2]);
  }
  body = body.replace(/^\[\^(\w+)\]:\s*.+$/gm, '').trim();

  // Map footnote keys to sequential indices
  const fnKeyToIndex = new Map();
  const footnotes = {};
  let fnIndex = 1;
  for (const [key, text] of footnoteMap) {
    fnKeyToIndex.set(key, fnIndex);
    footnotes[fnIndex] = {
      children: [new Paragraph({
        children: [
          new TextRun({ text: '  ', size: 20, font: 'Times New Roman' }),
          ...makeRuns(text, fnKeyToIndex, docx, null),
        ],
        spacing: { after: 80 },
      })],
    };
    fnIndex++;
  }

  // ── Split into lines and process ─────────────────────────────────────────
  const lines = body.split('\n');
  const children = [];
  let inCodeBlock = false;
  let codeBlockContent = [];
  const usedFootnoteIds = new Set();

  // Title from frontmatter
  if (frontmatter.title) {
    children.push(new Paragraph({
      children: [
        new TextRun({ text: '{{field-on:Heading}}', size: 2, color: 'FFFFFF' }),
        new TextRun({ text: frontmatter.title, bold: true, size: 32, font: 'Times New Roman' }),
        new TextRun({ text: '{{field-off:Heading}}', size: 2, color: 'FFFFFF' }),
      ],
      heading: HeadingLevel.TITLE,
      spacing: { after: 240 },
    }));
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // ── Code blocks ────────────────────────────────────────────────────
    if (trimmed.startsWith('```')) {
      if (inCodeBlock) {
        const content = codeBlockContent.join('\n');
        if (content.trim()) {
          for (const cl of codeBlockContent) {
            children.push(new Paragraph({
              children: [new TextRun({ text: cl, font: 'Consolas', size: 20, color: '444444' })],
              indent: { left: 360 },
              spacing: { after: 20 },
            }));
          }
        }
        inCodeBlock = false;
        codeBlockContent = [];
      } else {
        inCodeBlock = true;
        codeBlockContent = [];
      }
      i++;
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(line);
      i++;
      continue;
    }

    // ── Empty lines ────────────────────────────────────────────────────
    if (!trimmed) { i++; continue; }

    // ── Horizontal rule ────────────────────────────────────────────────
    if (trimmed === '---') {
      children.push(new Paragraph({
        border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' } },
        spacing: { before: 120, after: 120 },
      }));
      i++;
      continue;
    }

    // ── Page markers → Logos [[@Page:N]] milestones ────────────────────
    const pageMatch = trimmed.match(/^<!--\s*page:\s*(.+?)\s*-->$/);
    if (pageMatch) {
      children.push(new Paragraph({
        children: [new TextRun({ text: `[[@Page:${pageMatch[1]}]]`, font: 'Times New Roman', size: 24 })],
        spacing: { before: 80, after: 40 },
      }));
      i++;
      continue;
    }

    // ── Document Outline marker (skip any remaining) ───────────────────
    if (/^<!--\s*Document Outline\s*-->$/.test(trimmed)) {
      i++;
      continue;
    }

    // ── Other HTML comments (skip) ─────────────────────────────────────
    if (/^<!--.*-->$/.test(trimmed)) { i++; continue; }

    // ── Headings with Logos field tags ──────────────────────────────────
    const headingMatch = trimmed.match(/^(#{1,8})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const levels = {
        1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2,
        3: HeadingLevel.HEADING_3, 4: HeadingLevel.HEADING_4,
        5: HeadingLevel.HEADING_5, 6: HeadingLevel.HEADING_6,
      };

      children.push(new Paragraph({
        children: [
          new TextRun({ text: '{{field-on:Heading}}', size: 2, color: 'FFFFFF' }),
          ...makeRuns(headingMatch[2], fnKeyToIndex, docx, usedFootnoteIds),
          new TextRun({ text: '{{field-off:Heading}}', size: 2, color: 'FFFFFF' }),
        ],
        heading: levels[level] || HeadingLevel.HEADING_6,
        spacing: { before: 240, after: 120 },
      }));
      i++;
      continue;
    }

    // ── Tables ─────────────────────────────────────────────────────────
    if (trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.split('|').length >= 3) {
      const tableRows = [];
      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|') && lines[i].trim().split('|').length >= 3) {
        const row = lines[i].trim();
        if (/^\|[\s:\-|]+\|$/.test(row)) { i++; continue; }
        const cells = row.split('|').slice(1, -1).map(c => c.trim());
        tableRows.push(cells);
        i++;
      }

      if (tableRows.length > 0) {
        const isFirstRowHeader = tableRows.length > 1;
        const wordRows = tableRows.map((cells, rowIdx) => {
          return new TableRow({
            children: cells.map(cellText => {
              const isHeader = isFirstRowHeader && rowIdx === 0;
              return new TableCell({
                children: [new Paragraph({
                  children: makeRuns(cellText, fnKeyToIndex, docx, usedFootnoteIds),
                  spacing: { after: 40 },
                })],
                width: { size: Math.floor(100 / cells.length), type: WidthType.PERCENTAGE },
                shading: isHeader ? { fill: 'F0F0F0' } : undefined,
              });
            }),
          });
        });

        children.push(new Table({
          rows: wordRows,
          width: { size: 100, type: WidthType.PERCENTAGE },
        }));
        children.push(new Paragraph({ spacing: { after: 120 } }));
      }
      continue;
    }

    // ── Blockquotes ────────────────────────────────────────────────────
    if (trimmed.startsWith('> ')) {
      const quoteLines = [];
      while (i < lines.length && lines[i].trim().startsWith('> ')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      children.push(new Paragraph({
        children: makeRuns(quoteLines.join(' '), fnKeyToIndex, docx, usedFootnoteIds),
        indent: { left: 720 },
        border: { left: { style: BorderStyle.SINGLE, size: 3, color: 'CCCCCC', space: 10 } },
        spacing: { before: 100, after: 100 },
      }));
      continue;
    }

    // ── Regular paragraph ──────────────────────────────────────────────
    const paraLines = [];
    while (i < lines.length) {
      const pl = lines[i].trim();
      if (!pl || pl === '---' || pl.startsWith('#') || pl.startsWith('>') ||
          pl.startsWith('|') || pl.startsWith('```') || pl.startsWith('<!--')) break;
      if (/^\[\^\w+\]:\s/.test(pl)) break;
      paraLines.push(pl);
      i++;
    }

    if (paraLines.length > 0) {
      children.push(new Paragraph({
        children: makeRuns(paraLines.join(' '), fnKeyToIndex, docx, usedFootnoteIds),
        spacing: { after: 120 },
      }));
    }
    if (paraLines.length === 0) i++;
  }

  // ── Build and pack ───────────────────────────────────────────────────────
  // Explicitly define heading styles with outlineLevel so Logos/Verbum
  // recognizes them for table of contents generation.
  const headingStyles = [1, 2, 3, 4, 5, 6].map(level => ({
    id: `Heading${level}`,
    name: `Heading ${level}`,
    basedOn: 'Normal',
    next: 'Normal',
    quickFormat: true,
    paragraph: { outlineLevel: level - 1 },
    run: {
      size: Math.max(20, 36 - level * 4),
      bold: true,
      font: 'Times New Roman',
    },
  }));

  const doc = new Document({
    footnotes: Object.keys(footnotes).length > 0 ? footnotes : undefined,
    styles: {
      paragraphStyles: [
        {
          id: 'Normal',
          name: 'Normal',
          run: { size: 24, font: 'Times New Roman' },
          paragraph: { spacing: { line: 276 } },
        },
        ...headingStyles,
      ],
    },
    sections: [{ children }],
  });

  const rawBuffer = await Packer.toBuffer(doc);
  return await deduplicateHeadingStyles(rawBuffer);
}

/**
 * Post-process the DOCX buffer to remove duplicate heading styles.
 * The docx library's DefaultStylesFactory generates heading styles without
 * w:outlineLvl, then our explicit styles (with outlineLvl) are appended.
 * Logos/Verbum reads the first definition and ignores the second, so TOC
 * generation fails. This function removes the library's defaults, keeping
 * only our explicit styles that include outlineLvl.
 */
async function deduplicateHeadingStyles(buffer) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buffer);
  const stylesXml = await zip.file('word/styles.xml').async('string');

  // Remove duplicate heading style blocks that lack outlineLvl.
  // Keep only the ones that contain <w:outlineLvl>.
  const styleRegex = /<w:style\b[^>]*w:styleId="(Heading[1-6]|Title)"[^>]*>[\s\S]*?<\/w:style>/g;
  const seen = new Map(); // styleId → { xml, hasOutline, index }
  const matches = [];
  let m;
  while ((m = styleRegex.exec(stylesXml)) !== null) {
    const styleId = m[1];
    const xml = m[0];
    const hasOutline = xml.includes('w:outlineLvl');
    matches.push({ styleId, xml, hasOutline, start: m.index, end: m.index + m[0].length });
  }

  // Build list of ranges to remove: for each duplicate styleId, remove the
  // version WITHOUT outlineLvl (the library default).
  const toRemove = [];
  const byId = new Map();
  for (const match of matches) {
    const existing = byId.get(match.styleId);
    if (existing) {
      // We have a duplicate — remove the one without outlineLvl
      if (match.hasOutline && !existing.hasOutline) {
        toRemove.push(existing);
      } else if (!match.hasOutline && existing.hasOutline) {
        toRemove.push(match);
      }
      // If both or neither have outlineLvl, remove the first (library default)
      if (match.hasOutline === existing.hasOutline) {
        toRemove.push(existing);
      }
      byId.set(match.styleId, match);
    } else {
      byId.set(match.styleId, match);
    }
  }

  if (toRemove.length === 0) return buffer;

  // Remove in reverse order to preserve indices
  let fixed = stylesXml;
  toRemove.sort((a, b) => b.start - a.start);
  for (const r of toRemove) {
    fixed = fixed.slice(0, r.start) + fixed.slice(r.end);
  }

  zip.file('word/styles.xml', fixed);
  const result = await zip.generateAsync({ type: 'uint8array' });
  return Buffer.from(result);
}

/**
 * Build TextRun/FootnoteReferenceRun array from text with
 * inline formatting and footnote references.
 * Uses Times New Roman for all text runs.
 */
function makeRuns(text, fnKeyToIndex, docx, usedFootnoteIds) {
  const { TextRun, FootnoteReferenceRun } = docx;
  const runs = [];

  const fnRegex = /\[\^(\w+)\]/g;
  let lastIdx = 0;
  let match;

  while ((match = fnRegex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      runs.push(...formatText(text.slice(lastIdx, match.index), TextRun));
    }
    const fnIdx = fnKeyToIndex.get(match[1]);
    if (fnIdx && usedFootnoteIds && !usedFootnoteIds.has(fnIdx)) {
      runs.push(new FootnoteReferenceRun(fnIdx));
      usedFootnoteIds.add(fnIdx);
    } else {
      runs.push(new TextRun({ text: match[1], superScript: true, color: '2563EB', size: 18, font: 'Times New Roman' }));
    }
    lastIdx = fnRegex.lastIndex;
  }

  if (lastIdx < text.length) {
    runs.push(...formatText(text.slice(lastIdx), TextRun));
  }

  if (runs.length === 0) runs.push(new TextRun({ text, font: 'Times New Roman' }));
  return runs;
}

/** Parse **bold**, *italic*, ***bold+italic*** into TextRun array with Times New Roman. */
function formatText(text, TextRun) {
  const runs = [];
  const regex = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*)/g;
  let lastIdx = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      runs.push(new TextRun({ text: text.slice(lastIdx, match.index), font: 'Times New Roman' }));
    }
    if (match[2]) {
      runs.push(new TextRun({ text: match[2], bold: true, italics: true, font: 'Times New Roman' }));
    } else if (match[3]) {
      runs.push(new TextRun({ text: match[3], bold: true, font: 'Times New Roman' }));
    } else if (match[4]) {
      runs.push(new TextRun({ text: match[4], italics: true, font: 'Times New Roman' }));
    }
    lastIdx = regex.lastIndex;
  }

  if (lastIdx < text.length) {
    runs.push(new TextRun({ text: text.slice(lastIdx), font: 'Times New Roman' }));
  }
  return runs;
}

module.exports = { convertMarkdownToDocxLogos };
