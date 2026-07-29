// Keyboard shortcuts. Arrows drive the option cursor; the bracketed keys shown
// next to each option are also accepted directly.

import { moveSelection, endKeyNav, activateSelection, adjustSelection } from './terminal.js';

/**
 * @param handlers  { getStage, getDoneMode, selectFile, proceed, retry, toggleSettings,
 *                    changeSettings, downloadPdf, downloadImages, downloadZip,
 *                    cancel, reset }
 */
export function installKeyboard(handlers) {
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const stage = handlers.getStage();
        let handled = false;

        // While a field has the focus its letters are what is being typed, not
        // shortcuts — `s` belongs to the password, not to the settings panel.
        // Enter is the form's own submit and Escape still means "get me out",
        // so those two are the only ones that carry on past here.
        if (e.target instanceof HTMLInputElement && e.key !== 'Escape') return;

        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            handled = moveSelection(e.key === 'ArrowDown' ? 1 : -1);
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            // Changes the value of whichever row is under the cursor; rows
            // without one leave the key alone
            handled = adjustSelection(e.key === 'ArrowRight' ? 1 : -1);
        } else if (e.key === 'Escape') {
            // Escape means "stop what is going on": during a run that is the
            // run itself, otherwise it is the option cursor
            if (stage === 'processing' || stage === 'downloading' || stage === 'password') {
                handlers.cancel();
            } else {
                endKeyNav();
            }
            handled = true;
        } else if ((e.key === 'Enter' || e.key === ' ') && activateSelection()) {
            // Space as well as Enter: the options carry role="button", and that
            // is the pair a button is expected to answer to
            handled = true;
        } else if (stage === 'init' && e.key === 'Enter') {
            handlers.proceed();
            handled = true;
        } else if (stage === 'init' && (e.key === 'f' || e.key === 'F')) {
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
            }
        }

        if (handled) e.preventDefault();
    });
}
