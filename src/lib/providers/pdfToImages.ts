import * as pdfjsLib from 'pdfjs-dist';

// Polyfill Uint8Array.prototype.toHex — used internally by pdfjs-dist but
// not available in all Chromium/Electron builds.
if (typeof (Uint8Array.prototype as any).toHex !== 'function') {
  (Uint8Array.prototype as any).toHex = function (this: Uint8Array) {
    return Array.from(this, b => b.toString(16).padStart(2, '0')).join('');
  };
}

// Build a worker Blob URL that injects the toHex polyfill before loading the
// real pdfjs worker. This is necessary because Web Workers have their own
// global scope and can't see polyfills applied in the main thread.
const realWorkerUrl = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const workerBlob = new Blob(
  [
    `if (typeof Uint8Array.prototype.toHex !== 'function') {`,
    `  Uint8Array.prototype.toHex = function() {`,
    `    return Array.from(this, b => b.toString(16).padStart(2, '0')).join('');`,
    `  };`,
    `}`,
    `import "${realWorkerUrl}";`,
  ],
  { type: 'text/javascript' },
);
pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(workerBlob);

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

    await page.render({ canvas, canvasContext: ctx, viewport }).promise;

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
