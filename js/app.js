// Entry point: owns the app state and wires the pieces together.
//
// Everything runs in the browser — the file never leaves the page.

import { t } from './i18n.js';
import { pdfjsLib, PDFDocument, vendorReady, vendorState, canRaster } from './vendor.js';
import { onSchemeChange } from './theme.js';
import { keepText, pageLayout } from './settings.js';
import {
    METADATA_FIELDS,
    ETA_MIN_MS,
    PORTRAIT_WIDTH,
    PORTRAIT_HEIGHT,
    CSS_PX_PER_PT,
} from './config.js';
import { extractImages } from './pdf/extract.js';
import { createNewPdf, cleanSavePdf, sheetFor, pointsPerPixel } from './pdf/build.js';
import { processImageFiles } from './images.js';
import { rasterize, closeBitmap } from './raster.js';
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
    renderSampleScreen,
    renderLoading,
    renderUnavailable,
    renderDone,
    sampleUpdate,
    sampleEstimate,
    setMood,
    toggleSettings,
    openSettings,
} from './screens.js';
import { installKeyboard } from './keyboard.js';
import {
    initTerminal,
    termInvalidate,
    termUpdateProgress,
    termStopSpinner,
    setAccent,
} from './terminal.js';

const fileInput = document.getElementById('fileInput');

