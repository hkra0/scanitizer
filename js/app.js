// Entry point: owns the app state and wires the pieces together.
//
// Everything runs in the browser — the file never leaves the page.

import { t } from './i18n.js';
import { pdfjsLib, PDFDocument, vendorReady, canRaster } from './vendor.js';
import { onSchemeChange } from './theme.js';
import { extractImages } from './pdf/extract.js';
import { createNewPdf, cleanSavePdf } from './pdf/build.js';
import { hasTextLayer } from './pdf/textlayer.js';
import { processImageFiles } from './images.js';
import {
    saveUrl,
    downloadImages,
    downloadZip,
    baseNameOf,
} from './download.js';
import { boot, renderInit, renderDone, setMood, setKeepTextState } from './screens.js';
import { installKeyboard } from './keyboard.js';
import {
    initTerminal,
    termClear,
    termInvalidate,
    termStartProgress,
    termUpdateProgress,
    termStopSpinner,
    termWarn,
    clearWarnings,
    setPendingFinish,
    setAccent,
} from './terminal.js';

const fileInput = document.getElementById('fileInput');

const state = {
    fileName: '',
    stage: 'booting',   // booting | init | processing | downloading | done
    doneMode: null,     // 'direct' (PDF only) | 'format' (pdf/images/zip)
    pdfUrl: null,       // object URL of the cleaned PDF
    pdfName: null,
    images: null,       // page images, when the source was a scan
    pageCount: 0,
    keepText: false,    // re-draw the source text on top of the page images
};

// === Screen helpers ===

function showInit() {
    state.stage = 'init';
    renderInit({ selectFile: () => fileInput.click() });
}

// Bail out of processing with a warning, then fall back to the start screen
function abortWith(message) {
    termStopSpinner();
    termClear();
    termWarn(message);
    state.stage = 'init';
    setPendingFinish(showInit);
}

function showDone(directDownload) {
    renderDone(directDownload, state.pageCount, {
        onStart: () => { state.stage = 'done'; },
        setDoneMode: (mode) => { state.doneMode = mode; },
        // The text option is only meaningful when the source actually carried
        // text; image inputs and text-free scans never see it
        canKeepText: hasTextLayer(state.images),
        keepText: state.keepText,
        toggleKeepText,
        downloadPdf,
        downloadImages: downloadAsImages,
        downloadZip: downloadAsZip,
        reset,
    });
}

function releasePdfUrl() {
    if (state.pdfUrl) {
        URL.revokeObjectURL(state.pdfUrl);
        state.pdfUrl = null;
    }
}

function reset() {
    termInvalidate();
    termStopSpinner();
    clearWarnings();
    fileInput.value = '';
    releasePdfUrl();
    state.images = null;
    state.pdfName = null;
    state.pageCount = 0;
    state.doneMode = null;
    state.keepText = false;
    setAccent('var(--accent)');
    setMood('idle');
    showInit();
}

// === Downloads ===

function downloadPdf() {
    if (!state.pdfUrl) return;
    saveUrl(state.pdfUrl, state.pdfName);
}

async function downloadAsImages() {
    if (!state.images || state.images.length === 0) return;
    state.stage = 'downloading';
    termStartProgress(t.downloading);
    await downloadImages(
        state.images,
        baseNameOf(state.fileName),
        (current, total) => termUpdateProgress(t.downloading, current, total)
    );
    showDone(false);
}

// Flip the text-layer option and rebuild. Rebuilding is cheap next to the
// original extraction — the page images are already encoded, so this only
// re-embeds them — so it runs without taking over the screen: the done screen
// stays exactly as it is and only the toggle's own state box moves. The old
// PDF stays downloadable throughout, and is what a failed rebuild falls back
// to, so there is nothing to abort to.
let rebuilding = false;

async function toggleKeepText() {
    if (!state.images || rebuilding) return;
    const next = !state.keepText;
    rebuilding = true;
    setKeepTextState(state.keepText, true);
    try {
        const newPdf = await createNewPdf(state.images, null, { keepText: next });
        const blob = await cleanSavePdf(newPdf);
        releasePdfUrl();
        state.pdfUrl = URL.createObjectURL(blob);
        state.keepText = next;
    } catch (err) {
        console.error('PDF rebuild failed:', err);
        termWarn(t.failed);
    } finally {
        rebuilding = false;
        setKeepTextState(state.keepText);
    }
}

async function downloadAsZip() {
    if (!state.images || state.images.length === 0) return;
    state.stage = 'downloading';
    termStartProgress(t.zipping);
    try {
        await downloadZip(state.images, baseNameOf(state.fileName));
    } catch (err) {
        console.error('Zipping failed:', err);
        termWarn(t.failed);
    }
    showDone(false);
}

// === Processing ===

