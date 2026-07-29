// User settings: text layer, page geometry and image compression.
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
 */
export const SETTINGS = [
    {
        // Off by default: the recovered text comes straight from the source
        // and, unlike the images, has not been through the cleanup
        id: 'keepText',
        label: t.keepText,
        note: t.keepTextNote,
        def: 'off',
        values: [
            { id: 'off', label: t.off, value: false },
            { id: 'on', label: t.on, value: true },
        ],
    },
    {
        id: 'paper',
        label: t.setPaper,
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
        def: String(MAX_PIXEL_HEIGHT),
        values: [
            [1240, 1754],
            [1654, 2339],
            [MAX_PIXEL_WIDTH, MAX_PIXEL_HEIGHT],
            [2480, 3508],
        ].map(([w, h]) => ({ id: String(h), label: h + ' px', value: [w, h] })),
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

export function rasterLimits() {
    const [maxWidth, maxHeight] = valueOf('imageSize');
    return { maxWidth, maxHeight, quality: valueOf('quality') };
}
