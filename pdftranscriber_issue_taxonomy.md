# PDFTranscriber Issue Taxonomy

> Based on systematic heading cleanup of 15+ scholarly commentaries and monographs
> on the Book of Revelation, totaling ~2,300 heading fixes across four passes.
> Cross-referenced with the PDFTranscriber codebase (prompt, chunking, and conversion logic).

---

## How the Current Pipeline Works (Summary)

The app has a **two-pass architecture**:

1. **Prescan (Pass 1):** The AI reads the full PDF and produces a structural outline with heading levels and page numbers.
2. **Batch Conversion (Pass 2):** The PDF is split into chunks of ~5 pages each. Each chunk is sent to the AI with the prescan outline as context. The AI transcribes that chunk's content to Markdown, using the outline to assign heading levels.

Batches are strict page ranges with **no overlap** and **no inter-batch context** (i.e., batch N does not know what batch N-1 actually produced). After all batches are joined, the only post-processing is blank-line normalization (`\n{3,}` → `\n\n`) and code-fence stripping.

The Markdown is then converted to DOCX (standard or Logos/Verbum format) with heading levels mapped directly: `#` → Heading 1, `##` → Heading 2, etc.

---

## Issue Categories

### 1. Exact-Duplicate Headings

**Frequency:** Very high (~960 instances across 15 files)

**Root cause:** Chunk-boundary re-transcription. The AI processes pages 1–5, ending mid-section. When it starts pages 6–10, it re-emits the section heading that was already produced at the end of the previous batch.

**Why the current prompt doesn't prevent it:** The prompt says "Never duplicate content — each passage of text should appear exactly once," but the AI has no way to know what text the previous batch actually produced. The prescan outline tells it *what headings exist*, but not *which ones have already been emitted*.

**Pattern:** Two identical heading paragraphs, usually separated by the chunk boundary (every ~5 pages).

**Example:**
```markdown
## THE WOMAN, HER SON, AND THE DRAGON (12:1–18)
[body text from batch N...]

## THE WOMAN, HER SON, AND THE DRAGON (12:1–18)    ← batch N+1 re-emits heading
[body text continues from batch N+1...]
```

**Detection:** Group headings by exact text; flag groups with count > 1. Keep first occurrence, remove rest. Special care for legitimately repeated short headings like `(a)`, `(b)` — check parent context before removing.

---

### 2. Near-Duplicate Headings

**Frequency:** High (~137 instances)

**Root cause:** Same chunk-boundary issue as #1, but the re-transcription introduces minor variations — different punctuation in verse references, slight translation differences, or formatting variations between the two AI calls.

**Why the current prompt doesn't prevent it:** Same reason as #1. Additionally, the AI may read the same PDF heading slightly differently across two calls (e.g., interpreting a colon vs. comma in a verse reference).

**Pattern:** Two headings with the same structural meaning but slightly different text.

**Examples:**
```markdown
## ADDRESS (1:4-8)
## ADDRESS (1, 4-8)          ← colon vs comma in reference

## The Sealed Book and the Lamb (5, 1-14)
## The Sealed Book and the Lamb (5:1-14)

## THE WOMAN, HER SON, AND THE DRAGON (12:1–18)
## THE WOMAN, HER SON AND THE DRAGON (12, 1-18)    ← comma dropped, punctuation changed
```

**Detection strategies:**
- Normalize verse references: strip spaces around colons/commas/dashes, treat `:` ≈ `,` in `(X:Y–Z)` patterns
- Fuzzy matching: Levenshtein ratio > 0.85 between headings at the same level within a window
- Lowercase token-set comparison (ignoring punctuation)

---

### 3. Chunk-Boundary Level Reset

**Frequency:** High (occurs in most multi-chunk files)

**Root cause:** When a new batch starts, the AI sometimes ignores the prescan outline and assigns heading levels based on the visual formatting of the first page in the batch. This creates a "reset" where deeply-nested content (H5–H7) suddenly appears at H1–H2.

