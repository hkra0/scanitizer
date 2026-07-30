// Screens: what the terminal shows at each stage. These only describe lines and
// wire them to callbacks the caller supplies — no processing happens here.

import { t } from './i18n.js';
import { getTool } from './theme.js';
import { renderTinyko } from './tinyko.js';
import { REPO_URL, TERM_DELAY } from './config.js';
import { LOGO, LOGO_C, LOGO_C_END } from './logo.js';
import { DEPENDENCIES } from './vendor.js';
import { SETTINGS, currentValue, cycle } from './settings.js';
import {
    delay,
    termHeaderTarget,
    openTermContent,
    termLine,
    termText,
    termStatus,
    termInput,
    termClear,
    termInvalidate,
    termStartProgress,
    termGap,
    termRule,
    termBlock,
    termCaret,
    termOption,
    termChoice,
    termPage,
    setPageGeometry,
    setPageImage,
    setAdjust,
    setToggleState,
    termStopSpinner,
    renderLines,
    registerLogoCell,
    setAccent,
} from './terminal.js';

const TINYKO = {
    idle: '(๑- . -๑)',
    done: '(๑• . •๑)',
};

// Value rows read as ‹ value ›, so it's clear the arrows step through a list
const ANGLE = ['< ', ' >'];

let tinyko = null;    // the big tinyko line, created during boot
let mood = 'idle';

// tinyko and the document title always move together
export function setMood(next) {
    if (next) mood = next;
    const text = getTool() + TINYKO[mood];
    if (tinyko) drawTinyko(tinyko, text);
    document.title = text;
}

// The canvas carries no text of its own, so the line is also kept as a label
// for anything reading the page rather than looking at it
function drawTinyko(canvas, text) {
    const style = getComputedStyle(canvas);
    renderTinyko(canvas, text, style.fontFamily, style.color);
    canvas.setAttribute('aria-label', text);
}

// === Boot ===

export async function boot() {
    const header = termHeaderTarget();
    setMood('idle');

    // Wordmark, one row per refresh. Hidden from assistive tech: these rows are
    // a drawing of the name, and read out they are three lines of block
    // characters. The name itself is the `sr-only` heading in index.html.
    for (const row of LOGO) {
        const el = termLine('tl-logo', header);
        el.setAttribute('aria-hidden', 'true');
        const cell = document.createElement('span');
        cell.className = 'logo-c';
        cell.textContent = row.slice(LOGO_C, LOGO_C_END);
        el.appendChild(document.createTextNode(row.slice(0, LOGO_C)));
        el.appendChild(cell);
        el.appendChild(document.createTextNode(row.slice(LOGO_C_END)));
        registerLogoCell(cell);
        await delay(TERM_DELAY);
    }
    termGap(header);

    // tinyko
    tinyko = document.createElement('canvas');
    tinyko.className = 'tl-tinyko';
    tinyko.setAttribute('role', 'img');
    termLine('tl-tinyko-line', header).appendChild(tinyko);
    drawTinyko(tinyko, getTool() + TINYKO.idle);
    await delay(TERM_DELAY);

    // Description + tagline + github
    termText(t.desc, 'tl-dim', header);
    await delay(TERM_DELAY);
    const linkEl = termLine('tl-dim', header);
    linkEl.appendChild(document.createTextNode(t.tagline + ' · '));
    const link = document.createElement('a');
    link.href = REPO_URL;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Github';
    linkEl.appendChild(link);
    await delay(TERM_DELAY);
    termGap(header);

    // Dependency check, printed like a boot log. The libraries load in the
    // background, so each line goes up as [..] straight away and flips to
    // [ok]/[--] whenever its own load settles — boot doesn't wait on any of
    // them, and the start screen is reachable while they are still arriving.
    for (const [name, ready] of DEPENDENCIES) {
        const el = termLine('tl-dim', header);
        el.appendChild(document.createTextNode('  ' + name.padEnd(10, ' ')));
        const mark = document.createElement('span');
        mark.className = 'tl-dim';
        mark.textContent = '[..]';
        el.appendChild(mark);
        ready.then((loaded) => {
            mark.className = loaded ? 'tl-ok' : 'tl-warn';
            mark.textContent = loaded ? '[ok]' : '[--]';
        });
        await delay(TERM_DELAY);
    }

    termRule(header);

    // Everything below the rule is redrawn per stage
    openTermContent();
}

// === Stages ===

