// pdf-lib and JSZip are loaded as globals by the `async` script tags in
// index.html; pdf.js is an ES module and is fetched here instead (see below).
// This module is the single place that reaches for all three: it hands out a
// promise per library, so a slow or blocked CDN shows up as a pending then
// failed line in the boot log instead of holding back the first paint or
// throwing before anything is rendered.
//
// === Why pdf.js is not a script tag ===
//
// From version 4 pdf.js ships as an ES module and nothing else — there is no
// UMD build any more, so there is no tag that would leave `window.pdfjsLib`
// behind. It is fetched, checked against its hash, and imported from a blob,
// which is the same thing `pinWorker` has always done for the worker.
//
// === Why 4.10.38 and not 6.x ===
//
// 4.10.38 is the newest release that can decode a scanned document from this
// one origin. In 5.7 pdf.js moved JBIG2, CCITT fax and JPEG 2000 out of the
// bundle and into `jbig2.wasm` and `openjpeg.wasm`, and cdnjs publishes neither
// those nor the `_nowasm_fallback.js` files that stand in for them. Those three
// codecs are what scanners produce — CCITT G4 is every fax and most bilevel
// scans — so on 6.x a scan decodes to null and the run stops on "page N holds a
// scan that could not be read". 4.10.38 carries all three in the bundle, with
// the JPEG 2000 decoder inlined as a data URI, which is the one thing here that
// needs `'wasm-unsafe-eval'` in the page's CSP.
//
// Moving past it means hosting the wasm somewhere — vendored into this repo, or
// a second CDN — and pointing pdf.js at it with the `wasmUrl` option.
const PDF_VERSION = '4.10.38';
const PDF_SRC =
    `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDF_VERSION}/pdf.min.mjs`;
const PDF_INTEGRITY =
    'sha384-+0ti2moQlmLN7WZHE2RHIf5lV8hHxhxEalN0il3YZceG26fUPyOkR0hp9daxk1i7';
const PDF_WORKER_SRC =
    `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDF_VERSION}/pdf.worker.min.mjs`;
const PDF_WORKER_INTEGRITY =
    'sha384-ToeVvShCxKc6CEvhHeMt0Q8A06pSPDbAlngO9nokrDmh914gk/pYd0N7D0a4Lz2o';

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
// `pdf/sweep.js` walks the object graph, so it needs to recognise the two
// containers a reference can be sitting inside.
export let PDFArray = null;

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
 * One asset, fetched and checked against its hash before anything is done with
 * it. Rejects on a mismatch, which is the whole point: `fetch` fails an
 * `integrity` that does not match, exactly as a script tag's SRI attribute
 * would.
 *
 * @returns a blob URL for the verified bytes. The caller owns it.
 */
async function fetchPinned(url, integrity) {
    const response = await fetch(url, {
        integrity,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return URL.createObjectURL(await response.blob());
}

/**
 * pdf.js itself, verified and imported.
 *
 * There is no fallback to an unverified copy, deliberately: a hash that does
 * not match means the bytes are not the ones this app was written against, and
 * running them anyway would defeat the check. A failure here is a `[--]` in the
 * boot log and an app that says it cannot open files, which is the honest end.
 *
 * The blob URL is released once the import has resolved — the module is in the
 * graph by then, and the bundle has no imports of its own that could need to
 * resolve against it later.
 */
async function importPdfjs() {
    const url = await fetchPinned(PDF_SRC, PDF_INTEGRITY);
    try {
        return await import(url);
    } finally {
        URL.revokeObjectURL(url);
    }
}

/**
 * The worker is the one dependency pdf.js fetches itself, so it can't carry an
 * SRI attribute. Fetching it here with an `integrity` option gets the same
 * guarantee, and pdf.js is then pointed at the verified copy via a blob URL.
 *
 * That URL is deliberately never revoked: pdf.js re-reads `workerSrc` every
 * time it spins a worker up, not just once.
 *
 * On failure it falls back to the plain URL: pdf.js still works, just without
 * the integrity check — a weaker guarantee, but not a broken app. The library
 * above gets no such fallback, because a tampered library is the whole page
 * whereas a tampered worker is caught by the same-origin CDN pinning at worst.
 */
async function pinWorker() {
    try {
        pdfjsLib.GlobalWorkerOptions.workerSrc =
            await fetchPinned(PDF_WORKER_SRC, PDF_WORKER_INTEGRITY);
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
export const pdfjsReady = (async () => {
    try {
        pdfjsLib = await importPdfjs();
    } catch (err) {
        console.warn('pdf.js could not be loaded:', err);
        return false;
    }
    await pinWorker();
    return true;
})();

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
        PDFArray,
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
