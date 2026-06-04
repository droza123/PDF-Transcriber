/**
 * Endnote support for the DOCX exporters (shared by docxExport.cjs and
 * docxExportLogos.cjs).
 *
 * An endnote book carries [^N] references in the body and [^N]: definitions in a
 * back-matter Notes section (flagged by `notes: endnotes` in the frontmatter). The
 * Markdown file keeps those printed numbers verbatim. When building the DOCX we
 * turn them into NATIVE Word endnotes:
 *   • continuous numbering → labels are already unique, render as-is.
 *   • per-chapter numbering → [^1] repeats each chapter; we reconcile each body
 *     reference with its definition (chapter-scoped) onto a unique synthetic label
 *     so the existing label→note machinery links them, then split the document into
 *     one Word section per chapter and have Word restart endnote numbers each
 *     section (the printed per-chapter numbers).
 */
'use strict';

const SECTION_BREAK_MARKER = '<!-- ENDNOTE-SECTION-BREAK -->';

/** Group {n,...} items into chapters: a number strictly LESS than the previous one
 *  starts a new group (a per-chapter reset). Equal numbers (a note referenced
 *  twice) stay in the same group. */
function groupByReset(items) {
  const groups = [];
  let cur = null;
  let lastN = null;
  for (const it of items) {
    if (lastN === null || it.n < lastN) { cur = []; groups.push(cur); }
    cur.push(it);
    lastN = it.n;
  }
  return groups;
}

/**
 * Drop placeholder note definitions the transcription emits when it can't read a
 * note's actual text — lines whose entire definition body is a bracketed stand-in
 * echoing the note number, e.g. "[^98]: [Endnote 98]" (also "[Footnote N]" /
 * "[Note N]"). These carry no real content, and — far worse for per-chapter books —
 * when such a block lands mid-body (before a chapter's real NOTES section) it forms
 * a spurious definition-reset GROUP. That extra group shifts every chapter's
 * reference→definition matching by one, so links resolve to the PREVIOUS chapter's
 * notes (observed in Combat Myth: a stray [^98]..[^107] block inside Ch I's body).
 * Removing them restores 1:1 chapter alignment. MUST run first in the endnote
 * pipeline, before detectEndnoteNumbering / reconcilePerChapterEndnotes.
 *
 * The pattern is deliberately tight — only "[word + optional number]" with nothing
 * else on the line — so a real note that merely starts with a bracket (e.g.
 * "[^5]: [sic] …") is never dropped. Returns { body, dropped }.
 */
function stripPlaceholderEndnoteDefs(body) {
  const placeholderRe = /^\s*\[\^\w+\]:\s*\[\s*(?:end|foot)?note\s*\d*\s*\]\s*$/i;
  let dropped = 0;
  const out = body.split('\n').filter((l) => {
    if (placeholderRe.test(l)) { dropped += 1; return false; }
    return true;
  });
  return { body: out.join('\n'), dropped };
}

/**
 * Classify endnote numbering from the [^N]: definitions in a body.
 * Returns { numbering: 'continuous' | 'per-chapter', defCount, groups }.
 */
function detectEndnoteNumbering(body) {
  const defLineRe = /^\[\^(\d+)\]:/;
  const defs = [];
  for (const line of body.split('\n')) {
    const m = line.trim().match(defLineRe);
    if (m) defs.push({ n: parseInt(m[1], 10) });
  }
  const groups = groupByReset(defs);
  return {
    numbering: groups.length > 1 ? 'per-chapter' : 'continuous',
    defCount: defs.length,
    groups: groups.length,
  };
}

/** Visible placeholder for a note whose printed reference exists but whose text was
 *  lost in transcription (e.g. a truncated notes section). Shown, never silent. */
const STUB_NOTE_TEXT = '*[Note text not captured from source]*';

