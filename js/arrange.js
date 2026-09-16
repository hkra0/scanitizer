// Arrange screen data model, thumbnail generation, and reordering.
// Supports images, PDF stacks (with stack visual effect), and expanded PDF page cards.

import { pdfjsLib } from './vendor.js';
import { closeBitmap } from './raster.js';

let nextId = 0;
const thumbUrls = new Set();

/**
 * Renders an image file to a thumbnail JPEG blob URL.
 *
 * @param {File} file
 * @returns {Promise<string|null>}
 */
export async function renderImageThumbnail(file) {
    let bmp = null;
    try {
        bmp = await createImageBitmap(file);
        const maxDim = 160;
        const scale = Math.min(maxDim / bmp.width, maxDim / bmp.height, 1);
        const w = Math.max(1, Math.round(bmp.width * scale));
        const h = Math.max(1, Math.round(bmp.height * scale));

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(bmp, 0, 0, w, h);

        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
        if (!blob) return null;
        const url = URL.createObjectURL(blob);
        thumbUrls.add(url);
        return url;
    } catch (err) {
        console.warn('Thumbnail generation failed for image:', file.name, err);
        return null;
    } finally {
        if (bmp) closeBitmap(bmp);
    }
}

/**
 * Renders a specific page of a PDF document to a thumbnail JPEG blob URL.
 *
 * @param {any} pdfDoc - pdf.js document proxy
 * @param {number} pageNumber - 1-based page number
 * @returns {Promise<string|null>}
 */
export async function renderPdfPageThumbnail(pdfDoc, pageNumber) {
    try {
        const page = await pdfDoc.getPage(pageNumber);
        const unscaled = page.getViewport({ scale: 1 });
        const maxDim = 160;
        const scale = Math.min(maxDim / unscaled.width, maxDim / unscaled.height, 1);
        const viewport = page.getViewport({ scale });

        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        await page.render({
            canvasContext: ctx,
            viewport,
            intent: 'display',
        }).promise;

        page.cleanup();

        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
        if (!blob) return null;
        const url = URL.createObjectURL(blob);
        thumbUrls.add(url);
        return url;
    } catch (err) {
        console.warn(`Thumbnail generation failed for PDF page ${pageNumber}:`, err);
        return null;
    }
}

function readAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(file);
    });
}

function isPdfFile(file) {
    return file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf';
}

/**
 * Builds initial arrange items for a list of files.
 *
 * @param {File[]} files
 * @param {(current: number, total: number) => void} [onProgress]
 * @returns {Promise<{ items: Array<any>, allPdfs: boolean }>}
 */
export async function buildArrangeItems(files, onProgress) {
    const items = [];
    const allPdfs = files.length > 0 && files.every(isPdfFile);

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        onProgress?.(i + 1, files.length);

        if (isPdfFile(file)) {
            try {
                const buffer = await readAsArrayBuffer(file);
                const loadingTask = pdfjsLib.getDocument({
                    data: buffer.slice(0),
                    disableFontFace: true,
                    isEvalSupported: false,
                    verbosity: 0,
                });
                const pdfDoc = await loadingTask.promise;
                const pageCount = pdfDoc.numPages;
                const thumbUrl = await renderPdfPageThumbnail(pdfDoc, 1);
                const pages = Array.from({ length: pageCount }, (_, idx) => idx + 1);

                items.push({
                    id: 'item_' + (++nextId),
                    type: 'pdf-stack',
                    file,
                    buffer,
                    name: file.name,
                    pdfDoc,
                    pageCount,
                    pages,
                    thumbUrl,
                    expanded: false,
                });
            } catch (err) {
                console.error(`Failed to open PDF ${file.name} for arrange:`, err);
            }
        } else {
            const thumbUrl = await renderImageThumbnail(file);
            items.push({
                id: 'item_' + (++nextId),
                type: 'image',
                file,
                name: file.name,
                thumbUrl,
            });
        }
    }

    return { items, allPdfs };
}

/**
 * Expands a PDF stack into individual PDF page cards.
 *
 * @param {Array<any>} items
 * @param {string} stackId
 * @returns {Array<any>} updated items
 */
export function expandPdfStack(items, stackId) {
    const idx = items.findIndex((it) => it.id === stackId && it.type === 'pdf-stack');
    if (idx === -1) return items;

    const stack = items[idx];
    const originalPageCount = stack.pages.length;
    const pageItems = stack.pages.map((pageNum) => ({
        id: 'item_' + (++nextId),
        type: 'pdf-page',
        file: stack.file,
        buffer: stack.buffer,
        name: stack.name,
        pdfDoc: stack.pdfDoc,
        pageNumber: pageNum,
        stackId: stack.id,
        originalPageCount,
        // Reuse page 1 thumb if it matches the first page of the stack
        thumbUrl: (pageNum === stack.pages[0]) ? stack.thumbUrl : null,
    }));

    const nextItems = [...items];
    nextItems.splice(idx, 1, ...pageItems);
    return nextItems;
}

/**
 * Checks if an expanded PDF stack is eligible to be collapsed back.
 * Only allowed if:
 * 1. None of the pages were dragged out (length matches originalPageCount).
 * 2. All pages are still contiguous (no other pages or files inserted in between).
 * 3. The internal order has not been altered (page numbers strictly 1, 2, ... N).
 *
 * @param {Array<any>} items
 * @param {string} stackId
 * @returns {boolean}
 */
