// pdf/build.js — `sheetFor` and `pointsPerPixel`, the page geometry.
//
// These two are exported so the sample screen can draw the sheet the real page
// will land on, and the 1:1 window beside it at the scale the real page gives.
// That is the contract worth testing: not that they return particular numbers,
// but that the numbers describe a page the builder actually produces. A preview
// that disagrees with the file is worse than no preview — it is a wrong answer
// to the only question the sample screen exists to ask.
//
// So `placement` below re-derives what `createNewPdf` does with these two, and
// the tests assert against that. It is a handful of lines copied out of the
// builder on purpose: it is what makes a change to the placement rule show up
// here as a failure rather than as a preview that quietly drifted.

import './browser-globals.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sheetFor, pointsPerPixel } from '../js/pdf/build.js';
import { PORTRAIT_WIDTH, PORTRAIT_HEIGHT } from '../js/config.js';

const A4 = [PORTRAIT_WIDTH, PORTRAIT_HEIGHT];
const LETTER = [612, 792];

function close(actual, expected, what) {
    const tolerance = 1e-9 * Math.max(1, Math.abs(expected));
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `${what}: expected ${expected}, got ${actual}`,
    );
}

// createNewPdf's own placement, in terms of the two functions under test
function placement(imgWidth, imgHeight, layout) {
    const [pageWidth, pageHeight] = sheetFor(imgWidth, imgHeight, layout);
    const scale = pointsPerPixel(imgWidth, imgHeight, layout);
    const { margin } = layout;
    const width = imgWidth * scale;
    const height = imgHeight * scale;
    return {
        pageWidth,
        pageHeight,
        width,
        height,
        x: margin + (pageWidth - 2 * margin - width) / 2,
        y: margin + (pageHeight - 2 * margin - height) / 2,
    };
}

// Portrait scan, landscape scan, square, and a panorama wide enough that the
// margins bind on the other axis
const IMAGES = [
    ['portrait scan', 1700, 2340],
    ['landscape scan', 2340, 1700],
    ['square', 2000, 2000],
    ['panorama', 4000, 800],
    ['tall strip', 600, 4000],
];

const LAYOUTS = [
    ['a4 auto', { paper: A4, orientation: 'auto', margin: 20 }],
    ['a4 portrait', { paper: A4, orientation: 'portrait', margin: 20 }],
    ['a4 landscape', { paper: A4, orientation: 'landscape', margin: 20 }],
    ['letter auto, no margin', { paper: LETTER, orientation: 'auto', margin: 0 }],
    ['a4 auto, wide margin', { paper: A4, orientation: 'auto', margin: 40 }],
    ['fit', { paper: null, orientation: 'auto', margin: 20 }],
    ['fit, no margin', { paper: null, orientation: 'auto', margin: 0 }],
];

test('the image always lands inside the margins', () => {
    // The invariant behind every other one: whatever the paper and whatever the
    // image, the drawn box fits within the sheet less its margins. Overflowing
    // it is not an error anywhere in the pipeline — pdf-lib draws it, the page
    // saves, and the scan is simply cropped by the edge of the paper.
    for (const [imageName, w, h] of IMAGES) {
        for (const [layoutName, layout] of LAYOUTS) {
            const p = placement(w, h, layout);
            const where = `${imageName} on ${layoutName}`;
            assert.ok(p.x >= layout.margin - 1e-9, `${where}: left edge inside margin`);
            assert.ok(p.y >= layout.margin - 1e-9, `${where}: bottom edge inside margin`);
            assert.ok(
                p.x + p.width <= p.pageWidth - layout.margin + 1e-9,
                `${where}: right edge inside margin`,
            );
            assert.ok(
                p.y + p.height <= p.pageHeight - layout.margin + 1e-9,
                `${where}: top edge inside margin`,
            );
        }
    }
});

test('the image keeps its proportions and is centred', () => {
    // A scan drawn at the wrong aspect is the one output failure a user cannot
    // fix by re-running with different settings
    for (const [imageName, w, h] of IMAGES) {
        for (const [layoutName, layout] of LAYOUTS) {
            const p = placement(w, h, layout);
            const where = `${imageName} on ${layoutName}`;
            close(p.width / p.height, w / h, `${where}: aspect`);
            close(p.x, p.pageWidth - p.x - p.width, `${where}: horizontal centring`);
            close(p.y, p.pageHeight - p.y - p.height, `${where}: vertical centring`);
        }
    }
});

