// Screens: what the terminal shows at each stage. These only describe lines and
// wire them to callbacks the caller supplies — no processing happens here.

import { t } from './i18n.js';
import { getTool } from './theme.js';
import { REPO_URL, TERM_DELAY } from './config.js';
import { LOGO, LOGO_C, LOGO_C_END } from './logo.js';
import { DEPENDENCIES } from './vendor.js';
import {
    delay,
    termHeaderTarget,
    openTermContent,
    termLine,
    termText,
    termGap,
    termRule,
    termCaret,
    termOption,
    termToggle,
    setToggleState,
    termStopSpinner,
    renderLines,
    registerLogoCell,
    setAccent,
    warnActive,
    setPendingFinish,
} from './terminal.js';

const FACES = {
    idle: '(๑- . -๑)',
    done: '(๑• . •๑)',
};

let face = null;      // the big mascot line, created during boot
let mood = 'idle';

// The text-layer toggle on the done screen, kept so its state can be updated
// in place; null whenever the current screen doesn't show it
let keepTextLine = null;

/**
 * Repaint the text-layer toggle only. `busy` parks it on an ellipsis while the
 * PDF is being rebuilt, which is the whole point of updating in place: the
 * rest of the screen stays put instead of being cleared and replayed.
 */
export function setKeepTextState(on, busy = false) {
    setToggleState(keepTextLine, {
        on: on && !busy,
        label: busy ? t.busy : (on ? t.on : t.off),
    });
}

// Face and document title always move together
export function setMood(next) {
    if (next) mood = next;
    const text = getTool() + FACES[mood];
    if (face) face.textContent = text;
    document.title = text;
}

// === Boot ===

export async function boot() {
    const header = termHeaderTarget();
    setMood('idle');

    // Wordmark, one row per refresh
    for (const row of LOGO) {
        const el = termLine('tl-logo', header);
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

    // Face
    face = termText(getTool() + FACES.idle, 'tl-face', header);
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
    keepTextLine = null;
    return renderLines([
        () => termText(t.loadingLibs, 'tl-dim'),
        () => termGap(),
        () => termCaret(),
    ]);
}

// Dead end: without pdf.js and pdf-lib there is nothing the app can do, so it
// says so and offers a reload rather than a start screen that can't start
export function renderUnavailable({ retry }) {
    keepTextLine = null;
    return renderLines([
        () => termText('! ' + t.libsUnavailable, 'tl-warn'),
        () => termGap(),
        () => termOption('r', t.retry, retry),
        () => termGap(),
        () => termCaret(),
    ]);
}

export function renderInit({ selectFile }) {
    keepTextLine = null;
    return renderLines([
        () => termText(t.ready, 'tl-dim'),
        () => termGap(),
        () => termOption('enter', t.selectFile, selectFile),
        () => termGap(),
        () => termCaret(),
    ]);
}

/**
 * @param directDownload  true when only metadata was stripped, so the PDF is
 *                        the single possible output
 * @param actions         { onStart, setDoneMode, canKeepText, keepText,
 *                          toggleKeepText, downloadPdf, downloadImages,
 *                          downloadZip, reset }
 */
export async function renderDone(directDownload, pageCount, actions) {
    // Warnings own the screen until they expire; queue behind them
    if (warnActive()) {
        setPendingFinish(() => renderDone(directDownload, pageCount, actions));
        return;
    }
    termStopSpinner();
    actions.onStart();
    keepTextLine = null;

    setAccent('var(--text)');
    setMood('done');

    const summary = directDownload
        ? '✓ ' + t.metaCleaned
        : `✓ ${pageCount} ${t.pagesReady}`;

    const lines = directDownload ? [
        () => termText(summary, 'tl-ok'),
        () => termGap(),
        () => { actions.setDoneMode('direct'); termOption('enter', t.download, actions.downloadPdf); },
        () => termGap(),
        () => termOption('0', t.reset, actions.reset),
        () => termGap(),
        () => termCaret(),
    ] : [
        () => termText(summary, 'tl-ok'),
        () => termGap(),
        () => { actions.setDoneMode('format'); termText(t.formatHeader); },
        () => termOption('1', t.formatPdf, actions.downloadPdf),
        () => termOption('2', t.formatImages, actions.downloadImages),
        () => termOption('3', t.formatZip, actions.downloadZip),
        // Off by default: the recovered text comes straight from the source
        // and, unlike the images, has not been through the cleanup
        ...(actions.canKeepText ? [
            () => termGap(),
            () => termText(t.optionHeader),
            () => {
                keepTextLine = termToggle(
                    't',
                    t.keepText,
                    { on: actions.keepText, label: actions.keepText ? t.on : t.off },
                    actions.toggleKeepText
                );
            },
            () => termText('  ' + t.keepTextNote, 'tl-dim'),
        ] : []),
        () => termGap(),
        () => termOption('0', t.reset, actions.reset),
        () => termGap(),
        () => termCaret(),
    ];

    await renderLines(lines);
}
