// A regression harness for real files.
//
// Everything in test/*.test.mjs is a unit test over the pure functions, which
// is where the rules live and where a mistake is easiest to reason about. None
// of it touches pdf-lib, and pdf-lib is where this app can damage a document:
// `strip.js` rewrites content streams in place and `sweep.js` deletes every
// object it judges unreachable. Both are correct against every file I could
// write by hand, and neither has ever met a document produced by InDesign, a
// scanner's own firmware, a tax office, or LaTeX.
//
// So this runs the *real* pipeline — the same functions app.js calls, not a
// restatement of them — over a folder of real PDFs, and checks the things that
// have to be true of a cleaned file whatever was in it. It cannot say the
// output is right. It can say the output still opens, still has its pages,
// still draws them, still carries its text and its navigation, and no longer
// carries what it was supposed to lose. That is the set of ways this code is
// likely to be wrong.
//
// It is a page rather than a node script because the pipeline is a browser
// pipeline: OffscreenCanvas, createImageBitmap and a pdf.js worker are not
// incidental to it, they are how it works.

import { pdfjsLib, PDFDocument, PDFName, PDFDict, vendorReady } from '../js/vendor.js';
import { extractImages } from '../js/pdf/extract.js';
import { createNewPdf, cleanSavePdf } from '../js/pdf/build.js';
import { stripMarks } from '../js/pdf/strip.js';
import { removeMarks, keepText, pageLayout } from '../js/settings.js';

// Rendering every page of every file twice is the slow part, and past a point
// it stops telling us anything new — a document that is going to be damaged is
// damaged on a page we have already looked at.
const MAX_PAGES_CHECKED = 25;
// Pages are rendered small: this is looking for a page that went blank or lost
// a block, not for a changed hairline.
const INK_SCALE = 0.35;
// Anything at or above this in every channel counts as paper rather than ink.
const WHITE = 245;

// How much of a page's ink may go before it is worth a human looking. Removing
// a watermark legitimately removes some, and a stamp across a sparse page can
// be a surprising share of what was on it.
const INK_WARN = 0.20;
const INK_FAIL = 0.60;
// Below this a page is, to any practical purpose, blank.
const INK_BLANK = 0.005;

const state = { rows: [], running: false, cancel: false };

// === Measuring a document ===

/** Open bytes with pdf.js. The caller destroys it. */
function open(bytes) {
    return pdfjsLib.getDocument({
        data: bytes.slice(0),
        disableFontFace: true,
        isEvalSupported: false,
        verbosity: 0,
    }).promise;
}

/**
 * The share of a page that has ink on it.
 *
 * Annotations are turned off on both sides of the comparison. Removing markup
 * annotations is the tool working, so counting their disappearance as lost ink
 * would flag every successful run; what this is here to catch is the page's own
 * content going missing.
 */
async function inkOf(page) {
    const viewport = page.getViewport({ scale: INK_SCALE, rotation: 0 });
    const canvas = new OffscreenCanvas(
        Math.max(1, Math.ceil(viewport.width)),
        Math.max(1, Math.ceil(viewport.height)),
    );
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({
        canvasContext: context,
        viewport,
        intent: 'print',
        annotationMode: pdfjsLib.AnnotationMode.DISABLE,
    }).promise;

    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let inked = 0;
    for (let i = 0; i < data.length; i += 4) {
        if (data[i] < WHITE || data[i + 1] < WHITE || data[i + 2] < WHITE) inked++;
    }
    return inked / (canvas.width * canvas.height);
}

// Text as one normalized run per page, so a difference in how items were split
// is not read as a difference in what they said.
function normalize(text) {
    return text.replace(/\s+/g, ' ').trim();
}

/**
 * Everything about a document that the checks below compare.
 *
 * `renderError` is recorded rather than thrown: a page that will not draw is a
 * finding, and one bad page should not cost us the measurements of the rest.
 */