test('the image is as large as the margins allow', () => {
    // The other half of fitting: one axis has to touch, or the page is padded
    // out with white for no reason and the scan is smaller than it needed to be
    for (const [imageName, w, h] of IMAGES) {
        for (const [layoutName, layout] of LAYOUTS) {
            const p = placement(w, h, layout);
            const availableWidth = p.pageWidth - 2 * layout.margin;
            const availableHeight = p.pageHeight - 2 * layout.margin;
            const touches =
                Math.abs(p.width - availableWidth) < 1e-6 ||
                Math.abs(p.height - availableHeight) < 1e-6;
            assert.ok(touches, `${imageName} on ${layoutName}: neither axis is tight`);
        }
    }
});

test('a fixed paper size is the sheet, whatever the image', () => {
    for (const [imageName, w, h] of IMAGES) {
        assert.deepEqual(
            sheetFor(w, h, { paper: A4, orientation: 'portrait', margin: 20 }),
            A4,
            `${imageName}: portrait a4`,
        );
        assert.deepEqual(
            sheetFor(w, h, { paper: A4, orientation: 'landscape', margin: 20 }),
            [PORTRAIT_HEIGHT, PORTRAIT_WIDTH],
            `${imageName}: landscape a4`,
        );
    }
});

test('auto turns the sheet to match the image', () => {
    const layout = { paper: A4, orientation: 'auto', margin: 20 };
    assert.deepEqual(sheetFor(1700, 2340, layout), A4, 'portrait image stays portrait');
    assert.deepEqual(
        sheetFor(2340, 1700, layout),
        [PORTRAIT_HEIGHT, PORTRAIT_WIDTH],
        'landscape image turns the sheet',
    );
    // A square image is not landscape — the rule is a strict comparison, and
    // this is the boundary it turns on
    assert.deepEqual(sheetFor(2000, 2000, layout), A4, 'square image stays portrait');
});

test('fit cuts the page to the image and never pads it', () => {
    // `fit` exists so nothing is padded out with white. That means the content
    // box has to match the image exactly on both axes, not just fit inside it.
    for (const [imageName, w, h] of IMAGES) {
        for (const margin of [0, 20, 40]) {
            const layout = { paper: null, orientation: 'auto', margin };
            const p = placement(w, h, layout);
            const where = `${imageName}, margin ${margin}`;
            close(p.width, p.pageWidth - 2 * margin, `${where}: fills the width`);
            close(p.height, p.pageHeight - 2 * margin, `${where}: fills the height`);
            // The long edge is A4's, so a fitted page is a plausible sheet
            // rather than whatever size the scanner happened to produce
            close(
                Math.max(p.pageWidth, p.pageHeight),
                PORTRAIT_HEIGHT,
                `${where}: long edge matches a4`,
            );
        }
    }
});

test('fit ignores the orientation setting', () => {
    // There is no sheet to turn, so the setting has nothing to decide. If it
    // ever starts mattering here, the sample screen's `affects: 'layout'`
    // repaint is still correct but the note under the option is not.
    for (const [imageName, w, h] of IMAGES) {
        const of = (orientation) => sheetFor(w, h, { paper: null, orientation, margin: 20 });
        assert.deepEqual(of('auto'), of('portrait'), `${imageName}: auto vs portrait`);
        assert.deepEqual(of('auto'), of('landscape'), `${imageName}: auto vs landscape`);
    }
});

test('pointsPerPixel is the scale the 1:1 window is cut to', () => {
    // The sample screen multiplies this by CSS_PX_PER_PT to decide how large one
    // image pixel is drawn. Two properties matter there and neither is obvious:
    const layout = { paper: A4, orientation: 'auto', margin: 20 };

    // more pixels in the same page means each one is smaller, in exact
    // proportion — this is what keeps the crop window still while `max page
    // pixels` moves, so the setting can actually be compared against itself
    const coarse = pointsPerPixel(1000, 1376, layout);
    const fine = pointsPerPixel(2000, 2752, layout);
    close(fine * 2, coarse, 'doubling the pixels halves the point size');

    // and a wider margin leaves less room, so the same image draws smaller
    const wide = pointsPerPixel(1700, 2340, { ...layout, margin: 40 });
    assert.ok(wide < pointsPerPixel(1700, 2340, layout), 'a wider margin shrinks the image');
});
