// Assemble the extracted page images into a fresh, metadata-free PDF.

import { PDFDocument, PDFName, PDFDict } from '../vendor.js';
import { sweepUnreachable } from './sweep.js';
import { drawTextLayer, finalizeTextLayer } from './textlayer.js';
import { pageLayout, keepText } from '../settings.js';
import { PORTRAIT_HEIGHT, METADATA_FIELDS } from '../config.js';

/**
 * The sheet a single image is placed on, in points.
 *
 * With a paper size chosen, the sheet is fixed and the image is centred on it;
 * `auto` turns the sheet to match the image, which is what leaves a portrait
 * scan on a portrait page. With `fit` there is no sheet at all — the page is
 * cut to the image's own proportions, sized so its long edge matches A4's, so
 * nothing is padded out with white and the orientation setting has nothing to
 * decide.
 *
 * Exported because the sample screen draws the same sheet in the browser
 * without building a PDF to do it. It has to be this function rather than a
 * copy of its rules: a preview of the page geometry that disagrees with the
 * page geometry is worse than no preview at all.
 */
export function sheetFor(imgWidth, imgHeight, { paper, orientation, margin }) {
    if (!paper) {
        const long = PORTRAIT_HEIGHT - 2 * margin;
        const short = long * Math.min(imgWidth, imgHeight) / Math.max(imgWidth, imgHeight);
        const [w, h] = imgWidth > imgHeight ? [long, short] : [short, long];
        return [w + 2 * margin, h + 2 * margin];
    }
    const [portraitWidth, portraitHeight] = paper;
    const landscape = orientation === 'landscape' ||
        (orientation === 'auto' && imgWidth > imgHeight);
    return landscape ? [portraitHeight, portraitWidth] : [portraitWidth, portraitHeight];
}

/**
 * How large one image pixel comes out on the page, in points.
 *
 * The image is fitted inside the margins and keeps its proportions, so this one
 * number is the whole placement — the drawn size is it times the pixel count,
 * and the centring follows from that.
 *
 * Exported for the same reason `sheetFor` is: it is what tells the sample screen
 * how big to draw a pixel when it shows the page at 100%. That figure has to
 * come from the function that does the placing. Derived from a copy of the rule,
 * it would quietly disagree with the file the moment either changed — and a
 * preview claiming to be 100% is worth nothing if it is 100% of something else.
 */
export function pointsPerPixel(imgWidth, imgHeight, layout) {
    const [pageWidth, pageHeight] = sheetFor(imgWidth, imgHeight, layout);
    const margin = layout.margin;
    return Math.min(
        (pageWidth - 2 * margin) / imgWidth,
        (pageHeight - 2 * margin) / imgHeight,
    );
}

/**
 * One page per image, laid out per the user's page settings and centred within
 * a uniform margin.
 *
 * @param extractedImages  [{ page, blob, width, height, texts }]
 * @param options.onProgress  (current, total) => void
 * @param options.kept     1-based page numbers that had no scan on them and
 *                         are to be carried into the output as original pages.
 * @param options.dropped  1-based page numbers the caller is deliberately
 *                         leaving out — the other half of the same decision.
 *                         A page that is neither rebuilt, nor carried, nor
 *                         named here is a hard error: the builder refuses to
 *                         lose a page no one asked it to lose.
 * @param options.sourceDoc  a pdf-lib PDFDocument to copy the kept pages from.
 *                         Required whenever `kept` is non-empty; without it a
 *                         page would have to be dropped, which no caller may
 *                         do silently.
 *
 * With the text-layer setting on, the source text items travel with the image
 * and are re-drawn invisibly on top of it. Pages that carried no text simply
 * contribute nothing.
 *
 * The output keeps the source's page order: scan pages are rebuilt from their
 * images, and every other page is copied from the source as it was, so a
 * document that mixes scans and laid-out pages comes back complete. A page
 * that is neither rebuilt nor copied is a hard error — the one failure this
 * builder is not allowed to have is a smaller document that still reports as
 * a success.
 */