**Why the current prompt doesn't prevent it:** The prompt says "Use the heading hierarchy from the outline above to determine correct heading levels. Match headings to the outline." However, for detailed sub-sub-sections (e.g., `1.1.3`, `2.2.1`), the prescan outline often doesn't capture this level of granularity. The outline may list `D. Analysis of Revelation 12` but not each verse-level sub-heading under it. So the AI falls back to guessing levels from visual formatting.

**Pattern:** A sudden jump to H1 or H2 mid-document, often accompanied by a re-emitted chapter title.

**Example (Tavo Ch 6):**
```markdown
####### 1.1.2 γυνὴ περιβεβλημένη τὸν ἥλιον...
[end of batch N]

# Chapter Six: The Woman Clothed with the Sun     ← batch N+1 resets to H1
## 1.1.3 καὶ ἐν γαστρὶ ἔχουσα...                 ← should be H7, not H2
### 1.2 A Fiery Great Dragon                       ← should be H6, not H3
```

**Detection strategies:**
- Flag any H1 after the first ~5 headings whose text matches an earlier H1 (duplicate chapter title)
- Flag sudden level drops of ≥3 levels (e.g., H6 → H1 → H2)
- Use section numbering patterns (1.1.3, 2.2.1) to infer expected depth:
  - `X.` → one level below parent section
  - `X.Y` → two levels below
  - `X.Y.Z` → three levels below

---

### 4. Mechanical Heading Level Jumps

**Frequency:** Moderate (~63 instances)

**Root cause:** The AI skips levels in the heading hierarchy (e.g., H2 directly to H4 with no H3), or assigns a child at the same level as its parent.

**Why the current prompt doesn't prevent it:** The prescan outline may not capture every heading, especially in densely structured academic texts. When the AI encounters a heading not in the outline, it guesses the level, sometimes skipping.

**Pattern:** `current_level > previous_level + 1` (e.g., H1 followed by H3 with no H2).

**Detection:** Walk the heading sequence; if a heading is >1 level deeper than the most recent heading at the nearest shallower level, flag it.

---

### 5. Logical Heading Level Errors

**Frequency:** Moderate-high (~650+ instances across targeted files)

**Root cause:** The AI assigns heading levels based on visual formatting in the PDF (font size, boldness) rather than the book's actual logical structure, even when the prescan outline provides the correct hierarchy.

**Sub-types:**

**5a. Sections at wrong depth relative to siblings.** Numbered sections that should be peers end up at different levels.
```markdown
## 5. Outline
### 6. The Genesis of the Book    ← should be ## (peer of 5)
## 7. Theology
```

**5b. Major divisions at incorrect absolute level.** Commentary sections (A, B, C, D or I, II, III) placed under the Introduction rather than as top-level divisions.
```markdown
# Introduction
  ## 1. The Special Position...
  ## 10. On the Design...
  ## A. Introduction to the Book 1:1-20    ← should be # (major section)
  ## B. The Letters...                      ← should be #
```

