// Structural cleanup: take the watermarks and the markup out of a page and
// leave the page.
//
// This is the other half of what the tool does. The extractor's answer to a
// watermark is to throw the page away and keep the pixels, which works because
// on a scan the pixels *are* the page. On a typeset document they are not: the
// text, the fonts and the vectors are the document, and rasterising them to get
// rid of a stamp costs more than the stamp did. So a document that is not a scan
// used to leave here with nothing removed but its metadata.
//
// What this removes instead is the objects and the operators that draw the mark,
// with every other byte of the page left where it was — no re-encoding, no
// resampling, no loss. It is deliberately narrow: it only removes things it can
// name, and everything it cannot read it leaves alone. Three rules, in order of
// how sure they are:
//
//   1. Annotations that are markup. A highlight, a sticky note, a freehand
//      scribble and Acrobat's own watermark are all annotations — objects
//      hanging off the page rather than part of it, which is why they can be
//      unhooked without touching the page at all.
//   2. Content marked as a watermark artifact. The PDF spec has a way to say
//      "this is a watermark and not the document" — `/Artifact <</Subtype
//      /Watermark>> BDC … EMC` — and the tools that stamp files use it.
//   3. Semi-transparent blocks. A document does not draw itself at 30% opacity;
//      something stamped over it does. This is the rule that catches the
//      watermarks nobody labelled.
//
// What it does *not* catch is worth stating plainly: an opaque, unlabelled
// watermark drawn as ordinary page content is indistinguishable from the page's
// own content by any of these rules, and survives. So does anything already
// burnt into a bitmap — that is a pixel problem and this file is nowhere near
// it.

import {
    PDFName,
    PDFDict,
    PDFRef,
    PDFRawStream,
    decodePDFRawStream,
} from '../vendor.js';
import { tokenize, mergeRanges, applyCuts } from './tokens.js';

/**
 * Annotation subtypes that survive.
 *
 * Stated as what is kept rather than as what goes, because the list of markup
 * subtypes is long, open-ended and full of things nobody has heard of, and a
 * subtype this file has never met is far more likely to be another kind of
 * markup than another kind of link. Getting that backwards would mean quietly
 * keeping whichever watermark flavour we forgot to enumerate.
 *
 * `Link` is navigation and part of how the document works. `Widget` is a form
 * field — removing one would take the field with it and leave the AcroForm
 * pointing at nothing, which is breaking the document rather than cleaning it.
 */
const KEPT_ANNOTATIONS = new Set(['Link', 'Widget']);

/**
 * The opacity below which a block is taken to be stamped on rather than part of
 * the page.
 *
 * Page content is drawn opaque. Transparency appears in two places: in
 * decoration a designer put there — a tint panel behind a heading, a soft
 * shadow — and in watermarks, which are semi-transparent precisely so the text
 * can be read through them. The figure sits low enough that a watermark faint
 * enough to be legible under it is well below it, and a designed tint that is
 * meant to be *seen* is generally above it.
 *
 * This is the least certain of the three rules, which is why the guard below
 * exists as well.
 */
const MAX_CONTENT_ALPHA = 0.6;

/**
 * How much of a page's content stream these rules may delete before the whole
 * page is left alone.
 *
 * A page that is nine-tenths watermark is not a page anybody wants back; a
 * result that says so is much more likely to mean the scan went wrong — an
 * inline image whose data happened to contain `EI`, a `q`/`Q` nesting this file
 * misread — and the honest response to "I appear to have found that the entire
 * page is a watermark" is to conclude the finding is wrong.
 *
 * It is the backstop for the transparency rule in particular: that rule cuts a
 * whole `q … Q` block, and a producer that wraps the entire page in one and
 * happens to set a low alpha inside it would otherwise take the page with it.
 */
const MAX_CUT_SHARE = 0.9;

// === The content-stream rules ===
//
// Pure, and separated from pdf-lib entirely: what they need from the page's
// resources arrives as two lookup functions. That is not ceremony — the rules
// are the part that can be wrong in a way that silently damages a file, and
// this is what lets them be tested against a stream written by hand rather than
// against whatever a real document happens to do.

