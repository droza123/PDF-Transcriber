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
 * Used by both the in-app Preview and the HTML export so the two match.
 */

/** Strip a trailing dedup suffix ("_2") so a reset-renamed "1_2" shows as "1". */
function footnoteDisplay(label: string): string {
  return label.replace(/_\d+$/, '');
}

export const footnoteComponents = {
  // Inline reference: <sup><a href="#user-content-fn-90" data-footnote-ref>3</a></sup>
  a({ node, href, children, ...props }: any) {
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
