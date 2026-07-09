import '../polyfills';
import * as pdfjsLib from 'pdfjs-dist';
// @ts-ignore — worker module has no type declarations
import * as pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs';

// Run pdfjs parsing on the main thread (via the built-in "fake worker")
// instead of in a Web Worker.  Web Workers have their own global scope and
// don't inherit our Uint8Array.toHex / toBase64 polyfills that pdfjs-dist v5
// requires internally.  Importing the worker as a regular module keeps
// everything on the main thread where the polyfills are active.
(globalThis as any).pdfjsWorker = pdfjsWorker;

/**
 * Convert all pages of a PDF blob into PNG data-URI strings.
 * Each page is rendered at 2x scale for good OCR quality.
 */
export async function pdfToImages(pdfBlob: Blob, scale = 2): Promise<string[]> {
  const arrayBuffer = await pdfBlob.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const dataUrls: string[] = [];

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvas, viewport }).promise;
    dataUrls.push(canvas.toDataURL('image/png'));
  }

  return dataUrls;
}
