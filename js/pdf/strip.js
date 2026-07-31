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
                    cuts: block.cut
                        ? [...cuts, { start: block.start, end: token.end, rule: 'alpha' }]
                        : cuts,
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
                    cuts: span.cut
                        ? [...cuts, { start: span.start, end: token.end, rule: 'artifact' }]
                        : cuts,
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
 * @param allowFullCut  let the rules take the whole stream, which `MAX_CUT_SHARE`
 *                      otherwise forbids. For a form XObject, and only when
 *                      every cut came from an explicit watermark label — see
 *                      below.
 * @returns { bytes, blocks } — `bytes` is the input itself when nothing was
 *          removed, so the caller can tell "unchanged" by identity and skip
 *          writing the page back
 *
 * `MAX_CUT_SHARE` reads "the whole of this is a watermark" as evidence that the
 * scan went wrong, which is right for a page and wrong for a form XObject: a
 * watermark stamp *is* a fragment that is entirely watermark, and that is the
 * commonest shape one comes in. Applying the page's guard there would mean
 * finding the mark, being certain about it, and then declining to remove it.
 *
 * So the guard is lifted for forms — but only for cuts the file labelled
 * itself. `/Artifact <</Subtype /Watermark>>` is the producer saying outright
 * that this is not the document, and there is nothing to second-guess. The
 * transparency rule is a heuristic about what faint drawing usually means, and
 * a heuristic that has concluded "all of it" is exactly the case the guard was
 * written for, form or not.
 */