/**
 * Does this `BDC` open a span the spec has labelled a watermark?
 *
 * @param operands  the tokens between the previous operator and this `BDC`,
 *                  which is `/Tag properties` — the properties being either an
 *                  inline dictionary or the name of one in the page's
 *                  `/Properties` resource
 */
function opensWatermark(operands, propertySubtype) {
    const tag = operands[0];
    if (tag?.kind !== 'name' || tag.value !== 'Artifact') return false;

    // `/Artifact /P0 BDC` — the dictionary is a named resource
    if (operands.length === 2 && operands[1].kind === 'name') {
        return propertySubtype(operands[1].value) === 'Watermark';
    }

    // `/Artifact <</Subtype /Watermark>> BDC` — an inline dictionary, read as
    // the flat token run it is. Only the pairing matters, and `/Subtype` cannot
    // appear as a value here, so a scan for the two names in sequence says the
    // same thing a parse of the dictionary would.
    return operands.some((token, index) =>
        token.kind === 'name' && token.value === 'Subtype' &&
        operands[index + 1]?.kind === 'name' &&
        operands[index + 1].value === 'Watermark');
}

/**
 * The byte ranges of a content stream that draw a watermark.
 *
 * @param tokens             from `tokenize`
 * @param alphaOf            (extGStateName) => fill/stroke alpha, or null when
 *                           the state names none or cannot be read
 * @param propertySubtype    (propertiesName) => that dictionary's `/Subtype`
 * @returns [{ start, end }] unmerged, possibly overlapping
 *
 * Everything cut is cut at a boundary that restores itself: a `q … Q` pair, or a
 * `BDC … EMC` span. Both leave the graphics state exactly as they found it, so
 * removing one cannot change how anything after it is drawn. Cutting at any
 * other boundary could — a `cm` deleted on its own moves everything downstream
 * of it — so a rule with no enclosing `q` to cut (a `gs` at the top level of the
 * stream) declines to cut anything at all.
 */
export function contentCuts(tokens, { alphaOf = () => null, propertySubtype = () => null } = {}) {
    const state = tokens.reduce((state, token, index) => {
        // Operands accumulate until an operator consumes them. An inline image
        // is neither, but it does end the run before it.
        if (token.kind === 'inlineImage') return { ...state, operandsFrom: index + 1 };
        if (token.kind !== 'op') return state;

        const operands = tokens.slice(state.operandsFrom, index);
        const next = { ...state, operandsFrom: index + 1 };
        const { blocks, spans, cuts } = state;

        switch (token.value) {
            case 'q':
                return { ...next, blocks: [...blocks, { start: token.start, cut: false }] };

            case 'Q': {
                const block = blocks[blocks.length - 1];
                // An unbalanced `Q` is a malformed stream, not a cut site
                if (!block) return next;
                return {
                    ...next,
                    blocks: blocks.slice(0, -1),
                    cuts: block.cut ? [...cuts, { start: block.start, end: token.end }] : cuts,
                };
            }

            case 'gs': {
                const name = operands[operands.length - 1];
                const alpha = name?.kind === 'name' ? alphaOf(name.value) : null;
                if (alpha === null || alpha >= MAX_CONTENT_ALPHA || !blocks.length) return next;
                // Mark the innermost block; the cut is recorded when its `Q`
                // arrives, since that is where the range ends
                return {
                    ...next,
                    blocks: [...blocks.slice(0, -1),
                        { ...blocks[blocks.length - 1], cut: true }],
                };
            }

            case 'BMC':
            case 'BDC':
                return {
                    ...next,
                    spans: [...spans, {
                        // The span starts at its operands, not at `BDC`: the
                        // tag and the dictionary are part of what goes
                        start: operands[0]?.start ?? token.start,
                        cut: token.value === 'BDC' &&
                            opensWatermark(operands, propertySubtype),
                    }],
                };

            case 'EMC': {
                const span = spans[spans.length - 1];
                if (!span) return next;
                return {
                    ...next,
                    spans: spans.slice(0, -1),
                    cuts: span.cut ? [...cuts, { start: span.start, end: token.end }] : cuts,
                };
            }

            default:
                return next;
        }
    }, { operandsFrom: 0, blocks: [], spans: [], cuts: [] });

    return state.cuts;
}

