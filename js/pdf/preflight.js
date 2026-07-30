// A structural look at the document before pdf.js is asked to read any of it.
//
// The verdict "this is not a scan" is expensive to reach through pdf.js: it
// decodes every image it parses, so even the walk that only *counts* images
// costs a couple of seconds a page and the answer arrives after the document has
// been taken apart. Most non-scans do not need any of that. A PDF of typeset
// text has no page-sized image on any page, and that is visible in the object
// dictionaries alone — pdf-lib reads the whole structure of a 9 MB file in about
// 20 ms and walking every page's resources after that is not measurable.
//
// So this runs first and gets one veto: a document in which no page could hold a
// scan is rejected here, without pdf.js. Everything else — coverage, resolution,
// what the page drew on its own account — needs the content stream's transforms
// and stays in extract.js, which remains the authority. Whatever this cannot
// read, it passes.
//
// It also does the one thing extract.js cannot do at all: identify an image
// across pages. pdf.js hands out per-page object ids, so the only cross-page
// signal available there is its own `g_` cache prefix, which does not appear
// until the second page paints the image and stops appearing altogether once the
// cache's byte budget is reached. Here the object references are the document's
// own, so a watermark is recognisable on page 1 and in a document of any length.

import { PDFDocument, PDFName, PDFDict } from '../vendor.js';

/**
 * The survey, from the file's own bytes, or null if there is not going to be one.
 *
 * Null is a first-class answer and every caller has a path for it: the extractor
 * falls back on judging each page through pdf.js, which is where it stood before
 * any of this existed. So nothing here has to succeed, and nothing here may
 * report a document as unscannable on the strength of not having understood it.
 *
 * An encrypted document is refused rather than attempted. pdf-lib will open one
 * with `ignoreEncryption`, but its streams stay encrypted, so the object
 * dictionaries would read as a document with no images anywhere in it — which is
 * exactly the shape of the one verdict this file is allowed to reach.
 */
export async function surveyDocument(bytes) {
    if (!bytes || !PDFDocument) return null;
    try {
        const doc = await PDFDocument.load(bytes, { updateMetadata: false });
        if (doc.isEncrypted) return null;
        return surveyPages(doc);
    } catch (err) {
        console.warn('Preflight could not open the document, skipping it:', err);
        return null;
    }
}

// A number out of an object dictionary, whether it is stored directly or behind
// a reference. Anything unreadable comes back as 0, which every caller treats as
// "not stated" rather than as a measurement.
function numberOf(dict, key) {
    const value = dict.lookup(PDFName.of(key));
    const n = typeof value?.asNumber === 'function' ? value.asNumber() : NaN;
    return Number.isFinite(n) ? n : 0;
}

/**
 * What each page holds, as the object dictionaries have it.
 *
 * @param doc  a pdf-lib PDFDocument
 * @returns  one entry per page:
 *           { images: [{ ref, width, height }], opaque }
 *
 *           `opaque` means this page's contents could not be established — its
 *           resources would not read, or they name a form XObject, whose own
 *           resources are not followed here. Such a page is never held against
 *           the document: it is the difference between "there is no scan on this
 *           page" and "this cannot say", and only the first may veto anything.
 */
export function surveyPages(doc) {
    return doc.getPages().map((page) => {
        const images = [];
        let opaque = false;
        try {
            const resources = page.node.Resources();
            const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
            if (!resources) opaque = true;
            for (const [, ref] of xobjects?.entries() ?? []) {
                const stream = doc.context.lookup(ref);
                const dict = stream?.dict;
                if (!dict) { opaque = true; continue; }
                const subtype = String(dict.lookup(PDFName.of('Subtype')));
                if (subtype === '/Form') { opaque = true; continue; }
                if (subtype !== '/Image') continue;
                images.push({
                    ref: String(ref),
                    width: numberOf(dict, 'Width'),
                    height: numberOf(dict, 'Height'),
                });
            }
        } catch (err) {
            // A structure this cannot walk is not evidence about the document
            console.warn('Preflight could not read a page, passing it:', err);
            opaque = true;
        }
        return { images, opaque };
    });
}

/**
 * Whether the document can be ruled out as a scan from its structure alone.
 *
 * The only thing being asked is whether a page holds any image at all. Nothing
 * about *which* image is a scan is decided here, and deliberately so: in
 * extract.js coverage is the only veto, and an image is ranked on how large it is
 * painted rather than on its pixel count — so a 2×2 image stretched over a page
 * is still that page's candidate. A pixel-count floor here would quietly
 * overrule that from a place where the painting is not even visible.
 *
 * The tolerance is extract.js's, for the same reason it is a third there: the two
 * have to agree about how much of a document may be image-less before it stops
 * being a scan, or this one rejects documents the other would have accepted.
 *
 * @param pages       from `surveyPages`
 * @param giveUpAfter image-less pages the document is allowed
 */
export function noScanPossible(pages, giveUpAfter) {
    const imageless = pages.filter((page) => !page.opaque && page.images.length === 0);
    return imageless.length >= giveUpAfter;
}

/**
 * The pixel sizes of images this document paints on more than one page, as
 * `WIDTHxHEIGHT` keys.
 *
 * A page's scan belongs to that page; a watermark, a letterhead or a stamp is
 * one object painted on many. The count is per object reference, so pages that
 * merely happen to hold same-sized images — which is every page of a scan made
 * by one scanner — are not mistaken for each other.
 *
 * Sizes rather than references are what comes out because that is all the two
 * sides share: what extract.js has is pdf.js's `paintImageXObject`, whose
 * arguments are a per-page object id and the image's own pixel dimensions. The
 * cost of the translation is that a page holding both a repeated image and a
 * page-scoped one of exactly the same pixel size cannot tell them apart, and
 * treats both as repeated. That demotes rather than drops — coverage is still the
 * only veto — and it is the narrowest of the ways to be wrong here.
 */
export function repeatedImageSizes(pages) {
    const pagesByRef = new Map();
    pages.forEach(({ images }, index) => {
        for (const { ref } of images) {
            if (!pagesByRef.has(ref)) pagesByRef.set(ref, new Set());
            pagesByRef.get(ref).add(index);
        }
    });

    const sizes = new Set();
    for (const page of pages) {
        for (const { ref, width, height } of page.images) {
            if (pagesByRef.get(ref).size > 1) sizes.add(`${width}x${height}`);
        }
    }
    return sizes;
}
