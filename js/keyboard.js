// Keyboard shortcuts. Arrows drive the option cursor; the bracketed keys shown
// next to each option are also accepted directly.

import { moveSelection, endKeyNav, activateSelection, adjustSelection } from './terminal.js';

/**
 * @param handlers  { getStage, getDoneMode, selectFile, proceed, startRun, retry,
 *                    toggleSettings, changeSettings, downloadPdf, downloadImages,
 *                    downloadZip, cancel, reset }
 */
export function installKeyboard(handlers) {
    document.addEventListener('keydown', (e) => {
        // While a field has the focus its letters are what is being typed, not
        // shortcuts — `s` belongs to the password, not to the settings panel.
        // Enter is the form's own submit and Escape still means "get me out",
        // so those two are the only ones that carry on past here.
        if (e.target instanceof HTMLInputElement && e.key !== 'Escape') return;

        const stage = handlers.getStage();

        // Standard Ctrl+Z / Cmd+Z undo accelerator on arrange screen
        const isUndoCombo = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'z' || e.key === 'Z');
        if (isUndoCombo && stage === 'arrange') {
            if (handlers.canUndo?.()) {
                handlers.undo?.();
                e.preventDefault();
            }
            return;
        }

        // Redo accelerators on arrange screen: Ctrl+Y / Cmd+Y, Ctrl+Shift+Z / Cmd+Shift+Z
        const isRedoCombo = ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'y' || e.key === 'Y'))
            || ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.key === 'z' || e.key === 'Z'));
        if (isRedoCombo && stage === 'arrange') {
            if (handlers.canRedo?.()) {
                handlers.redo?.();
                e.preventDefault();
            }
            return;
        }

        if (e.ctrlKey || e.metaKey || e.altKey) return;
        let handled = false;

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
        } else if (stage === 'arrange') {
            if (e.key === 'Enter') { handlers.proceed(); handled = true; }
            else if (e.key === 'u' || e.key === 'U') {
                if (handlers.canUndo?.()) { handlers.undo?.(); handled = true; }
            }
            else if (e.key === 'f' || e.key === 'F') { handlers.selectFile(); handled = true; }
            else if (e.key === '0') { handlers.reset(); handled = true; }
            else if (handlers.getAllPdfs?.()) {
                if (e.key === 'm' || e.key === 'M') { handlers.setArrangeMode?.('merge'); handled = true; }
                else if (e.key === 'b' || e.key === 'B') { handlers.setArrangeMode?.('batch'); handled = true; }
            }
        } else if (stage === 'sample') {
            // No `s` here: the panel this screen is built around is already
            // open, so there is nothing for the key to reach
            if (e.key === 'Enter') { handlers.startRun(); handled = true; }
            else if (e.key === 'f' || e.key === 'F') { handlers.selectFile(); handled = true; }
            else if (e.key === '0') { handlers.reset(); handled = true; }
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
