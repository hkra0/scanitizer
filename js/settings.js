// User settings: page geometry, image compression and text layer.
//
// Every setting is a short list of values the user cycles through with the
// left/right arrows, so a plain on/off option is just a two-value list and
// needs no separate handling. The value each list starts on is what the app
// used before there were settings at all, so an untouched install behaves
// exactly as it did.
//
// Choices live in localStorage and are read at build time, which means they
// apply to the next file processed rather than to one already on screen.

import { t } from './i18n.js';
import {
    PORTRAIT_WIDTH,
    PORTRAIT_HEIGHT,
    PAGE_MARGIN,
    MAX_PIXEL_WIDTH,
    MAX_PIXEL_HEIGHT,
    JPEG_QUALITY,
} from './config.js';

const STORAGE_KEY = 'scanitizer.settings';

/**
 * The settings panel, in display order.
 *
 * `def` names the value a fresh install starts on; `value` is the payload the
 * rest of the app consumes, `label` is what the terminal prints, and the
 * optional `note` is a caveat printed under the row.
 *
 * `affects` says which half of the pipeline a setting reaches, which is what
 * the sample screen redraws itself from:
 *
 *   'image'   read by `rasterize` — changing it means encoding the page again
 *   'layout'  read by `sheetFor` — the pixels are unchanged and only the sheet
 *             around them moves, so the sample repaints without re-encoding
 *   'note'    the page is untouched and only what the screen says about the run
 *             changes, so the note under the sample is rewritten and no more
 *   null      nothing the sample can show
 *
 * It is recorded here rather than worked out at the call site because this is
 * where the answer is a fact about the setting; anywhere else it is a guess
 * that goes stale the first time a setting moves.
 */
export const SETTINGS = [
    {
        id: 'paper',
        label: t.setPaper,
        affects: 'layout',
        def: 'a4',
        values: [
            { id: 'a4', label: 'a4', value: [PORTRAIT_WIDTH, PORTRAIT_HEIGHT] },
            { id: 'letter', label: 'letter', value: [612, 792] },
            { id: 'legal', label: 'legal', value: [612, 1008] },
            { id: 'a3', label: 'a3', value: [842, 1191] },
            { id: 'a5', label: 'a5', value: [420, 595] },
            // No fixed sheet: the page is cut to the image's own proportions
            { id: 'fit', label: t.optFit, value: null },
        ],
    },
    {
        id: 'orientation',
        label: t.setOrientation,
        affects: 'layout',
        def: 'auto',
        values: [
            { id: 'auto', label: t.optAuto, value: 'auto' },
            { id: 'portrait', label: t.optPortrait, value: 'portrait' },
            { id: 'landscape', label: t.optLandscape, value: 'landscape' },
        ],
    },
    {
        id: 'margin',
        label: t.setMargin,
        affects: 'layout',
        def: String(PAGE_MARGIN),
        values: [0, 10, PAGE_MARGIN, 30, 40].map((pt) => ({
            id: String(pt),
            label: pt + ' pt',
            value: pt,
        })),
    },
    {
        // Named after the encoder's own knob, so the note carries what moving
        // it actually does to the file that comes out
        id: 'quality',
        label: t.setQuality,
        note: t.setQualityNote,
        affects: 'image',
        def: String(JPEG_QUALITY),
        values: [0.5, JPEG_QUALITY, 0.85, 0.95].map((q) => ({
            id: String(q),
            label: Math.round(q * 100) + '%',
            value: q,
        })),
    },
    {
        // Pixel budget per page, labelled by the long edge. Bigger keeps more
        // detail and costs proportionally more bytes.
        id: 'imageSize',
        label: t.setImageSize,
        note: t.setImageSizeNote,
        affects: 'image',
        def: String(MAX_PIXEL_HEIGHT),
        values: [
            [1240, 1754],
            [1654, 2339],
            [MAX_PIXEL_WIDTH, MAX_PIXEL_HEIGHT],
            [2480, 3508],
        ].map(([w, h]) => ({ id: String(h), label: h + ' px', value: [w, h] })),
    },
    {
        // Off by default: the recovered text comes straight from the source
        // and, unlike the images, has not been through the cleanup
        id: 'keepText',
        label: t.keepText,
        note: t.keepTextNote,
        // An invisible layer drawn behind the pixels: nothing a sample of the
        // page could show, whichever way it is set
        affects: null,
        def: 'off',
        values: [
            { id: 'off', label: t.off, value: false },
            { id: 'on', label: t.on, value: true },
        ],
    },
    {
        // On by default: a page that had no scan on it is still the document,
        // and an output with fewer pages than the input reads as a failure
        // even when the fewer pages are the point of the tool. Off is for the
        // file whose non-scan pages are inserts or covers — a reader, a
        // separator — where the run is asked to ship the scans alone.
        id: 'keepNonScans',
        label: t.keepNonScans,
        note: t.keepNonScansNote,
        // It changes what happens to whole pages, which the sample screen can
        // say but cannot show — a non-scan page has no image to preview
        affects: 'note',
        def: 'on',
        values: [
            { id: 'on', label: t.on, value: true },
            { id: 'off', label: t.off, value: false },
        ],
    },
    {
        // On by default: taking the marks off is what the tool is for, and this
        // is the only path on which a mark can survive at all — a rebuilt page
        // has already lost every annotation it had. Off is here for the file
        // whose annotations are the point, where a highlight is the reader's own
        // work rather than something stamped on top of it.
        id: 'removeMarks',
        label: t.setMarks,
        note: t.setMarksNote,
        // It applies to the pages a document keeps as they are — a document
        // with no page image, or the non-scan pages of a mixed one — so there
        // is no rebuilt page for it to change, only the lines the screens say
        // about the run
        affects: 'note',
        def: 'on',
        values: [
            { id: 'on', label: t.on, value: true },
            { id: 'off', label: t.off, value: false },
        ],
    },
];

