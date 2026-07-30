// The three PDF/zip libraries are loaded as globals by the `async` script tags
// in index.html. This module is the single place that reaches for them: it
// watches each tag and hands out a promise per library, so a slow or blocked
// CDN shows up as a pending then failed line in the boot log instead of
// holding back the first paint or throwing before anything is rendered.

const PDF_WORKER_SRC =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.10.111/pdf.worker.js';
const PDF_WORKER_INTEGRITY =
    'sha384-yiyR3o/OOlRR24A/0I4SMoJFx2iNCRwxMR00Mr7ZSbPLaLJxU20/Ml3KNc5i5mkv';

// Filled in as the scripts land. Exported as `let`, so the modules that import
// them see the assignment — every use is inside a function that only runs once
// the matching promise below has resolved.
export let pdfjsLib = null;
export let PDFLib = null;
export let JSZip = null;

export let PDFDocument = null;
export let PDFName = null;
export let PDFDict = null;
export let PDFNumber = null;
export let PDFString = null;
export let PDFHexString = null;
export let PDFOperator = null;
export let PDFOperatorNames = null;
// The object model below the page: `pdf/strip.js` edits pages in place rather
// than rebuilding them, so it needs to tell a reference from an inline object
// and to get at a content stream's decoded bytes.
export let PDFRef = null;
export let PDFRawStream = null;
export let decodePDFRawStream = null;

/**
 * Resolves true once `window[globalName]` is there, false if the tag failed.
 * Never rejects: a missing library is a boot-log line, not an exception.
 *
 * An async script may already have run, failed, or still be in flight by the
 * time this module executes, so all three are covered: the global is checked
 * first, then the tag's own events, and finally `window.load` — async scripts
 * delay that event, so by then the tag has settled one way or the other even
 * if it failed before we could attach a listener.
 */
function scriptReady(id, globalName) {
    if (window[globalName]) return Promise.resolve(true);
    const el = document.getElementById(id);
    if (!el) return Promise.resolve(false);
    return new Promise((resolve) => {
        const settle = () => resolve(!!window[globalName]);
        el.addEventListener('load', settle);
        el.addEventListener('error', () => resolve(false));
        window.addEventListener('load', settle);
    });
}

/**
 * The worker is the one dependency pdf.js fetches itself, so it can't carry an
 * SRI attribute like the script tags in index.html. Fetching it here with an
 * `integrity` option gets the same guarantee — a mismatched body rejects — and
 * pdf.js is then pointed at the verified copy via a blob URL.
 *
 * On failure it falls back to the plain URL: pdf.js still works, just without
 * the integrity check — a weaker guarantee, but not a broken app.
 */
async function pinWorker() {
    try {
        const response = await fetch(PDF_WORKER_SRC, {
            integrity: PDF_WORKER_INTEGRITY,
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const source = await response.blob();
        pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(source);
    } catch (err) {
        console.warn('pdf.js worker could not be verified, loading it directly:', err);
        pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
    }
}

// The whole pipeline decodes and re-encodes through an OffscreenCanvas. Older
// Safari ships the constructor without `convertToBlob`, where processing used
// to fail silently halfway through; checking here turns that into a visible
// [--] in the boot log instead. Unlike the libraries this is a capability
// check, so it is known immediately and is printed first.
export const canRaster =
    typeof OffscreenCanvas === 'function' &&
    typeof OffscreenCanvas.prototype.convertToBlob === 'function' &&
    typeof createImageBitmap === 'function';

// Awaited before the first getDocument call: the worker must be pinned before
// pdf.js starts.
export const pdfjsReady = scriptReady('lib-pdfjs', 'pdfjsLib').then(async (ok) => {
    if (!ok) return false;
    pdfjsLib = window.pdfjsLib;
    await pinWorker();
    return true;
});

export const pdfLibReady = scriptReady('lib-pdflib', 'PDFLib').then((ok) => {
    if (!ok) return false;
    PDFLib = window.PDFLib;
    ({
        PDFDocument,
        PDFName,
        PDFDict,
        PDFNumber,
        PDFString,
        PDFHexString,
        PDFOperator,
        PDFOperatorNames,
        PDFRef,
        PDFRawStream,
        decodePDFRawStream,
    } = PDFLib);
    return true;
});

export const jszipReady = scriptReady('lib-jszip', 'JSZip').then((ok) => {
    if (ok) JSZip = window.JSZip;
    return ok;
});

// [name, promise-of-loaded] pairs, printed as a boot log that fills in as the
// libraries arrive. The capability check comes first, since it is the one
// answer that is already known when the log is drawn.
export const DEPENDENCIES = [
    ['canvas', Promise.resolve(canRaster)],
    ['pdf.js', pdfjsReady],
    ['pdf-lib', pdfLibReady],
    ['jszip', jszipReady],
];

// Everything processing needs. jszip is left out: it is only used by the zip
// download, which checks for itself, so losing it costs one output format
// rather than the whole app.
export let vendorState = 'pending';   // 'pending' | 'ready' | 'failed'

export const vendorReady = Promise.all([pdfjsReady, pdfLibReady])
    .then((results) => {
        const ok = results.every(Boolean) && canRaster;
        vendorState = ok ? 'ready' : 'failed';
        return ok;
    });
