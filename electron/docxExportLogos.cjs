/**
 * Markdown-to-DOCX converter optimized for Logos/Verbum Personal Books.
 *
 * Differences from the standard export:
 * - Times New Roman font (Logos default)
 * - Page markers as [[@Page:N]] milestones (enables page-parallel scrolling)
 * - Headings wrapped with {{field-on:Heading}} / {{field-off:Heading}} tags
 * - No metadata block or document outline section
 * - Footnotes use standard Word footnotes (Logos reads them natively)
 * - Endnote documents (frontmatter `notes: endnotes`) use native Word endnotes
 */

const {
  stripPlaceholderEndnoteDefs, detectEndnoteNumbering, reconcilePerChapterEndnotes,
  mergeEndnoteContinuations, extractEndnotePages, stripPrintedNotesSection,
  applyEndnoteFormatting, SECTION_BREAK_MARKER,
} = require('./endnotes.cjs');

async function convertMarkdownToDocxLogos(markdown) {
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

  // ── Endnote mode (see docxExport.cjs for the full rationale) ──────────────
  const isEndnote = frontmatter.notes === 'endnotes';
  let endnoteNumbering = 'continuous';
  let endnotePages = new Map();
  if (isEndnote) {
    // Drop transcription placeholder defs ("[^N]: [Endnote N]") first — a stray
    // mid-body block of these forms a phantom reset group that shifts per-chapter
    // linking to the previous chapter's notes.
    const ph = stripPlaceholderEndnoteDefs(body);
    body = ph.body;
    if (ph.dropped) console.log(`[docx-logos] Dropped ${ph.dropped} placeholder endnote definition(s)`);
    endnoteNumbering = detectEndnoteNumbering(body).numbering;
    if (endnoteNumbering === 'per-chapter') {
      const r = reconcilePerChapterEndnotes(body);
      body = r.body;
      console.log(`[docx-logos] Endnotes (per-chapter): ${r.matched} reference(s) linked, ${r.unmatchedRefs} unmatched (${r.refGroups} reference group(s)/${r.defGroups} definition group(s))`);
      if (r.refGroups !== r.defGroups) {
        console.warn(`[docx-logos] WARNING: endnote chapter groups mismatch (${r.refGroups} reference vs ${r.defGroups} definition) — links may resolve to the wrong chapter`);
      }
    }
    // Fold continued (page-wrapped) notes back into their definitions first, then
    // capture each note's printed page before stripping markers, to re-attach it as
    // a native Logos [[@Page:N]] milestone inside the endnote.
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

  // (Endnotes are auto-numbered by Word — see docxExport.cjs; "start at" is for footnotes only.)
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
  for (const [key, text] of footnoteMap) {
    fnKeyToIndex.set(key, fnIndex);
    // For endnotes, lead with the printed back-matter page as a VISIBLE "[p. N]"
    // run on EVERY endnote. Logos/Verbum treats endnotes like footnotes — hover-only,
    // viewed one at a time — so each note must carry its own page (no "only-on-change"
    // collapsing, which only suits a printed list). A [[@Page]] milestone inside a
    // note drives no navigation in Verbum, hence the visible marker. This does NOT
    // touch the body's [[@Page:N]] milestones, so main-text page navigation is intact.
    const pageRuns = [];
    if (isEndnote) {
      const pg = endnotePages.get(key);
      if (pg != null) {
        pageRuns.push(new TextRun({ text: `[p. ${pg}] `, color: 'B8976A', italics: true, size: 18, font: 'Times New Roman' }));
      }
    }
    footnotes[fnIndex] = {
      children: [new Paragraph({
        children: [
          new TextRun({ text: '  ', size: 20, font: 'Times New Roman' }),
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
  // `children` accumulates the current Word section; per-chapter endnote books
  // flush a section at each SECTION_BREAK_MARKER (for per-chapter number restart).
  let children = [];
  const sectionChunks = [];
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
          ...makeRuns(headingMatch[2], fnKeyToIndex, docx, usedFootnoteIds, NoteRefRun),
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

    // ── Standalone images ──────────────────────────────────────────────
    const imgMatch = trimmed.match(/^!\[([^\]]*)\]\((data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)\)$/);
    if (imgMatch) {
      const imgPara = makeImageParagraph(imgMatch[1], imgMatch[2], ImageRun, Paragraph, TextRun);
      if (imgPara) { children.push(...imgPara); i++; continue; }
    }

    // ── Regular paragraph ──────────────────────────────────────────────
    const paraLines = [];
    while (i < lines.length) {
      const pl = lines[i].trim();
      if (!pl || pl === '---' || pl.startsWith('#') || pl.startsWith('>') ||
          pl.startsWith('|') || pl.startsWith('```') || pl.startsWith('<!--')) break;
      if (/^\[\^\w+\]:\s/.test(pl)) break;
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

  // Flush the final (or only) section. Per-chapter endnote books get one
  // continuous section per chapter so Word can restart endnote numbering.
  sectionChunks.push(children);
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
          run: { size: 24, font: 'Times New Roman' },
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
 * Make Word/Logos display footnote numbers beginning at `startNum` (e.g. an
 * excerpt whose notes start at 33) instead of always renumbering from 1.
 * Numbering is continuous from the start value — gaps in the source are not
 * reproduced (the exact numbers live in the Markdown).
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
 * Build TextRun + note-reference run array from text with inline formatting and
 * [^N] note references. `NoteRefRun` is FootnoteReferenceRun or (for endnote
 * documents) EndnoteReferenceRun; defaults to FootnoteReferenceRun.
 * Uses Times New Roman for all text runs.
 */
function makeRuns(text, fnKeyToIndex, docx, usedFootnoteIds, NoteRefRun) {
  const { TextRun } = docx;
  const NoteRun = NoteRefRun || docx.FootnoteReferenceRun;
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
      runs.push(new NoteRun(fnIdx));
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

/** Parse **bold**, *italic*, ***bold+italic***, and <br> into TextRun array with Times New Roman. */
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
      runs.push(new TextRun({ text: text.slice(lastIdx, match.index), font: 'Times New Roman' }));
    }
    if (match[2]) {
      runs.push(new TextRun({ text: match[2], bold: true, italics: true, font: 'Times New Roman' }));
    } else if (match[3]) {
      runs.push(new TextRun({ text: match[3], bold: true, font: 'Times New Roman' }));
    } else if (match[4]) {
      runs.push(new TextRun({ text: match[4], italics: true, font: 'Times New Roman' }));
    } else {
      // <br> tag — insert a line break
      runs.push(new TextRun({ break: 1, font: 'Times New Roman' }));
    }
    lastIdx = regex.lastIndex;
  }

  if (lastIdx < text.length) {
    runs.push(new TextRun({ text: text.slice(lastIdx), font: 'Times New Roman' }));
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

    const dims = getImageDimensions(buf);
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
            type: 'png',
          }),
        ],
        spacing: { before: 120, after: alt ? 40 : 120 },
      }),
    ];

    if (alt) {
      result.push(new Paragraph({
        children: [new TextRun({ text: alt, italics: true, size: 18, color: '666666', font: 'Times New Roman' })],
        spacing: { after: 120 },
      }));
    }

    return result;
  } catch (e) {
    console.warn('[docx-logos] Failed to embed image:', e.message);
    return null;
  }
}

/** Best-effort image dimension reader for PNG and JPEG. */
function getImageDimensions(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let offset = 2;
    while (offset < buf.length - 9) {
      if (buf[offset] !== 0xFF) { offset++; continue; }
      const marker = buf[offset + 1];
      if (marker === 0xC0 || marker === 0xC2) {
        return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      }
      const segLen = buf.readUInt16BE(offset + 2);
      offset += 2 + segLen;
    }
  }
  return null;
}

module.exports = { convertMarkdownToDocxLogos };