/**
 * Recover endnotes whose body reference marker was lost — trapped inside a fenced code
 * block (an OCR'd table) or dropped outright by OCR / a skipped page — and keep the
 * displayed numbers aligned with the printed book no matter why a number is skipped.
 *
 * Native Word/Logos endnotes are auto-numbered by REFERENCE order within a numbering
 * section, so any printed number lacking a live reference makes its note invisible AND
 * shifts every following note's number down by one. Per chapter (numbering-reset group)
 * we make the references a gapless run from the chapter's first number up to maxDef —
 * the highest printed number that actually has note text — inserting whatever is missing:
 *   • note text but no body reference   → synthesize a [^N] marker in ascending order
 *     just before the first higher reference (placement is approximate — we only know
 *     which two real notes it falls between — but the note is recovered and numbered).
 *   • a body reference but no note text (a real note follows, N < maxDef) → insert a
 *     VISIBLE stub definition so the number is occupied and following notes don't drift.
 *   • a number missing from BOTH (a true gap below maxDef) → insert both, keeping the
 *     run gapless.
 * Printed numbers ABOVE maxDef (e.g. a notes section truncated mid-chapter) are left as
 * plain superscript text: correct literal numbers, nothing real follows them, so they
 * neither drift nor add noise.
 *
 * Runs BEFORE reconcilePerChapterEndnotes. Aligns the k-th reference group with the k-th
 * definition group; if the group COUNTS differ it makes NO change (skipped:true) so a
 * chapter is never guessed. `perChapter` sets the run's start: per-chapter chapters fill
 * from 1 (Word restarts each section at 1); a continuous book fills from its first printed
 * number, returned as `firstNumber` for the numbering "start at" value.
 * Returns { body, synthRefs, stubDefs, firstNumber, skipped }.
 */
function fillEndnoteGaps(body, perChapter) {
  const lines = body.split('\n');
  const defLineRe = /^\[\^(\d+)\]:/;
  const refRe = /\[\^(\d+)\]/g;

  // References (skip code fences + definition lines), grouped by reset, with positions.
  const refGroups = [];
  {
    let cur = null, last = null, inCode = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('```')) { inCode = !inCode; continue; }
      if (inCode) continue;
      if (defLineRe.test(lines[i].trim())) continue;
      let m; refRe.lastIndex = 0;
      while ((m = refRe.exec(lines[i])) !== null) {
        const n = parseInt(m[1], 10);
        if (last === null || n < last) { cur = []; refGroups.push(cur); }
        cur.push({ n, lineIdx: i, start: m.index, end: m.index + m[0].length });
        last = n;
      }
    }
  }
  // Definitions, grouped by reset, with line indices.
  const defGroups = [];
  {
    let cur = null, last = null;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].trim().match(defLineRe);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      if (last === null || n < last) { cur = []; defGroups.push(cur); }
      cur.push({ n, lineIdx: i });
      last = n;
    }
  }

  const firstNumber = (defGroups.length && defGroups[0].length)
    ? Math.min(...defGroups[0].map(d => d.n), ...(refGroups[0] ? refGroups[0].map(r => r.n) : []))
    : 1;
  if (refGroups.length === 0 || refGroups.length !== defGroups.length) {
    return { body, synthRefs: 0, stubDefs: 0, firstNumber, skipped: refGroups.length !== defGroups.length };
  }

  const refInsertAt = new Map();    // `${lineIdx}:${pos}` -> { lineIdx, pos, labels:[n,...] }
  const stubBeforeLine = new Map(); // lineIdx -> [n,...]   stub defs inserted BEFORE this line
  const stubAfterLine = new Map();  // lineIdx -> [n,...]   stub defs inserted AFTER this line
  const addTo = (map, key, n) => { if (!map.has(key)) map.set(key, []); map.get(key).push(n); };
  let synthRefs = 0, stubDefs = 0;

  for (let k = 0; k < refGroups.length; k++) {
    const refs = refGroups[k];
    const defs = defGroups[k];
    const refNums = new Set(refs.map(r => r.n));
    const defNums = new Set(defs.map(d => d.n));
    const maxDef = Math.max(...defs.map(d => d.n));
    const lo = perChapter ? 1 : Math.min(...defs.map(d => d.n), ...refs.map(r => r.n));

    for (let n = lo; n <= maxDef; n++) {
      const hasRef = refNums.has(n);
      const hasDef = defNums.has(n);
      if (hasRef && hasDef) continue;

      if (!hasRef) {
        // Place [^N] so the reference run stays ascending: just before the first existing
        // reference greater than N, else after the group's last reference.
        let target;
        const higher = refs.find(r => r.n > n);
        if (higher) target = { lineIdx: higher.lineIdx, pos: higher.start };
        else if (refs.length) { const lr = refs[refs.length - 1]; target = { lineIdx: lr.lineIdx, pos: lr.end }; }
        else target = { lineIdx: defs[0].lineIdx, pos: 0 };
        const key = `${target.lineIdx}:${target.pos}`;
        if (!refInsertAt.has(key)) refInsertAt.set(key, { lineIdx: target.lineIdx, pos: target.pos, labels: [] });
        refInsertAt.get(key).labels.push(n);
        synthRefs++;
      }
      if (!hasDef) {
        // Insert a stub definition in ascending order: before the first higher definition.
        const higherDef = defs.find(d => d.n > n);
        if (higherDef) addTo(stubBeforeLine, higherDef.lineIdx, n);
        else addTo(stubAfterLine, defs[defs.length - 1].lineIdx, n);
        stubDefs++;
      }
    }
  }

  // Splice synthetic references in, rightmost position first so earlier offsets stay valid.
  const byLine = new Map();
  for (const ins of refInsertAt.values()) addTo(byLine, ins.lineIdx, ins);
  for (const [lineIdx, inss] of byLine) {
    inss.sort((a, b) => b.pos - a.pos);
    let line = lines[lineIdx];
    for (const ins of inss) {
      const text = ins.labels.sort((a, b) => a - b).map(n => `[^${n}]`).join('');
      line = line.slice(0, ins.pos) + text + line.slice(ins.pos);
    }
    lines[lineIdx] = line;
  }

  // Emit, inserting stub-definition lines around their anchors (ascending).
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (stubBeforeLine.has(i)) for (const n of stubBeforeLine.get(i).sort((a, b) => a - b)) out.push(`[^${n}]: ${STUB_NOTE_TEXT}`);
    out.push(lines[i]);
    if (stubAfterLine.has(i)) for (const n of stubAfterLine.get(i).sort((a, b) => a - b)) out.push(`[^${n}]: ${STUB_NOTE_TEXT}`);
  }

  return { body: out.join('\n'), synthRefs, stubDefs, firstNumber, skipped: false };
}

