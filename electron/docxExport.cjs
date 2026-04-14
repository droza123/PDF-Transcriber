/**
 * Markdown-to-DOCX converter with native Word footnotes.
 * Runs in Electron's main process (Node.js context).
 */

async function convertMarkdownToDocx(markdown) {
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
          new TextRun({ text: '  ', size: 20 }),
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
  let inOutline = false;
  let inCodeBlock = false;
  let codeBlockContent = [];
  const usedFootnoteIds = new Set(); // OOXML requires each footnoteReference ID to be unique

  // Title
  if (frontmatter.title) {
    children.push(new Paragraph({
      children: [new TextRun({ text: frontmatter.title, bold: true, size: 32 })],
      heading: HeadingLevel.TITLE,
      spacing: { after: 80 },
    }));
  }

  // Metadata
  const meta = [];
  if (frontmatter.source_file) meta.push(`Source: ${frontmatter.source_file}`);
  if (frontmatter.pages) meta.push(`Pages: ${frontmatter.pages}`);
  if (frontmatter.converted) meta.push(`Converted: ${frontmatter.converted}`);
  if (frontmatter.converter) meta.push(`Converter: ${frontmatter.converter}`);
  if (frontmatter.model) meta.push(`Model: ${frontmatter.model}`);
  if (meta.length > 0) {
    children.push(new Paragraph({
      children: [new TextRun({ text: meta.join('  |  '), size: 18, color: '888888', italics: true })],
      spacing: { after: 240 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'DDDDDD' } },
    }));
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // ── Code blocks ────────────────────────────────────────────────────
    if (trimmed.startsWith('```')) {
      if (inCodeBlock) {
        // End of code block
        const content = codeBlockContent.join('\n');
        if (content.trim()) {
          // Render code block lines individually as monospace
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
      inOutline = false;
      children.push(new Paragraph({
        border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' } },
        spacing: { before: 120, after: 120 },
      }));
      i++;
      continue;
    }

    // ── Page markers ───────────────────────────────────────────────────
    const pageMatch = trimmed.match(/^<!--\s*page:\s*(.+?)\s*-->$/);
    if (pageMatch) {
      children.push(new Paragraph({
        children: [new TextRun({ text: `\u2014 page ${pageMatch[1]} \u2014`, color: 'B8976A', size: 18, italics: true })],
        spacing: { before: 240, after: 80 },
      }));
      i++;
      continue;
    }

    // ── Document Outline marker ────────────────────────────────────────
    if (/^<!--\s*Document Outline\s*-->$/.test(trimmed)) {
      inOutline = true;
      children.push(new Paragraph({
        children: [new TextRun({ text: 'Document Outline', color: '666666', size: 22, bold: true })],
        spacing: { before: 200, after: 100 },
      }));
      i++;
      continue;
    }

    // ── Other HTML comments (skip) ─────────────────────────────────────
    if (/^<!--.*-->$/.test(trimmed)) { i++; continue; }

    // ── Headings ───────────────────────────────────────────────────────
    const headingMatch = trimmed.match(/^(#{1,8})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;

      if (inOutline) {
        // Render as indented outline entry, not a real heading
        const indent = (level - 1) * 280;
        children.push(new Paragraph({
          children: [new TextRun({ text: headingMatch[2], size: 20, color: '444444' })],
          indent: { left: indent },
          spacing: { after: 40 },
        }));
      } else {
        const levels = {
          1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2,
          3: HeadingLevel.HEADING_3, 4: HeadingLevel.HEADING_4,
          5: HeadingLevel.HEADING_5, 6: HeadingLevel.HEADING_6,
        };
        children.push(new Paragraph({
          children: makeRuns(headingMatch[2], fnKeyToIndex, docx, usedFootnoteIds),
          heading: levels[level] || HeadingLevel.HEADING_6,
          spacing: { before: 240, after: 120 },
        }));
      }
      i++;
      continue;
    }

    // ── Tables ─────────────────────────────────────────────────────────
    if (trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.split('|').length >= 3) {
      const tableRows = [];
      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|') && lines[i].trim().split('|').length >= 3) {
        const row = lines[i].trim();
        // Skip separator rows (| :--- | :--- |)
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
              const TABLE_WIDTH_TWIPS = 9360; // 6.5 inches text area
              return new TableCell({
                children: [new Paragraph({
                  children: makeRuns(cellText, fnKeyToIndex, docx, usedFootnoteIds),
                  spacing: { after: 40 },
                })],
                width: { size: Math.floor(TABLE_WIDTH_TWIPS / cells.length), type: WidthType.DXA },
                shading: isHeader ? { fill: 'F0F0F0' } : undefined,
              });
            }),
          });
        });

        children.push(new Table({
          rows: wordRows,
          width: { size: 9360, type: WidthType.DXA },
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

    // ── Outline description text ───────────────────────────────────────
    if (inOutline) {
      children.push(new Paragraph({
        children: [new TextRun({ text: trimmed, size: 20, color: '444444', italics: true })],
        spacing: { after: 60 },
      }));
      i++;
      continue;
    }

    // ── Regular paragraph ──────────────────────────────────────────────
    // Collect consecutive non-special lines into one paragraph
    const paraLines = [];
    while (i < lines.length) {
      const pl = lines[i].trim();
      if (!pl || pl === '---' || pl.startsWith('#') || pl.startsWith('>') ||
          pl.startsWith('|') || pl.startsWith('```') || pl.startsWith('<!--')) break;
      // Check if this line is a footnote definition
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
    // Safety: if nothing consumed the line, advance
    if (paraLines.length === 0) i++;
  }

  // ── Build and pack ───────────────────────────────────────────────────────
  // Explicitly define heading styles with outlineLevel so TOC generation
  // works correctly in Word and third-party tools (e.g. Logos/Verbum).
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
      font: 'Calibri',
    },
  }));

  const doc = new Document({
    footnotes: Object.keys(footnotes).length > 0 ? footnotes : undefined,
    styles: {
      paragraphStyles: [
        {
          id: 'Normal',
          name: 'Normal',
          run: { size: 24, font: 'Calibri' },
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
 * The docx library generates default heading styles without w:outlineLvl,
 * then our explicit styles (with outlineLvl) are appended. Some tools read
 * only the first definition, so TOC generation fails. This removes the
 * library's defaults, keeping only our explicit styles.
 */
async function deduplicateHeadingStyles(buffer) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buffer);
  const stylesXml = await zip.file('word/styles.xml').async('string');

  const styleRegex = /<w:style\b[^>]*w:styleId="(Heading[1-6]|Title)"[^>]*>[\s\S]*?<\/w:style>/g;
  const matches = [];
  let m;
  while ((m = styleRegex.exec(stylesXml)) !== null) {
    matches.push({ styleId: m[1], xml: m[0], hasOutline: m[0].includes('w:outlineLvl'), start: m.index, end: m.index + m[0].length });
  }

  const toRemove = [];
  const byId = new Map();
  for (const match of matches) {
    const existing = byId.get(match.styleId);
    if (existing) {
      if (match.hasOutline && !existing.hasOutline) {
        toRemove.push(existing);
      } else if (!match.hasOutline && existing.hasOutline) {
        toRemove.push(match);
      } else {
        toRemove.push(existing);
      }
      byId.set(match.styleId, match);
    } else {
      byId.set(match.styleId, match);
    }
  }

  if (toRemove.length === 0) return buffer;

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
      // First reference — create real OOXML footnote
      runs.push(new FootnoteReferenceRun(fnIdx));
      usedFootnoteIds.add(fnIdx);
    } else {
      // No definition or duplicate reference — render as superscript text
      runs.push(new TextRun({ text: match[1], superScript: true, color: '2563EB', size: 18 }));
    }
    lastIdx = fnRegex.lastIndex;
  }

  if (lastIdx < text.length) {
    runs.push(...formatText(text.slice(lastIdx), TextRun));
  }

  if (runs.length === 0) runs.push(new TextRun(text));
  return runs;
}

/** Parse **bold**, *italic*, ***bold+italic***, and <br> into TextRun array. */
function formatText(text, TextRun) {
  // Decode HTML entities before processing
  text = text.replace(/&nbsp;/g, '\u00A0').replace(/&amp;/g, '&')
             .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
             .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));

  const runs = [];
  const regex = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|<br\s*\/?>)/gi;
  let lastIdx = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      runs.push(new TextRun(text.slice(lastIdx, match.index)));
    }
    if (match[2]) {
      runs.push(new TextRun({ text: match[2], bold: true, italics: true }));
    } else if (match[3]) {
      runs.push(new TextRun({ text: match[3], bold: true }));
    } else if (match[4]) {
      runs.push(new TextRun({ text: match[4], italics: true }));
    } else {
      // <br> tag — insert a line break
      runs.push(new TextRun({ break: 1 }));
    }
    lastIdx = regex.lastIndex;
  }

  if (lastIdx < text.length) {
    runs.push(new TextRun(text.slice(lastIdx)));
  }
  return runs;
}

module.exports = { convertMarkdownToDocx };