async function measure(bytes) {
    const pdf = await open(bytes);
    const limit = Math.min(pdf.numPages, MAX_PAGES_CHECKED);
    const pages = [];
    let renderError = null;

    for (let n = 1; n <= limit; n++) {
        const page = await pdf.getPage(n);
        const entry = { view: page.view.map((v) => Math.round(v * 100) / 100) };
        try {
            entry.text = normalize((await page.getTextContent()).items.map((i) => i.str).join(' '));
            entry.ink = await inkOf(page);
        } catch (err) {
            renderError ??= `page ${n}: ${err?.message || err}`;
        }
        pages.push(entry);
        page.cleanup();
    }

    const meta = await pdf.getMetadata().catch(() => ({ info: {}, metadata: null }));
    const result = { numPages: pdf.numPages, pages, renderError, info: meta.info, xmp: !!meta.metadata };
    await pdf.destroy();
    return result;
}

/**
 * The structural facts the sweep could plausibly get wrong.
 *
 * Every one of these is reachable from the catalog, so a correct reachability
 * walk keeps all of them. That is exactly why they are the things to check: if
 * the walk is missing a root or a container type, this is where it shows.
 */
async function structure(bytes) {
    const doc = await PDFDocument.load(bytes.slice(0), {
        updateMetadata: false, ignoreEncryption: true,
    });
    const catalog = doc.catalog;
    const has = (key, dict = catalog) => {
        try { return !!dict?.get?.(PDFName.of(key)); } catch { return false; }
    };
    const names = (() => {
        try { return catalog.lookupMaybe(PDFName.of('Names'), PDFDict); } catch { return null; }
    })();

    let annots = 0;
    try {
        doc.getPages().forEach((p) => { annots += p.node.Annots()?.asArray?.()?.length ?? 0; });
    } catch { /* unreadable annotations are not a measurement */ }

    return {
        objects: doc.context.enumerateIndirectObjects().length,
        outlines: has('Outlines'),
        acroForm: has('AcroForm'),
        structTree: has('StructTreeRoot'),
        dests: has('Dests') || has('Dests', names),
        pageLabels: has('PageLabels'),
        annots,
        // What must be gone afterwards
        metadata: has('Metadata'),
        openAction: has('OpenAction'),
        additionalActions: has('AA'),
        javascript: has('JavaScript', names),
        embeddedFiles: has('EmbeddedFiles', names),
        id: !!doc.context.trailerInfo.ID,
    };
}

// === Running the pipeline ===
//
// This is app.js's `runPdf`, with the screens taken out and nothing else
// changed. If the two ever disagree the harness is testing a pipeline the app
// does not have, so it is written to be read side by side with that function.

async function clean(buffer) {
    const pdf = await open(buffer);
    try {
        const images = await extractImages(pdf, { pdfBytes: buffer });

        if (images === false) {
            const doc = await PDFDocument.load(buffer);
            const marks = removeMarks() ? stripMarks(doc) : null;
            return { path: 'kept', marks, blob: await cleanSavePdf(doc) };
        }
        if (images.length === 0) return { path: 'no-images', blob: null };

        const doc = await createNewPdf(images);
        return { path: 'rebuilt', pageCount: images.length, blob: await cleanSavePdf(doc) };
    } finally {
        await pdf.destroy();
    }
}

// === The checks ===

const ok = (name, detail = '') => ({ name, level: 'ok', detail });
const warn = (name, detail) => ({ name, level: 'warn', detail });
const fail = (name, detail) => ({ name, level: 'fail', detail });
// A file this harness could not read on the way *in* says nothing about the
// pipeline, and reporting it as a failure is worse than not reporting it: a
// corpus with two odd files in it teaches you to skim past red rows.
const skip = (name, detail) => ({ name, level: 'skip', detail });

/** What must be true whichever path the file took. */
function cleanlinessChecks(after, afterStruct) {
    const left = [
        after.xmp && 'XMP',
        afterStruct.metadata && '/Metadata',
        afterStruct.openAction && '/OpenAction',
        afterStruct.additionalActions && '/AA',
        afterStruct.javascript && '/JavaScript',
        afterStruct.embeddedFiles && '/EmbeddedFiles',
        afterStruct.id && 'trailer /ID',
    ].filter(Boolean);

    const infoLeft = Object.entries(after.info || {})
        .filter(([k, v]) => ['Title', 'Author', 'Producer', 'Creator', 'CreationDate', 'ModDate', 'Subject', 'Keywords'].includes(k)
            && v !== undefined && v !== null && String(v).trim() !== '')
        .map(([k]) => k);

    return [
        left.length ? fail('cleaned', `still carries ${left.join(', ')}`) : ok('cleaned'),
        infoLeft.length ? fail('info gone', `still set: ${infoLeft.join(', ')}`) : ok('info gone'),
    ];
}

