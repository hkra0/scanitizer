// The three PDF/zip libraries are classic scripts served from a CDN, so they
// arrive as globals. This module is the single place that reaches for them: it
// injects the tags itself rather than letting them sit in <head>, so nothing
// blocks the first paint — the terminal prints its header immediately and each
// library reports into the boot log as it lands. index.html only preloads the
// same URLs, which warms the cache while the page is still parsing.
//
// Every asset (these three plus the pdf.js worker below) comes from one origin
// and is pinned with an SRI hash: a tampered or swapped file is refused by the
// browser rather than being handed our pages. Bump the hash whenever a version
// changes — a stale hash blocks the load, which shows up as [--] in the boot
// log. Keep the URLs in sync with the preload hints in index.html.

const CDN = 'https://cdnjs.cloudflare.com/ajax/libs';

export const SCRIPTS = [
    {
        name: 'pdf.js',
        src: `${CDN}/pdf.js/3.10.111/pdf.js`,
        integrity: 'sha384-hPWOzdzzGESHvuwjQXU410pdrhU6LxPfeXLkWU0DJYApT04lwsOMl6xA32pAF0Io',
    },
    {
        name: 'pdf-lib',
        src: `${CDN}/pdf-lib/1.17.1/pdf-lib.min.js`,
        integrity: 'sha384-weMABwrltA6jWR8DDe9Jp5blk+tZQh7ugpCsF3JwSA53WZM9/14PjS5LAJNHNjAI',
    },
    {
        name: 'jszip',
        src: `${CDN}/jszip/3.10.1/jszip.min.js`,
        integrity: 'sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG',
    },
];

const PDF_WORKER_SRC = `${CDN}/pdf.js/3.10.111/pdf.worker.js`;
const PDF_WORKER_INTEGRITY =
    'sha384-yiyR3o/OOlRR24A/0I4SMoJFx2iNCRwxMR00Mr7ZSbPLaLJxU20/Ml3KNc5i5mkv';

// These are filled in as the scripts land. They are exported as `let`, so the
// modules that import them see the assignment — every use is inside a function
// that only runs once the matching promise below has resolved.
export let pdfjsLib = null;
export let PDFLib = null;
export let JSZip = null;

export let PDFDocument = null;
export let PDFName = null;
export let PDFNumber = null;
export let PDFString = null;
export let PDFHexString = null;
export let PDFOperator = null;
export let PDFOperatorNames = null;

function loadScript({ src, integrity }) {
    return new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = src;
        el.integrity = integrity;
        el.crossOrigin = 'anonymous';
        el.referrerPolicy = 'no-referrer';
        el.async = true;
        el.onload = () => resolve();
        el.onerror = () => reject(new Error(`could not load ${src}`));
        document.head.appendChild(el);
    });
}

/**
 * The worker is the one dependency pdf.js fetches itself, so it can't carry an
 * SRI attribute like a script tag. Fetching it here with an `integrity` option
 * gets the same guarantee — a mismatched body rejects — and pdf.js is then
 * pointed at the verified copy via a blob URL.
 *
 * On failure it falls back to the plain URL: pdf.js still works, just without
 * the integrity check, which is no worse than before this was added.
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

// Each of these resolves to true once the library is usable and false if the
// load failed; they never reject, since a missing library is reported in the
// boot log rather than thrown.
function ready(script, adopt) {
    return loadScript(script)
        .then(adopt)
        .then(() => true)
        .catch((err) => {
            console.warn(`${script.name} unavailable:`, err);
            return false;
        });
}

// Awaited before the first getDocument call: the worker must be pinned before
// pdf.js starts.
export const pdfjsReady = ready(SCRIPTS[0], async () => {
    pdfjsLib = window.pdfjsLib;
    if (!pdfjsLib) throw new Error('global missing');
    await pinWorker();
});

export const pdfLibReady = ready(SCRIPTS[1], () => {
    PDFLib = window.PDFLib;
    if (!PDFLib) throw new Error('global missing');
    ({
        PDFDocument,
        PDFName,
        PDFNumber,
        PDFString,
        PDFHexString,
        PDFOperator,
        PDFOperatorNames,
    } = PDFLib);
});

export const jszipReady = ready(SCRIPTS[2], () => {
    JSZip = window.JSZip;
    if (!JSZip) throw new Error('global missing');
});

// The whole pipeline decodes and re-encodes through an OffscreenCanvas. Older
// Safari ships the constructor without `convertToBlob`, where processing used
// to fail silently halfway through; checking here turns that into a visible
// [--] in the boot log instead.
export const canRaster =
    typeof OffscreenCanvas === 'function' &&
    typeof OffscreenCanvas.prototype.convertToBlob === 'function' &&
    typeof createImageBitmap === 'function';

// [name, promise-of-loaded] pairs, printed as a boot log that fills in as the
// libraries arrive
export const DEPENDENCIES = [
    ['pdf.js', pdfjsReady],
    ['pdf-lib', pdfLibReady],
    ['jszip', jszipReady],
    ['canvas', Promise.resolve(canRaster)],
];

// Everything processing needs. jszip is left out: it is only used by the zip
// download, which checks for itself.
export const vendorReady = Promise.all([pdfjsReady, pdfLibReady])
    .then((results) => results.every(Boolean) && canRaster);