/**
 * Per-chapter reconciliation. Rewrites the body so each body reference and its
 * matching definition share a unique synthetic label `e{K}`, and inserts a
 * section-break marker before each chapter (after the first) so the exporter can
 * restart Word endnote numbering per chapter.
 *
 * Matching: definitions and references are each grouped by numbering reset, in
 * document order; the k-th reference group is matched to the k-th definition group
 * by printed number. References with no matching definition keep their [^N] form
 * (rendered as a plain superscript). Returns
 * { body, matched, unmatchedRefs, defGroups, refGroups } — the exporters warn when
 * defGroups !== refGroups (a stray definition block would shift chapter linking).
 */
function reconcilePerChapterEndnotes(body) {
  const lines = body.split('\n');
  const defLineRe = /^\[\^(\d+)\]:/;
  const refRe = /\[\^(\d+)\]/g;

  // 1) Definition groups → per-group map { printedNumber → uniqueLabel }.
  const defs = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(defLineRe);
    if (m) defs.push({ n: parseInt(m[1], 10), lineIdx: i });
  }
  const defGroups = groupByReset(defs);
  let counter = 0;
  const groupNumToLabel = defGroups.map(group => {
    const map = new Map();
    for (const d of group) {
      if (!map.has(d.n)) { counter += 1; map.set(d.n, 'e' + counter); }
    }
    return map;
  });

  // 2) Rewrite references (skip definition lines), tracking the chapter group by
  //    reset so the same [^1] in different chapters maps to different labels.
  //    Skip fenced code blocks: their content is rendered verbatim by the exporters
  //    (makeRuns is never applied), so a [^N] inside one cannot become a live
  //    reference — rewriting it would only leak the synthetic "[^eK]" label as
  //    literal text. Leave such a [^N] untouched (it stays as the OCR emitted it).
  let matched = 0;
  let unmatchedRefs = 0;
  let repeatRefs = 0;
  let inCodeBlock = false;
  const state = { groupIdx: -1, lastN: null };
  const groupStartLine = []; // groupStartLine[k] = first reference line of chapter k
  // A note may be referenced more than once in a chapter, but a native Word/Logos
  // endnote can carry only ONE reference mark. We rewrite the FIRST occurrence of each
  // (chapter, number) to its unique label (→ a real endnote reference) and leave any
  // repeat as the printed [^N], which makeRuns renders as a plain superscript number.
  // Rewriting the repeat too would leak the internal "eK" label as visible body text.
  const emitted = new Set(); // `${groupIdx}:${n}` already turned into a real reference
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('```')) { inCodeBlock = !inCodeBlock; continue; }
    if (inCodeBlock) continue;
    if (defLineRe.test(lines[i].trim())) continue;
    if (!/\[\^\d+\]/.test(lines[i])) continue;
    let result = '';
    let lastIdx = 0;
    let m;
    refRe.lastIndex = 0;
    while ((m = refRe.exec(lines[i])) !== null) {
      const n = parseInt(m[1], 10);
      if (state.lastN === null) state.groupIdx = 0;
      else if (n < state.lastN) state.groupIdx += 1;
      state.lastN = n;
      if (groupStartLine[state.groupIdx] === undefined) groupStartLine[state.groupIdx] = i;
      const label = groupNumToLabel[state.groupIdx] ? groupNumToLabel[state.groupIdx].get(n) : null;
      const key = `${state.groupIdx}:${n}`;
      result += lines[i].slice(lastIdx, m.index);
      if (label && !emitted.has(key)) { result += `[^${label}]`; emitted.add(key); matched += 1; }
      else if (label) { result += m[0]; repeatRefs += 1; } // repeat reference — keep printed number
      else { result += m[0]; unmatchedRefs += 1; }
      lastIdx = m.index + m[0].length;
    }
    result += lines[i].slice(lastIdx);
    lines[i] = result;
  }

  // 3) Rewrite definition lines to the same unique labels.
  for (let g = 0; g < defGroups.length; g++) {
    for (const d of defGroups[g]) {
      const label = groupNumToLabel[g].get(d.n);
      lines[d.lineIdx] = lines[d.lineIdx].replace(/^(\s*)\[\^\d+\]:/, `$1[^${label}]:`);
    }
  }

  // 4) Insert a section-break marker before each chapter after the first. Place it
  //    at the nearest heading preceding that chapter's first reference (so the
  //    break aligns with the chapter title), else just before the reference line.
  const breakBeforeLine = new Set();
  const isFurn = (l) => /^#{1,6}\s+/.test(l.trim()) || /^<!--\s*page:.*-->$/i.test(l.trim()) || l.trim() === '';
  for (let k = 1; k < groupStartLine.length; k++) {
    const refLine = groupStartLine[k];
    if (refLine === undefined) continue;
    const prevRefLine = groupStartLine[k - 1] === undefined ? 0 : groupStartLine[k - 1];
    let insertAt = -1;
    for (let i = refLine; i > prevRefLine; i--) {
      if (/^#{1,6}\s+/.test(lines[i].trim())) { insertAt = i; break; }
    }
    if (insertAt < 0) { breakBeforeLine.add(refLine); continue; }
    // Extend up over the whole contiguous chapter-opening block (page marker +
    // stacked headings like "# CHAPTER IV" then its title), so the entire opening
    // moves into the new section together rather than leaving the top heading and
    // its page marker stranded at the end of the previous chapter's section.
    while (insertAt - 1 > prevRefLine && isFurn(lines[insertAt - 1])) insertAt--;
    breakBeforeLine.add(insertAt);
  }
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (breakBeforeLine.has(i)) out.push(SECTION_BREAK_MARKER);
    out.push(lines[i]);
  }

  return { body: out.join('\n'), matched, unmatchedRefs, repeatRefs, defGroups: defGroups.length, refGroups: groupStartLine.length };
}

