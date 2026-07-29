// Entry point: owns the app state and wires the pieces together.
//
// Everything runs in the browser — the file never leaves the page.

import { t } from './i18n.js';
import { pdfjsLib, PDFDocument, vendorReady, vendorState, canRaster } from './vendor.js';
import { onSchemeChange } from './theme.js';
import { extractImages } from './pdf/extract.js';
import { createNewPdf, cleanSavePdf } from './pdf/build.js';
import { processImageFiles } from './images.js';
import {
    saveUrl,
    downloadImages,
    downloadZip,
    baseNameOf,
} from './download.js';
import {
    boot,
    renderInit,
    renderProgress,
    renderPassword,
    renderLoading,
    renderUnavailable,
    renderDone,
    setMood,
    toggleSettings,
    openSettings,
} from './screens.js';
import { installKeyboard } from './keyboard.js';
import {
    initTerminal,
    termClear,
    termInvalidate,
    termUpdateProgress,
    termStopSpinner,
    termWarn,
    clearWarnings,
    setAccent,
} from './terminal.js';

const fileInput = document.getElementById('fileInput');

const state = {
    fileName: '',
    // booting | blocked (libraries missing) | init | processing |
    // downloading | done
    stage: 'booting',
    doneMode: null,     // 'direct' (PDF only) | 'format' (pdf/images/zip)
    pdfUrl: null,       // object URL of the cleaned PDF
    pdfName: null,
    images: null,       // page images, when the source was a scan
    pageCount: 0,
};

// === Cancellation ===
//
// Cooperative, and it rides on the progress callbacks the processing modules
// already take: every one of them reports once per page, from the top of its
// loop, so that is a checkpoint on every stage of every run for free. Throwing
// there unwinds the loop exactly the way a genuine failure does — the sentinel
// is what tells the two apart once the exception reaches the catch.
const CANCELLED = Symbol('cancelled');
let cancelRequested = false;

function checkpoint() {
    if (cancelRequested) throw CANCELLED;
}

// Wrap a progress reporter so it doubles as the cancellation checkpoint
function reporter(label) {
    return (current, total) => {
        checkpoint();
        termUpdateProgress(label, current, total);
    };
}

// Set while an encrypted PDF is waiting on its password, so Escape reaches the
// same way out the screen's own option offers
let passwordGiveUp = null;

function requestCancel() {
    if (state.stage === 'password') {
        passwordGiveUp?.();
        return;
    }
    if (state.stage !== 'processing' && state.stage !== 'downloading') return;
    cancelRequested = true;
    // The run notices at its next page. Say so now rather than leaving the
    // spinner turning as though nothing had been asked for.
    termUpdateProgress(t.cancelled + '...');
}

function startProgress(label, header) {
    cancelRequested = false;
    renderProgress({ text: label, header, onCancel: requestCancel });
}

// === Screen helpers ===

function showInit(error) {
    state.stage = 'init';
    renderInit({
        selectFile: () => fileInput.click(),
        proceed: () => handleFileSelection(),
        fileLabel: pendingFileLabel(),
        error,
    });
}

// The picker keeps its selection across a settings change, so the start screen
// can offer to run the same file again. More than one file shows the first and
// a count, the same shape the progress line uses.
function pendingFileLabel() {
    const files = fileInput.files;
    if (!files || files.length === 0) return null;
    return files.length > 1 ? `${files[0].name} +${files.length - 1}` : files[0].name;
}

// Bail out of processing and go back to the start screen, carrying the reason
// with it. The reason is part of that screen and stays until something else is
// drawn — it used to be a warning, which expired two seconds later and took the
// only account of what went wrong with it.
//
// The file stays in the picker. Some failures are the file's fault and some are
// the settings' — a scan that runs out of memory at one page size will go
// through at another — and holding onto it is what makes `[s]` a retry rather
// than a re-pick. `[f]` is right there for the other case.
function abortWith(message) {
    termStopSpinner();
    termInvalidate();
    clearWarnings();
    passwordGiveUp = null;
    showInit(message);
}

function showDone(directDownload) {
    renderDone(directDownload, state.pageCount, {
        onStart: () => { state.stage = 'done'; },
        setDoneMode: (mode) => { state.doneMode = mode; },
        downloadPdf,
        downloadImages: downloadAsImages,
        downloadZip: downloadAsZip,
        changeSettings,
        reset: () => reset(),
    });
}

function releasePdfUrl() {
    if (state.pdfUrl) {
        URL.revokeObjectURL(state.pdfUrl);
        state.pdfUrl = null;
    }
}

// The way back from a finished run: the settings are read while a file is being
// processed, so acting on a change means running the file again. Reset does the
// discarding; this only makes sure the panel is already open on the way out.
function changeSettings() {
    openSettings();
    reset({ keepFile: true });
}

function reset({ keepFile = false } = {}) {
    termInvalidate();
    termStopSpinner();
    clearWarnings();
    passwordGiveUp = null;
    if (!keepFile) {
        fileInput.value = '';
        state.fileName = '';
    }
    releasePdfUrl();
    state.images = null;
    state.pdfName = null;
    state.pageCount = 0;
    state.doneMode = null;
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
    startProgress(t.downloading);
    try {
        await downloadImages(state.images, baseNameOf(state.fileName), reporter(t.downloading));
    } catch (err) {
        // A cancelled page-by-page save keeps whatever already landed; the rest
        // simply never starts, and the output screen still has all three formats
        if (err !== CANCELLED) throw err;
    }
    showDone(false);
}

