# PDFTranscriber: Recommendations for Heading Quality Improvement

> Companion document to `pdftranscriber_issue_taxonomy.md`.
> Actionable recommendations at two levels:
> (A) AI prompt improvements, and (B) script-based Markdown post-processing.
>
> **Architecture constraints:**
> - The AI only sees ~5 PDF pages per batch (not changing).
> - The prescan outline (full document structure) is passed to every batch.
> - Post-processing is script-based only (no LLM calls on assembled output).
> - The AI cannot cross-reference content across batches.

---

## A. AI Prompt Improvements

These changes target `buildBatchPrompt` in `gemini.ts` and the prescan prompt.

### A1. Add Previous-Batch Heading Context (HIGH PRIORITY)

**Problem:** The #1 cause of issues (exact duplicates, near-duplicates, level resets) is
that each batch has zero knowledge of what the previous batch actually produced. The AI
re-emits headings that already appeared at the end of the prior batch.

**Current state:** The prompt includes the prescan outline for structural context, but
nothing about the actual output of the preceding batch.

**Recommendation:** After each batch completes, extract the last ~5 headings from its
Markdown output. Pass them to the next batch in the prompt.

**Proposed prompt addition** (insert after the outline section):

```
Previous batch context:
The previous batch ended with the following headings (in order). DO NOT repeat these
headings — continue from where the previous batch left off. Maintain the heading
hierarchy established below:

{previousBatchHeadings}

If the first page of this batch shows content that falls under the last heading above,
do NOT re-emit that heading. Simply continue the content.
```

**Implementation sketch** (in `convert.ts`, around line 140):

```typescript
// After each batch result, extract trailing headings for next batch
function extractTrailingHeadings(markdown: string, count = 5): string {
  const lines = markdown.split('\n');
  const headings: string[] = [];
  for (const line of lines) {
    const match = line.match(/^(#{1,7})\s+(.+)/);
    if (match) headings.push(line);
  }
  return headings.slice(-count).join('\n');
}
```

**Expected impact:** Should eliminate ~80% of exact-duplicate and near-duplicate headings,
and significantly reduce chunk-boundary level resets.

---

### A2. Running Header Suppression (MEDIUM PRIORITY)

**Problem:** The AI picks up running headers (book title, chapter name, author name
repeated at the top of every page) and transcribes them as document headings. Within a
5-page batch, these appear as the same short text at the top of each page — the AI can
detect this pattern.

**Proposed prompt addition:**

```
Running headers / page headers:
- PDF pages often have repeated headers at the top of each page (book title, chapter
  title, author name, or abbreviated section titles). These are navigational artifacts
  of the printed page, NOT document headings or content.
- If you see the same short text appearing at the top of multiple pages in this batch,
  it is a running header — do NOT transcribe it.
- Running headers typically alternate between recto (right page, often the chapter
  title) and verso (left page, often the book title or author name).
```

---

### A3. Deeper Prescan Outline (MEDIUM PRIORITY)

**Problem:** The prescan outline often captures only 3–4 levels of heading depth. For
densely-structured academic texts (common in biblical commentaries), this means the AI
has no outline guidance for sub-sub-sections, leading to level guessing within each batch.

**Current prescan prompt** shows examples up to `#### Sub-subsection`.

**Proposed replacement for the prescan prompt:**

```
Analyze this PDF document and produce a structural outline in Markdown. Include:

1. The document's page numbering scheme (e.g., "roman numerals i-xii for front matter,
   then arabic 1-234 for body", or "no page numbers visible").
2. A hierarchical table of contents using Markdown headings to show the nesting.
   Capture ALL levels of the hierarchy, including deeply nested subsections
   (up to 6 or 7 levels if present). Academic commentaries often have structures like:
   # Part
   ## Chapter
   ### §1. Major Section
   #### A. Subsection
   ##### 1. Sub-subsection
   ###### 1.1 Detailed point
   ####### 1.1.1 Verse-level analysis
   Include the page number (as printed in the document) next to each heading if visible.
3. If the document has a Table of Contents, use it as the primary source for the
   outline — it shows the author's intended hierarchy. But verify against the actual
   body headings where possible.

Output ONLY the outline — no content, no commentary.
```

