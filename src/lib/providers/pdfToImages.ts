import * as pdfjsLib from 'pdfjs-dist';

// Use the bundled worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

export interface PdfImage {
  base64: string;
  mimeType: string;
}

/**
 * Render each page of a PDF blob to a base64-encoded JPEG image.
 * Used by providers (OpenRouter) that don't accept raw PDFs.
 */
export async function pdfBlobToBase64Images(
  pdfBlob: Blob,
  options?: { scale?: number; quality?: number },
): Promise<PdfImage[]> {
  const scale = options?.scale ?? 1.5;
  const quality = options?.quality ?? 0.85;

  const arrayBuffer = await pdfBlob.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const images: PdfImage[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d')!;

    await page.render({ canvasContext: ctx, viewport }).promise;

    // Export as JPEG for smaller size
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    // Strip the "data:image/jpeg;base64," prefix
    const base64 = dataUrl.split(',')[1];

    images.push({ base64, mimeType: 'image/jpeg' });

    // Clean up
    page.cleanup();
  }

  return images;
}
