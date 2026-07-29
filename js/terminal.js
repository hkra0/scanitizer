// The terminal: every DOM write goes through here. Screens describe what to
// print, this module owns the elements, the spinner, the warning queue and the
// keyboard/mouse selection state.

import {
    TERM_DELAY,
    BAR_WIDTH,
    SPINNER_FRAMES,
    SPINNER_INTERVAL,
    SCROLL_SLACK,
    SCROLL_REVEAL_MARGIN,
} from './config.js';

let termRoot = null;     // whole terminal, including the boot header
let termContent = null;  // dynamic area, redrawn per stage
let logoCells = [];      // the 'c' glyph rows of the logo, filled during boot

let spinnerIntervalId = null;
let progressLine = null;

// Bumped by every screen change so a slow line-by-line render can tell that it
// has been superseded and bail out
let renderVersion = 0;

let selEl = null;        // keyboard selection, null when the mouse is in charge
let keyNavAnchor = null; // option the pointer rested on when keys took over

export function delay(ms) {
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

// === Following the output ===
//
// The terminal follows its own printing the way a real one does: pinned to the
// last line while output arrives, and released the moment the user scrolls up
// to read something that has gone past. Scrolling back to the end re-attaches.
//
// The jump is deliberately instant. A terminal's viewport moves a row at a time
// rather than gliding, and a smooth scroll would in any case be animating
// towards a target the next line has already moved.

// Whether the end of the output is still in view. Measured against the document
// each time rather than tracked in a flag updated from `scroll` events: the
// scroll position is already the state, and a cached copy of it is one more
// thing that can be wrong — it goes stale for any scroll that arrives without
// an event, which is the same reason `optionEls` reads its rows from the DOM.
function atEnd() {
    const doc = document.documentElement;
    return doc.scrollHeight - window.scrollY - window.innerHeight <= SCROLL_SLACK;
}

/**
 * Run a DOM write, and follow it only if the view was following already.
 *
 * The question has to be asked *before* the content lands. Once the line is in
 * the document the page is taller than the viewport by exactly that line, so
 * "am I at the end" would answer no every time and the terminal would never
 * follow anything.
 *
 * Nesting is fine and is what the composite printers rely on: an inner call
 * that scrolls to the end leaves the outer one still at the end, so setting a
 * line's text after appending it follows the text too — and if the user is
 * scrolled up, every layer answers no and nothing moves.
 */
function printing(write) {
    const follow = atEnd();
    const result = write();
    if (follow) {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
    }
    return result;
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
// Every printed line lands here, so this is where following starts
export function termLine(cls, target) {
    return printing(() => {
        const el = document.createElement('div');
        el.className = 'tl' + (cls ? ' ' + cls : '');
        (target || termContent).appendChild(el);
        return el;
    });
}

export function termText(text, cls, target) {
    const el = termLine(cls, target);
    // Followed again now the line has its text: one long enough to wrap is
    // taller than the empty line `termLine` measured
    return printing(() => {
        el.textContent = text;
        return el;
    });
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
    return printing(() => {
        const el = document.createElement('div');
        (target || termContent).appendChild(el);
        return el;
    });
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
 * A row whose value is stepped rather than clicked through blindly: the
 * left/right arrows call `onAdjust` with -1/+1, and a click on the row is
 * simply a step forward. Two-value lists cover what used to be a toggle, so
 * on/off options and multi-value ones behave the same way.
 *
 * `state` is { label, cls, wrap } — `label` is already localized by the caller,
 * since this module deliberately holds no strings.
 */
export function termChoice(key, text, state, onAdjust, target) {
    const el = termOption(key, text, () => onAdjust(1), target);
    el.classList.add('tl-row');
    // Both set before the box is painted: `setToggleState` turns the wrapping
    // glyphs into targets only for rows that have something to step, and it can
    // only know that if it can already see how to step them
    el.classList.add('tl-choice');
    el._adjust = onAdjust;
    // Keyless rows are sub-items of the option above them; keyed ones line up
    // with their siblings
    if (!key) el.classList.add('tl-sub');
    setToggleState(el, state);
    return el;
}

/**
 * One of the wrapping glyphs of a stepped row, made into a target of its own.
 *
 * `< value >` has always been drawn as though the arrows were things you could
 * press, while the only way to act on them was the arrow keys or a click
 * anywhere on the row — which can only ever step *forward*. On a touch screen
 * that left no way back at all: a value could only be cycled all the way round.
 * Now the glyph does what it has been claiming to do.
 *
 * Hidden from assistive tech: these duplicate what the row and the arrow keys
 * already offer, and the row carries an aria-label of its own, so exposing them
 * would add two unnamed targets per setting and read the punctuation out loud.
 */
function stepper(glyph, row, delta) {
    const el = document.createElement('span');
    el.className = 'tl-step';
    el.textContent = glyph;
    el.setAttribute('aria-hidden', 'true');
    el.addEventListener('click', (e) => {
        // The row's own click steps forward. Without this, a tap on `<` would
        // step back and then immediately forward again, and nothing would move.
        e.stopPropagation();
        row._adjust(delta);
    });
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
    box.textContent = '';

    if (el.classList.contains('tl-choice')) {
        // A stepped row: the glyphs around the value are the two directions it
        // can be stepped in, so they are drawn as the targets they look like
        box.appendChild(stepper(open, el, -1));
        box.appendChild(document.createTextNode(state.label));
        box.appendChild(stepper(close, el, 1));
    } else {
        // Everything else — the fold marker, the file name — is a label, and a
        // label's brackets are punctuation
        box.textContent = open + state.label + close;
    }

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
    printing(() => el.appendChild(document.createTextNode(key ? ' ' + text : text)));
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
 * The page figure: the whole page on its sheet, and a 1:1 window into it.
 *
 * The one place the terminal shows a picture instead of describing one, and the
 * one place the grid is broken on purpose. Everything else drawn here — the
 * logo, tinyko — is snapped to `--px`, but this is a photograph of the user's
 * own document, and the question it exists to answer is whether the compression
 * ruined it. Styling that away would be answering it with the wrong picture.
 *
 * The two halves answer two different questions, which is why there are two:
 *
 *   the sheet   what the page looks like and how it sits on the paper. The
 *               proportions and the padding arrive as ratios, worked out in
 *               points by the same function that lays the real page out, so
 *               nothing here knows what A4 is.
 *   the detail  whether the pixels survived. It has to be 1:1 and it has to be
 *               a crop: the sheet shows the page at about a twelfth of its
 *               size, and at a twelfth of its size a JPEG block is two thirds
 *               of one screen pixel — every compression artefact there is to
 *               judge has been averaged away by the act of shrinking it. The
 *               thumbnail never showed quality; it only looked as though it
 *               might.
 *
 * Side by side rather than behind a click: the space to the right of a page is
 * empty anyway, and a judgement that needs two views should not need an
 * interaction to reach the second one. There is no link out to a full-size
 * image — that was the one control on this screen that left the app, and what
 * it opened was the whole page scaled to fit a window, which is the one thing
 * that cannot answer the question either.
 *
 * Created empty and filled afterwards: the settings under it change what
 * belongs in it, and redrawing the row each time would take the option cursor
 * and the scroll position with it.
 */
export function termPage(target) {
    const el = termLine('tl-figure', target);

    const sheet = document.createElement('div');
    sheet.className = 'tl-page';

    // Sized exactly to the picture inside the sheet's margins, so the marker
    // that says where the detail was cut from can be placed in per cent of the
    // image rather than of the paper around it
    const frame = document.createElement('div');
    frame.className = 'tl-page-frame';
    const img = document.createElement('img');
    img.className = 'tl-page-img';
    frame.appendChild(img);
    const mark = document.createElement('div');
    mark.className = 'tl-crop-mark';
    frame.appendChild(mark);
    sheet.appendChild(frame);

    // What the sheet says while it has no picture — rendering, or why there
    // isn't one. On the sheet rather than under it, so an empty page reads as
    // an empty page rather than as a missing row.
    const note = document.createElement('span');
    note.className = 'tl-page-note';
    sheet.appendChild(note);

    const detail = document.createElement('div');
    detail.className = 'tl-detail';
    const canvas = document.createElement('canvas');
    canvas.className = 'tl-detail-canvas';
    detail.appendChild(canvas);

    el._parts = { sheet, frame, img, mark, note, detail, canvas };

    // The detail is cut to whatever width the row leaves it, so it is redrawn
    // when that changes — a window resize, and also a paper size, which moves
    // the sheet's height and with it the row's
    if (typeof ResizeObserver === 'function') {
        const observer = new ResizeObserver(() => drawDetail(el));
        observer.observe(detail);
    }
    // The picture is decoded asynchronously, so the crop is cut when there is
    // something to cut it from rather than when the src is assigned
    img.addEventListener('load', () => drawDetail(el));

    printing(() => {
        el.appendChild(sheet);
        el.appendChild(detail);
    });
    return el;
}

/**
 * Cut the centre of the page into the space beside it, at 100%.
 *
 * 100% of the *page*, not of the image — the thing being judged is the PDF, and
 * what a viewer shows when nothing is zoomed is the page at 1 point to 4/3 CSS
 * pixels however many image pixels went into it. `zoom` carries that: the CSS
 * size one image pixel comes out at, from the same function that places the
 * image on the real page.
 *
 * Getting this from the image instead was a bug with a tell: `max page pixels`
 * changed how much of the page the window covered. More pixels in the page meant
 * fewer of them fit beside it, so raising the budget silently zoomed in — the
 * one setting whose whole effect is resolution was the one setting the window
 * could not be used to compare, because it moved the frame every time it moved
 * the pixels. Cut to the page, the frame holds still and the budget does what it
 * actually does: the same piece of page, more or less finely resolved.
 *
 * Smoothed rather than nearest-neighbour, for the same reason. At most budgets a
 * page carries more pixels than 100% has room for, so this is usually a
 * reduction, and a viewer reduces it by resampling. Nearest would be showing
 * aliasing the file does not have.
 *
 * The window is as large as the row leaves it, so a wider terminal is more of
 * the page rather than a bigger picture of the same amount. A page that fits
 * whole is shown whole and centred.
 */
function drawDetail(el) {
    const { img, mark, detail, canvas } = el._parts;
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    if (!width || !height || img.hidden || !detail.clientWidth) {
        mark.hidden = true;
        return;
    }
    const zoom = el._zoom || 1;

    // How much of the image reaches the box once each of its pixels is drawn at
    // the size the page gives it
    const cropWidth = Math.min(width, Math.round(detail.clientWidth / zoom));
    const cropHeight = Math.min(height, Math.round(detail.clientHeight / zoom));
    const left = Math.round((width - cropWidth) / 2);
    const top = Math.round((height - cropHeight) / 2);

    const ratio = window.devicePixelRatio || 1;
    const shownWidth = Math.round(cropWidth * zoom);
    const shownHeight = Math.round(cropHeight * zoom);
    canvas.width = Math.round(shownWidth * ratio);
    canvas.height = Math.round(shownHeight * ratio);
    canvas.style.width = shownWidth + 'px';
    canvas.style.height = shownHeight + 'px';

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, left, top, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);

    // Where it came from, drawn on the page it came from. Two pictures of the
    // same thing side by side otherwise read as one picture shown twice.
    mark.hidden = cropWidth === width && cropHeight === height;
    mark.style.left = (left / width * 100) + '%';
    mark.style.top = (top / height * 100) + '%';
    mark.style.width = (cropWidth / width * 100) + '%';
    mark.style.height = (cropHeight / height * 100) + '%';
}

/**
 * @param geometry  { sheet: [w, h], margin } in points, straight from
 *                  `sheetFor` and the margin setting, plus `zoom` — the CSS
 *                  pixels one image pixel occupies when the page is shown at
 *                  100%, which is what the detail beside it is cut to
 */
export function setPageGeometry(el, geometry) {
    if (!el || !geometry) return;
    const [width, height] = geometry.sheet;
    if (!(width > 0 && height > 0)) return;
    const { sheet } = el._parts;
    el._zoom = geometry.zoom > 0 ? geometry.zoom : 1;
    printing(() => {
        sheet.style.setProperty('--page-aspect', `${width} / ${height}`);
        // A fraction of the sheet's own width rather than a percentage: a
        // percentage padding resolves against the *containing block*, which
        // here is the full terminal width and has nothing to do with the sheet
        sheet.style.setProperty('--page-margin', String(geometry.margin / width));
    });
    // The zoom moved with the geometry, so the window beside it has to be recut.
    // Not left to the resize observer: a margin step changes how large the image
    // is drawn without changing the size of anything on screen, so there is no
    // resize to observe and the crop would keep a scale the page no longer has.
    drawDetail(el);
}

/**
 * `url` absent leaves the sheet blank and shows `note` on it instead.
 *
 * @param aspect  width/height of the picture, so the frame is the right shape
 *                before the picture has decoded and the detail beside it does
 *                not jump when it does
 */
export function setPageImage(el, { url, alt, aspect, note } = {}) {
    if (!el) return;
    const { frame, img, note: noteEl, detail } = el._parts;
    printing(() => {
        if (url) {
            img.src = url;
            img.alt = alt || '';
            img.hidden = false;
            if (aspect) frame.style.aspectRatio = String(aspect);
        } else {
            img.removeAttribute('src');
            img.hidden = true;
        }
        frame.hidden = !url;
        // Nothing to cut a crop from, so the row is the sheet alone rather than
        // the sheet next to an empty box
        detail.hidden = !url;
        noteEl.textContent = url ? '' : (note || '');
        drawDetail(el);
    });
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

    printing(() => (target || termContent).appendChild(form));
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

/**
 * `current`/`total` are optional; when given, an ASCII bar is drawn below.
 *
 * `eta` is a ready-to-print figure or null, localized by the caller like every
 * other string that reaches this module. It rides on the bar line rather than
 * the label line, next to the percentage — the two answer the same question,
 * and it is where anything that draws a progress bar has always put it.
 */
export function termUpdateProgress(text, current, total, eta) {
    if (!progressLine) return;
    if (total > 0) {
        const ratio = Math.max(0, Math.min(1, current / total));
        const filled = Math.round(ratio * BAR_WIDTH);
        progressLine.text.textContent = `${text}  ${current}/${total}`;
        progressLine.bar.textContent =
            '[' + '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled) + '] ' +
            String(Math.round(ratio * 100)).padStart(3) + '%' +
            (eta ? '  ' + eta : '');
        progressLine.line.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
        // The estimate is worth having when the bar is asked for out loud too
        progressLine.line.setAttribute(
            'aria-valuetext',
            `${text} ${current}/${total}${eta ? ', ' + eta : ''}`,
        );
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

/**
 * Bring a row into view when the cursor has stepped past an edge of the window.
 *
 * Minimal movement: the row is brought just inside whichever edge it went past
 * rather than centred, so walking a list scrolls a row at a time the way a
 * terminal's viewport does. Instant, for the same reason printing is — the
 * cursor is somewhere the moment the key is pressed, not a fifth of a second
 * later.
 *
 * This is why the focus call below passes `preventScroll`: the browser's own
 * scroll-into-view centres the element and may animate, so the terminal does
 * its own rather than letting focus move the page out from under it.
 */
function revealSelection(el) {
    const rect = el.getBoundingClientRect();
    let delta = 0;
    if (rect.top < SCROLL_REVEAL_MARGIN) {
        delta = rect.top - SCROLL_REVEAL_MARGIN;
    } else if (rect.bottom > window.innerHeight - SCROLL_REVEAL_MARGIN) {
        delta = rect.bottom - window.innerHeight + SCROLL_REVEAL_MARGIN;
    }
    if (delta) window.scrollBy({ top: delta, behavior: 'instant' });
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
    revealSelection(el);
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
