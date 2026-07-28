// Keyboard shortcuts. Arrows drive the option cursor; the bracketed keys shown
// next to each option are also accepted directly.

import { moveSelection, endKeyNav, activateSelection, adjustSelection } from './terminal.js';

/**
 * @param handlers  { getStage, getDoneMode, selectFile, retry, canKeepText,
 *                    toggleKeepText, toggleSettings, changeSettings,
 *                    downloadPdf, downloadImages, downloadZip, reset }
 */
export function installKeyboard(handlers) {
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const stage = handlers.getStage();
        let handled = false;

        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            handled = moveSelection(e.key === 'ArrowDown' ? 1 : -1);
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            // Changes the value of whichever row is under the cursor; rows
            // without one leave the key alone
            handled = adjustSelection(e.key === 'ArrowRight' ? 1 : -1);
        } else if (e.key === 'Escape') {
            endKeyNav();
            handled = true;
        } else if (e.key === 'Enter' && activateSelection()) {
            handled = true;
        } else if (stage === 'init' && e.key === 'Enter') {
            handlers.selectFile();
            handled = true;
        } else if (stage === 'init' && (e.key === 's' || e.key === 'S')) {
            handled = handlers.toggleSettings();
        } else if (stage === 'blocked' && (e.key === 'r' || e.key === 'R')) {
            handlers.retry();
            handled = true;
        } else if (stage === 'done') {
            const doneMode = handlers.getDoneMode();
            if (e.key === '0') { handlers.reset(); handled = true; }
            else if (e.key === 's' || e.key === 'S') { handlers.changeSettings(); handled = true; }
            else if (doneMode === 'direct' && e.key === 'Enter') { handlers.downloadPdf(); handled = true; }
            else if (doneMode === 'format') {
                if (e.key === '1') { handlers.downloadPdf(); handled = true; }
                else if (e.key === '2') { handlers.downloadImages(); handled = true; }
                else if (e.key === '3') { handlers.downloadZip(); handled = true; }
                else if ((e.key === 't' || e.key === 'T') && handlers.canKeepText()) {
                    handlers.toggleKeepText();
                    handled = true;
                }
            }
        }

        if (handled) e.preventDefault();
    });
}
