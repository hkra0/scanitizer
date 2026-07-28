// The terminal: every DOM write goes through here. Screens describe what to
// print, this module owns the elements, the spinner, the warning queue and the
// keyboard/mouse selection state.

import {
    TERM_DELAY,
    BAR_WIDTH,
    SPINNER_FRAMES,
    SPINNER_INTERVAL,
    WARN_DURATION,
} from './config.js';

let termRoot = null;     // whole terminal, including the boot header
let termContent = null;  // dynamic area, redrawn per stage
let logoCells = [];      // the 'c' glyph rows of the logo, filled during boot

let spinnerIntervalId = null;
let progressLine = null;

let warnTimeout = null;
let warnQueue = [];
let pendingFinish = null;

// Bumped by every screen change so a slow line-by-line render can tell that it
// has been superseded and bail out
let renderVersion = 0;

let options = [];        // selectable lines on the current screen, in order
let selIndex = -1;       // keyboard selection, -1 when the mouse is in charge
let keyNavAnchor = null; // option the pointer rested on when keys took over

export function delay(ms) {
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

export function initTerminal(root) {
    termRoot = root;
}

// The header is printed into the root; once boot finishes it hands over a
// nested element that later screens are free to wipe
export function termHeaderTarget() {
    return termRoot;
}

export function openTermContent() {
    termContent = document.createElement('div');
    termContent.id = 'term-content';
    termRoot.appendChild(termContent);
}

// === Printing ===

// Append a line to a container (defaults to the dynamic content area)
export function termLine(cls, target) {
    const el = document.createElement('div');
    el.className = 'tl' + (cls ? ' ' + cls : '');
    (target || termContent).appendChild(el);
    return el;
}

export function termText(text, cls, target) {
    const el = termLine(cls, target);
    el.textContent = text;
    return el;
}

export function termGap(target) {
    return termLine('tl-gap', target);
}

export function termRule(target) {
    return termLine('tl-rule', target);
}

export function termClear() {
    if (termContent) termContent.innerHTML = '';
    progressLine = null;
    options = [];
    selIndex = -1;
    endKeyNav();
}

// A blinking block caret parked on its own line, like an idle shell
export function termCaret() {
    const el = termLine();
    const caret = document.createElement('span');
    caret.className = 'caret';
    caret.textContent = '█';
    el.appendChild(caret);
    return el;
}

/**
 * A selectable line carrying an on/off state, printed to the right of the
 * label like a settings row in a TUI.
 *
 * @param state  { on, label } — `label` is already localized by the caller,
 *               since this module deliberately holds no strings
 */
export function termToggle(key, text, state, onClick) {
    const el = termOption(key, text, onClick);
    el.appendChild(document.createElement('span')).className = 'tl-state';
    setToggleState(el, state);
    return el;
}

// Flip a toggle's state box without redrawing anything around it, so changing
// an option doesn't wipe and replay the screen it lives on
export function setToggleState(el, state) {
    const box = el?.querySelector('.tl-state');
    if (!box) return;
    box.className = 'tl-state ' + (state.on ? 'tl-ok' : 'tl-dim');
    box.textContent = '  [' + state.label + ']';
}

export function termOption(key, text, onClick) {
    const el = termLine('tl-option');
    const cursor = document.createElement('span');
    cursor.className = 'tl-cursor';
    cursor.textContent = '> ';
    const keySpan = document.createElement('span');
    keySpan.className = 'tl-key';
    keySpan.textContent = '[' + key + ']';
    el.appendChild(cursor);
    el.appendChild(keySpan);
    el.appendChild(document.createTextNode(' ' + text));
    el.addEventListener('click', onClick);
    // Moving onto a different option hands control back to the mouse
    el.addEventListener('mouseenter', () => {
        if (keyNavAnchor !== el) endKeyNav();
    });
    options.push(el);
    return el;
}

// Draw a screen line by line, aborting if another render started meanwhile
export async function renderLines(lines) {
    const myVersion = ++renderVersion;
    termClear();
    for (const fn of lines) {
        if (renderVersion !== myVersion) return false;
        fn();
        await delay(TERM_DELAY);
    }
    return renderVersion === myVersion;
}

// Invalidate any render currently in flight without drawing anything
export function termInvalidate() {
    renderVersion++;
}

// === Logo accent ===

export function registerLogoCell(cell) {
    logoCells.push(cell);
}

export function setAccent(color) {
    logoCells.forEach((cell) => { cell.style.color = color; });
}

// === Progress ===

export function termStartProgress(text, header) {
    termInvalidate();
    termClear();
    if (header) {
        termText('> ' + header, 'tl-dim');
        termGap();
    }
    const el = termLine();
    const spinnerSpan = document.createElement('span');
    spinnerSpan.textContent = '| ';
    const textSpan = document.createElement('span');
    textSpan.textContent = text;
    const barSpan = document.createElement('span');
    barSpan.className = 'tl-bar';
    el.appendChild(spinnerSpan);
    el.appendChild(textSpan);
    const barLine = termLine('tl-bar');
    barLine.appendChild(barSpan);
    progressLine = { spinner: spinnerSpan, text: textSpan, bar: barSpan };

    let idx = 0;
    clearInterval(spinnerIntervalId);
    spinnerIntervalId = setInterval(() => {
        spinnerSpan.textContent = SPINNER_FRAMES[idx] + ' ';
        idx = (idx + 1) % SPINNER_FRAMES.length;
    }, SPINNER_INTERVAL);
}

// `current`/`total` are optional; when given, an ASCII bar is drawn below
export function termUpdateProgress(text, current, total) {
    if (!progressLine) return;
    if (total > 0) {
        const ratio = Math.max(0, Math.min(1, current / total));
        const filled = Math.round(ratio * BAR_WIDTH);
        progressLine.text.textContent = `${text}  ${current}/${total}`;
        progressLine.bar.textContent =
            '[' + '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled) + '] ' +
            String(Math.round(ratio * 100)).padStart(3) + '%';
    } else {
        progressLine.text.textContent = text;
        progressLine.bar.textContent = '';
    }
}

