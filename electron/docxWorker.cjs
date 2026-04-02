/**
 * Worker thread for DOCX conversion.
 * Runs off the main Electron process thread so the window stays responsive.
 * Supports both standard and Logos export formats via workerData.format.
 */
const { workerData, parentPort } = require('worker_threads');

(async () => {
  try {
    let buffer;
    if (workerData.format === 'logos') {
      const { convertMarkdownToDocxLogos } = require('./docxExportLogos.cjs');
      buffer = await convertMarkdownToDocxLogos(workerData.markdown);
    } else {
      const { convertMarkdownToDocx } = require('./docxExport.cjs');
      buffer = await convertMarkdownToDocx(workerData.markdown);
    }
    const uint8 = new Uint8Array(buffer);
    parentPort.postMessage({ buffer: uint8.buffer }, [uint8.buffer]);
  } catch (err) {
    parentPort.postMessage({ error: err.message || 'DOCX conversion failed' });
  }
})();