**5c. Chiastic / literary structures misread.** When a scholar uses a chiastic structure (A, B, C, D, C', B', A'), the AI doesn't recognize these as siblings.
```markdown
#### Section A (11:15B-19)
##### Section B (12:1-18)       ← should be #### (sibling of A)
##### Section C (13:1-18)       ← should be ####
### Section D (14:1-5)          ← should be ####
```

**Detection strategies:**
- Numbering sequence analysis: if headings follow a sequence (1, 2, 3... or A, B, C... or I, II, III...), verify they're at the same level
- Chiastic detection: look for prime-marked headings (C', B', A') and match to counterparts

---

### 6. Table of Contents Transcribed as Headings

**Frequency:** Occasional (1 file, ~146 headings)

**Root cause:** The AI encounters the book's printed Table of Contents and transcribes each entry as a Markdown heading, creating a complete duplicate heading structure.

**Why the current prompt doesn't prevent it:** The prompt says "If the document has a table of contents, render its entries as plain text — not as headings." This is the right instruction, but the AI doesn't always follow it, especially for academic TOCs that visually look like section headers.

**Pattern:** A block of headings early in the document where each ends with a page number.

**Example:**
```markdown
# Contents IX
# Chapter One: The Ecclesial Notions... 1       ← TOC entry
## §1. Preliminary Remarks 1                     ← TOC entry
...
# Chapter One: The Ecclesial Notions...*          ← real heading (no page number)
## §1. Preliminary Remarks                        ← real heading
```

**Detection:**
- Find "Contents" / "Table of Contents" / "Inhaltsverzeichnis" heading
- Walk subsequent headings; flag those ending with `\s+\d+\s*$` (trailing page number)
- All such headings are TOC entries → strip heading formatting

---

### 7. Overview/Summary Stubs Duplicating Subsection Titles

**Frequency:** Occasional

**Root cause:** Some academic books have brief structural overviews before detailed analysis. The AI transcribes both the overview labels and the actual subsection headings as headings, creating semantic duplicates that aren't textually identical.

**Example:**
```markdown
#### PRESENTATION OF DRAMATIS PERSONAE (vv. 1-2, 3a-4b)    ← overview
##### THE CHILD VS. THE DRAGON (vv. 4c-5c, 7-12)           ← overview
#### D. Analysis of Revelation 12
##### 1. Presentation of Dramatis Personae (vv. 1–2, 3–4b)  ← real section
##### 2. Child vs. Dragon (vv. 4c-5c, 7-12)                 ← real section
```

**Detection:** Compare ALL-CAPS unnumbered headings against nearby numbered subsections. If an unnumbered heading's normalized text matches a numbered subsection within ~30 headings, the unnumbered version is likely an overview stub.

---

### 8. Page Headers / Running Headers as Headings

**Frequency:** Occasional

**Root cause:** The AI picks up running headers (book title, chapter name, author name repeated at page tops) and transcribes them as document headings.

**Pattern:** Short heading text appearing many times (>5) throughout the document.

**Detection:** Any heading text with >5 occurrences is likely a running header. Exclude legitimately repeated items (e.g., `(a)` sub-items) by checking length and context.

---

### 9. Markdown Artifacts in Heading Text

**Frequency:** Rare

**Root cause:** The AI includes Markdown syntax (`##`, `**`) in heading text that also has Markdown heading markers, leading to double-encoding.

**Example:** `# ## §VI. Narrative Regarding Other Eschatological Adversaries...`

**Detection:** Check heading text for `^#{1,6}\s` or `^\*\*` patterns.

---

### 10. Field Marker Pollution

**Frequency:** Systematic (Logos/Verbum exports only)

**Root cause:** The Logos export pipeline wraps heading text with `{{field-on:Heading}}...{{field-off:Heading}}` markers. Any text-based heading comparison must strip these first.

**Handling:** Always apply `text.replace(/\{\{field-[^}]+\}\}/g, '')` before comparing heading text.

---

## Priority Summary

| # | Issue | Prevention (Prompt) | Detection (Post-process) | Effort | Impact |
|---|-------|---------------------|--------------------------|--------|--------|
| 1 | Exact duplicates | Medium | Easy | Low | Very High |
| 2 | Near duplicates | Medium | Medium | Medium | High |
| 3 | Chunk-boundary reset | High | Medium-Hard | High | Very High |
| 4 | Mechanical jumps | Low | Easy | Low | Medium |
| 5 | Logical level errors | Medium | Hard | Very High | High |
| 6 | TOC as headings | High (prompt exists) | Easy | Low | Medium |
| 7 | Overview stubs | Low | Medium | Medium | Low |
| 8 | Running headers | Medium | Easy | Low | Low-Med |
| 9 | Markdown artifacts | Low | Very Easy | Very Low | Low |
| 10 | Field markers | N/A | Very Easy | Very Low | Medium |
