// Assemble the extracted page images into a fresh, metadata-free PDF.

import { PDFDocument, PDFName } from '../vendor.js';
import {
    PORTRAIT_WIDTH,
    PORTRAIT_HEIGHT,
    PAGE_MARGIN,
    METADATA_FIELDS,
} from '../config.js';

const LANDSCAPE_WIDTH = PORTRAIT_HEIGHT;
const LANDSCAPE_HEIGHT = PORTRAIT_WIDTH;

/**
 * One A4 page per image, orientation matched to the image, centred within a
 * uniform margin.
 *
 * @param extractedImages  [{ page, blob, width, height }]
 * @param onProgress       (current, total) => void
 */
export async function createNewPdf(extractedImages, onProgress) {
    const pdfDoc = await PDFDocument.create();
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
        const isLandscape = imgWidth > imgHeight;
        const pageWidth = isLandscape ? LANDSCAPE_WIDTH : PORTRAIT_WIDTH;
        const pageHeight = isLandscape ? LANDSCAPE_HEIGHT : PORTRAIT_HEIGHT;

        const page = pdfDoc.addPage([pageWidth, pageHeight]);
        const maxWidth = pageWidth - 2 * PAGE_MARGIN;
        const maxHeight = pageHeight - 2 * PAGE_MARGIN;
        const scale = Math.min(maxWidth / imgWidth, maxHeight / imgHeight);
        const scaledWidth = imgWidth * scale;
        const scaledHeight = imgHeight * scale;

        page.drawImage(pdfImage, {
            x: PAGE_MARGIN + (maxWidth - scaledWidth) / 2,
            y: PAGE_MARGIN + (maxHeight - scaledHeight) / 2,
            width: scaledWidth,
            height: scaledHeight,
        });
    }
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