// Shown when the libraries are still in flight after the header is up: the app
// isn't usable yet, so no file option is offered
export function renderLoading() {
    settingsToggle = null;
    return renderLines([
        () => termText(t.loadingLibs, 'tl-dim'),
        () => termGap(),
        () => termCaret(),
    ]);
}

// Dead end: without pdf.js and pdf-lib there is nothing the app can do, so it
// says so and offers a reload rather than a start screen that can't start
export function renderUnavailable({ retry }) {
    settingsToggle = null;
    return renderLines([
        () => termStatus('! ' + t.libsUnavailable, 'tl-warn'),
        () => termGap(),
        () => termOption('r', t.retry, retry),
        () => termGap(),
        () => termCaret(),
    ]);
}

// === Settings ===

// Whether the panel is folded open. Deliberately not persisted: the settings
// themselves are, and the start screen should stay short by default.
let settingsOpen = false;

// Set while the start screen is up, so the 's' key can reach the panel
let settingsToggle = null;

export function toggleSettings() {
    settingsToggle?.();
    return settingsToggle !== null;
}

// Leave the panel folded open for the start screen that is about to be drawn.
// The output screen's way back: the settings only bite during processing, so
// changing them means starting over, and arriving at a start screen with the
// panel already open saves unfolding it again.
export function openSettings() {
    settingsOpen = true;
}

// One row per setting, printed at once rather than line by line: a panel that
// answers a keypress should be there by the time the eye gets to it.
//
// `onChange` is handed the setting that moved, not just the fact that something
// did — the sample screen shows a page whose sheet and whose pixels come from
// different halves of the pipeline, and only the setting itself says which of
// them has to be redone.
function fillSettings(box, onChange) {
    for (const setting of SETTINGS) {
        let row;
        const paint = (value) => setToggleState(row, { label: value.label, wrap: ANGLE });
        row = termChoice(null, setting.label, { label: '', wrap: ANGLE }, (delta) => {
            paint(cycle(setting, delta));
            onChange?.(setting);
        }, box);
        paint(currentValue(setting));
        if (setting.note) termText(setting.note, 'tl-dim tl-note', box);
    }
    termText(t.settingsHint, 'tl-dim tl-sub', box);
}

// A file name long enough to fight the label for the row is cut from the
// front — the tail carries the extension and the telling part of the name
function shortName(name, max = 28) {
    return name.length > max ? '…' + name.slice(-(max - 1)) : name;
}

/**
 * The screen a run is started from, and the one a failed run comes back to.
 *
 * @param fileLabel  name of the file still in the picker, when there is one:
 *                   the way back from the output screen keeps the selection,
 *                   so the same file can be run again under new settings
 * @param error      why the last run ended, when it ended badly. Printed as
 *                   part of the screen rather than as a warning, because a
 *                   warning expires after two seconds and the reason for a
 *                   failure is what the next attempt is decided on. The file
 *                   is still in the picker, so "change a setting and run it
 *                   again" is one keypress from here.
 */
export function renderInit({ selectFile, proceed, fileLabel, error }) {
    let header = null;
    let box = null;

    // The header's box is a fold marker, not a value, so it is announced as an
    // expanded/collapsed state rather than read out as "settings: +"
    const paintHeader = () => {
        setToggleState(header, { label: settingsOpen ? '-' : '+', cls: 'tl-dim' });
        header.setAttribute('aria-expanded', String(settingsOpen));
    };

    // Folding is a local edit: only the panel's own rows come and go, so the
    // screen around them is never cleared and replayed
    const fold = (open) => {
        // `box` lands a line after the header, so a keypress that beats the
        // render out has nothing to fold yet
        if (!box || open === settingsOpen) return;
        settingsOpen = open;
        paintHeader();
        box.textContent = '';
        if (settingsOpen) fillSettings(box);
    };

    settingsToggle = () => fold(!settingsOpen);

    return renderLines([
        () => {
            if (error) {
                termStatus('! ' + error, 'tl-warn');
                termGap();
            }
            termText(t.ready, 'tl-dim');
        },
        () => termGap(),
        () => {
            if (!fileLabel) {
                termOption('enter', t.selectFile, selectFile);
                termText(t.dropHint, 'tl-dim tl-sub');
                return;
            }
            const row = termOption('enter', t.proceed, proceed);
            row.classList.add('tl-row');
            setToggleState(row, { label: shortName(fileLabel), cls: 'tl-dim', wrap: ['', ''] });
            termOption('f', t.changeFile, selectFile);
        },
        () => termGap(),
        () => {
            header = termOption('s', t.settings, settingsToggle);
            header.classList.add('tl-row');
            header._ariaBase = null;   // named by its own text, not by the marker
            paintHeader();
            // The arrows open and shut it, the same keys that change a value
            setAdjust(header, (delta) => fold(delta > 0));
        },
        () => {
            box = termBlock();
            if (settingsOpen) fillSettings(box);
        },
        () => termGap(),
        () => termCaret(),
    ]);
}