export function canCollapsePdf(items, stackId) {
    const matching = [];
    const matchingIndices = [];
    items.forEach((it, idx) => {
        if (it.type === 'pdf-page' && it.stackId === stackId) {
            matching.push(it);
            matchingIndices.push(idx);
        }
    });

    if (matching.length === 0) return false;

    // Check 1: total count must match original
    const expectedCount = matching[0].originalPageCount;
    if (expectedCount && matching.length !== expectedCount) return false;

    // Check 2: must be strictly contiguous (no other items inserted in between)
    const firstIndex = matchingIndices[0];
    const lastIndex = matchingIndices[matchingIndices.length - 1];
    if (lastIndex - firstIndex + 1 !== matching.length) return false;

    // Check 3: internal order must be original ascending order (1, 2, 3...)
    for (let i = 0; i < matching.length; i++) {
        if (matching[i].pageNumber !== i + 1) return false;
    }

    return true;
}

/**
 * Collapses remaining contiguous PDF page cards back into a stack.
 *
 * @param {Array<any>} items
 * @param {string} stackId
 * @returns {Array<any>} updated items
 */
export function collapsePdfPages(items, stackId) {
    if (!canCollapsePdf(items, stackId)) return items;

    const matchingIndices = [];
    items.forEach((it, idx) => {
        if (it.type === 'pdf-page' && it.stackId === stackId) {
            matchingIndices.push(idx);
        }
    });

    if (matchingIndices.length === 0) return items;

    const firstIndex = matchingIndices[0];
    const pages = matchingIndices.map((i) => items[i].pageNumber);
    const sampleItem = items[firstIndex];

    const collapsedStack = {
        id: stackId,
        type: 'pdf-stack',
        file: sampleItem.file,
        buffer: sampleItem.buffer,
        name: sampleItem.name,
        pdfDoc: sampleItem.pdfDoc,
        pageCount: pages.length,
        pages,
        thumbUrl: sampleItem.thumbUrl || null,
        expanded: false,
    };

    const nextItems = items.filter((it, idx) => !matchingIndices.includes(idx));
    const insertPos = Math.min(firstIndex, nextItems.length);
    nextItems.splice(insertPos, 0, collapsedStack);
    return nextItems;
}

/**
 * Inserts an item into a specific slot index (0 to items.length).
 *
 * @param {Array<any>} items
 * @param {number} fromIndex
 * @param {number} targetIndex
 * @returns {Array<any>}
 */
export function insertAt(items, fromIndex, targetIndex) {
    if (fromIndex < 0 || fromIndex >= items.length) return items;
    if (targetIndex < 0) targetIndex = 0;
    if (targetIndex > items.length) targetIndex = items.length;

    if (targetIndex === fromIndex || targetIndex === fromIndex + 1) return items;

    const updated = [...items];
    const [moved] = updated.splice(fromIndex, 1);
    const finalIndex = fromIndex < targetIndex ? targetIndex - 1 : targetIndex;
    updated.splice(finalIndex, 0, moved);
    return updated;
}

/**
 * Counts total individual pages across all items.
 *
 * @param {Array<any>} items
 * @returns {number}
 */
export function totalPageCount(items) {
    let count = 0;
    for (const it of items) {
        if (it.type === 'image') count += 1;
        else if (it.type === 'pdf-stack') count += it.pages.length;
        else if (it.type === 'pdf-page') count += 1;
    }
    return count;
}

/**
 * Flattens arrange items into a sequence of individual pages for processing.
 *
 * @param {Array<any>} items
 * @returns {Array<{
 *   type: 'image' | 'pdf-page',
 *   file: File,
 *   buffer?: ArrayBuffer,
 *   pdf?: any,
 *   pageNumber?: number,
 *   name: string
 * }>}
 */
export function flattenToPages(items) {
    const pages = [];
    for (const it of items) {
        if (it.type === 'image') {
            pages.push({
                type: 'image',
                file: it.file,
                name: it.name,
            });
        } else if (it.type === 'pdf-stack') {
            for (const p of it.pages) {
                pages.push({
                    type: 'pdf-page',
                    file: it.file,
                    buffer: it.buffer,
                    pdf: it.pdfDoc,
                    pageNumber: p,
                    name: `${it.name} (p.${p})`,
                });
            }
        } else if (it.type === 'pdf-page') {
            pages.push({
                type: 'pdf-page',
                file: it.file,
                buffer: it.buffer,
                pdf: it.pdfDoc,
                pageNumber: it.pageNumber,
                name: `${it.name} (p.${it.pageNumber})`,
            });
        }
    }
    return pages;
}

/**
 * Releases all generated thumbnail Object URLs to prevent memory leaks.
 */
export function releaseArrangeThumbs() {
    thumbUrls.forEach((url) => {
        try {
            URL.revokeObjectURL(url);
        } catch (_) {}
    });
    thumbUrls.clear();
}

/**
 * Destroys all pdf.js document proxies loaded for arrange items.
 *
 * @param {Array<any>} items
 */
export function destroyArrangePdfs(items) {
    if (!items) return;
    const closed = new Set();
    for (const it of items) {
        if (it.pdfDoc && !closed.has(it.pdfDoc)) {
            closed.add(it.pdfDoc);
            try {
                it.pdfDoc.destroy();
            } catch (_) {}
        }
    }
}

/**
 * Removes an item by its ID from the items list.
 *
 * @param {Array<any>} items
 * @param {string} itemId
 * @returns {Array<any>}
 */
export function removeItem(items, itemId) {
    return items.filter((it) => it.id !== itemId);
}