export function rewriteContent(bytes, lookups, { allowFullCut = false } = {}) {
    // The share is judged on the raw cuts, before merging folds a labelled span
    // and a guessed one into a single range with no rule left on it
    const found = contentCuts(tokenize(bytes), lookups);
    const cuts = mergeRanges(found);
    if (!cuts.length) return { bytes, blocks: 0 };

    const labelledOnly = found.every((cut) => cut.rule === 'artifact');
    const limit = allowFullCut && labelledOnly ? 1 : MAX_CUT_SHARE;

    const removed = cuts.reduce((n, cut) => n + (cut.end - cut.start), 0);
    if (removed > bytes.length * limit) {
        console.warn('Watermark rules matched nearly the whole stream; leaving it alone');
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
 * The two resource lookups `contentCuts` needs, bound to one resource
 * dictionary — a page's, or a form XObject's own.
 *
 * A stream with no readable resources gets lookups that answer null to
 * everything, which costs the transparency and artifact rules their evidence
 * and leaves the content untouched. That is the right failure: this pass may
 * only remove what it has positively identified.
 */
function resourceLookups(resources) {
    let extGState = null;
    let properties = null;
    try {
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
 * Unhook every markup annotation from a page.
 *
 * Unhooking is all that happens here. The objects themselves are not deleted,
 * because an annotation may hang off more than one page and deleting it on
 * behalf of this one would take it off the other — see `pdf/sweep.js`, which
 * removes whatever is left unreachable once every page has been through. That
 * an unhooked annotation must not simply be *left* in the file is not in
 * question: the note's text, the scribble's path and the watermark's appearance
 * stream would all still be there, invisible to a reader and perfectly visible
 * to anyone who looks at the bytes. The sweep is what takes them, and it takes
 * the appearance streams underneath them too, which deleting the annotation
 * dictionary by hand never did.
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

// === Form XObjects ===
//
// A watermark is very often not drawn by the page at all. The stamping tool
// puts it in a form XObject — a reusable fragment of content stream, stored
// once and invoked from each page with `Do` — and the page's own stream holds
// nothing but that one operator. Everything this file looks for then lives
// inside the form: the `/Artifact <</Subtype /Watermark>> BDC` that labels it,
// or the `gs` that makes it faint.
//
// Reading only the page's stream therefore misses the whole of the commonest
// way a watermark is applied, and misses it silently — the page parses, the
// rules find nothing, the file is handed back with the stamp still on it and
// reported as cleaned. (The cases where the *page* wraps the `Do` in the label
// or the transparency were already caught, which is what made the gap easy to
// miss: some stamped files did come out clean.)
//
// Forms are processed once per document rather than once per page, and for the
// same reason they exist: one watermark form is shared by every page that
// carries the mark. Rewriting it in place, at its own reference, is what makes
// one edit clean all five hundred pages.

// A form's own stream keys are carried across a rewrite, except the three that
// describe the encoding — those belong to the bytes, which are about to change.
const ENCODING_KEYS = new Set(['Length', 'Filter', 'DecodeParms', 'DL']);

// Every form XObject a resource dictionary names, as [ref, stream] pairs.
// Anything that will not resolve to a form stream is skipped rather than
// guessed at.
function formXObjects(resources, context) {
    let xobjects = null;
    try {
        xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict) || null;
    } catch {
        return [];
    }

    const forms = [];
    for (const [, entry] of xobjects?.entries() ?? []) {
        if (!(entry instanceof PDFRef)) continue;   // an inline form cannot be shared, or reassigned
        const stream = context.lookup(entry);
        if (!(stream instanceof PDFRawStream)) continue;
        if (nameOf(stream.dict.get(PDFName.of('Subtype'))) !== 'Form') continue;
        forms.push({ ref: entry, stream });
    }
    return forms;
}

/**
 * Clean one form XObject, and everything it draws in turn.
 *
 * @param inherited  the resources to read when the form states none of its own,
 *                   which the spec says are the invoking page's
 * @param state      { reaches, blocks } shared across the document — `reaches`
 *                   memoises the answer per form, so the second page to use a
 *                   watermark form costs a map lookup rather than another parse
 * @returns whether this form or anything under it had something taken out, so
 *          the page that invoked it can be reported as cleaned even when the
 *          work itself happened on an earlier page's turn
 */
function stripForm({ ref, stream }, context, inherited, state) {
    // Set before the recursion below, so a form that reaches itself — malformed,
    // but a file can say it — is answered rather than followed round for ever
    if (state.reaches.has(ref.tag)) return state.reaches.get(ref.tag);
    state.reaches.set(ref.tag, false);

    let resources = inherited;
    try {
        resources = stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) || inherited;
    } catch {
        // Unreadable; the invoker's resources stand
    }

    const nested = stripForms(resources, context, resources, state);

    let own = false;
    const bytes = decodeContentStream(stream);
    if (bytes) {
        const { bytes: rewritten, blocks } =
            rewriteContent(bytes, resourceLookups(resources), { allowFullCut: true });
        if (blocks) {
            const carried = {};
            stream.dict.entries().forEach(([key, value]) => {
                const name = String(key).replace(/^\//, '');
                if (!ENCODING_KEYS.has(name)) carried[name] = value;
            });
            // Reassigned at its own reference rather than registered as a new
            // object: every page pointing at this form is meant to get the
            // cleaned version, which is the whole point of it being shared
            context.assign(ref, context.flateStream(rewritten, carried));
            state.blocks += blocks;
            own = true;
        }
    }

    const touched = own || nested;
    state.reaches.set(ref.tag, touched);
    return touched;
}

/** Every form a resource dictionary reaches. @returns whether any was cleaned */
function stripForms(resources, context, inherited, state) {
    // `reduce` and not `some`: every form has to be visited, and `some` would
    // stop at the first one that matched
    return formXObjects(resources, context).reduce(
        (touched, form) => stripForm(form, context, inherited, state) || touched,
        false,
    );
}

// A page's own resource dictionary, or null if it will not read.
function pageResources(pageNode) {
    try {
        return pageNode.Resources() || null;
    } catch {
        return null;
    }
}

/**
 * Rewrite one page's content stream in place.
 *
 * The page is pointed at a new stream and the old one is simply let go of. That
 * is deliberate and it is the whole of the fix for the sharing problem: two
 * pages may be drawn by one content stream, and this page's watermark is not
 * necessarily the other page's. Pointing only this page at the rewritten bytes
 * leaves the other page exactly as it was, still drawn by the original — which
 * is the correct answer, not a compromise. The original is collected later if
 * this page turns out to have been its only reader, and kept if it was not.
 *
 * @returns how many blocks went
 */
function stripContent(pageNode, context) {
    const bytes = pageContent(pageNode, context);
    if (!bytes) return 0;

    const { bytes: rewritten, blocks } =
        rewriteContent(bytes, resourceLookups(pageResources(pageNode)));
    if (!blocks) return 0;

    pageNode.set(PDFName.of('Contents'), context.register(context.flateStream(rewritten)));
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
 *
 * `blocks` counts each removal once, where it happened. A watermark form shared
 * by five hundred pages is one block, not five hundred — it was stored once and
 * it was cut once. `pages` still counts all five hundred, because every one of
 * them had the mark and no longer does.
 */
export function stripMarks(pdfDoc, onProgress) {
    const context = pdfDoc.context;
    const pages = pdfDoc.getPages();
    // Carried across the whole document: a form is cleaned on the first page
    // that invokes it and merely recognised on the rest
    const forms = { reaches: new Map(), blocks: 0 };

    const totals = pages.reduce((total, page, index) => {
        onProgress?.(index + 1, pages.length);
        try {
            const annotations = stripAnnotations(page.node, context);
            const resources = pageResources(page.node);
            const inForms = stripForms(resources, context, resources, forms);
            const blocks = stripContent(page.node, context);
            return {
                annotations: total.annotations + annotations,
                blocks: total.blocks + blocks,
                pages: total.pages + (annotations + blocks > 0 || inForms ? 1 : 0),
            };
        } catch (err) {
            // One page that will not be read is not a reason to abandon the
            // document; it is a reason to hand that page back untouched
            console.warn(`Could not clean page ${index + 1}, leaving it as it was:`, err);
            return total;
        }
    }, { annotations: 0, blocks: 0, pages: 0 });

    // The forms' own cuts happened outside the per-page tally, since they belong
    // to the document rather than to whichever page reached them first
    return { ...totals, blocks: totals.blocks + forms.blocks };
}
