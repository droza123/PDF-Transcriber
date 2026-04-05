import * as pdfjsLib from 'pdfjs-dist';

// Use the bundled worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

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

    await page.render({ canvasContext: ctx, viewport }).promise;
    dataUrls.push(canvas.toDataURL('image/png'));
  }

  return dataUrls;
}