export function termStopSpinner() {
    clearInterval(spinnerIntervalId);
    spinnerIntervalId = null;
}

// === Warnings ===

// Warnings are shown one at a time; anything queued behind them, including the
// screen that follows, waits until the queue drains
export function termWarn(text) {
    if (warnTimeout) {
        warnQueue.push(text);
        return;
    }
    const el = termText('! ' + text, 'tl-warn');

    warnTimeout = setTimeout(() => {
        el.remove();
        warnTimeout = null;
        const next = warnQueue.shift();
        if (next) {
            termWarn(next);
        } else if (pendingFinish) {
            const fn = pendingFinish;
            pendingFinish = null;
            fn();
        }
    }, WARN_DURATION);
}

export function warnActive() {
    return warnTimeout !== null;
}

// Deferred screen, drawn once the warnings have cleared
export function setPendingFinish(fn) {
    pendingFinish = fn;
}

export function clearWarnings() {
    clearTimeout(warnTimeout);
    warnTimeout = null;
    warnQueue = [];
    pendingFinish = null;
}

// === Option selection ===

// While the keyboard drives the menu, hover highlighting is suppressed so
// the two cursors can't both be lit; it stays that way until the pointer
// actually crosses into another option
export function endKeyNav() {
    keyNavAnchor = null;
    document.body.classList.remove('key-nav');
    if (selIndex >= 0) {
        if (options[selIndex]) options[selIndex].classList.remove('is-sel');
        selIndex = -1;
    }
}

export function moveSelection(delta) {
    if (options.length === 0) return false;
    if (!document.body.classList.contains('key-nav')) {
        // Remember where the pointer was resting when the keyboard took over
        keyNavAnchor = options.find((el) => el.matches(':hover')) || null;
        document.body.classList.add('key-nav');
        // Start from the hovered option, so arrows continue from there
        selIndex = keyNavAnchor ? options.indexOf(keyNavAnchor) : (delta > 0 ? -1 : 0);
    }
    if (options[selIndex]) options[selIndex].classList.remove('is-sel');
    selIndex = (selIndex + delta + options.length) % options.length;
    options[selIndex].classList.add('is-sel');
    return true;
}

// Activate the keyboard-selected option, if any
export function activateSelection() {
    if (selIndex >= 0 && options[selIndex]) {
        options[selIndex].click();
        return true;
    }
    return false;
}