// { settingId: valueId }, one entry per setting, always a valid id
const chosen = load();

function load() {
    let stored = null;
    try {
        stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch {
        // Unreadable or unavailable storage is not worth reporting: the
        // defaults below are a perfectly good answer
    }
    const out = {};
    for (const setting of SETTINGS) {
        const saved = stored?.[setting.id];
        const known = setting.values.some((v) => v.id === saved);
        out[setting.id] = known ? saved : setting.def;
    }
    return out;
}

function save() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(chosen));
    } catch {
        // Storage full or blocked (private mode, cookies off) — the choice
        // still applies to this session, it just won't survive a reload
    }
}

export function currentValue(setting) {
    return setting.values.find((v) => v.id === chosen[setting.id]) || setting.values[0];
}

// Step to the neighbouring value, wrapping at both ends
export function cycle(setting, delta) {
    const index = setting.values.indexOf(currentValue(setting));
    const next = setting.values[
        (index + delta + setting.values.length) % setting.values.length
    ];
    chosen[setting.id] = next.id;
    save();
    return next;
}

function valueOf(id) {
    return currentValue(SETTINGS.find((s) => s.id === id)).value;
}

// === Consumers ===

/** `paper` is null when the page follows the image instead of a sheet size. */
export function pageLayout() {
    return {
        paper: valueOf('paper'),
        orientation: valueOf('orientation'),
        margin: valueOf('margin'),
    };
}

/** Whether the source text should be re-drawn on top of the page images. */
export function keepText() {
    return valueOf('keepText');
}

/**
 * Whether the non-scan pages of a rebuilt document travel into the output.
 *
 * Off means the run deliberately produces fewer pages than the input, which
 * is a decision the screens have to name — never a silent difference.
 */
export function keepNonScans() {
    return valueOf('keepNonScans');
}

/**
 * Whether a document that is not a scan should have its annotations and
 * watermark-marked content taken out as well as its metadata.
 */
export function removeMarks() {
    return valueOf('removeMarks');
}

export function rasterLimits() {
    const [maxWidth, maxHeight] = valueOf('imageSize');
    return { maxWidth, maxHeight, quality: valueOf('quality') };
}
