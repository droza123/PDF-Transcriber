'use strict';

const MARKDOWN_HEADING_LEVELS = 6;
const MAX_HEADING_LEVEL = 9;
const HEADING_LEVEL_META_RE = /^\s*<!--\s*heading-level:\s*([7-9])\s*-->\s*$/i;
const EXTENDED_ATX_HEADING_RE = /^(#{1,9})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;

function matchHeadingAt(lines, index) {
  if (index < 0 || index >= lines.length) return null;
  const meta = lines[index].match(HEADING_LEVEL_META_RE);
  if (meta && index + 1 < lines.length) {
    const next = lines[index + 1].match(EXTENDED_ATX_HEADING_RE);
    if (next && next[1].length <= MARKDOWN_HEADING_LEVELS) {
      return {
        level: Number(meta[1]),
        text: next[2],
        startLineIndex: index,
        lineIndex: index + 1,
      };
    }
  }

  const match = lines[index].match(EXTENDED_ATX_HEADING_RE);
  if (!match) return null;
  return {
    level: match[1].length,
    text: match[2],
    startLineIndex: index,
    lineIndex: index,
  };
}

function serializeHeading(level, text) {
  const clamped = Math.max(1, Math.min(MAX_HEADING_LEVEL, Math.trunc(level)));
  if (clamped <= MARKDOWN_HEADING_LEVELS) return `${'#'.repeat(clamped)} ${text}`;
  return `<!-- heading-level: ${clamped} -->\n${'#'.repeat(MARKDOWN_HEADING_LEVELS)} ${text}`;
}

function normalizeExtendedHeadingSyntax(markdown) {
  const lines = markdown.split('\n');
  const out = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      inFence = !inFence;
      out.push(lines[i]);
      continue;
    }
    if (inFence) {
      out.push(lines[i]);
      continue;
    }
    const heading = matchHeadingAt(lines, i);
    if (heading && (heading.level > MARKDOWN_HEADING_LEVELS || heading.lineIndex > i)) {
      out.push(...serializeHeading(heading.level, heading.text).split('\n'));
      i = heading.lineIndex;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join('\n');
}

function isHeadingLine(line) {
  return EXTENDED_ATX_HEADING_RE.test(line.trim());
}

function isHeadingMetadataLine(line) {
  return HEADING_LEVEL_META_RE.test(line.trim());
}

module.exports = {
  HEADING_LEVEL_META_RE,
  MAX_HEADING_LEVEL,
  MARKDOWN_HEADING_LEVELS,
  isHeadingLine,
  isHeadingMetadataLine,
  matchHeadingAt,
  normalizeExtendedHeadingSyntax,
  serializeHeading,
};