/**
 * The stream with its watermark blocks removed.
 *
 * @returns { bytes, blocks } — `bytes` is the input itself when nothing was
 *          removed, so the caller can tell "unchanged" by identity and skip
 *          writing the page back
 */
export function rewriteContent(bytes, lookups) {
    const cuts = mergeRanges(contentCuts(tokenize(bytes), lookups));
    if (!cuts.length) return { bytes, blocks: 0 };

    const removed = cuts.reduce((n, cut) => n + (cut.end - cut.start), 0);
    if (removed > bytes.length * MAX_CUT_SHARE) {
        console.warn('Watermark rules matched nearly the whole page; leaving it alone');
        return { bytes, blocks: 0 };
    }
    return { bytes: applyCuts(bytes, cuts), blocks: cuts.length };
}

// === The pdf-lib side ===

// A number out of a dictionary, or null when it is absent or unreadable. Null
// rather than 0, because 0 is a perfectly meaningful alpha and "not stated" is
// not the same answer as "fully transparent".
function numberOf(dict, key) {
    const value = dict?.lookup(PDFName.of(key));
    const n = typeof value?.asNumber === 'function' ? value.asNumber() : NaN;
    return Number.isFinite(n) ? n : null;
}

// A `/Name` as its plain text, whatever kind of object turned up in its place.
function nameOf(value) {
    return value?.asString?.().replace(/^\//, '') ?? null;
}

/**
 * The two resource lookups `contentCuts` needs, bound to one page.
 *
 * A page with no readable resources gets lookups that answer null to
 * everything, which costs the transparency and artifact rules their evidence
 * and leaves the page's content untouched. That is the right failure: this pass
 * may only remove what it has positively identified.
 */
function resourceLookups(pageNode) {
    let extGState = null;
    let properties = null;
    try {
        const resources = pageNode.Resources();
        extGState = resources?.lookupMaybe(PDFName.of('ExtGState'), PDFDict) || null;
        properties = resources?.lookupMaybe(PDFName.of('Properties'), PDFDict) || null;
    } catch {
        // Unreadable resources; both lookups stay null
    }

    return {
        // The lower of the fill and stroke alphas: a block that paints anything
        // at all faintly is the block this is looking for, and which of the two
        // knobs the producer reached for is not information
        alphaOf(name) {
            const gs = extGState?.lookupMaybe(PDFName.of(name), PDFDict);
            const alphas = [numberOf(gs, 'ca'), numberOf(gs, 'CA')].filter((a) => a !== null);
            return alphas.length ? Math.min(...alphas) : null;
        },
        propertySubtype(name) {
            const dict = properties?.lookupMaybe(PDFName.of(name), PDFDict);
            return nameOf(dict?.lookup(PDFName.of('Subtype')));
        },
    };
}

/**
 * Unhook every markup annotation from a page, and delete the objects.
 *
 * Deleting matters as much as unhooking. An annotation left in the file but
 * referenced by nothing is still in the file — the note's text, the scribble's
 * path and the watermark's appearance stream all still there, invisible to a
 * reader and perfectly visible to anyone who looks at the bytes. A tool whose
 * entire claim is that things were removed cannot leave them in.
 *
 * @returns how many went
 */
function stripAnnotations(pageNode, context) {
    const annots = pageNode.Annots();
    const entries = annots?.asArray?.();
    if (!entries?.length) return 0;

    const kept = entries.filter((entry) => {
        const subtype = nameOf(context.lookup(entry)?.get?.(PDFName.of('Subtype')));
        // An annotation whose subtype will not read stays: unidentified is not
        // the same as unwanted
        return subtype === null || KEPT_ANNOTATIONS.has(subtype);
    });
    if (kept.length === entries.length) return 0;

    entries
        .filter((entry) => !kept.includes(entry) && entry instanceof PDFRef)
        .forEach((ref) => context.delete(ref));

    if (kept.length) pageNode.set(PDFName.of('Annots'), context.obj(kept));
    else pageNode.delete(PDFName.of('Annots'));

    return entries.length - kept.length;
}

// One content stream's decoded bytes, or null if it will not decode. A stream
// this cannot read is a page this cannot safely rewrite, and null carries that
// all the way up rather than producing a shorter page.
function decodeContentStream(stream) {
    if (!(stream instanceof PDFRawStream)) return null;
    try {
        return decodePDFRawStream(stream).decode();
    } catch (err) {
        console.warn('A content stream would not decode, leaving its page alone:', err);
        return null;
    }
}

/**
 * A page's content as one run of bytes, with the objects it came out of.
 *
 * `/Contents` may be a single stream or an array of them, and the spec says the
 * array is to be treated as one stream with the parts concatenated — a token
 * may even be split across the join, so they are glued with a newline and read
 * as one. That is also why the rewrite writes a single stream back: reproducing
 * the original split would mean mapping every cut onto whichever part it landed
 * in, for no gain to anyone.
 */
function pageContent(pageNode, context) {
    const contents = pageNode.Contents();
    if (!contents) return null;

    const streams = typeof contents.asArray === 'function'
        ? contents.asArray().map((entry) => context.lookup(entry))
        : [contents];

    const parts = streams.map(decodeContentStream);
    if (!parts.length || parts.some((part) => part === null)) return null;

    const bytes = new Uint8Array(parts.reduce((n, part) => n + part.length + 1, 0));
    parts.reduce((offset, part) => {
        bytes.set(part, offset);
        bytes[offset + part.length] = 0x0a;
        return offset + part.length + 1;
    }, 0);
    return bytes;
}

// Every object reference `/Contents` reaches, so the streams that have been
// replaced can be deleted rather than left orphaned in the file.
function contentRefs(pageNode, context) {
    const entry = pageNode.get(PDFName.of('Contents'));
    const refs = entry instanceof PDFRef ? [entry] : [];
    const contents = context.lookup(entry);
    return typeof contents?.asArray === 'function'
        ? [...refs, ...contents.asArray().filter((item) => item instanceof PDFRef)]
        : refs;
}

/** Rewrite one page's content stream in place. @returns how many blocks went */
function stripContent(pageNode, context) {
    const bytes = pageContent(pageNode, context);
    if (!bytes) return 0;

    const { bytes: rewritten, blocks } = rewriteContent(bytes, resourceLookups(pageNode));
    if (!blocks) return 0;

    const stale = contentRefs(pageNode, context);
    pageNode.set(PDFName.of('Contents'), context.register(context.flateStream(rewritten)));
    stale.forEach((ref) => context.delete(ref));
    return blocks;
}

/**
 * Run the three rules over every page of a document, in place.
 *
 * @param pdfDoc      a pdf-lib PDFDocument
 * @param onProgress  (current, total) => void, called once per page. It is also
 *                    where a cancelled run unwinds, which is why it is outside
 *                    the per-page catch — a page that throws is skipped, and a
 *                    cancellation must not be.
 * @returns { annotations, blocks, pages } — what went, and how many pages had
 *          anything taken off them
 */
export function stripMarks(pdfDoc, onProgress) {
    const context = pdfDoc.context;
    const pages = pdfDoc.getPages();

    return pages.reduce((total, page, index) => {
        onProgress?.(index + 1, pages.length);
        try {
            const annotations = stripAnnotations(page.node, context);
            const blocks = stripContent(page.node, context);
            return {
                annotations: total.annotations + annotations,
                blocks: total.blocks + blocks,
                pages: total.pages + (annotations + blocks > 0 ? 1 : 0),
            };
        } catch (err) {
            // One page that will not be read is not a reason to abandon the
            // document; it is a reason to hand that page back untouched
            console.warn(`Could not clean page ${index + 1}, leaving it as it was:`, err);
            return total;
        }
    }, { annotations: 0, blocks: 0, pages: 0 });
}