---

## B. Script-Based Markdown Post-Processing

These steps run on the assembled Markdown **before** conversion to DOCX. They use no
LLM calls — pure string/regex processing. They belong in `convert.ts` after the
`normalizeBlankLines()` call (around line 170).

Given the architecture, this is where most of the practical value lies. The AI prompt
can be improved (section A), but the AI will never be perfect — a robust post-processing
pipeline catches what it misses.

### B1. Exact Duplicate Removal (HIGH PRIORITY, LOW EFFORT)

**Issue addressed:** #1 (exact duplicates), #8 (running headers)

Port the logic from `clean_duplicate_headings.py`:

```typescript
function removeExactDuplicateHeadings(markdown: string): string {
  const lines = markdown.split('\n');
  const seenHeadings = new Map<string, number>(); // key → line index of first occurrence
  const toRemove = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,7})\s+(.+)/);
    if (!match) continue;
    const [, hashes, text] = match;
    const key = `${hashes.length}:${text.trim()}`;

    if (seenHeadings.has(key)) {
      toRemove.add(i);
    } else {
      seenHeadings.set(key, i);
    }
  }

  // Special handling: short headings like "(a)", "(b)" may legitimately repeat
  // under different parent headings. For headings matching /^\([a-z]\)/, check
  // that the nearest parent heading (first preceding heading at a shallower level)
  // is the same before marking as duplicate.

  return lines.filter((_, i) => !toRemove.has(i)).join('\n');
}
```