const state = {
    fileName: '',
    // booting | blocked (libraries missing) | init | password | sample |
    // processing | downloading | done
    stage: 'booting',
    session: null,      // the opened source — see below
    doneMode: null,     // 'direct' (PDF only) | 'format' (pdf/images/zip)
    pdfUrl: null,       // object URL of the cleaned PDF
    pdfName: null,
    images: null,       // page images, when the source was a scan
    pageCount: 0,
    inputSize: 0,       // bytes picked, summed over a multi-file selection
    // Object URL of whichever first-page image is on screen — the sample
    // screen's proposal or the output screen's result. Only ever one of them,
    // since one screen replaces the other.
    previewUrl: null,
    sampleImage: null,  // page 1 under the settings as they currently stand
    sampleSource: null, // its pixels before the encoder, kept for the next pass
    report: null,       // the account the output screen prints
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

// === Time remaining ===
//
// A count of pages says how far along a run is; it does not say how long is
// left, which is the thing "should I cancel this" actually turns on.

/**
 * Estimate the milliseconds left in the stage in progress.
 *
 * Timed from the first *completed* item rather than from the start of the run,
 * because the first one carries setup the rest don't — opening the document,
 * warming the decoder — and folding that into the per-page rate would inflate
 * the estimate across every page that follows it.
 *
 * The rate is the average over completed items, not the last one: pages differ
 * enough that a rate taken from one of them would make the number jump on every
 * repaint. Each stage estimates itself and starts over, since the per-item cost
 * of extracting a page and of embedding one are not the same number.
 */
function makeEta() {
    let stage = null;
    let markedAt = 0;
    let markedDone = 0;

    return {
        reset() { stage = null; markedAt = 0; },
        estimate(label, current, total) {
            if (label !== stage) {
                stage = label;
                markedAt = 0;
            }
            if (!total) return null;
            // The reporters fire from the top of their loop, so `current` is the
            // item about to be worked on and the ones behind it are done
            const done = current - 1;
            if (done < 1) return null;
            if (!markedAt) {
                markedAt = performance.now();
                markedDone = done;
                return null;
            }
            const since = done - markedDone;
            if (since < 1) return null;
            const perItem = (performance.now() - markedAt) / since;
            return (total - done) * perItem;
        },
    };
}

const eta = makeEta();

// Seconds jitter by a page's worth on every repaint, so anything long enough to
// be worth rounding is rounded — a figure that ticks 14, 13, 14 reads as noise
// even when it is perfectly accurate
function formatEta(ms) {
    const raw = ms / 1000;
    const secs = raw > 30 ? Math.round(raw / 5) * 5 : Math.round(raw);
    if (secs < 60) return secs + t.unitSec;
    const mins = Math.floor(secs / 60);
    const rest = secs % 60;
    return rest ? `${mins}${t.unitMin} ${rest}${t.unitSec}` : `${mins}${t.unitMin}`;
}

function etaText(label, current, total) {
    const ms = eta.estimate(label, current, total);
    return (ms !== null && ms >= ETA_MIN_MS) ? t.eta.replace('{}', formatEta(ms)) : null;
}

// Wrap a progress reporter so it doubles as the cancellation checkpoint
function reporter(label) {
    return (current, total) => {
        checkpoint();
        termUpdateProgress(label, current, total, etaText(label, current, total));
    };
}

/**
 * Serialize the document, honouring a cancel asked for while it was happening.
 *
 * This is the one stage with no checkpoints inside it: `save()` is pdf-lib's,
 * it takes no progress callback, and on a long document it is where a good
 * share of the wait goes. So Escape here used to do nothing at all — the flag
 * was set, "cancelled..." was printed over the spinner, and then the run
 * finished and showed the output screen as though nothing had been asked.
 *
 * The save still can't be interrupted, but the answer can be honoured: check
 * once it returns and throw the work away. That costs the user the wait they
 * were already having, and it keeps the promise the screen makes — an option
 * that says `[esc] cancel` has to cancel.
 */
async function saveCancellably(pdfDoc) {
    checkpoint();
    const blob = await cleanSavePdf(pdfDoc);
    checkpoint();
    return blob;
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
    // Two runs in a row use the same stage labels, so the estimator has to be
    // told a new run started rather than inferring it from the label changing
    eta.reset();
    renderProgress({ text: label, header, onCancel: requestCancel });
}

// === Screen helpers ===

function showInit(error) {
    state.stage = 'init';
    renderInit({
        selectFile: () => fileInput.click(),
        proceed,
        fileLabel: pendingFileLabel(),
        error,
    });
}

// Onwards from the start screen. The source may already be open — a run that
// failed comes back here without closing it — and reopening it would ask for
// the password a second time to reach a screen that was one keypress away.
function proceed() {
    if (state.session) startSample();
    else handleFileSelection();
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
    passwordGiveUp = null;
    showInit(message);
}

function showDone(directDownload, notice = null) {
    renderDone({
        directDownload,
        pageCount: state.pageCount,
        report: state.report,
        notice,
    }, {
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

// The thumbnail's URL outlives the screen that showed it — the output screen is
// redrawn on every download — so it is released with the run, not with the render
function releasePreviewUrl() {
    if (state.previewUrl) {
        URL.revokeObjectURL(state.previewUrl);
        state.previewUrl = null;
    }
}

// Everything a finished run produced. Kept apart from `reset` because the way
// back to the settings throws the result away and keeps the file — the whole
// point of going back is to run the same source again.
function discardResult() {
    releasePdfUrl();
    state.images = null;
    state.pdfName = null;
    state.pageCount = 0;
    state.doneMode = null;
    state.report = null;
}

// The way back from a finished run: the settings are read while a file is being
// processed, so acting on a change means running the file again — and the
// screen to decide the change on is the sample, not the start screen. The
// source is still open, so this costs one page rather than a fresh open.
function changeSettings() {
    if (!state.session) {
        // Nothing left to sample. Fall back to the start screen with the panel
        // already unfolded, which is where the choice can still be made.
        openSettings();
        reset({ keepFile: true });
        return;
    }
    discardResult();
    startSample();
}

function reset({ keepFile = false } = {}) {
    termInvalidate();
    termStopSpinner();
    passwordGiveUp = null;
    if (!keepFile) {
        fileInput.value = '';
        state.fileName = '';
    }
    closeSession();
    discardResult();
    releasePreviewUrl();
    releaseSampleSource();
    state.sampleImage = null;
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
    let notice = null;
    try {
        await downloadImages(state.images, baseNameOf(state.fileName), reporter(t.downloading));
    } catch (err) {
        // A cancelled page-by-page save keeps whatever already landed; the rest
        // simply never starts, and the output screen still has all three formats
        if (err !== CANCELLED) {
            // This used to rethrow, out of an async function nobody awaits —
            // the rejection went nowhere and the run stayed on the progress
            // screen, spinner turning, with no way out but a reload
            console.error('Saving images failed:', err);
            notice = t.saveFailed;
        }
    }
    showDone(false, notice);
}

async function downloadAsZip() {
    if (!state.images || state.images.length === 0) return;
    state.stage = 'downloading';
    startProgress(t.zipping);
    let notice = null;
    try {
        await downloadZip(state.images, baseNameOf(state.fileName), reporter(t.zipping));
        // Zipping reports from inside JSZip, so the cancel lands there; this
        // only catches a cancel asked for after the last update but before the
        // file was handed to the browser
        checkpoint();
    } catch (err) {
        if (err !== CANCELLED) {
            console.error('Zipping failed:', err);
            notice = t.saveFailed;
        }
    }
    showDone(false, notice);
}

// === The source, opened once ===
//
// The sample and the run that follows it read the same file, and on the PDF
// path opening it is the expensive half — the buffer, pdf.js's parse, and the
// part that must not happen twice: the password. So the source is opened once,
// held for as long as the file is the one on screen, and closed when the file
// is let go. A session is `{ pdf, buffer }` for a PDF and `{ files }` for
// picked images, which have nothing to open.

function closeSession() {
    const session = state.session;
    state.session = null;
    if (!session?.pdf) return;
    invalidateSample();
    // Destroying a document a sample is still reading does not fail that read,
    // it leaves it pending for good — so the close waits for the page in flight
    // while whoever asked for it carries straight on
    samplePending.then(() => session.pdf.destroy());
}

/** Returns null having already said what went wrong on the start screen. */
async function openSession(files) {
    const isPdf = files[0].name.toLowerCase().endsWith('.pdf') ||
        files[0].type === 'application/pdf';
    if (!isPdf) return { files };

    // Set once the user declines the password prompt, so the rejection that
    // pdf.js raises afterwards doesn't overwrite the more specific message
    let gaveUpOnPassword = false;
    try {
        const buffer = await readAsArrayBuffer(files[0]);
        // pdf.js takes ownership of the buffer it is handed, so keep the
        // original around for the metadata-only path
        const loadingTask = pdfjsLib.getDocument({
            data: buffer.slice(0),
            disableFontFace: true,
            verbosity: 0,
        });
        attachPasswordPrompt(loadingTask, () => { gaveUpOnPassword = true; });
        return { pdf: await loadingTask.promise, buffer };
    } catch (err) {
        if (gaveUpOnPassword) {
            abortWith(t.passwordNotProvided);
        } else {
            console.error('Opening the PDF failed:', err);
            abortWith(t.failed);
        }
        return null;
    }
}

function sessionPageCount(session) {
    return session.pdf ? session.pdf.numPages : session.files.length;
}

/**
 * Page 1, through the pipeline the run uses and stopped after it.
 *
 * Both branches are the run's own functions bounded to one item, so a sample is
 * never a different rendering of the page from the one that will be shipped —
 * it is the first N-th of the same walk. Each is asked to keep the decoded
 * bitmap, which is what makes the *second* look cheap; see `encodeSample`.
 */
async function firstPageImage(session) {
    if (!session.pdf) {
        const [image] = await processImageFiles(
            session.files.slice(0, 1), null, { keepSource: true },
        );
        return image || null;
    }
    const images = await extractImages(session.pdf, { limit: 1, keepSource: true });
    return (images && images.length) ? images[0] : null;
}

// === The sample ===

// One page in flight at a time, and at most one more queued behind it. Holding
// an arrow key down cycles a setting faster than a page can be encoded, and
// what that should produce is the page for the value it comes to rest on — not
// a queue of pages for every value it passed through.
let sampleBusy = false;
let sampleStale = false;

/**
 * Bumped whenever the sample stops being of what is on screen: a new file, the
 * run starting, the way back to the start screen. A pass whose token has moved
 * on throws away what it produced instead of painting it over the answer to a
 * question nobody is asking any more.
 */
let sampleToken = 0;

/**
 * The pass in flight, and the reason there is one to await at all.
 *
 * Everything the sample touches is shared with what comes after it — the run
 * reads the same document, a new file closes it. pdf.js does not fail a read
 * whose document is destroyed underneath it, it simply never answers, so the
 * sample cannot merely be abandoned: it has to be waited out. Invalidating and
 * awaiting are two separate things here and both are needed — the token says
 * the answer is no longer wanted, the promise says the document is free.
 */
let samplePending = Promise.resolve();

function invalidateSample() {
    sampleToken++;
    sampleStale = false;
}

// The sheet page 1 would land on, and how big one of its pixels comes out on
// it. With no page yet it is portrait A4 through the same function, so the empty
// sheet is a plausible page rather than a box.
function sampleGeometry() {
    const image = state.sampleImage;
    const width = image ? image.width : PORTRAIT_WIDTH;
    const height = image ? image.height : PORTRAIT_HEIGHT;
    const layout = pageLayout();
    return {
        sheet: sheetFor(width, height, layout),
        margin: layout.margin,
        zoom: pointsPerPixel(width, height, layout) * CSS_PX_PER_PT,
    };
}

function paintSample() {
    const image = state.sampleImage;
    sampleUpdate({
        // On the sheet, what is missing; under it, what that means. Saying the
        // same sentence in both places reads as the screen stuttering.
        image: image
            ? {
                url: state.previewUrl,
                alt: t.sampleAlt,
                aspect: image.width / image.height,
            }
            : { note: t.notScanMark },
        geometry: sampleGeometry(),
        caption: image ? t.sampleCaption : t.notScan,
        // Page 1 is the only page that has been encoded, so it is the only
        // basis there is for what the rest will weigh. Nothing is estimated
        // from a page that produced no image — the whole document may yet be
        // a scan, and a number invented here would be the wrong kind of guess.
        size: image
            ? sampleEstimate({
                pageBytes: image.blob.size,
                pageCount: sessionPageCount(state.session),
            })
            : t.notScanNote,
    });
}

function refreshSample() {
    // The queued pass runs inside the one already going, so the promise the
    // caller is handed covers it too
    if (sampleBusy) sampleStale = true;
    else samplePending = samplePass(sampleToken);
    return samplePending;
}

/**
 * Page 1 under the settings as they now stand.
 *
 * The first time this has to open the page: render it, find the scan on it,
 * decode it. None of that depends on a setting, and all of it is where the time
 * goes — measured at about three seconds on a five-page scan, against some tens
 * of milliseconds for the encode at the end of it. Doing the whole thing again
 * for a quality step made the sample cost roughly what a short run costs, which
 * is the expense the sample exists to avoid.
 *
 * So the bitmap is kept, and every later pass is the encoder alone — the same
 * `rasterize` the run calls, reading the same settings. `orient` follows the
 * source the way it does in the pipeline: a picked image brings its own
 * orientation, a page out of a PDF is already the right way up.
 */
function encodeSample(session, source) {
    if (!source) return firstPageImage(session);
    return rasterize(source, { orient: !session.pdf });
}

function releaseSampleSource() {
    closeBitmap(state.sampleSource);
    state.sampleSource = null;
}

async function samplePass(token) {
    const session = state.session;
    if (!session) return;
    sampleBusy = true;
    // The sheet says it, so the caption does not say it again — the sheet is
    // where the missing picture is, which is where the reason for it belongs
    sampleUpdate({ image: { note: t.sampleBusy }, caption: '', size: '' });
    try {
        let image;
        do {
            sampleStale = false;
            image = await encodeSample(session, state.sampleSource);
            // Superseded while this was encoding. Checked before anything is
            // stored, so a pass that is too late leaves no trace — including
            // the bitmap it may have just decoded, which nothing else holds.
            if (token !== sampleToken) {
                closeBitmap(image?.source);
                return;
            }
            if (image?.source) state.sampleSource = image.source;
        } while (sampleStale);
        releasePreviewUrl();
        state.sampleImage = image;
        if (image) state.previewUrl = URL.createObjectURL(image.blob);
        paintSample();
    } catch (err) {
        console.error('Rendering the sample page failed:', err);
        if (token === sampleToken) {
            sampleUpdate({ image: { note: t.sampleFailed }, caption: '', size: '' });
        }
    } finally {
        sampleBusy = false;
    }
}

// A settings change costs whatever it actually reaches. The sheet moving around
// the same pixels is a repaint; different pixels are a page to encode again.
function settingChanged(setting) {
    if (setting.affects === 'image') refreshSample();
    else if (setting.affects === 'layout') sampleUpdate({ geometry: sampleGeometry() });
}

async function startSample() {
    state.stage = 'sample';
    invalidateSample();
    termStopSpinner();
    setAccent('var(--accent)');
    setMood('idle');

    // The screen goes up first and fills in afterwards: it carries the settings
    // panel, and there is no reason to hold that back behind a page render
    const shown = await renderSampleScreen({
        fileLabel: pendingFileLabel(),
        pageCount: sessionPageCount(state.session),
        onSettingChange: settingChanged,
        onProceed: startRun,
        onSelectFile: () => fileInput.click(),
        onReset: () => reset(),
    });
    // Enter can beat the last of those lines onto the screen, and so can a
    // second file
    if (!shown || state.stage !== 'sample') return;
    // A pass from before this screen may still be holding the last page it was
    // given; the one it is about to be replaced by is the one to release
    await samplePending;
    if (state.stage !== 'sample') return;

    releasePreviewUrl();
    releaseSampleSource();
    state.sampleImage = null;
    refreshSample();
}

// === Processing ===

async function handleFileSelection() {
    if (state.stage === 'booting') return;
    // A new pick supersedes whatever was open; nothing below it survives
    closeSession();
    discardResult();
    state.stage = 'processing';
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
    // Read before anything is processed: it is half of the before/after the
    // output screen reports, and the picker can be refilled by then
    state.inputSize = files.reduce((sum, file) => sum + file.size, 0);
    startProgress(t.extracting + '...', pendingFileLabel());

    // The PDF libraries stream in behind the start screen, so a file picked
    // moments after load may arrive first; the progress line above is already
    // up, so this just waits under the spinner
    if (!await vendorReady) {
        abortWith(t.libsUnavailable);
        return;
    }

    const session = await openSession(files);
    if (!session) return;
    // Opening is the one stretch with no checkpoints in it — reading the file
    // and parsing it take no progress callback — so the answer is honoured on
    // the way out instead, the same way `saveCancellably` honours it
    if (cancelRequested) {
        session.pdf?.destroy();
        abortWith(t.cancelled);
        return;
    }
    state.session = session;
    startSample();
}

// Off the sample screen and into the run the sample was judged for
async function startRun() {
    if (!state.session) return;
    state.stage = 'processing';
    invalidateSample();
    startProgress(t.extracting + '...', pendingFileLabel());
    // The sample has been told its page is no longer wanted, but it still has
    // the document until it lets go of it
    await samplePending;
    if (cancelRequested) {
        abortWith(t.cancelled);
        return;
    }
    if (state.session.pdf) runPdf(state.session);
    else runImages(state.session.files);
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

/**
 * Which of the metadata fields the *source* was actually carrying.
 *
 * Read from pdf.js's own info dictionary rather than from what `cleanSavePdf`
 * deleted, because on the rebuild path the output is a fresh document that
 * never had the originals — deleting nothing from it would report nothing gone,
 * when in fact the whole info dictionary was left behind. This way the screen
 * names what this file was carrying instead of restating what the app strips.
 */
async function sourceMetadataFields(pdf) {
    try {
        const { info } = await pdf.getMetadata();
        return METADATA_FIELDS.filter((field) => {
            const value = info?.[field];
            return value !== undefined && value !== null && String(value).trim() !== '';
        });
    } catch {
        // An unreadable info dictionary is not worth failing a run over; the
        // screen simply has one fewer thing to say
        return [];
    }
}

function readAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(file);
    });
}

// The document stays open afterwards, whichever way this ends: the session owns
// it, so a finished run can be sent back to the sample screen and a failed one
// retried under different settings without opening the file again.
async function runPdf({ pdf, buffer }) {
    try {
        const removedFields = await sourceMetadataFields(pdf);
        const imgs = await extractImages(pdf, { onProgress: reporter(t.extracting) });

        if (imgs === false) {
            // Not a scan: leave the pages alone and only strip the metadata.
            // The run carries on under the spinner and the explanation lands on
            // the output screen, where it stays — it used to be a two-second
            // warning printed onto a cleared screen, which held the result back
            // by exactly as long as it took to say something the output screen
            // then said again.
            checkpoint();
            termUpdateProgress(t.saving);
            const originalPdfDoc = await PDFDocument.load(buffer);
            finishProcessing(await saveCancellably(originalPdfDoc), null, true, { removedFields });
        } else if (imgs.length === 0) {
            abortWith(t.noImages);
        } else {
            checkpoint();
            termUpdateProgress(t.saving);
            const newPdf = await createNewPdf(imgs, reporter(t.processing));
            finishProcessing(await saveCancellably(newPdf), imgs, false, { removedFields });
        }
    } catch (err) {
        if (err === CANCELLED) {
            abortWith(t.cancelled);
        } else {
            console.error('PDF processing failed:', err);
            abortWith(t.failed);
        }
    }
}

async function runImages(files) {
    try {
        const extracted = await processImageFiles(files, reporter(t.extracting));
        if (extracted.length === 0) {
            abortWith(t.noImages);
            return;
        }
        checkpoint();
        termUpdateProgress(t.saving);
        const newPdf = await createNewPdf(extracted, reporter(t.processing));
        finishProcessing(await saveCancellably(newPdf), extracted, false, { sourceIsImages: true });
    } catch (err) {
        if (err === CANCELLED) {
            abortWith(t.cancelled);
        } else {
            console.error('Image processing failed:', err);
            abortWith(t.failed);
        }
    }
}

/**
 * The account the output screen prints. Assembled here rather than in the
 * screen because only this layer knows which path the file took; the screen is
 * handed facts and decides how to word them.
 *
 * @param source  { removedFields, sourceIsImages } — what the input was and
 *                what it was carrying
 */
function buildReport(newPdfBlob, directDownload, { removedFields = [], sourceIsImages = false }) {
    const rebuilt = !directDownload && state.pageCount > 0;
    // Page 1 stands in for the run: it is the page whose quality and resolution
    // the settings are judged on, and the only one worth the memory of a
    // second decode
    const first = rebuilt ? state.images[0] : null;
    if (first) state.previewUrl = URL.createObjectURL(first.blob);
    // The sheet this page actually landed on. Read now rather than when the
    // screen draws, because `createNewPdf` has just read the same settings and
    // these are the values it used — a later reading would describe a page the
    // file does not have.
    const layout = first ? pageLayout() : null;

    return {
        inputSize: state.inputSize,
        outputSize: newPdfBlob.size,
        rebuilt,
        // Not a question when the pages were left alone, and not one for picked
        // images either: they arrive with an empty `texts` array whatever the
        // setting says, so reporting the setting would be reporting a decision
        // that was never taken
        textKept: (rebuilt && !sourceIsImages) ? keepText() : null,
        removedFields,
        sourceIsImages,
        preview: first
            ? {
                url: state.previewUrl,
                aspect: first.width / first.height,
                geometry: {
                    sheet: sheetFor(first.width, first.height, layout),
                    margin: layout.margin,
                    zoom: pointsPerPixel(first.width, first.height, layout) * CSS_PX_PER_PT,
                },
            }
            : null,
    };
}

function finishProcessing(newPdfBlob, extractedImages, directDownload, source = {}) {
    termStopSpinner();
    if (!(newPdfBlob instanceof Blob)) {
        abortWith(t.failed);
        return;
    }

    releasePdfUrl();
    releasePreviewUrl();
    state.pdfUrl = URL.createObjectURL(newPdfBlob);
    state.pdfName = `${baseNameOf(state.fileName)}_c.pdf`;
    state.pageCount = extractedImages ? extractedImages.length : 0;
    state.images = (!directDownload && state.pageCount > 0) ? extractedImages : null;
    state.report = buildReport(newPdfBlob, directDownload, source);

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
    return state.stage === 'init' || state.stage === 'sample' || state.stage === 'done';
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
    proceed: () => { if (pendingFileLabel()) proceed(); else fileInput.click(); },
    startRun,
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