/**
 * The comparison for a file whose pages were handed back as they were.
 *
 * This is the path the risky code runs on, so this is where the checks are.
 */
function keptChecks(before, after, beforeStruct, afterStruct, marks) {
    const checks = [];

    if (after.numPages !== before.numPages) {
        checks.push(fail('page count', `${before.numPages} → ${after.numPages}`));
    } else {
        checks.push(ok('page count', String(after.numPages)));
    }

    if (after.renderError) checks.push(fail('renders', after.renderError));
    else checks.push(ok('renders'));

    const n = Math.min(before.pages.length, after.pages.length);

    const moved = [];
    for (let i = 0; i < n; i++) {
        if (before.pages[i].view.join() !== after.pages[i].view.join()) {
            moved.push(`p${i + 1} ${before.pages[i].view.join(',')} → ${after.pages[i].view.join(',')}`);
        }
    }
    checks.push(moved.length ? fail('geometry', moved.slice(0, 3).join('; ')) : ok('geometry'));

    // Ink, page by page. A page that went blank is the failure this whole
    // harness exists for.
    let worst = { drop: 0, page: 0, from: 0, to: 0 };
    let blanked = null;
    for (let i = 0; i < n; i++) {
        const from = before.pages[i].ink ?? 0;
        const to = after.pages[i].ink ?? 0;
        if (from <= 0) continue;
        const drop = (from - to) / from;
        if (drop > worst.drop) worst = { drop, page: i + 1, from, to };
        if (from > 0.01 && to < INK_BLANK) blanked ??= i + 1;
    }
    const pct = (x) => `${Math.round(x * 100)}%`;
    const inkDetail = worst.drop > 0
        ? `worst p${worst.page}: ${pct(worst.from)} → ${pct(worst.to)} of page (−${pct(worst.drop)})`
        : 'no page lost ink';
    if (blanked) checks.push(fail('ink', `p${blanked} went blank; ${inkDetail}`));
    else if (worst.drop >= INK_FAIL) checks.push(fail('ink', inkDetail));
    else if (worst.drop >= INK_WARN) checks.push(warn('ink', inkDetail));
    else checks.push(ok('ink', inkDetail));

    // Text. Losing some is expected when a watermark went; losing it on a page
    // where nothing was removed is not.
    const lost = [];
    for (let i = 0; i < n; i++) {
        const b = before.pages[i].text ?? '';
        const a = after.pages[i].text ?? '';
        if (b && a.length < b.length) {
            const missing = b.split(' ').filter((w) => w && !a.includes(w));
            if (missing.length) lost.push(`p${i + 1}: ${missing.slice(0, 6).join(' ')}`);
        }
    }
    if (!lost.length) checks.push(ok('text kept'));
    else if (marks && (marks.blocks || marks.annotations)) {
        checks.push(warn('text kept', `lost (marks were removed, check it was the mark) — ${lost.slice(0, 2).join(' | ')}`));
    } else {
        checks.push(fail('text kept', `lost with nothing removed — ${lost.slice(0, 2).join(' | ')}`));
    }

    // The sweep's own risk: a structure that was reachable and now is not.
    const dropped = [
        beforeStruct.outlines && !afterStruct.outlines && 'outlines',
        beforeStruct.acroForm && !afterStruct.acroForm && 'form fields',
        beforeStruct.structTree && !afterStruct.structTree && 'structure tree',
        beforeStruct.dests && !afterStruct.dests && 'named destinations',
        beforeStruct.pageLabels && !afterStruct.pageLabels && 'page labels',
    ].filter(Boolean);
    checks.push(dropped.length
        ? fail('navigation', `swept away: ${dropped.join(', ')}`)
        : ok('navigation'));

    return checks;
}