/**
 * The screen an encrypted PDF stops on.
 *
 * Printed at once and not a line at a time: it is an answer to something the
 * file asked, and a field that fades in under a cursor already in it is a field
 * that swallows the first characters typed. For the same reason it does not go
 * through `renderLines` — there is nothing to animate and nothing to supersede.
 *
 * @param retry     the last attempt was wrong, rather than this being the first
 * @param onSubmit  (password) => void
 * @param onCancel  giving up; the run is abandoned and the reason said out loud
 */
export function renderPassword({ fileLabel, retry, onSubmit, onCancel }) {
    settingsToggle = null;
    termInvalidate();
    termClear();
    termStopSpinner();

    if (fileLabel) {
        termText('> ' + shortName(fileLabel), 'tl-dim');
        termGap();
    }
    // A wrong password is worth announcing; the plain locked notice is not,
    // since the field it belongs to is the thing being focused anyway
    if (retry) termStatus('! ' + t.incorrectPassword, 'tl-warn');
    termText(t.locked, 'tl-dim');
    termGap();

    const input = termInput(t.passwordPrompt + ': ', { type: 'password', onSubmit });

    // Revealing what was typed is the cheapest fix for the commonest failure —
    // a mistyped password no one can see. Keyless: the field has the focus and
    // every letter belongs to it, so there is no shortcut to spare.
    const reveal = termOption(null, t.showPassword, () => {
        const shown = input.type === 'text';
        input.type = shown ? 'password' : 'text';
        reveal.lastChild.textContent = shown ? t.showPassword : t.hidePassword;
        input.focus();
    });

    termGap();
    termOption('esc', t.cancel, onCancel);
    termGap();

    input.focus();
}

/**
 * The screen a run occupies while it works. Printed at once — a progress line
 * that fades in a row at a time is a progress line that is already out of date.
 *
 * @param header    the file, or the first of several, shown above the bar
 * @param onCancel  a run can be long and there is no other way out of it than
 *                  reloading the page, so the way out is named on screen
 */
export function renderProgress({ text, header, onCancel }) {
    settingsToggle = null;
    termStartProgress(text, header);
    if (onCancel) {
        termGap();
        termOption('esc', t.cancel, onCancel);
    }
}

// === The sample ===

/**
 * The live parts of the sample screen: the sheet and the two lines under it.
 *
 * Kept so a settings change can rewrite them in place. A settings change that
 * redrew the screen would take the option cursor and the scroll position with
 * it — and the row the user is holding the arrow key on is exactly the row that
 * would move.
 */
let sampleView = null;

// The sheet is still on screen only if it is still in the document. Asked of
// the DOM rather than cleared by every other screen on its way in, for the same
// reason `optionEls` reads its rows from the DOM: the answer is already there,
// and a copy of it is one more thing that can be wrong.
function sampleLive() {
    return sampleView?.page?.isConnected ? sampleView : null;
}

// `n pages × page 1` — an estimate, and drawn as one. The multiplication is
// shown because it is the whole basis: page 1 is the only page that has been
// encoded, and a reader who knows that can judge how much to trust the total.
export function sampleEstimate({ pageBytes, pageCount }) {
    const total = t.estSize + '  ≈ ' + formatBytes(pageBytes * pageCount);
    return pageCount > 1
        ? `${total}  (${pageCount} × ${formatBytes(pageBytes)})`
        : total;
}

/**
 * Rewrite whatever the caller has a new answer for; omitted keys are left as
 * they are. Silently does nothing once the screen has moved on, so a sample
 * that finishes rendering after the user has walked away lands nowhere.
 *
 * @param image     { url, alt } — or { note } while there is no picture to show
 * @param geometry  { sheet: [w, h], margin }, in points
 * @param caption   the dim line under the sheet
 * @param size      the estimate line, or anything else worth saying there
 */
export function sampleUpdate({ image, geometry, caption, size } = {}) {
    const view = sampleLive();
    if (!view) return;
    if (image !== undefined) setPageImage(view.page, image);
    if (geometry !== undefined) setPageGeometry(view.page, geometry);
    if (caption !== undefined && view.caption) view.caption.textContent = caption;
    if (size !== undefined && view.size) view.size.textContent = size;
}

