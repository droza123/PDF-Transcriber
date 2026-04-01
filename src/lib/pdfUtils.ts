import { PDFDocument } from 'pdf-lib';

/** Get total page count from a PDF ArrayBuffer. */
export async function getPdfPageCount(arrayBuffer: ArrayBuffer): Promise<number> {
  const pdfDoc = await PDFDocument.load(arrayBuffer);
  return pdfDoc.getPageCount();
}

/** Extract a page range from a PDF into a new PDF's bytes (0-based indices, exclusive end). */
export async function extractPdfPageRange(
  arrayBuffer: ArrayBuffer,
  startIndex: number,
  endIndex: number,
): Promise<ArrayBuffer> {
  const srcDoc = await PDFDocument.load(arrayBuffer);
  const newPdf = await PDFDocument.create();
  const indices = Array.from({ length: endIndex - startIndex }, (_, i) => startIndex + i);
  const pages = await newPdf.copyPages(srcDoc, indices);
  pages.forEach(page => newPdf.addPage(page));
  const bytes = await newPdf.save();
  return bytes.buffer;
}