/**
 * The comparison for a scan that was rebuilt out of its page images.
 *
 * Geometry and text are deliberately not compared: the page is re-laid onto the
 * chosen sheet and the text becomes an invisible layer over a picture, so both
 * differ by design. Ink cannot be compared as a fraction either — the same
 * content on a new sheet with new margins covers a different share of it.
 *
 * What can still be said is that a page which had something on it must not come
 * back blank. That is the shape the dangerous failure takes here: a born-digital
 * page mistaken for a scan comes back as whichever image was largest, and if
 * that image was a background or a watermark the page arrives empty. It is the
 * one failure in this whole app that is reported as a success.
 */
function rebuiltChecks(before, after, expectedPages) {
    const n = Math.min(before.pages.length, after.pages.length);
    let blanked = null;
    for (let i = 0; i < n && !blanked; i++) {
        if ((before.pages[i].ink ?? 0) > 0.01 && (after.pages[i].ink ?? 0) < INK_BLANK) blanked = i + 1;
    }

    return [
        after.numPages === expectedPages
            ? ok('page count', String(after.numPages))
            : fail('page count', `${expectedPages} extracted → ${after.numPages} in file`),
        after.renderError ? fail('renders', after.renderError) : ok('renders'),
        blanked
            ? fail('not blank', `p${blanked} had ink and came back empty — page probably not a scan`)
            : ok('not blank'),
    ];
}

// === One file ===

async function checkFile(file) {
    const started = performance.now();
    const row = { name: file.name, size: file.size, checks: [], path: '?', notes: [] };

    try {
        const buffer = await file.arrayBuffer();

        // Read the input first and on its own. A file no reader will open is
        // not a result about this pipeline, and it has to be told apart from a
        // file the pipeline broke — those are the same exception otherwise.
        let before;
        let beforeStruct;
        try {
            before = await measure(buffer);
            beforeStruct = await structure(buffer);
        } catch (err) {
            row.path = 'unreadable';
            row.checks.push(skip('input', `not a readable PDF: ${err?.message || err}`));
            return row;
        }

        const result = await clean(buffer);
        row.path = result.path;
        row.marks = result.marks;

        if (!result.blob) {
            row.checks.push(warn('produced output', 'no page image could be extracted'));
            return row;
        }

        const out = new Uint8Array(await result.blob.arrayBuffer());
        row.outSize = out.length;

        let after;
        try {
            after = await measure(out);
        } catch (err) {
            row.checks.push(fail('opens', `output will not parse: ${err?.message || err}`));
            return row;
        }
        const afterStruct = await structure(out);
        row.checks.push(ok('opens'));
        row.objects = `${beforeStruct.objects} → ${afterStruct.objects}`;

        if (result.path === 'kept') {
            row.checks.push(...keptChecks(before, after, beforeStruct, afterStruct, result.marks));
        } else {
            row.checks.push(...rebuiltChecks(before, after, result.pageCount));
        }
        row.checks.push(...cleanlinessChecks(after, afterStruct));

        if (before.numPages > MAX_PAGES_CHECKED) {
            row.notes.push(`only the first ${MAX_PAGES_CHECKED} of ${before.numPages} pages compared`);
        }
    } catch (err) {
        row.checks.push(fail('ran', String(err?.message || err)));
    } finally {
        row.ms = Math.round(performance.now() - started);
    }
    return row;
}

// === Reporting ===

const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

function worstLevel(checks) {
    if (checks.some((c) => c.level === 'fail')) return 'fail';
    if (checks.some((c) => c.level === 'warn')) return 'warn';
    // A skipped input has no other checks to outrank it
    if (checks.some((c) => c.level === 'skip')) return 'skip';
    return 'ok';
}