export async function createNewPdf(
    extractedImages,
    { onProgress, kept = [], dropped = [], sourceDoc = null } = {},
) {
    const pdfDoc = await PDFDocument.create();
    const layout = pageLayout();
    const withText = keepText();
    const margin = layout.margin;
    extractedImages.sort((a, b) => a.page - b.page);

    // One pass in source order, so the kept pages land exactly where the
    // source had them. `byPage` makes the scan lookup constant regardless of
    // where in the document the scans sit.
    const byPage = new Map(extractedImages.map((img) => [img.page, img]));
    const keptSet = new Set(kept);
    const droppedSet = new Set(dropped);
    const lastPage = Math.max(
        ...extractedImages.map((img) => img.page),
        ...(kept.length ? kept : [0]),
    );
    let copied = null;

    for (let pageNumber = 1; pageNumber <= lastPage; pageNumber++) {
        const img = byPage.get(pageNumber);
        if (!img) {
            // A page with no scan on it travels into the output as an original
            // page; the caller may instead name it as deliberately dropped. A
            // page that is neither is a gap nobody accounted for, and gaps are
            // not a path — they are the quiet failure this builder exists to
            // make loud.
            if (keptSet.has(pageNumber)) {
                if (!sourceDoc) {
                    throw new Error(`page ${pageNumber} has no image and no source page to copy`);
                }
                // Copied lazily, and only once: pdf-lib's copyPages walks the
                // source's object graph, which is the expensive part of carrying a
                // page over. A document with several kept pages pays it once.
                // `copyPages` wants the source's zero-based indices; `kept` is
                // 1-based, the way page numbers are spoken everywhere else
                copied ??= await pdfDoc.copyPages(sourceDoc, kept.map((p) => p - 1));
                const index = kept.indexOf(pageNumber);
                pdfDoc.insertPage(pdfDoc.getPageCount(), copied[index]);
                onProgress?.(pageNumber, lastPage);
                continue;
            }
            if (droppedSet.has(pageNumber)) continue;
            throw new Error(`page ${pageNumber} has no image and no source page to copy`);
        }

        const arrayBuffer = await img.blob.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        const pdfImage = img.blob.type === 'image/jpeg'
            ? await pdfDoc.embedJpg(uint8Array)
            : await pdfDoc.embedPng(uint8Array);

        const imgWidth = pdfImage.width;
        const imgHeight = pdfImage.height;
        const [pageWidth, pageHeight] = sheetFor(imgWidth, imgHeight, layout);

        const page = pdfDoc.addPage([pageWidth, pageHeight]);
        const maxWidth = pageWidth - 2 * margin;
        const maxHeight = pageHeight - 2 * margin;
        const scale = pointsPerPixel(imgWidth, imgHeight, layout);
        const scaledWidth = imgWidth * scale;
        const scaledHeight = imgHeight * scale;

        const x = margin + (maxWidth - scaledWidth) / 2;
        const y = margin + (maxHeight - scaledHeight) / 2;
        page.drawImage(pdfImage, { x, y, width: scaledWidth, height: scaledHeight });

        // The image's placement, as the matrix the text items are relative to
        if (withText) {
            drawTextLayer(pdfDoc, page, img.texts, [scaledWidth, 0, 0, scaledHeight, x, y]);
        }
        onProgress?.(pageNumber, lastPage);
    }
    if (withText) finalizeTextLayer(pdfDoc);
    return pdfDoc;
}

/**
 * The pages a scan extraction skipped, as 1-based page numbers.
 *
 * `extractImages` counts a page with no scan on it as evidence about the
 * document, which is how a mixed document is classified — but the pages
 * themselves are not evidence, they are the document. Callers that rebuild a
 * scan must hand every number this returns back to the builder, or the output
 * silently loses pages.
 *
 * @param extractedImages  [{ page }] — the pages that did hold a scan
 * @param numPages         the whole document's page count
 */
export function keptPageNumbers(extractedImages, numPages) {
    const scanned = new Set(extractedImages.map((img) => img.page));
    const kept = [];
    for (let page = 1; page <= numPages; page++) {
        if (!scanned.has(page)) kept.push(page);
    }
    return kept;
}

/**
 * Keys that hold metadata about the document rather than any part of it, on the
 * catalog and on individual pages alike.
 *
 * `/Metadata` is the XMP packet, and it is the one that matters. It restates
 * everything the info dictionary holds — title, author, the tool that made the
 * file — and then adds what the info dictionary has no room for: `xmpMM:
 * DocumentID` and `InstanceID`, which are stable identifiers that link separate
 * files back to a common ancestor, and `xmpMM:History`, which is a log of every
 * edit with its timestamp and the software that made it. Deleting eight info
 * fields and leaving that behind removes the copy nobody reads and keeps the
 * copy that says more.
 *
 * `/PieceInfo` is private working data a producer is allowed to park on the
 * document — Illustrator and InDesign both use it, sometimes for an editable
 * version of the page.
 */
const METADATA_KEYS = ['Metadata', 'PieceInfo'];