async function downloadAsZip() {
    if (!state.images || state.images.length === 0) return;
    state.stage = 'downloading';
    startProgress(t.zipping);
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
    startProgress(
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

// Encrypted PDFs. pdf.js asks by calling `onPassword`, and waits for
// `updatePassword` however long that takes — so the question can be a screen
// like any other rather than a `prompt()` dialog outside the page. A wrong
// answer brings pdf.js straight back here with INCORRECT_PASSWORD, which is
// the retry the screen reports.
//
// Giving up has to end the loading task itself: not calling `updatePassword`
// leaves pdf.js waiting forever, so the task is destroyed, and the rejection
// that follows is what carries the flow into the catch below.
function attachPasswordPrompt(loadingTask, onGiveUp) {
    loadingTask.onPassword = (updatePassword, reason) => {
        state.stage = 'password';
        const giveUp = () => {
            passwordGiveUp = null;
            state.stage = 'processing';
            onGiveUp();
            loadingTask.destroy();
        };
        passwordGiveUp = giveUp;
        renderPassword({
            fileLabel: state.fileName,
            retry: reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD,
            onSubmit: (password) => {
                passwordGiveUp = null;
                // Back under the spinner: unlocking is the same run carrying on
                state.stage = 'processing';
                startProgress(t.extracting + '...', state.fileName);
                updatePassword(password);
            },
            onCancel: giveUp,
        });
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
        const imgs = await extractImages(pdf, { onProgress: reporter(t.extracting) });

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
            checkpoint();
            termUpdateProgress(t.saving);
            const newPdf = await createNewPdf(imgs, reporter(t.processing));
            finishProcessing(await cleanSavePdf(newPdf), imgs, false);
        }
    } catch (err) {
        if (err === CANCELLED) {
            abortWith(t.cancelled);
        } else if (gaveUpOnPassword) {
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
        const extracted = await processImageFiles(files, reporter(t.extracting));
        if (extracted.length === 0) {
            abortWith(t.noImages);
            return;
        }
        checkpoint();
        termUpdateProgress(t.saving);
        const newPdf = await createNewPdf(extracted, reporter(t.processing));
        finishProcessing(await cleanSavePdf(newPdf), extracted, false);
    } catch (err) {
        if (err === CANCELLED) {
            abortWith(t.cancelled);
        } else {
            console.error('Image processing failed:', err);
            abortWith(t.failed);
        }
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

// === Drag and drop ===
//
// The whole window is the target, not a marked-out rectangle: there is only one
// thing on the page to drop onto, so asking the user to aim is asking for
// nothing. A drop hands the files to the same input the picker fills, so
// everything downstream — the file label, `[s]` running the same file again —
// works without knowing where the files came from.

const dropTypes = /^(application\/pdf|image\/)/;

function droppable() {
    return state.stage === 'init' || state.stage === 'done';
}

function acceptedFiles(dataTransfer) {
    return Array.from(dataTransfer.files || []).filter(
        (file) => dropTypes.test(file.type) || file.name.toLowerCase().endsWith('.pdf')
    );
}

// dragenter/dragleave fire for every element the pointer crosses, so the depth
// is counted rather than the events trusted
let dragDepth = 0;

function setDragging(on) {
    document.body.classList.toggle('dragging', on);
}

document.addEventListener('dragenter', (e) => {
    if (!droppable() || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    setDragging(true);
});

document.addEventListener('dragover', (e) => {
    if (!droppable() || !e.dataTransfer?.types.includes('Files')) return;
    // Without this the browser keeps the drop for itself and navigates away
    // from the page, losing whatever was on screen
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
});

document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDragging(false);
});

document.addEventListener('drop', (e) => {
    if (!droppable()) return;
    e.preventDefault();
    dragDepth = 0;
    setDragging(false);

    const files = acceptedFiles(e.dataTransfer);
    if (files.length === 0) {
        showInit(t.dropRejected);
        return;
    }
    // Load the picker from the drop, so a dropped file is indistinguishable
    // from a picked one everywhere else
    const transfer = new DataTransfer();
    files.forEach((file) => transfer.items.add(file));
    fileInput.files = transfer.files;
    handleFileSelection();
});

// === Start ===

initTerminal(document.getElementById('term'));

fileInput.addEventListener('change', handleFileSelection);

installKeyboard({
    getStage: () => state.stage,
    getDoneMode: () => state.doneMode,
    selectFile: () => fileInput.click(),
    proceed: () => { if (pendingFileLabel()) handleFileSelection(); else fileInput.click(); },
    retry: () => location.reload(),
    toggleSettings,
    changeSettings,
    downloadPdf,
    downloadImages: downloadAsImages,
    downloadZip: downloadAsZip,
    cancel: requestCancel,
    reset: () => reset(),
});

// tinyko's tool follows the colour scheme, so redraw it on a switch
onSchemeChange(() => setMood());

// The header goes up first, then the start screen — but only once the
// libraries are actually there. Anything else would print "ready" over an app
// that can't open a file: while they are still in flight the screen says so,
// and if they never arrive it's a dead end with a reload rather than a start
// screen that fails on the first click.
(async function start() {
    await boot();
    if (vendorState === 'pending') renderLoading();
    if (await vendorReady) {
        showInit();
    } else {
        state.stage = 'blocked';
        renderUnavailable({ retry: () => location.reload() });
    }
})();
