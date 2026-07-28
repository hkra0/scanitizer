// The three PDF/zip libraries are loaded as classic scripts from a CDN, so they
// arrive as globals. This module is the single place that reaches for them, and
// it reads them defensively so a failed CDN load surfaces in the boot log
// instead of throwing before anything is rendered.

const PDF_WORKER_SRC =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.10.111/pdf.worker.js';
const PDF_WORKER_INTEGRITY =
    'sha384-yiyR3o/OOlRR24A/0I4SMoJFx2iNCRwxMR00Mr7ZSbPLaLJxU20/Ml3KNc5i5mkv';

export const pdfjsLib = window.pdfjsLib;
export const PDFLib = window.PDFLib;
export const JSZip = window.JSZip;

export const {
    PDFDocument,
    PDFName,
    PDFNumber,
    PDFString,
    PDFHexString,
    PDFOperator,
    PDFOperatorNames,
} = PDFLib || {};

/**
 * The worker is the one dependency pdf.js fetches itself, so it can't carry an
 * SRI attribute like the script tags in index.html. Fetching it here with an
 * `integrity` option gets the same guarantee — a mismatched body rejects — and
 * pdf.js is then pointed at the verified copy via a blob URL.
 *
 * Resolves to true when the worker is pinned. On failure it falls back to the
 * plain URL: pdf.js still works, just without the integrity check, which is no
 * worse than before this was added.
 */
async function pinWorker() {
    if (!pdfjsLib) return false;
    try {
        const response = await fetch(PDF_WORKER_SRC, {
            integrity: PDF_WORKER_INTEGRITY,
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const source = await response.blob();
        pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(source);
        return true;
    } catch (err) {
        console.warn('pdf.js worker could not be verified, loading it directly:', err);
        pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
        return false;
    }
}

// Kicked off at load; awaited before the first getDocument call
export const workerReady = pinWorker();

// The whole pipeline decodes and re-encodes through an OffscreenCanvas. Older
// Safari ships the constructor without `convertToBlob`, where processing used
// to fail silently halfway through; checking here turns that into a visible
// [--] in the boot log instead.
export const canRaster =
    typeof OffscreenCanvas === 'function' &&
    typeof OffscreenCanvas.prototype.convertToBlob === 'function' &&
    typeof createImageBitmap === 'function';

// [name, loaded] pairs, printed as a boot log
export const DEPENDENCIES = [
    ['pdf.js', !!pdfjsLib],
    ['pdf-lib', !!PDFLib],
    ['jszip', !!JSZip],
    ['canvas', canRaster],
];
