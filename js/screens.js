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
    termGap,
    termRule,
    termBlock,
    termCaret,
    termOption,
    termChoice,
    setAdjust,
    setToggleState,
    termStopSpinner,
    renderLines,
    registerLogoCell,
    setAccent,
    warnActive,
    setPendingFinish,
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
        () => termText('! ' + t.libsUnavailable, 'tl-warn'),
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
// answers a keypress should be there by the time the eye gets to it
function fillSettings(box) {
    for (const setting of SETTINGS) {
        let row;
        const paint = (value) => setToggleState(row, { label: value.label, wrap: ANGLE });
        row = termChoice(null, setting.label, { label: '', wrap: ANGLE }, (delta) => {
            paint(cycle(setting, delta));
        }, box);
        paint(currentValue(setting));
        if (setting.note) termText(setting.note, 'tl-dim tl-note', box);
    }
    termText(t.settingsHint, 'tl-dim tl-sub', box);
}

export function renderInit({ selectFile }) {
    let header = null;
    let box = null;

    const paintHeader = () =>
        setToggleState(header, { label: settingsOpen ? '-' : '+', cls: 'tl-dim' });

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
        () => termText(t.ready, 'tl-dim'),
        () => termGap(),
        () => termOption('enter', t.selectFile, selectFile),
        () => termGap(),
        () => {
            header = termOption('s', t.settings, settingsToggle);
            header.classList.add('tl-row');
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
 * @param directDownload  true when only metadata was stripped, so the PDF is
 *                        the single possible output
 * @param actions         { onStart, setDoneMode, downloadPdf, downloadImages,
 *                          downloadZip, changeSettings, reset }
 */
export async function renderDone(directDownload, pageCount, actions) {
    // Warnings own the screen until they expire; queue behind them
    if (warnActive()) {
        setPendingFinish(() => renderDone(directDownload, pageCount, actions));
        return;
    }
    termStopSpinner();
    actions.onStart();
    settingsToggle = null;

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
        () => termOption('s', t.changeSettings, actions.changeSettings),
        () => termOption('0', t.reset, actions.reset),
        () => termGap(),
        () => termCaret(),
    ] : [
        () => termText(summary, 'tl-ok'),
        () => termGap(),
        // Each option downloads on the spot, so the header names the action;
        // the options themselves say which format it lands in
        () => { actions.setDoneMode('format'); termText(t.downloadHeader); },
        () => termOption('1', t.formatPdf, actions.downloadPdf),
        () => termOption('2', t.formatImages, actions.downloadImages),
        () => termOption('3', t.formatZip, actions.downloadZip),
        () => termGap(),
        () => termOption('s', t.changeSettings, actions.changeSettings),
        () => termOption('0', t.reset, actions.reset),
        () => termGap(),
        () => termCaret(),
    ];

    await renderLines(lines);
}
