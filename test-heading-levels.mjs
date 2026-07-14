import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import JSZip from 'jszip';

const require = createRequire(import.meta.url);
const electronHeadings = require('./electron/headings.cjs');
const { convertMarkdownToDocx } = require('./electron/docxExport.cjs');
const { convertMarkdownToDocxLogos } = require('./electron/docxExportLogos.cjs');

// Load the browser-side TypeScript helper without adding a test runner dependency.
const tsSource = fs.readFileSync(new URL('./src/lib/headings.ts', import.meta.url), 'utf8');
const jsSource = ts.transpileModule(tsSource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const browserHeadings = await import(`data:text/javascript;base64,${Buffer.from(jsSource).toString('base64')}`);

const rawExtended = [
  '# Level 1',
  '###### Level 6',
  '####### Level 7',
  '<!-- heading-level: 8 -->',
  '#### Heading 8 with a noncanonical fallback',
  '######### Level 9',
].join('\n');

const canonical = browserHeadings.normalizeExtendedHeadingSyntax(rawExtended);
assert.match(canonical, /<!-- heading-level: 7 -->\n###### Level 7/);
assert.match(canonical, /<!-- heading-level: 8 -->\n###### Heading 8 with a noncanonical fallback/);
assert.match(canonical, /<!-- heading-level: 9 -->\n###### Level 9/);
assert.deepEqual(
  browserHeadings.collectHeadings(canonical).map(h => h.level),
  [1, 6, 7, 8, 9],
);
assert.equal(electronHeadings.normalizeExtendedHeadingSyntax(rawExtended), canonical);

const tree = {
  type: 'root',
  children: [
    { type: 'html', value: '<!-- heading-level: 8 -->' },
    { type: 'heading', depth: 6, children: [{ type: 'text', value: 'Deep' }] },
  ],
};
browserHeadings.remarkExtendedHeadings()(tree);
assert.equal(tree.children.length, 1);
assert.equal(tree.children[0].data.hName, 'div');
assert.equal(tree.children[0].data.hProperties['aria-level'], 8);

const nineLevels = Array.from({ length: 9 }, (_, i) =>
  browserHeadings.serializeHeading(i + 1, `Level ${i + 1}`),
).join('\n\n');

async function assertDocx(buffer, label) {
  const zip = await JSZip.loadAsync(buffer);
  const styles = await zip.file('word/styles.xml').async('string');
  const document = await zip.file('word/document.xml').async('string');

  for (const [level, outlineValue] of [[7, 6], [8, 7], [9, 8]]) {
    const style = styles.match(new RegExp(`<w:style\\b[^>]*w:styleId="Heading${level}"[^>]*>[\\s\\S]*?<\\/w:style>`));
    assert.ok(style, `${label}: Heading ${level} style missing`);
    assert.match(style[0], new RegExp(`<w:outlineLvl w:val="${outlineValue}"`));
    assert.match(document, new RegExp(`<w:pStyle w:val="Heading${level}"`));
  }
  assert.doesNotMatch(document, /heading-level:/);
}

await assertDocx(await convertMarkdownToDocx(nineLevels), 'standard DOCX');
await assertDocx(await convertMarkdownToDocxLogos(nineLevels), 'Logos DOCX');

console.log('Heading levels 1-9: parser, preview metadata, and DOCX outline styles verified.');