/**
 * Fold continued endnotes back into their definition. When a long note wraps across
 * a printed page break, the transcription emits the continuation as a separate plain
 * paragraph after a `<!-- page: N -->` marker (e.g. "[^8]: …the author" / page 148 /
 * "of the book…"). Left alone, that continuation is neither a definition nor furniture,
 * so it breaks the notes run and ends up as stray body text before the endnotes.
 *
 * For each `[^N]:` definition we absorb the following continuation paragraph(s) — up to
 * the next definition / heading / notes-label — appending them to the note text. Any
 * page markers passed over are relocated to AFTER the merged note (before the next
 * note) so they still mark that next note's page for navigation / "[p. N]" display.
 * Runs after reconciliation and before extractEndnotePages / stripPrintedNotesSection.
 */
function mergeEndnoteContinuations(body) {
  const lines = body.split('\n');
  const isDef = (l) => /^\[\^\w+\]:/.test(l.trim());
  const isHeading = (l) => /^#{1,6}\s+/.test(l.trim());
  const isPage = (l) => /^<!--\s*page:.*-->$/i.test(l.trim());
  const isBlank = (l) => l.trim() === '';
  const isNotesLabel = (l) => {
    const t = l.trim();
    return /^(end\s*notes|notes)$/i.test(t) || /^(notes?\s+(to|for)\b.*)$/i.test(t) || /^chapter\s+[0-9ivxlcdm]+\.?$/i.test(t);
  };
  const isBoundary = (l) => isDef(l) || isHeading(l) || isNotesLabel(l) || l.trim() === SECTION_BREAK_MARKER;

  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (!isDef(lines[i])) { out.push(lines[i]); i++; continue; }
    let text = lines[i].trim();
    const heldPages = [];
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j];
      if (isBoundary(l)) break;
      if (isBlank(l)) { j++; continue; }
      if (isPage(l)) { heldPages.push(l.trim()); j++; continue; }
      text += ' ' + l.trim(); // continuation paragraph
      j++;
    }
    out.push(text);
    for (const pm of heldPages) out.push(pm); // relocate page markers to the next note
    i = j;
  }
  return out.join('\n');
}