/**
 * The screen a run is decided on: page 1, made the way the settings below it
 * would make all of them, and what the whole file is likely to weigh.
 *
 * It sits between picking a file and processing it because that is where the
 * question it answers is asked. The output screen's thumbnail answers "did this
 * work"; this one answers "are these the right settings", and an answer to that
 * arriving after every page has already been encoded is an answer that costs a
 * whole run to act on. Here the cost of changing one's mind is a single page.
 *
 * One keypress passes straight through it, so the run that needed no decision
 * pays a page and an Enter for the one that did.
 */
export function renderSampleScreen({
    fileLabel, pageCount, onSettingChange, onProceed, onSelectFile, onReset,
}) {
    settingsToggle = null;
    const view = { page: null, caption: null, size: null };
    sampleView = view;

    // Named by what it commits to, since that is what the key is being pressed
    // to decide. A one-page file has nothing to extrapolate, so it says the
    // plain thing instead of "process all 1 pages".
    const proceedLabel = pageCount > 1
        ? t.processAll.replace('{}', pageCount)
        : t.proceed;

    return renderLines([
        () => { if (fileLabel) termText('> ' + shortName(fileLabel), 'tl-dim'); },
        () => termGap(),
        () => {
            view.page = termPage();
            // The message goes on the sheet from the start, so nothing about
            // where it is said changes when the first pass takes over
            setPageImage(view.page, { note: t.sampleBusy });
        },
        () => { view.caption = termText('', 'tl-dim tl-sub'); },
        // The size is the line the settings are actually judged on — same
        // reasoning, and same full text colour, as the output screen's
        () => { view.size = termText('', 'tl-sub'); },
        () => termGap(),
        // No fold here: the panel is what this screen is for, so it is open and
        // has no marker offering to shut it
        () => termText(t.settings + ':'),
        () => fillSettings(termBlock(), onSettingChange),
        () => termGap(),
        () => termOption('enter', proceedLabel, onProceed),
        () => termOption('f', t.changeFile, onSelectFile),
        () => termOption('0', t.reset, onReset),
        () => termGap(),
        () => termCaret(),
    ]);
}

// === The account of a run ===

// Printed the way a file manager would rather than in bytes: the number is here
// to be judged, not to be exact
function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    // Three significant figures either way, so 9.8 MB and 480 KB read alike
    return (value >= 100 ? Math.round(value) : value.toFixed(1)) + ' ' + units[unit];
}

// `2.4 MB → 480 KB  -80%`. The percentage is the part worth reading: it is what
// says whether the compression settings were too harsh or not harsh enough.
function sizeLine({ inputSize, outputSize }) {
    const to = formatBytes(outputSize);
    if (!inputSize) return to;
    const delta = Math.round((outputSize - inputSize) / inputSize * 100);
    return `${formatBytes(inputSize)} → ${to}  ${delta > 0 ? '+' : ''}${delta}%`;
}

/**
 * What the run actually did, as a handful of lines under the summary.
 *
 * The tool's whole claim is that things were removed, and a screen that only
 * says "done" asks to be taken on trust — these lines say what went, what
 * stayed, and what it cost. Every one of them is a fact about this file rather
 * than a restatement of the settings: `removedFields` is what the source was
 * carrying, not what the app is configured to strip.
 */
