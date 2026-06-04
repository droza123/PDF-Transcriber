/**
 * Shared react-markdown component overrides that make GFM footnotes display the
 * document's ORIGINAL printed numbers instead of remark-gfm's sequential 1,2,3….
 *
 * The transcription preserves each note's printed number as its Markdown label
 * (e.g. `[^90]`); remark-rehype encodes that label into the reference href
 * (`#user-content-fn-90`) and the definition `<li id="user-content-fn-90">`.
 * remark-gfm still NUMBERS footnotes sequentially, so we read the label back out
 * and:
 *   • replace the inline reference's visible text with the label, and
 *   • set `<li value={n}>` so the definition list shows the label — native
 *     ordered-list numbering honours `value`, including gaps (e.g. 90 → 116).
 *
 * Only NUMERIC labels are rewritten; text labels (e.g. `[^methods]`) keep GFM's
 * default sequential rendering. A trailing dedup suffix added by convert.ts for
 * reset collisions ("1_2") is stripped so the original number ("1") is shown.
 *
 * Backreference links point at `#user-content-fnref-…`, which does NOT match the
 * `#user-content-fn-` prefix, so their "↩" glyphs are left untouched.
 *
 * `footnoteComponents` is used by both the in-app Preview and the HTML export so the
 * two match. For per-chapter ENDNOTE books both also run `endnotesToPlainMarkdown`
 * first — the Preview because its per-page chunking breaks GFM footnote resolution,
 * the HTML export because a single GFM pass would dedup the repeated per-chapter
 * labels to one note per number. Footnote books keep native, clickable GFM footnotes.
 */

/** Strip a trailing dedup suffix ("_2") so a reset-renamed "1_2" shows as "1". */
function footnoteDisplay(label: string): string {
  return label.replace(/_\d+$/, '');
}

/**
 * Rewrite a per-chapter endnote book's `[^N]` references and `[^N]:` definitions into
 * plain `#en-N` links that footnoteComponents renders as superscript numbers.
 *
 * The in-app Preview chunks the document by printed page and renders each chunk as its
 * OWN react-markdown instance. GFM footnotes only resolve within one instance, but in
 * an endnote book a `[^N]` reference and its `[^N]:` definition sit pages apart (body
 * vs. the back-of-chapter NOTES section) — different chunks. So the definitions, parsed
 * as "unreferenced", are silently dropped and the references render as literal `[^N]`.
 * Rewriting both to plain links sidesteps GFM entirely, so the note text is always
 * visible regardless of chunking or the repeated per-chapter numbers.
 *
 * Code blocks are left verbatim (a `[^N]` there is shown as-is, like the exporter does),
 * and fabricated "[Endnote N]" placeholder definitions are dropped so they don't show
 * as junk. Footnote books are left untouched — their notes share a page with their
 * references, so native, clickable GFM footnotes work there; this is endnote-only.
 */
export function endnotesToPlainMarkdown(body: string): string {
  const placeholderRe = /^\s*\[\^\w+\]:\s*\[\s*(?:end|foot)?note\s*\d*\s*\]\s*$/i;
  const out: string[] = [];
  let inCodeBlock = false;
  for (const line of body.split('\n')) {
    if (line.trim().startsWith('```')) { inCodeBlock = !inCodeBlock; out.push(line); continue; }
    if (inCodeBlock) { out.push(line); continue; }
    if (placeholderRe.test(line)) continue; // drop placeholder definitions
    const def = line.match(/^(\s*)\[\^(\w+)\]:[ \t]*(.*)$/);
    if (def) { out.push(`${def[1]}[${def[2]}](#en-${def[2]}) ${def[3]}`); continue; }
    out.push(line.replace(/\[\^(\w+)\]/g, '[$1](#en-$1)'));
  }
  return out.join('\n');
}

export const footnoteComponents = {
  // Inline reference: <sup><a href="#user-content-fn-90" data-footnote-ref>3</a></sup>
  a({ node, href, children, ...props }: any) {
    // Endnote-preview sentinel (see endnotesToPlainMarkdown): render as a superscript
    // number, not a link — its target lives in another chunk, so a link would be dead.
    const en = typeof href === 'string' ? href.match(/^#en-(.+)$/) : null;
    if (en) return <sup className="en-note-ref">{children}</sup>;
    const m = typeof href === 'string' ? href.match(/^#user-content-fn-(.+)$/) : null;
    if (m) {
      const disp = footnoteDisplay(m[1]);
      if (/^\d+$/.test(disp)) return <a href={href} {...props}>{disp}</a>;
    }
    return <a href={href} {...props}>{children}</a>;
  },
  // Definition list item: <li id="user-content-fn-90">…</li>
  li({ node, id, children, ...props }: any) {
    const m = typeof id === 'string' ? id.match(/^user-content-fn-(.+)$/) : null;
    if (m) {
      const disp = footnoteDisplay(m[1]);
      if (/^\d+$/.test(disp)) return <li id={id} value={parseInt(disp, 10)} {...props}>{children}</li>;
    }
    return <li id={id} {...props}>{children}</li>;
  },
};
