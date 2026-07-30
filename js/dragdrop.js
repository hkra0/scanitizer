// Dropping a file anywhere on the window.
//
// The whole window is the target, not a marked-out rectangle: there is only one
// thing on the page to drop onto, so asking the user to aim is asking for
// nothing.
//
// The files come back out as a plain array and nothing here knows what happens
// to them. The app hands them to the same input the picker fills, so everything
// downstream — the file label, `[s]` running the same file again — works without
// knowing where the files came from.

const DROP_TYPES = /^(application\/pdf|image\/)/;

function acceptedFiles(dataTransfer) {
    return Array.from(dataTransfer?.files || []).filter(
        (file) => DROP_TYPES.test(file.type) || file.name.toLowerCase().endsWith('.pdf'),
    );
}

/**
 * @param enabled     () => boolean — whether a drop makes sense on the screen
 *                    that is up. Asked on every event rather than set once,
 *                    since it follows the stage.
 * @param onFiles     (files) => void — a non-empty array of PDFs and images
 * @param onRejected  () => void — something was dropped, but nothing in it was
 *                    a file this app can open
 */
export function installDragAndDrop({ enabled, onFiles, onRejected }) {
    // dragenter/dragleave fire for every element the pointer crosses, so the
    // depth is counted rather than the events trusted
    let depth = 0;

    const setDragging = (on) => document.body.classList.toggle('dragging', on);

    document.addEventListener('dragenter', (e) => {
        if (!enabled() || !e.dataTransfer?.types.includes('Files')) return;
        e.preventDefault();
        depth++;
        setDragging(true);
    });

    document.addEventListener('dragover', (e) => {
        if (!enabled() || !e.dataTransfer?.types.includes('Files')) return;
        // Without this the browser keeps the drop for itself and navigates away
        // from the page, losing whatever was on screen
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    });

    document.addEventListener('dragleave', () => {
        depth = Math.max(0, depth - 1);
        if (depth === 0) setDragging(false);
    });

    document.addEventListener('drop', (e) => {
        if (!enabled()) return;
        e.preventDefault();
        depth = 0;
        setDragging(false);

        const files = acceptedFiles(e.dataTransfer);
        if (files.length === 0) onRejected();
        else onFiles(files);
    });
}
