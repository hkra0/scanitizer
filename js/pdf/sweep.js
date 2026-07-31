// Delete every object nothing points at any more.
//
// This exists because pdf-lib does not collect garbage. It writes back every
// object it is holding, whether or not anything still references it — so taking
// a key off a dictionary removes the *hook* and leaves the object in the file,
// unreachable to a reader and perfectly legible to anyone who opens the bytes in
// a text editor. For a tool whose entire claim is that things were removed, that
// is not a detail: an XMP packet, a watermark's appearance stream and an
// embedded attachment are all still there, and still say what they said.
//
// The obvious answer is to delete the object at the same time as the key, and
// that is what this project used to do. It is wrong in a way that is much worse
// than the problem it solves. A content stream may be shared by several pages —
// imposition tools and template-driven generators both do it — and an annotation
// may hang off two pages at once. Deleting one because the page in front of us
// stopped pointing at it takes the other page's content with it, silently, in a
// file that is reported as a success. The tool would be destroying documents in
// order to look thorough.
//
// So the two halves are separated. Removing a mark is only ever *unhooking*: the
// page stops pointing at the thing, and nothing is deleted. Then this runs once,
// at the end, and deletes what is provably unreachable — which is exactly the
// set of objects that nothing, on any page, can still see. A stream two pages
// shared stays because the second page still points at it. A stream only this
// page pointed at goes, along with everything that hung off it and nothing else.
//
// That "and everything that hung off it" is the other half of what this buys.
// Deleting one object by hand only ever removes that object; the appearance
// stream under a deleted annotation, the file stream under a deleted
// `/EmbeddedFiles` tree, and the action dictionaries under a deleted
// `/JavaScript` tree would all survive a key-by-key purge. Reachability does not
// care how deep they are.

import { PDFArray, PDFDict, PDFRef } from '../vendor.js';

/**
 * Every reference held directly by one object, handed to `visit`.
 *
 * References are reported, not followed — the caller owns the traversal, which
 * is what keeps a document whose objects point at each other in a circle (a page
 * and its parent node, at minimum, so: every document) from being walked for
 * ever.
 */
function eachRef(value, visit) {
    if (value instanceof PDFRef) {
        visit(value);
        return;
    }
    if (value instanceof PDFArray) {
        value.asArray().forEach((item) => eachRef(item, visit));
        return;
    }
    // A stream's references live in the dictionary in front of it; its bytes
    // hold none. `instanceof PDFDict` covers the catalog and the page nodes,
    // which are subclasses of it.
    const dict = value instanceof PDFDict ? value : value?.dict;
    if (dict instanceof PDFDict) dict.values().forEach((item) => eachRef(item, visit));
}

/**
 * The tags of every object reachable from the trailer.
 *
 * The trailer is the whole of the file's front door: `/Root` is the catalog and
 * everything the document is hangs off it, and `/Info` is the one thing that
 * does not. Anything not found from there cannot be found by a reader either.
 */
function reachableTags(context) {
    const seen = new Set();
    const queue = [];

    const seed = (ref) => {
        if (!(ref instanceof PDFRef) || seen.has(ref.tag)) return;
        seen.add(ref.tag);
        queue.push(ref);
    };

    const { Root, Info, Encrypt } = context.trailerInfo;
    [Root, Info, Encrypt].forEach(seed);

    while (queue.length) {
        // `lookup` of a reference with nothing behind it returns undefined,
        // which `eachRef` reads as an object with no references in it — a
        // dangling pointer is not a reason to stop
        eachRef(context.lookup(queue.pop()), seed);
    }
    return seen;
}

/**
 * Drop every indirect object the trailer cannot reach.
 *
 * @param pdfDoc  a pdf-lib PDFDocument, modified in place
 * @returns how many objects went
 *
 * Safe to run on a document nothing has been taken out of: a file that was
 * already tight loses nothing, and one that arrived carrying orphans from
 * whatever produced it comes out smaller for it.
 */
export function sweepUnreachable(pdfDoc) {
    const context = pdfDoc.context;
    const reachable = reachableTags(context);

    // Collected before anything is deleted: `enumerateIndirectObjects` reads the
    // map this loop is about to change.
    const doomed = context.enumerateIndirectObjects()
        .map(([ref]) => ref)
        .filter((ref) => !reachable.has(ref.tag));

    doomed.forEach((ref) => context.delete(ref));
    return doomed.length;
}