/**
 * Map each [^N]: definition to the printed page it appeared on — the most recent
 * `<!-- page: N -->` marker before it. The book's back-matter notes carry their own
 * page numbers (distinct from body pages); we capture them here so the exporters
 * can re-attach the page to each native endnote (a Logos [[@Page]] milestone, or a
 * visible "[p. N]" run for standard Word). MUST run after per-chapter reconciliation
 * (labels are final) but BEFORE stripPrintedNotesSection (markers still present).
 * Returns Map<label, pageString>.
 */
function extractEndnotePages(body) {
  const pageOf = new Map();
  const pageRe = /^<!--\s*page:\s*(.+?)\s*-->$/i;
  const defRe = /^\[\^(\w+)\]:/;
  let currentPage = null;
  for (const line of body.split('\n')) {
    const t = line.trim();
    const pm = t.match(pageRe);
    if (pm) { currentPage = pm[1]; continue; }
    const dm = t.match(defRe);
    if (dm && currentPage != null && !pageOf.has(dm[1])) pageOf.set(dm[1], currentPage);
  }
  return pageOf;
}

/**
 * Remove the printed Notes/Endnotes sections' headings and page markers from the
 * body. The note text (the [^N]: definitions) is extracted separately into native
 * Word endnotes, so leaving the printed "NOTES" / "Chapter N" headings behind would
 * produce empty, redundant heading blocks before Word's auto-rendered endnotes.
 *
 * Crucially this must handle BOTH layouts:
 *   • end-of-chapter notes — a notes block after every chapter, with body chapters
 *     in between (Combat Myth). Each block must be stripped INDEPENDENTLY so the
 *     intervening chapter headings and page markers survive.
 *   • end-of-book notes — one block (optionally with "Chapter N" subheads) at the
 *     very back.
 *
 * Algorithm: find each contiguous run of definitions (runs may interleave blank
 * lines, page markers, and notes sub-headings) and, for each, also absorb the
 * heading/page-marker/blank preamble immediately above it. Within that span only
 * heading and page-marker lines are dropped (definitions are kept for extraction).
 * A heading AFTER a run's last definition belongs to the next chapter and is left
 * untouched — the run is bounded to its last definition, and body text always ends
 * a run, so two chapters' notes never merge across intervening body.
 */
