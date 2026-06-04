/**
 * Markdown-to-DOCX converter with native Word footnotes (and native Word endnotes
 * for documents flagged `notes: endnotes` in their frontmatter).
 * Runs in Electron's main process (Node.js context).
 */

const {
  detectEndnoteNumbering, reconcilePerChapterEndnotes, mergeEndnoteContinuations,
  extractEndnotePages, stripPrintedNotesSection, applyEndnoteFormatting, SECTION_BREAK_MARKER,
} = require('./endnotes.cjs');

async function convertMarkdownToDocx(markdown) {
  const docx = await import('docx');
  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel,
    FootnoteReferenceRun, EndnoteReferenceRun, SectionType, BorderStyle, ImageRun,
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

  // ── Endnote mode ─────────────────────────────────────────────────────────
  // Documents flagged `notes: endnotes` carry [^N] references in the body and
  // [^N]: definitions in a back-matter Notes section. Render these as NATIVE Word
  // endnotes instead of page-bottom footnotes. For per-chapter numbering we first
  // reconcile each reference with its (chapter-scoped) definition onto a unique
  // label and split the document into one section per chapter so Word can restart
  // the numbers; the printed Notes headings/page markers are removed (the text
  // becomes Word endnotes). The body [^N]/[^N]: machinery below is reused as-is.
  const isEndnote = frontmatter.notes === 'endnotes';
  let endnoteNumbering = 'continuous';
  let endnotePages = new Map();
  if (isEndnote) {
    endnoteNumbering = detectEndnoteNumbering(body).numbering;
    if (endnoteNumbering === 'per-chapter') {
      const r = reconcilePerChapterEndnotes(body);
      body = r.body;
      console.log(`[docx] Endnotes (per-chapter): ${r.matched} reference(s) linked, ${r.unmatchedRefs} unmatched`);
    }
    // Fold continued (page-wrapped) notes back into their definitions first, then
    // capture each note's printed back-matter page BEFORE stripping the markers,
    // so we can re-attach it to the endnote (a visible "[p. N]" run here).
    body = mergeEndnoteContinuations(body);
    endnotePages = extractEndnotePages(body);
    body = stripPrintedNotesSection(body);
  }
  const NoteRefRun = isEndnote ? EndnoteReferenceRun : FootnoteReferenceRun;

  // ── Extract footnote definitions ─────────────────────────────────────────
  const footnoteMap = new Map();
  const fnDefRegex = /^\[\^(\w+)\]:\s*(.+)$/gm;
  let fnMatch;
  while ((fnMatch = fnDefRegex.exec(body)) !== null) {
    footnoteMap.set(fnMatch[1], fnMatch[2]);
  }
  body = body.replace(/^\[\^(\w+)\]:\s*.+$/gm, '').trim();

  // Footnote numbering start: Word auto-numbers footnotes from 1, but the source
  // may begin at another number (e.g. an excerpt whose notes start at 33). Use the
  // FIRST footnote reference's printed number as Word's "start at" value so the
  // displayed numbers match the original. Numbering is continuous from there, so
  // gaps render consecutively (the exact numbers are preserved in the Markdown).
  // (Endnotes are auto-numbered by Word — for per-chapter books a settings patch
  // restarts them each section; so this "start at" offset applies to footnotes only.)
  let footnoteNumStart = 0;
  if (!isEndnote) {
    const firstFnRef = body.match(/\[\^(\d+)\]/);
    if (firstFnRef) {
      const n = parseInt(firstFnRef[1], 10);
      if (!isNaN(n) && n > 1) footnoteNumStart = n;
    }
  }

  // Map note keys to sequential indices (footnotes or endnotes)
  const fnKeyToIndex = new Map();
  const footnotes = {};
  let fnIndex = 1;
  let prevNotePage = null;
  for (const [key, text] of footnoteMap) {
    fnKeyToIndex.set(key, fnIndex);
    // For endnotes, lead with the printed back-matter page — but only when it
    // changes from the previous note (mirrors how the book marks page boundaries).
    // Styled like the body's "— page N —" markers (gold, italic).
    const pageRuns = [];
    if (isEndnote) {
      const pg = endnotePages.get(key);
      if (pg != null && pg !== prevNotePage) {
        pageRuns.push(new TextRun({ text: `[p. ${pg}] `, color: 'B8976A', italics: true, size: 18 }));
        prevNotePage = pg;
      }
    }
    footnotes[fnIndex] = {
      children: [new Paragraph({
        children: [
          new TextRun({ text: '  ', size: 20 }),
          ...pageRuns,
          ...makeRuns(text, fnKeyToIndex, docx, null, NoteRefRun),
        ],
        spacing: { after: 80 },
      })],
    };
    fnIndex++;
  }

  // ── Split into lines and process ─────────────────────────────────────────
  const lines = body.split('\n');
  // `children` accumulates the CURRENT Word section. Per-chapter endnote books
  // emit SECTION_BREAK_MARKER lines, which flush the section so Word can restart
  // endnote numbering per chapter; everything else stays in one section.
  let children = [];
  const sectionChunks = [];
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

    // ── Endnote per-chapter section break ──────────────────────────────
    if (trimmed === SECTION_BREAK_MARKER) {
      sectionChunks.push(children);
      children = [];
      i++;
      continue;
    }

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
          children: makeRuns(headingMatch[2], fnKeyToIndex, docx, usedFootnoteIds, NoteRefRun),
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
                  children: makeRuns(cellText, fnKeyToIndex, docx, usedFootnoteIds, NoteRefRun),
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
        children: makeRuns(quoteLines.join(' '), fnKeyToIndex, docx, usedFootnoteIds, NoteRefRun),
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

    // ── Standalone images ──────────────────────────────────────────────
    const imgMatch = trimmed.match(/^!\[([^\]]*)\]\((data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)\)$/);
    if (imgMatch) {
      const imgPara = makeImageParagraph(imgMatch[1], imgMatch[2], ImageRun, Paragraph, TextRun);
      if (imgPara) { children.push(...imgPara); i++; continue; }
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
      // Don't swallow standalone image lines into a paragraph
      if (/^!\[.*\]\(data:image\//.test(pl)) break;
      paraLines.push(pl);
      i++;
    }

    if (paraLines.length > 0) {
      children.push(new Paragraph({
        children: makeRuns(paraLines.join(' '), fnKeyToIndex, docx, usedFootnoteIds, NoteRefRun),
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

  // Flush the final (or only) section.
  sectionChunks.push(children);
  // Per-chapter endnote books become one continuous section per chapter so Word
  // can restart endnote numbering each section; everything else is one section.
  const sections = sectionChunks.length > 1
    ? sectionChunks.map((chunk, idx) => (
        idx === 0
          ? { children: chunk }
          : { properties: { type: SectionType.CONTINUOUS }, children: chunk }
      ))
    : [{ children: sectionChunks[0] }];

  const notesObj = Object.keys(footnotes).length > 0 ? footnotes : undefined;
  const doc = new Document({
    ...(notesObj ? (isEndnote ? { endnotes: notesObj } : { footnotes: notesObj }) : {}),
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
    sections,
  });

  const rawBuffer = await Packer.toBuffer(doc);
  let outBuffer = await deduplicateHeadingStyles(rawBuffer);
  if (isEndnote) {
    const perChapter = endnoteNumbering === 'per-chapter';
    // Position default pairs with numbering (per-chapter → end of each section;
    // continuous → end of document); overridable via `notes_position` frontmatter.
    const position = frontmatter.notes_position === 'document-end' ? 'docEnd'
      : frontmatter.notes_position === 'section-end' ? 'sectEnd'
      : (perChapter ? 'sectEnd' : 'docEnd');
    outBuffer = await applyEndnoteFormatting(outBuffer, { perChapter, position });
  } else if (footnoteNumStart > 1) {
    outBuffer = await setFootnoteNumStart(outBuffer, footnoteNumStart);
  }
  return outBuffer;
}

/**
 * Make Word display footnote numbers beginning at `startNum` (e.g. an excerpt
 * whose notes start at 33) instead of always renumbering from 1. Numbering is
 * continuous from the start value — gaps in the source are not reproduced (the
 * exact numbers live in the Markdown).
 *
 * Word reads the footnote "start at" value from the SECTION properties
 * (w:sectPr/w:footnotePr), NOT the document-wide default in settings.xml, so we
 * inject into both: the section override (what Word honors) and the document
 * default (broad-compat for other readers). Schema note: in CT_Settings
 * <w:footnotePr> precedes <w:compat>; in CT_SectPr it precedes <w:pgSz> et al.
 * (these exports carry no header/footer references), so inserting it right after
 * the <w:sectPr> opening tag is valid.
 */
async function setFootnoteNumStart(buffer, startNum) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buffer);
  const frag = `<w:footnotePr><w:numStart w:val="${startNum}"/></w:footnotePr>`;
  let changed = false;

  // (1) Document-wide default in settings.xml (broad compat for non-Word readers).
  const settingsFile = zip.file('word/settings.xml');
  if (settingsFile) {
    let xml = await settingsFile.async('string');
    if (!xml.includes('<w:footnotePr')) {
      if (xml.includes('<w:compat')) {
        xml = xml.replace('<w:compat', `${frag}<w:compat`);
        zip.file('word/settings.xml', xml);
        changed = true;
      } else if (xml.includes('</w:settings>')) {
        xml = xml.replace('</w:settings>', `${frag}</w:settings>`);
        zip.file('word/settings.xml', xml);
        changed = true;
      }
    }
  }

  // (2) Section override in document.xml — the location Word actually honors.
  const docFile = zip.file('word/document.xml');
  if (docFile) {
    let xml = await docFile.async('string');
    if (!xml.includes('<w:footnotePr')) {
      const patched = xml.replace(/<w:sectPr\b[^>]*>/g, (tag) => `${tag}${frag}`);
      if (patched !== xml) {
        zip.file('word/document.xml', patched);
        changed = true;
      }
    }
  }

  if (!changed) return buffer;
  const result = await zip.generateAsync({ type: 'uint8array' });
  return Buffer.from(result);
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
 * Build TextRun + note-reference run array from text with inline formatting and
 * [^N] note references. `RefRunClass` is FootnoteReferenceRun or (for endnote
 * documents) EndnoteReferenceRun; defaults to FootnoteReferenceRun.
 */
function makeRuns(text, fnKeyToIndex, docx, usedFootnoteIds, RefRunClass) {
  const { TextRun } = docx;
  const NoteRun = RefRunClass || docx.FootnoteReferenceRun;
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
      // First reference — create the real OOXML footnote/endnote reference
      runs.push(new NoteRun(fnIdx));
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

/**
 * Decode a data:image/... URI and build an ImageRun paragraph.
 * Returns an array of paragraphs (image + optional caption), or null on failure.
 */
function makeImageParagraph(alt, dataUri, ImageRun, Paragraph, TextRun) {
  try {
    const commaIdx = dataUri.indexOf(',');
    if (commaIdx === -1) return null;
    const b64 = dataUri.slice(commaIdx + 1);
    const buf = Buffer.from(b64, 'base64');

    // Read image dimensions from header bytes (best-effort)
    const dims = getImageDimensions(buf);
    // Scale to fit page width (6 inches = 914400 EMU max)
    const MAX_WIDTH = 914400 * 6;
    let w = dims?.width || 400;
    let h = dims?.height || 300;
    if (w * 914400 / 96 > MAX_WIDTH) {
      const scale = MAX_WIDTH / (w * 914400 / 96);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }

    const result = [
      new Paragraph({
        children: [
          new ImageRun({
            data: buf,
            transformation: { width: w, height: h },
            type: 'png', // docx lib accepts any image format with this
          }),
        ],
        spacing: { before: 120, after: alt ? 40 : 120 },
      }),
    ];

    if (alt) {
      result.push(new Paragraph({
        children: [new TextRun({ text: alt, italics: true, size: 18, color: '666666' })],
        spacing: { after: 120 },
      }));
    }

    return result;
  } catch (e) {
    console.warn('[docx] Failed to embed image:', e.message);
    return null;
  }
}

/** Best-effort image dimension reader for PNG and JPEG. */
function getImageDimensions(buf) {
  // PNG: bytes 16-23 contain width (4 bytes) and height (4 bytes) in the IHDR chunk
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
    return {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
    };
  }
  // JPEG: scan for SOF0/SOF2 marker (0xFF 0xC0 or 0xFF 0xC2)
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let offset = 2;
    while (offset < buf.length - 9) {
      if (buf[offset] !== 0xFF) { offset++; continue; }
      const marker = buf[offset + 1];
      if (marker === 0xC0 || marker === 0xC2) {
        return {
          height: buf.readUInt16BE(offset + 5),
          width: buf.readUInt16BE(offset + 7),
        };
      }
      const segLen = buf.readUInt16BE(offset + 2);
      offset += 2 + segLen;
    }
  }
  return null;
}

module.exports = { convertMarkdownToDocx };