/**
 * Keys that make a document *do* something when it is opened.
 *
 * None of these is part of the page. `/OpenAction` is what runs the moment the
 * file is opened and is the classic place to hang a script; `/AA` is the same
 * idea spread over events — opening a page, closing the document, printing.
 * They are removed from the catalog and from every page.
 *
 * A tool called a sanitizer that hands back a file which still runs code on
 * open is not describing itself accurately, and unlike the watermark rules there
 * is no judgement involved here: nothing legitimate about a cleaned-up scan
 * needs to execute anything.
 */
const ACTION_KEYS = ['OpenAction', 'AA'];

/**
 * Entries of the catalog's `/Names` tree that are removed wholesale.
 *
 * `/Names` is a mixed bag and most of it is navigation, so it is emptied by the
 * key rather than deleted. `/JavaScript` is document-level script — the tree of
 * functions Acrobat installs before the first page is drawn. `/EmbeddedFiles`
 * is the attachment panel: whole files, of any type, carried inside the PDF and
 * invisible on every page of it. Someone cleaning a document before sending it
 * on is exactly the person who does not know it has an attachment.
 *
 * `/Dests` and the rest stay: they are how internal links find their targets.
 */
const NAME_TREE_KEYS = ['JavaScript', 'EmbeddedFiles'];

/**
 * Take one key off a dictionary.
 *
 * Only the hook goes. What it pointed at is left for `sweepUnreachable` to
 * collect, which is what makes the removal reach the whole of the thing rather
 * than its topmost object — an attachment's bytes and a script tree's action
 * dictionaries both sit several objects below the key that names them, and
 * deleting the key alone would leave every one of them in the file.
 */
function purgeEntry(dict, key) {
    const name = PDFName.of(key);
    if (dict?.has?.(name)) dict.delete(name);
}

/**
 * Strip everything identifying, everything executable, and serialise to a Blob.
 *
 * This is the one place every output goes through — the rebuilt scan and the
 * document handed back with its pages untouched both end here — which is why it
 * is where the unconditional cleaning lives. The watermark pass in `strip.js` is
 * a setting the user can turn off; none of this is. Somebody who switches off
 * "remove marks from non-scans" is saying they want the page left alone, not
 * that they would like the JavaScript back.
 *
 * What goes:
 *
 *   1. `/Info` — the eight fields in `METADATA_FIELDS`.
 *   2. `/Metadata` and `/PieceInfo`, on the catalog and on every page.
 *   3. `/OpenAction` and `/AA`, and the `/JavaScript` and `/EmbeddedFiles` name
 *      trees — everything that runs on open or rides along invisibly.
 *   4. The trailer's `/ID`, a pair of strings a producer derives from the file
 *      and carries across saves, so two documents that share one are two
 *      versions of the same document. The spec only requires it for encrypted
 *      files, which this never emits.
 *
 * Then the sweep, which is what turns all of the above from unhooking into
 * removal — see `pdf/sweep.js`. Without it the keys would be gone and the XMP
 * packet, the attachments and the scripts would all still be sitting in the
 * output. It also collects whatever `strip.js` unhooked on its way past, and
 * anything the source document was already carrying unreferenced.
 *
 * On the rebuild path most of the above is absent before it starts — the
 * document is one this app just created — and the sweep finds nothing to do.
 * The work is all for the file whose own structure survives into the output.
 */
export async function cleanSavePdf(pdfDoc) {
    const context = pdfDoc.context;
    const catalog = pdfDoc.catalog;

    const infoDict = context.lookup(pdfDoc.getInfoDict());
    METADATA_FIELDS.forEach((field) => {
        const fieldName = PDFName.of(field);
        if (infoDict.has(fieldName)) {
            infoDict.delete(fieldName);
        }
    });

    [...METADATA_KEYS, ...ACTION_KEYS].forEach((key) => purgeEntry(catalog, key));
    pdfDoc.getPages().forEach((page) => {
        [...METADATA_KEYS, ...ACTION_KEYS].forEach((key) => purgeEntry(page.node, key));
    });

    // `/Names` is emptied of the two dangerous trees rather than removed: what
    // is left of it is how internal links find their destinations
    const names = catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
    NAME_TREE_KEYS.forEach((key) => purgeEntry(names, key));

    context.trailerInfo.ID = undefined;

    sweepUnreachable(pdfDoc);

    const pdfBytes = await pdfDoc.save({
        useObjectStreams: true // use object streams for better compression
    });
    return new Blob([pdfBytes], { type: 'application/pdf' });
}
