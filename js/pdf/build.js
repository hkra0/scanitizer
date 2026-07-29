// Assemble the extracted page images into a fresh, metadata-free PDF.

import { PDFDocument, PDFName } from '../vendor.js';
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
 */
function sheetFor(imgWidth, imgHeight, { paper, orientation, margin }) {
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
 * One page per image, laid out per the user's page settings and centred within
 * a uniform margin.
 *
 * @param extractedImages  [{ page, blob, width, height, texts }]
 * @param onProgress       (current, total) => void
 *
 * With the text-layer setting on, the source text items travel with the image
 * and are re-drawn invisibly on top of it. Pages that carried no text simply
 * contribute nothing.
 */
export async function createNewPdf(extractedImages, onProgress) {
    const pdfDoc = await PDFDocument.create();
    const layout = pageLayout();
    const withText = keepText();
    const margin = layout.margin;
    extractedImages.sort((a, b) => a.page - b.page);

    for (const img of extractedImages) {
        onProgress?.(img.page, extractedImages.length);
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
        const scale = Math.min(maxWidth / imgWidth, maxHeight / imgHeight);
        const scaledWidth = imgWidth * scale;
        const scaledHeight = imgHeight * scale;

        const x = margin + (maxWidth - scaledWidth) / 2;
        const y = margin + (maxHeight - scaledHeight) / 2;
        page.drawImage(pdfImage, { x, y, width: scaledWidth, height: scaledHeight });

        // The image's placement, as the matrix the text items are relative to
        if (withText) {
            drawTextLayer(pdfDoc, page, img.texts, [scaledWidth, 0, 0, scaledHeight, x, y]);
        }
    }
    if (withText) finalizeTextLayer(pdfDoc);
    return pdfDoc;
}

// Strip the info dictionary and serialise to a Blob
export async function cleanSavePdf(pdfDoc) {
    const infoDict = pdfDoc.context.lookup(pdfDoc.getInfoDict());
    METADATA_FIELDS.forEach((field) => {
        const fieldName = PDFName.of(field);
        if (infoDict.has(fieldName)) {
            infoDict.delete(fieldName);
        }
    });
    const pdfBytes = await pdfDoc.save({
        useObjectStreams: true // use object streams for better compression
    });
    return new Blob([pdfBytes], { type: 'application/pdf' });
}