function renderRow(row) {
    const level = worstLevel(row.checks);
    const wrap = el('div', `row ${level}`);

    const head = el('div', 'head');
    head.append(
        el('span', `badge ${level}`, level.toUpperCase()),
        el('span', 'name', row.name),
        el('span', 'meta', [
            row.path,
            `${(row.size / 1024).toFixed(0)} KB${row.outSize ? ` → ${(row.outSize / 1024).toFixed(0)} KB` : ''}`,
            row.objects ? `objects ${row.objects}` : '',
            row.marks ? `marks ${row.marks.annotations}a/${row.marks.blocks}b/${row.marks.pages}p` : '',
            `${row.ms} ms`,
        ].filter(Boolean).join('  ·  ')),
    );
    wrap.append(head);

    const list = el('div', 'checks');
    row.checks.forEach((c) => {
        const item = el('div', `check ${c.level}`);
        item.append(el('span', 'k', c.name), el('span', 'v', c.detail || ''));
        list.append(item);
    });
    row.notes.forEach((n) => list.append(el('div', 'check note', n)));
    wrap.append(list);
    return wrap;
}

function renderSummary() {
    const counts = { ok: 0, warn: 0, fail: 0, skip: 0 };
    state.rows.forEach((r) => { counts[worstLevel(r.checks)]++; });
    const paths = state.rows.reduce((m, r) => ({ ...m, [r.path]: (m[r.path] ?? 0) + 1 }), {});
    document.getElementById('summary').textContent =
        `${state.rows.length} files — ${counts.fail} fail, ${counts.warn} warn, ` +
        `${counts.ok} ok, ${counts.skip} skipped` +
        `   ·   ${Object.entries(paths).map(([k, v]) => `${v} ${k}`).join(', ')}`;
}

async function run(files) {
    if (state.running) return;
    state.running = true;
    state.cancel = false;
    state.rows = [];

    const results = document.getElementById('results');
    results.replaceChildren();
    const progress = document.getElementById('progress');

    const pdfs = files.filter((f) => f.name.toLowerCase().endsWith('.pdf'));
    for (let i = 0; i < pdfs.length; i++) {
        if (state.cancel) break;
        progress.textContent = `${i + 1} / ${pdfs.length}  ${pdfs[i].name}`;
        const row = await checkFile(pdfs[i]);   // eslint-disable-line no-await-in-loop
        state.rows.push(row);
        results.append(renderRow(row));
        renderSummary();
    }
    progress.textContent = state.cancel ? 'cancelled' : 'done';
    state.running = false;
}

function settingsLine() {
    const layout = pageLayout();
    return `remove marks: ${removeMarks() ? 'on' : 'OFF — strip.js is not being exercised'}` +
        `  ·  keep text: ${keepText() ? 'on' : 'off'}` +
        `  ·  paper: ${layout.paper ? layout.paper.join('x') : 'fit'}`;
}

// === Wiring ===

(async function start() {
    const status = document.getElementById('status');
    if (!await vendorReady) {
        status.textContent = 'libraries failed to load — check the console';
        return;
    }
    status.textContent = `pdf.js ${pdfjsLib.version}   ·   ${settingsLine()}`;

    const pick = (input) => {
        input.addEventListener('change', () => run(Array.from(input.files || [])));
    };
    pick(document.getElementById('files'));
    pick(document.getElementById('folder'));

    // The repeatable path: drop files in test/corpus/, list them, and this runs
    // the same set every time. A picker is fine for a one-off look and useless
    // for "did today's change break what last week's change fixed".
    document.getElementById('corpus').addEventListener('click', async () => {
        const progress = document.getElementById('progress');
        try {
            const list = await (await fetch('corpus/list.txt')).text();
            const names = list.split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
            progress.textContent = `fetching ${names.length} files…`;
            const files = [];
            for (const name of names) {
                const response = await fetch(`corpus/${name}`);
                if (!response.ok) { progress.textContent = `missing: ${name}`; continue; }
                files.push(new File([await response.blob()], name, { type: 'application/pdf' }));
            }
            await run(files);
        } catch (err) {
            progress.textContent = `no corpus: ${err?.message || err} — see test/corpus/README`;
        }
    });

    document.getElementById('copy').addEventListener('click', async () => {
        await navigator.clipboard.writeText(JSON.stringify(state.rows, null, 2));
        document.getElementById('copy').textContent = 'copied';
        setTimeout(() => { document.getElementById('copy').textContent = 'copy JSON'; }, 1500);
    });
    document.getElementById('stop').addEventListener('click', () => { state.cancel = true; });
})();