function reportLines(report) {
    const lines = [
        // The size is the headline, so it keeps the full text colour while the
        // rest of the account stays dim
        () => termText(t.reportSize + '  ' + sizeLine(report), 'tl-sub'),
    ];

    if (report.sourceIsImages) {
        // "Pages rebuilt as images" is not news about an image, so the one line
        // this path gets is the one that says something: a picked image never
        // had a PDF info dictionary, but it may well have carried exif, and the
        // canvas round-trip is what drops it
        lines.push(() => termText(t.reportExif, 'tl-dim tl-sub'));
    } else {
        // Only the metadata-only path says anything about the pages. That they
        // were rebuilt is not news — the thumbnail above is the rebuilt page,
        // and "N pages ready" already said so. That they were *not* touched is
        // news, because this path's summary only mentions the metadata.
        if (!report.rebuilt) {
            lines.push(() => termText(t.reportUntouched, 'tl-dim tl-sub'));
        }
        // Only the pages-kept path can say this: a rebuilt page lost every
        // annotation it had as a side effect of being rebuilt, so counting them
        // there would be reporting on something nobody chose. A zero is still
        // worth a line — the pass ran, and "nothing was found" is a different
        // answer from "this was not looked at", which is what silence would mean
        if (report.marks) {
            lines.push(() => termText(
                report.marks.annotations + report.marks.blocks
                    ? t.reportMarks
                        .replace('{a}', report.marks.annotations)
                        .replace('{b}', report.marks.blocks)
                    : t.reportNoMarks,
                'tl-dim tl-sub',
            ));
        }
        lines.push(() => termText(
            report.removedFields.length
                ? t.reportRemoved + ' ' + report.removedFields.join(', ')
                : t.reportNoMeta,
            'tl-dim tl-sub',
        ));
    }

    // Only a question when the pages were rebuilt: a metadata-only pass leaves
    // whatever text was there exactly where it was. Stated plainly rather than
    // as a warning: the caveat belongs to the decision, and the setting that
    // takes it already prints it underneath. Repeating it here would be warning
    // the user about a choice they have already been warned about and made.
    if (report.textKept !== null) {
        lines.push(() => termText(
            report.textKept ? t.reportTextKept : t.reportTextDropped,
            'tl-dim tl-sub',
        ));
    }
    return lines;
}

// The result page, in the same figure the sample screen uses: the page on its
// sheet, and the pixels beside it at 1:1. Without the caption the picture looks
// like decoration rather than the page that is about to be downloaded.
//
// Not the same picture as the sample screen's, though it is the same page: that
// one is a proposal and this one is the delivery. The tool's whole claim is that
// it changed the file, and a screen that only says "done" asks to be taken on
// trust — so the result gets shown even to someone who has just seen the sample
// it was promised from.
function previewLines(preview) {
    return [
        () => {
            const figure = termPage();
            setPageGeometry(figure, preview.geometry);
            setPageImage(figure, {
                url: preview.url,
                alt: t.previewAlt,
                aspect: preview.aspect,
            });
        },
        () => termText(t.previewCaption, 'tl-dim tl-sub'),
        // The picture and the account of the run are two different answers to
        // "did this work"; a gap keeps the caption from reading as the first
        // line of the account
        () => termGap(),
    ];
}

/**
 * @param directDownload  true when only metadata was stripped, so the PDF is
 *                        the single possible output
 * @param report          the account of the run — see `reportLines`. Carries
 *                        the first page's thumbnail when there is one.
 * @param notice          something that went wrong with a download, when
 *                        something did. Printed as part of the screen and left
 *                        there: the result is still on offer in the other two
 *                        formats, so this is a thing to act on rather than a
 *                        thing to be told once. The same reasoning `abortWith`
 *                        applies to a failed run.
 * @param actions         { onStart, setDoneMode, downloadPdf, downloadImages,
 *                          downloadZip, changeSettings, reset }
 */
export async function renderDone({ directDownload, pageCount, report, notice }, actions) {
    termStopSpinner();
    actions.onStart();
    settingsToggle = null;

    setAccent('var(--text)');
    setMood('done');

    const summary = directDownload
        ? '✓ ' + t.metaCleaned
        : `✓ ${pageCount} ${pageCount === 1 ? t.pageReady : t.pagesReady}`;

    // Result first, then the evidence for it, then what can be done with it
    const lines = [
        () => termStatus(summary, 'tl-ok'),
        ...(notice ? [() => termStatus('! ' + notice, 'tl-warn')] : []),
        () => termGap(),
        ...(report?.preview ? previewLines(report.preview) : []),
        ...(report ? reportLines(report) : []),
        () => termGap(),
    ];

    if (directDownload) {
        lines.push(
            () => { actions.setDoneMode('direct'); termOption('enter', t.download, actions.downloadPdf); },
        );
    } else {
        // Each option downloads on the spot, so the header names the action;
        // the options themselves say which format it lands in
        lines.push(
            () => { actions.setDoneMode('format'); termText(t.downloadHeader); },
            () => termOption('1', t.formatPdf, actions.downloadPdf),
            () => termOption('2', t.formatImages, actions.downloadImages),
            () => termOption('3', t.formatZip, actions.downloadZip),
        );
    }

    lines.push(
        () => termGap(),
        () => termOption('s', t.changeSettings, actions.changeSettings),
        () => termOption('0', t.reset, actions.reset),
        () => termGap(),
        () => termCaret(),
    );

    await renderLines(lines);
}
