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

let selEl = null;        // keyboard selection, null when the mouse is in charge
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

// A line whose arrival is worth announcing to a screen reader. Nothing about it
// looks different — `role="status"` only means the text is read out when it is
// printed, which is what a sighted user gets for free by watching the screen.
export function termStatus(text, cls, target) {
    const el = termText(text, cls, target);
    el.setAttribute('role', 'status');
    return el;
}

export function termGap(target) {
    return termLine('tl-gap', target);
}

export function termRule(target) {
    return termLine('tl-rule', target);
}

// A container for lines that come and go on their own, without redrawing the
// screen around them — the settings panel folding open and shut
export function termBlock(target) {
    const el = document.createElement('div');
    (target || termContent).appendChild(el);
    return el;
}

export function termClear() {
    if (termContent) termContent.innerHTML = '';
    progressLine = null;
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
 * A selectable line carrying a state box, printed hard right of the label like
 * a settings row in a TUI.
 *
 * @param state  { label, cls, wrap } — `label` is already localized by the
 *               caller, since this module deliberately holds no strings
 */
export function termToggle(key, text, state, onClick, target) {
    const el = termOption(key, text, onClick, target);
    el.classList.add('tl-row');
    setToggleState(el, state);
    return el;
}

/**
 * A row whose value is stepped rather than clicked through blindly: the
 * left/right arrows call `onAdjust` with -1/+1, and a click is simply a step
 * forward. Two-value lists cover what used to be a toggle, so on/off options
 * and multi-value ones behave the same way.
 */
export function termChoice(key, text, state, onAdjust, target) {
    const el = termToggle(key, text, state, () => onAdjust(1), target);
    // Keyless rows are sub-items of the option above them; keyed ones line up
    // with their siblings
    if (!key) el.classList.add('tl-sub');
    el._adjust = onAdjust;
    return el;
}

// Let a plain option answer to the arrows too — the settings header folds open
// on right and shut on left
export function setAdjust(el, fn) {
    if (el) el._adjust = fn;
}

// Repaint a row's state box without redrawing anything around it, so changing
// an option doesn't wipe and replay the screen it lives on
export function setToggleState(el, state) {
    if (!el) return;
    let box = el.querySelector('.tl-state');
    if (!box) {
        box = document.createElement('span');
        el.appendChild(box);
    }
    const [open, close] = state.wrap || ['[', ']'];
    box.className = 'tl-state ' + (state.cls || '');
    box.textContent = open + state.label + close;
    // The row reads as "label: value" rather than as the bracketed glyphs it is
    // drawn with, and the name follows the value as it is stepped
    if (el._ariaBase) el.setAttribute('aria-label', el._ariaBase + ': ' + state.label);
}

// `key` may be null for rows the arrows reach but no shortcut names
export function termOption(key, text, onClick, target) {
    const el = termLine('tl-option', target);
    // A real focus stop: the arrow-key cursor below is a convenience on top of
    // this, not a replacement for it, so Tab and a screen reader reach every
    // option the mouse can
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    const cursor = document.createElement('span');
    cursor.className = 'tl-cursor';
    cursor.textContent = '> ';
    // Decoration: it marks the selected row visually and would otherwise be
    // read out as punctuation on every option
    cursor.setAttribute('aria-hidden', 'true');
    el.appendChild(cursor);
    if (key) {
        const keySpan = document.createElement('span');
        keySpan.className = 'tl-key';
        keySpan.textContent = '[' + key + ']';
        el.appendChild(keySpan);
    }
    el.appendChild(document.createTextNode(key ? ' ' + text : text));
    el._ariaBase = text;
    el.addEventListener('click', onClick);
    // Moving onto a different option hands control back to the mouse
    el.addEventListener('mouseenter', () => {
        if (keyNavAnchor !== el) endKeyNav();
    });
    // Tabbing in lights the same cursor the arrows drive, so there is only ever
    // one selected row. A click focuses too, but not *visibly* — that stays the
    // mouse's hover highlight.
    el.addEventListener('focus', () => {
        if (el.matches(':focus-visible')) markSelected(el);
    });
    el.addEventListener('blur', () => {
        if (selEl === el) endKeyNav();
    });
    return el;
}

/**
 * A prompt that is typed into, drawn as one more terminal line.
 *
 * A real `<input>` rather than a line that collects keystrokes: paste, IME
 * composition, a phone's own keyboard and the browser's masking all come with
 * the element, and none of them can be re-created by catching keydowns. It is
 * stripped of its own styling instead, so it inherits the cell — what makes it
 * look like a terminal line is that it is one.
 *
 * The label wraps the input, which is what names it for a screen reader; there
 * is no id to collide with anything the rest of the screen prints.
 *
 * @param options  { type, onSubmit } — submitting is the form's own Enter, so
 *                 the on-screen keyboard offers Go and nothing has to listen
 *                 for a key. Cancelling belongs to the screen, not the field.
 * @returns  the input, for the caller to focus and to read back
 */
export function termInput(label, { type = 'text', onSubmit }, target) {
    const form = document.createElement('form');
    form.className = 'tl tl-input-line';
    const wrap = document.createElement('label');
    wrap.className = 'tl-input-label';
    wrap.appendChild(document.createTextNode(label));

    const input = document.createElement('input');
    input.type = type;
    input.className = 'tl-input';
    // A document's own password is not a credential for this site, so nothing
    // should offer to remember it
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    wrap.appendChild(input);
    form.appendChild(wrap);

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        // An empty prompt is not an answer: leave the field where it is rather
        // than spending a decryption attempt on nothing
        if (input.value) onSubmit(input.value);
    });

    (target || termContent).appendChild(form);
    return input;
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
    // A progress bar rather than a live region: a page-by-page count would
    // announce a few hundred times on a long scan, whereas a progressbar is
    // reported when the reader is asked for it. The drawn bar is decoration —
    // aria-valuetext carries the same thing as words.
    el.setAttribute('role', 'progressbar');
    el.setAttribute('aria-valuemin', '0');
    el.setAttribute('aria-valuemax', '100');
    el.setAttribute('aria-valuetext', text);
    barSpan.setAttribute('aria-hidden', 'true');
    spinnerSpan.setAttribute('aria-hidden', 'true');
    progressLine = { line: el, spinner: spinnerSpan, text: textSpan, bar: barSpan };

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
        progressLine.line.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
        progressLine.line.setAttribute('aria-valuetext', `${text} ${current}/${total}`);
    } else {
        progressLine.text.textContent = text;
        progressLine.bar.textContent = '';
        progressLine.line.removeAttribute('aria-valuenow');
        progressLine.line.setAttribute('aria-valuetext', text);
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
    // Read out on arrival: it is on screen for two seconds, which is not long
    // enough to be discovered by browsing the page
    el.setAttribute('role', 'alert');

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

// The selectable lines of the current screen, in the order they are printed.
// Read from the DOM rather than kept in a list, so rows the settings panel adds
// and removes are picked up without any bookkeeping.
function optionEls() {
    return termContent ? Array.from(termContent.querySelectorAll('.tl-option')) : [];
}

// While the keyboard drives the menu, hover highlighting is suppressed so
// the two cursors can't both be lit; it stays that way until the pointer
// actually crosses into another option
export function endKeyNav() {
    keyNavAnchor = null;
    document.body.classList.remove('key-nav');
    const was = selEl;
    selEl?.classList.remove('is-sel');
    selEl = null;
    // Escape gives the row up entirely, focus included, so Tab resumes from the
    // top rather than from a row that no longer looks selected
    if (was && document.activeElement === was) was.blur();
}

// The one place the selected row is recorded. Focus and the drawn cursor are
// the same state seen two ways, so they are always set together.
function markSelected(el) {
    if (selEl === el) return;
    selEl?.classList.remove('is-sel');
    selEl = el;
    el.classList.add('is-sel');
    document.body.classList.add('key-nav');
    if (document.activeElement !== el) el.focus({ preventScroll: true });
}

export function moveSelection(delta) {
    const list = optionEls();
    if (list.length === 0) return false;
    if (!document.body.classList.contains('key-nav')) {
        // Remember where the pointer was resting when the keyboard took over
        keyNavAnchor = list.find((el) => el.matches(':hover')) || null;
        document.body.classList.add('key-nav');
        // Start from the hovered option, so arrows continue from there
        selEl = keyNavAnchor;
    }
    // A missing selection — first keypress, or a row that folded away — starts
    // just outside the list so the first step lands on either end
    let index = selEl ? list.indexOf(selEl) : -1;
    if (index < 0) index = delta > 0 ? -1 : 0;
    markSelected(list[(index + delta + list.length) % list.length]);
    return true;
}

// The row the arrows and Enter act on: the keyboard's, or whatever the pointer
// is resting on when the keyboard hasn't taken over
function activeOption() {
    if (selEl) return selEl;
    return optionEls().find((el) => el.matches(':hover')) || null;
}

// Activate the keyboard-selected option, if any
export function activateSelection() {
    if (selEl) {
        selEl.click();
        return true;
    }
    return false;
}

// Step the active row's value. Rows without one leave the arrows unhandled, so
// the browser keeps its usual horizontal scrolling.
export function adjustSelection(delta) {
    const el = activeOption();
    if (!el?._adjust) return false;
    el._adjust(delta);
    return true;
}