function stripPrintedNotesSection(body) {
  const lines = body.split('\n');
  const isDef = (l) => /^\[\^\w+\]:/.test(l.trim());
  const isHeading = (l) => /^#{1,6}\s+/.test(l.trim());
  const isPage = (l) => /^<!--\s*page:.*-->$/i.test(l.trim());
  const isBlank = (l) => l.trim() === '';
  // Some transcriptions emit the notes section's "NOTES" / "Chapter N" labels as
  // plain text rather than Markdown headings. Treat these (narrowly) as notes
  // furniture too, so they don't linger as stray paragraphs once the note text
  // becomes Word endnotes.
  const isNotesLabel = (l) => {
    const t = l.trim();
    return /^(end\s*notes|notes)$/i.test(t)
      || /^(notes?\s+(to|for)\b.*)$/i.test(t)
      || /^chapter\s+[0-9ivxlcdm]+\.?$/i.test(t);
  };
  const isFurniture = (l) => isHeading(l) || isPage(l) || isBlank(l) || isNotesLabel(l);
  const isStrippable = (l) => isHeading(l) || isPage(l) || isNotesLabel(l);

  const remove = new Array(lines.length).fill(false);
  let i = 0;
  while (i < lines.length) {
    if (!isDef(lines[i])) { i++; continue; }

    // Preamble: walk up over contiguous headings / page markers / blanks (the
    // printed "NOTES" / "Chapter N" labels), stopping at real body text.
    let start = i;
    for (let u = i - 1; u >= 0 && isFurniture(lines[u]); u--) start = u;

    // Walk down through this contiguous notes run, tracking the LAST definition.
    // Headings/page markers/blanks between definitions stay in the run; the first
    // body line ends it. Headings after the last definition are NOT part of it.
    let lastDef = i;
    let j = i;
    while (j < lines.length && (isDef(lines[j]) || isFurniture(lines[j]))) {
      if (isDef(lines[j])) lastDef = j;
      j++;
    }

    for (let k = start; k <= lastDef; k++) {
      if (isStrippable(lines[k])) remove[k] = true;
    }
    i = j;
  }

  return lines.filter((_, k) => !remove[k]).join('\n');
}

/**
 * Patch the packed DOCX with the endnote properties Word needs to render notes
 * faithfully. Three things must be set (verified against a hand-corrected file):
 *   • numFmt = decimal — the OOXML default for endnotes is lowerRoman (i, ii, iii),
 *     so without this Word shows roman numerals.
 *   • pos = sectEnd | docEnd — where the notes collect (end of each chapter vs the
 *     very end of the document).
 *   • numRestart = eachSect — restart numbering per chapter (per-chapter books only).
 * Crucially, numFmt/numRestart must live in EACH section's sectPr (not only the
 * document-wide default in settings.xml) — that is the location Word actually
 * honors, exactly as for footnote numbering (see setFootnoteNumStart). No-op if
 * endnote properties already exist.
 *
 *   • numStart — a continuous endnote book whose first note isn't 1 (e.g. an excerpt
 *     starting at note 33) needs a "start at" value. Like footnotes (see
 *     setFootnoteNumStart), Word honors this on the SECTION endnotePr — the document
 *     default alone is ignored — so it goes on both. Per-chapter books restart each
 *     section at 1, so no start offset applies there. Child order in CT_EdnProps is
 *     fixed: pos, numFmt, numStart, numRestart.
 *
 * @param {{ perChapter: boolean, position: 'sectEnd'|'docEnd', numStart?: number }} options
 */
async function applyEndnoteFormatting(buffer, options) {
  const { perChapter, position, numStart } = options;
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buffer);
  const numFmt = '<w:numFmt w:val="decimal"/>';
  const restart = perChapter ? '<w:numRestart w:val="eachSect"/>' : '';
  const startFrag = (!perChapter && numStart && numStart > 1) ? `<w:numStart w:val="${numStart}"/>` : '';
  let changed = false;

  // (1) Document-wide default in settings.xml: position + format (+ start) (+ restart).
  const settingsFile = zip.file('word/settings.xml');
  if (settingsFile) {
    let xml = await settingsFile.async('string');
    if (!xml.includes('<w:endnotePr')) {
      const frag = `<w:endnotePr><w:pos w:val="${position}"/>${numFmt}${startFrag}${restart}</w:endnotePr>`;
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

  // (2) Section-level override in document.xml — the location Word honors for the
  //     numbering format and per-section restart. Applied to every section.
  const docFile = zip.file('word/document.xml');
  if (docFile) {
    let xml = await docFile.async('string');
    if (!xml.includes('<w:endnotePr')) {
      const frag = `<w:endnotePr>${numFmt}${startFrag}${restart}</w:endnotePr>`;
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

module.exports = {
  SECTION_BREAK_MARKER,
  stripPlaceholderEndnoteDefs,
  detectEndnoteNumbering,
  fillEndnoteGaps,
  reconcilePerChapterEndnotes,
  mergeEndnoteContinuations,
  extractEndnotePages,
  stripPrintedNotesSection,
  applyEndnoteFormatting,
};
