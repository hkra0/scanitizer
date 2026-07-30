// pdf/preflight.js — the two judgements made from the object dictionaries alone,
// before pdf.js is asked to decode anything.
//
// Both of them can be wrong quietly. A document wrongly ruled out is handed back
// with only its metadata touched and no explanation, which is the failure this
// whole file exists to make rarer rather than more likely — so the tests are
// mostly about what must *not* be ruled out. And a survey that mistook a scan for
// a repeated image would demote the scan on every page of the document at once.
//
// `surveyPages` and `surveyDocument` are not here: they are pdf-lib walking a
// real file, and what they produce is the plain data below. The walk is exercised
// by running a document through `extractImages`.

import './browser-globals.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { noScanPossible, repeatedImageSizes } from '../js/pdf/preflight.js';

// The survey's own shape. `image` is a page holding one image, `bare` a page
// holding none, `opaque` a page whose contents could not be established.
const image = (ref, width = 2480, height = 3508) => ({
    images: [{ ref, width, height }], opaque: false,
});
const bare = () => ({ images: [], opaque: false });
const opaque = () => ({ images: [], opaque: true });

const pages = (n, make) => Array.from({ length: n }, (unused, i) => make(i));

test('a document with an image on every page is not ruled out', () => {
    assert.equal(noScanPossible(pages(10, (i) => image(`${i} 0 R`)), 4), false);
});

test('a document with no images anywhere is ruled out', () => {
    // The case worth the whole file: a PDF of typeset text, where the answer is
    // in the dictionaries and pdf.js would have charged a second a page for it
    assert.equal(noScanPossible(pages(10, bare), 4), true);
});

test('a scan with a few text-only pages among it is not ruled out', () => {
    // The tolerance is the extractor's own, and has to be spent the same way: a
    // scan with a typeset cover, a divider and a colophon is still a scan
    const mixed = [bare(), ...pages(10, (i) => image(`${i} 0 R`)), bare(), bare()];
    assert.equal(noScanPossible(mixed, 4), false);
});

test('a page whose contents could not be established is never held against it', () => {
    // `opaque` is "this cannot say", not "there is no scan here" — a page whose
    // resources would not read, or whose images sit inside a form XObject this
    // does not follow. Counting those as evidence would rule out documents on the
    // strength of not having understood them.
    assert.equal(noScanPossible(pages(10, opaque), 4), false);
    assert.equal(noScanPossible([...pages(8, opaque), bare(), bare()], 4), false);
});

test('the verdict is reached at the same count the extractor uses', () => {
    // Off by one here and the two disagree about the same document
    assert.equal(noScanPossible(pages(3, bare), 3), true, 'at the threshold');
    assert.equal(noScanPossible(pages(2, bare), 3), false, 'one short of it');
});

test('an image on several pages is reported by size', () => {
    // What a watermark, a letterhead or a stamp is: one object, many pages
    const stamp = { images: [{ ref: '7 0 R', width: 80, height: 40 }], opaque: false };
    const sizes = repeatedImageSizes([stamp, stamp, stamp]);
    assert.deepEqual([...sizes], ['80x40']);
});

test('a scan is not reported, however many pages have the same size of image', () => {
    // The trap: one scanner makes one size, so every page of a scan holds an image
    // of identical dimensions. Counting sizes rather than objects would mark every
    // page's own scan as repeated and demote all of them at once.
    const scan = pages(20, (i) => image(`${i} 0 R`));
    assert.equal(repeatedImageSizes(scan).size, 0);
});

test('a scan under a watermark reports the watermark alone', () => {
    // Both on every page, and only one of them is the same object each time
    const stamp = { ref: '99 0 R', width: 80, height: 40 };
    const document = pages(20, (i) => ({
        images: [{ ref: `${i} 0 R`, width: 2480, height: 3508 }, stamp],
        opaque: false,
    }));
    assert.deepEqual([...repeatedImageSizes(document)], ['80x40']);
});

test('an image painted twice on one page is not repeated across pages', () => {
    // Repetition means several pages, not several paints. A scanner that paints a
    // separator rule twice on a page has not made it page furniture.
    const twice = {
        images: [{ ref: '5 0 R', width: 60, height: 8 }, { ref: '5 0 R', width: 60, height: 8 }],
        opaque: false,
    };
    assert.equal(repeatedImageSizes([twice]).size, 0);
});

test('a document with nothing in it reports nothing', () => {
    assert.equal(repeatedImageSizes([]).size, 0);
    assert.deepEqual(noScanPossible([], 3), false);
});