async function handleFileSelection() {
    if (state.stage === 'booting') return;
    state.stage = 'processing';
    clearWarnings();
    setAccent('var(--accent)');
    setMood('idle');

    if (fileInput.files.length === 0) {
        showInit();
        return;
    }

    if (!canRaster) {
        abortWith(t.unsupported);
        return;
    }

    const files = Array.from(fileInput.files);
    state.fileName = files[0].name;
    termStartProgress(
        t.extracting + '...',
        files.length > 1 ? `${state.fileName} +${files.length - 1}` : state.fileName
    );

    // The PDF libraries stream in behind the start screen, so a file picked
    // moments after load may arrive first; the progress line above is already
    // up, so this just waits under the spinner
    if (!await vendorReady) {
        abortWith(t.libsUnavailable);
        return;
    }

    const isPdf = state.fileName.toLowerCase().endsWith('.pdf') ||
        files[0].type === 'application/pdf';
    if (isPdf) {
        processPdf(files[0]);
    } else {
        processImages(files);
    }
}

// Encrypted PDFs: pdf.js asks, we prompt, and giving up returns to the start.
// `onGiveUp` runs instead of the generic failure, since pdf.js rejects the
// loading task right after we decline to supply a password.
function attachPasswordPrompt(loadingTask, onGiveUp) {
    loadingTask.onPassword = (updatePassword, reason) => {
        const message = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD
            ? t.incorrectPassword
            : t.passwordPrompt;
        const password = prompt(message);
        if (password) {
            updatePassword(password);
        } else {
            onGiveUp();
        }
    };
}

function readAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(file);
    });
}

async function processPdf(file) {
    let pdf = null;
    // Set once the user declines the password prompt, so the rejection that
    // pdf.js raises afterwards doesn't overwrite the more specific message
    let gaveUpOnPassword = false;

    try {
        const buffer = await readAsArrayBuffer(file);
        // pdf.js takes ownership of the buffer it is handed, so keep the
        // original around for the metadata-only path
        const safeBuffer = buffer.slice(0);
        const loadingTask = pdfjsLib.getDocument({
            data: safeBuffer,
            disableFontFace: true,
            verbosity: 0,
        });
        attachPasswordPrompt(loadingTask, () => { gaveUpOnPassword = true; });

        pdf = await loadingTask.promise;
        const imgs = await extractImages(pdf, {
            onProgress: (current, total) => termUpdateProgress(t.extracting, current, total),
        });

        if (imgs === false) {
            // Not a scan: leave the pages alone and only strip the metadata
            termStopSpinner();
            termClear();
            termWarn(t.notScanned);
            const originalPdfDoc = await PDFDocument.load(buffer);
            finishProcessing(await cleanSavePdf(originalPdfDoc), null, true);
        } else if (imgs.length === 0) {
            abortWith(t.noImages);
        } else {
            termUpdateProgress(t.saving);
            const newPdf = await createNewPdf(imgs, (current, total) =>
                termUpdateProgress(t.processing, current, total));
            finishProcessing(await cleanSavePdf(newPdf), imgs, false);
        }
    } catch (err) {
        if (gaveUpOnPassword) {
            abortWith(t.passwordNotProvided);
        } else {
            console.error('PDF processing failed:', err);
            abortWith(t.failed);
        }
    } finally {
        pdf?.destroy();
    }
}

async function processImages(files) {
    try {
        const extracted = await processImageFiles(files, (current, total) =>
            termUpdateProgress(t.extracting, current, total));
        if (extracted.length === 0) {
            abortWith(t.noImages);
            return;
        }
        termUpdateProgress(t.saving);
        const newPdf = await createNewPdf(extracted, (current, total) =>
            termUpdateProgress(t.processing, current, total));
        finishProcessing(await cleanSavePdf(newPdf), extracted, false);
    } catch (err) {
        console.error('Image processing failed:', err);
        abortWith(t.failed);
    }
}

function finishProcessing(newPdfBlob, extractedImages, directDownload) {
    termStopSpinner();
    if (!(newPdfBlob instanceof Blob)) {
        abortWith(t.failed);
        return;
    }

    releasePdfUrl();
    state.pdfUrl = URL.createObjectURL(newPdfBlob);
    state.pdfName = `${baseNameOf(state.fileName)}_c.pdf`;
    state.pageCount = extractedImages ? extractedImages.length : 0;
    state.images = (!directDownload && state.pageCount > 0) ? extractedImages : null;

    showDone(directDownload || state.pageCount === 0);
}

// === Start ===

initTerminal(document.getElementById('term'));

fileInput.addEventListener('change', handleFileSelection);

installKeyboard({
    getStage: () => state.stage,
    getDoneMode: () => state.doneMode,
    selectFile: () => fileInput.click(),
    canKeepText: () => hasTextLayer(state.images),
    toggleKeepText,
    downloadPdf,
    downloadImages: downloadAsImages,
    downloadZip: downloadAsZip,
    reset,
});

// The mascot's tool follows the colour scheme, so redraw the face on a switch
onSchemeChange(() => setMood());

boot().then(showInit);
