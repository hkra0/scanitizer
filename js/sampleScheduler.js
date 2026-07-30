// One pass of the sample in flight at a time, and at most one queued behind it.
//
// Holding an arrow key down cycles a setting faster than a page can be encoded,
// and what that should produce is the page for the value the key comes to rest
// on — not a queue of pages for every value it passed through.
//
// == Why this is a module and not four variables next to the app state ==
//
// The sample shares everything it touches with what comes after it: the run
// reads the same document, and a new file closes it. pdf.js does not fail a
// read whose document is destroyed underneath it — it simply never answers — so
// an abandoned pass cannot merely be forgotten, it has to be waited out. That
// makes two separate things necessary, and getting either wrong is silent:
//
//   the token    says the answer is no longer wanted, so a pass that finishes
//                late paints nothing over the screen that replaced it
//   the promise  says the document is free, so whoever wants to destroy it can
//                wait for the read still in flight
//
// Neither is enforceable while they are loose variables — every new caller has
// to remember to bump one and await the other. Here they are behind three
// methods, and the callbacks below are the only way a result reaches the app:
// `show` is never handed a superseded result, and a superseded result is always
// handed to `drop`. The discipline is the interface rather than a convention.

/**
 * @param ready  () => boolean — whether there is anything to sample at all.
 *               Asked before a burst starts, so a request made with no source
 *               open costs nothing and leaves the screen exactly as it was:
 *               `busy` is not announced for work that is not going to happen.
 * @param pass   async () => result — one pass of the work. Takes nothing;
 *               whatever it needs it closes over, and it is called again
 *               whenever a request arrived while it was running.
 *
 * The four places a result can end up, in the order they are reached:
 *
 * @param keep   (result) => void — this pass survived the token check. Hold on
 *               to anything in it that would make the next pass cheaper. Called
 *               for every surviving pass, including ones already superseded by
 *               a queued request, because the expensive part of a pass is worth
 *               keeping even when its output is not.
 * @param show   (result) => void — the burst has settled on this one. The only
 *               place a result is painted, and never called with a stale or
 *               superseded one.
 * @param drop   (result) => void — this pass finished after the question
 *               changed. Whatever it holds has to be released here: nothing
 *               else has a reference to it.
 * @param fail   (err) => void — `pass` threw and the answer is still wanted.
 *               A throw from a superseded pass is swallowed, since there is no
 *               longer a screen for it to report to.
 *
 * @param busy   () => void — a burst has started and there is nothing to show
 *               yet. Fires once per burst, not once per pass.
 */
export function createSampleScheduler({ ready, pass, keep, show, drop, fail, busy }) {
    let running = false;
    let stale = false;

    // Bumped whenever the sample stops being of what is on screen: a new file,
    // the run starting, the way back to the start screen
    let token = 0;

    // The pass in flight, and the reason there is one to await at all
    let pending = Promise.resolve();

    async function run(myToken) {
        // Before `running` and before `busy`: a burst that has nothing to work
        // on must leave no trace, not even the notice that it started
        if (ready && !ready()) return;
        running = true;
        busy?.();
        try {
            let result;
            do {
                // Cleared before the pass rather than after it, so a request
                // arriving *during* the pass is the one that queues another
                stale = false;
                result = await pass();
                if (myToken !== token) {
                    drop?.(result);
                    return;
                }
                keep?.(result);
            } while (stale);
            show?.(result);
        } catch (err) {
            if (myToken === token) fail?.(err);
        } finally {
            running = false;
        }
    }

    return {
        /**
         * Ask for a pass. While one is running this only marks the result
         * stale, so a burst of requests costs one extra pass rather than one
         * each.
         *
         * @returns  a promise for the burst, the queued pass included — the
         *           queued pass runs inside the one already going, so the
         *           promise the caller is handed covers both
         */
        refresh() {
            if (running) stale = true;
            else pending = run(token);
            return pending;
        },

        /**
         * Say that whatever is in flight is no longer of what is on screen.
         *
         * This does not stop the pass and does not wait for it — it cannot do
         * either. It only guarantees that nothing the pass produces will be
         * shown or kept. To know the shared document is free, await `settled`.
         */
        invalidate() {
            token++;
            stale = false;
        },

        /** Resolves when nothing is in flight, so the shared source is free. */
        settled() {
            return pending;
        },
    };
}