Also catches running headers (#8) as a side effect — any heading repeated 5+ times
will have all but the first removed.

---

### B2. Near-Duplicate Detection (HIGH PRIORITY, MEDIUM EFFORT)

**Issue addressed:** #2 (near-duplicates)

The key insight: near-duplicates in these files almost always differ only in verse
reference punctuation (`1:4-8` vs `1, 4-8`) or minor wording. A normalization function
handles this without fuzzy matching:

```typescript
function removeNearDuplicateHeadings(markdown: string): string {
  const lines = markdown.split('\n');
  const headings: Array<{index: number, level: number, raw: string, normalized: string}> = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,7})\s+(.+)/);
    if (match) {
      headings.push({
        index: i,
        level: match[1].length,
        raw: match[2].trim(),
        normalized: normalizeHeadingText(match[2].trim()),
      });
    }
  }

  const toRemove = new Set<number>();
  const seen = new Map<string, number>(); // normalized key → first index in headings[]

  for (let i = 0; i < headings.length; i++) {
    if (toRemove.has(headings[i].index)) continue;
    const key = `${headings[i].level}:${headings[i].normalized}`;

    if (seen.has(key)) {
      toRemove.add(headings[i].index);
    } else {
      seen.set(key, i);
    }
  }

  return lines.filter((_, i) => !toRemove.has(i)).join('\n');
}

function normalizeHeadingText(text: string): string {
  return text
    .toLowerCase()
    // Normalize verse references: (1:4-8) ≈ (1, 4-8) ≈ (1,4–8)
    .replace(/\s*([,:;])\s*/g, '$1')  // collapse spaces around punctuation
    .replace(/[,:]/g, ':')             // unify comma/colon in refs
    .replace(/[–—]/g, '-')            // unify dashes
    .replace(/\s+/g, ' ')
    .trim();
}
```

---

### B3. TOC Heading Removal (MEDIUM PRIORITY, LOW EFFORT)

**Issue addressed:** #6 (TOC transcribed as headings)

```typescript
function removeTocHeadings(markdown: string): string {
  const lines = markdown.split('\n');
  let inToc = false;
  const toRemove = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,7})\s+(.+)/);
    if (!match) continue;
    const text = match[2].trim();

    if (/^(Contents|Table of Contents|Inhaltsverzeichnis)/i.test(text)) {
      inToc = true;
      toRemove.add(i);
      continue;
    }

    if (inToc) {
      // TOC entries end with page numbers
      if (/\s+\d+\s*$/.test(text)) {
        toRemove.add(i);
      } else {
        inToc = false; // First heading without trailing page number = end of TOC
      }
    }
  }

  return lines.filter((_, i) => !toRemove.has(i)).join('\n');
}
```

---

### B4. Mechanical Level Jump Repair (MEDIUM PRIORITY, LOW EFFORT)

**Issue addressed:** #4 (level jumps like H1 → H4 with no H2/H3)

```typescript
function fixMechanicalLevelJumps(markdown: string): string {
  const lines = markdown.split('\n');
  let deepestSeen = 0; // tracks the deepest heading level encountered so far

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,7})\s+(.+)/);
    if (!match) continue;

    const level = match[1].length;

    if (level > deepestSeen + 1 && deepestSeen > 0) {
      // Jump too big — promote to deepestSeen + 1
      const fixedLevel = deepestSeen + 1;
      lines[i] = '#'.repeat(fixedLevel) + ' ' + match[2];
      deepestSeen = fixedLevel;
    } else {
      deepestSeen = Math.max(deepestSeen, level);
    }

    // When we encounter a shallower heading, reset our tracker
    // (e.g., going from ### back to # means ## is valid next)
    if (level <= deepestSeen) {
      deepestSeen = level;
    }
  }

  return lines.join('\n');
}
```

Note: This simplified version tracks only the last heading depth. A more robust approach
would maintain a full heading stack, but this catches the most common cases.

---

### B5. Chunk-Boundary Level Reset Detection (MEDIUM PRIORITY, HIGH EFFORT)

**Issue addressed:** #3 (level resets at chunk boundaries)

This is the hardest issue to fix with pure scripts, because it requires inferring the
"correct" level. The approach: detect the reset (duplicate chapter-level heading), remove
it, then use section numbering patterns to reassign levels to the subsequent headings.

```typescript
function fixChunkBoundaryResets(markdown: string): string {
  const lines = markdown.split('\n');
  const headings: Array<{index: number, level: number, text: string}> = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,7})\s+(.+)/);
    if (match) {
      headings.push({ index: i, level: match[1].length, text: match[2].trim() });
    }
  }

  // Step 1: Find duplicate H1s that signal chunk resets
  const h1Texts = new Map<string, number>(); // normalized text → first heading index
  const resetPoints: number[] = []; // heading indices where resets occur

  for (let i = 0; i < headings.length; i++) {
    if (headings[i].level !== 1) continue;
    const norm = normalizeHeadingText(headings[i].text);
    if (h1Texts.has(norm)) {
      resetPoints.push(i);
      lines[headings[i].index] = ''; // Remove the duplicate H1
    } else {
      h1Texts.set(norm, i);
    }
  }

  // Step 2: For headings after each reset point, infer correct levels from numbering
  for (const resetIdx of resetPoints) {
    // Find the last "good" heading before the reset to establish context
    let contextLevel = 1;
    for (let j = resetIdx - 1; j >= 0; j--) {
      if (headings[j].level > 0 && lines[headings[j].index] !== '') {
        contextLevel = headings[j].level;
        break;
      }
    }

    // Walk headings after the reset and fix levels using numbering patterns
    for (let j = resetIdx + 1; j < headings.length; j++) {
      const h = headings[j];
      if (lines[h.index] === '') continue;

      const inferred = inferLevelFromNumbering(h.text);
      if (inferred !== null && inferred !== h.level) {
        lines[h.index] = '#'.repeat(inferred) + ' ' + h.text;
        headings[j] = { ...h, level: inferred };
      }

      // Stop fixing when we hit a heading that seems correctly placed
      // (i.e., its level matches what we'd expect from context)
      if (h.level <= contextLevel) break;
    }
  }

  return lines.filter(l => l !== '').join('\n');
}

/**
 * Infer the expected heading level from a heading's numbering pattern.
 * Returns null if no pattern is detected.
 *
 * This function needs a "base level" — the level of the parent section
 * heading (e.g., "D. Analysis" at H4). It determines depth relative to that.
 * Since we may not always know the parent, returns absolute estimates based
 * on common academic numbering conventions.
 */
function inferLevelFromNumbering(text: string): number | null {
  // §N patterns → typically H3 (major section under chapter subtitle)
  if (/^§\d+\.?\s/.test(text)) return 3;
  // Letter patterns A., B., C. → typically H4 (under §N)
  if (/^[A-Z]\.\s/.test(text)) return 4;
  // x.y.z → H7
  if (/^\d+\.\d+\.\d+/.test(text)) return 7;
  // x.y space → H6
  if (/^\d+\.\d+\s/.test(text)) return 6;
  // Single number followed by period and space → H5
  if (/^\d+\.\s/.test(text)) return 5;
  return null;
}
```

**Caveat:** The `inferLevelFromNumbering` function uses absolute level estimates based
on common academic commentary conventions (§ → H3, letter → H4, etc.). This works well
for the Revelation commentary corpus but may need tuning for books with different
conventions. A more robust version would be relative to the detected parent heading.

---

### B6. Markdown Artifact Cleanup (LOW PRIORITY, VERY LOW EFFORT)

**Issue addressed:** #9 (double-encoded headings like `# ## Title`)

```typescript
function cleanMarkdownArtifacts(markdown: string): string {
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // Double-encoded heading: "## ## Title" → "## Title"
    const match = lines[i].match(/^(#{1,7})\s+#{1,7}\s+(.+)/);
    if (match) {
      lines[i] = match[1] + ' ' + match[2];
    }
  }
  return lines.join('\n');
}
```

---

## C. Recommended Processing Pipeline

Assemble the post-processing steps in this order (in `convert.ts`):

```typescript
async function postProcessMarkdown(rawMarkdown: string): Promise<string> {
  let md = rawMarkdown;

  // 1. Existing cleanup
  md = stripCodeFences(md);
  md = normalizeBlankLines(md);

  // 2. Heading cleanup (new — order matters)
  md = cleanMarkdownArtifacts(md);         // Fix ## ## double-encoding
  md = removeTocHeadings(md);              // Strip TOC entries (before dedup)
  md = removeExactDuplicateHeadings(md);   // Exact text match dedup
  md = removeNearDuplicateHeadings(md);    // Fuzzy match dedup
  md = fixChunkBoundaryResets(md);         // Fix reset-level chaos (before jump fix)
  md = fixMechanicalLevelJumps(md);        // Fix H1→H4 skips (last — after other fixes)

  return md;
}
```

**Order matters:**
1. Artifact cleanup and TOC removal run first to simplify the data.
2. Deduplication runs before level fixes, because duplicates confuse level heuristics.
3. Chunk-boundary reset repair runs before mechanical jump repair, because resets create
   artificial jumps that would be "fixed" in the wrong direction otherwise.

---

## D. Quick Wins (Implementable in < 1 Hour Each)

| # | Change | Where | Lines of code | Expected impact |
|---|--------|-------|---------------|-----------------|
| 1 | Previous-batch heading context (A1) | `convert.ts` + `gemini.ts` | ~20 | Prevents ~80% of duplicates at source |
| 2 | Exact duplicate removal (B1) | `convert.ts` | ~30 | Catches remaining exact duplicates |
| 3 | TOC heading removal (B3) | `convert.ts` | ~20 | Eliminates TOC-as-heading blocks |
| 4 | Markdown artifact cleanup (B6) | `convert.ts` | ~10 | Strips `## ##` double-encoding |
| 5 | Running header prompt (A2) | `gemini.ts` | ~5 | Prevents running header transcription |

These five changes would have prevented roughly 70–80% of the ~2,300 heading fixes
we made manually.

---

## E. Testing Strategy

To validate improvements, maintain a small test corpus of known-problematic PDFs:

1. **Prigent** — many near-duplicates with verse reference variations
2. **Tavo** — TOC-as-headings + chunk boundary reset in Ch 6
3. **Satake** — logical level errors with Roman numeral sections
4. **Giblin** — chiastic structure + running headers
5. **Giesen** — major sections buried under Introduction

For each, keep the expected heading structure as a reference file. After re-running the
pipeline with improvements, diff against the reference to verify fix counts.
