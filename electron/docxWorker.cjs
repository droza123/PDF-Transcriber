/**
 * Worker thread for DOCX conversion.
 * Runs off the main Electron process thread so the window stays responsive.
 */
const { workerData, parentPort } = require('worker_threads');
const { convertMarkdownToDocx } = require('./docxExport.cjs');

(async () => {
  try {
    const buffer = await convertMarkdownToDocx(workerData.markdown);
    const uint8 = new Uint8Array(buffer);
    parentPort.postMessage({ buffer: uint8.buffer }, [uint8.buffer]);
  } catch (err) {
    parentPort.postMessage({ error: err.message || 'DOCX conversion failed' });
  }
})();
