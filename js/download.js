// Saving to disk. Everything is produced in-page as a Blob and handed to an
// anchor click — no server, no upload.

import { JSZip, jszipReady } from './vendor.js';
import { DOWNLOAD_INTERVAL, URL_LIFETIME } from './config.js';

/**
 * A blob URL handed to a `download` click — the browser's own download, straight
 * to wherever it puts downloads, no dialog.
 *
 * `download` is only a hint: a blob URL carrying a type the browser can render
 * (a PDF above all) is opened in a tab instead by several of them. Re-typing the
 * bytes as an opaque stream leaves nothing to render, so the download is the
 * only thing left to do. The name still carries the real extension, which is
 * what decides the file's type once it has landed.
 */
function saveViaAnchor(blob, name) {
    const url = URL.createObjectURL(
        new Blob([blob], { type: 'application/octet-stream' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoking synchronously kills the download before it starts in Firefox
    // and some WebKit builds, so let the click settle first
    setTimeout(() => URL.revokeObjectURL(url), URL_LIFETIME);
}

/** One finished file, downloaded. */
export function saveFile(blob, name) {
    saveViaAnchor(blob, name);
}

export function pageFileName(baseName, index) {
    return `${baseName}_${String(index + 1).padStart(3, '0')}.jpg`;
}

// Strip the extension so outputs are named after the input
export function baseNameOf(fileName) {
    return fileName.replace(/\.[^/.]+$/, '');
}

/**
 * One file per page. Browsers throttle bursts of downloads, so they are spaced
 * out and reported through `onProgress`.
 */
export async function downloadImages(images, baseName, onProgress) {
    for (let i = 0; i < images.length; i++) {
        onProgress?.(i + 1, images.length);
        saveViaAnchor(images[i].blob, pageFileName(baseName, i));
        await new Promise((r) => setTimeout(r, DOWNLOAD_INTERVAL));
    }
}

/**
 * Every page in one archive.
 *
 * `onProgress` is handed straight to JSZip's own update callback, which is the
 * only visibility there is into a step that would otherwise be a bare spinner
 * however long it took. It is also where a cancel gets noticed: the reporter throws
 * from inside the callback, which rejects `generateAsync` — so the archive is
 * abandoned mid-build rather than being finished and then thrown away.
 */
export async function downloadZip(images, baseName, onProgress) {
    // jszip is loaded in the background, and this is the only thing that needs
    // it — by the time a file has been processed it has long since arrived
    if (!(await jszipReady)) throw new Error('jszip unavailable');
    const zip = new JSZip();
    images.forEach((img, i) => {
        zip.file(pageFileName(baseName, i), img.blob);
    });
    const zipBlob = await zip.generateAsync({ type: 'blob' }, (meta) => {
        onProgress?.(Math.round(meta.percent), 100);
    });
    saveViaAnchor(zipBlob, `${baseName}_images.zip`);
}
