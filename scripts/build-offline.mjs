#!/usr/bin/env node

/**
 * Build script to generate `scanitizer-offline.html`:
 * A self-contained, single-file HTML version of scanitizer containing all CSS,
 * application logic, and vendor libraries (pdf-lib, jszip, pdf.js, and an inlined
 * Blob worker for pdf.worker).
 *
 * Runs completely offline without any network access or server setup,
 * suitable for air-gapped computers or USB storage.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const VENDOR_CACHE_DIR = path.resolve(__dirname, 'vendor_cache');
const OUTPUT_FILE = path.resolve(ROOT_DIR, 'scanitizer-offline.html');

const VENDORS = [
    {
        name: 'pdf-lib',
        file: 'pdf-lib.min.js',
        url: 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js',
        integrity: 'sha384-weMABwrltA6jWR8DDe9Jp5blk+tZQh7ugpCsF3JwSA53WZM9/14PjS5LAJNHNjAI',
    },
    {
        name: 'jszip',
        file: 'jszip.min.js',
        url: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
        integrity: 'sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG',
    },
    {
        name: 'pdf.js',
        file: 'pdf.min.mjs',
        url: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs',
        integrity: 'sha384-+0ti2moQlmLN7WZHE2RHIf5lV8hHxhxEalN0il3YZceG26fUPyOkR0hp9daxk1i7',
    },
    {
        name: 'pdf.worker',
        file: 'pdf.worker.min.mjs',
        url: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs',
        integrity: 'sha384-ToeVvShCxKc6CEvhHeMt0Q8A06pSPDbAlngO9nokrDmh914gk/pYd0N7D0a4Lz2o',
    },
];

function verifyHash(buffer, expectedIntegrity) {
    const [algo, expectedBase64] = expectedIntegrity.split('-');
    const hash = crypto.createHash(algo).update(buffer).digest('base64');
    return hash === expectedBase64;
}

async function ensureVendors() {
    if (!fs.existsSync(VENDOR_CACHE_DIR)) {
        fs.mkdirSync(VENDOR_CACHE_DIR, { recursive: true });
    }

    for (const item of VENDORS) {
        const filePath = path.join(VENDOR_CACHE_DIR, item.file);
        let valid = false;

        if (fs.existsSync(filePath)) {
            const existingBuf = fs.readFileSync(filePath);
            if (verifyHash(existingBuf, item.integrity)) {
                valid = true;
                console.log(`[cache] ${item.name} (${item.file}) verified`);
            } else {
                console.warn(`[cache] ${item.name} hash mismatch, re-fetching...`);
            }
        }

        if (!valid) {
            console.log(`[fetch] Downloading ${item.name} from ${item.url}...`);
            const res = await fetch(item.url);
            if (!res.ok) {
                throw new Error(`Failed to download ${item.name}: HTTP ${res.status}`);
            }
            const buf = Buffer.from(await res.arrayBuffer());
            if (!verifyHash(buf, item.integrity)) {
                throw new Error(`Integrity check failed for downloaded ${item.name}`);
            }
            fs.writeFileSync(filePath, buf);
            console.log(`[fetch] ${item.name} verified and saved to cache`);
        }
    }
}

function safeScript(content) {
    return content.replace(/<\/script/gi, '<\\/script');
}

function safeStyle(content) {
    return content.replace(/<\/style/gi, '<\\/style');
}

async function build() {
    console.log('--- scanitizer offline single-file builder ---');
    await ensureVendors();

    console.log('[bundle] Transpiling pdf.min.mjs to IIFE window.pdfjsLib...');
    const pdfJsPath = path.join(VENDOR_CACHE_DIR, 'pdf.min.mjs');
    const pdfJsBundle = execSync(
        `npx -y esbuild "${pdfJsPath}" --bundle --format=iife --global-name=pdfjsLib`,
        { cwd: ROOT_DIR, maxBuffer: 50 * 1024 * 1024, encoding: 'utf8' }
    );

    console.log('[bundle] Bundling application modules (app.js)...');
    const appJsPath = path.join(ROOT_DIR, 'js', 'app.js');
    const appJsBundle = execSync(
        `npx -y esbuild "${appJsPath}" --bundle --format=iife`,
        { cwd: ROOT_DIR, maxBuffer: 50 * 1024 * 1024, encoding: 'utf8' }
    );

    console.log('[read] Reading CSS and vendor scripts...');
    const baseCss = fs.readFileSync(path.join(ROOT_DIR, 'css', 'base.css'), 'utf8');
    const termCss = fs.readFileSync(path.join(ROOT_DIR, 'css', 'terminal.css'), 'utf8');

    const pdfLibJs = fs.readFileSync(path.join(VENDOR_CACHE_DIR, 'pdf-lib.min.js'), 'utf8');
    const jszipJs = fs.readFileSync(path.join(VENDOR_CACHE_DIR, 'jszip.min.js'), 'utf8');
    const pdfWorkerJs = fs.readFileSync(path.join(VENDOR_CACHE_DIR, 'pdf.worker.min.mjs'), 'utf8');

    const workerJson = JSON.stringify(pdfWorkerJs);

    console.log('[assemble] Generating single-file HTML...');

    const offlineHtml = `<!DOCTYPE html>
<html lang="en">

<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>scanitizer (offline)</title>
    <meta name="description" content="Scanned PDF cleanup in the browser. Fully offline, nothing is uploaded.">

    <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 script-src 'unsafe-inline' blob: 'wasm-unsafe-eval';
                 worker-src blob:;
                 style-src 'unsafe-inline';
                 img-src blob:;
                 base-uri 'none';
                 form-action 'none';
                 connect-src 'none'">

    <style>
${safeStyle(baseCss)}
${safeStyle(termCss)}
    </style>

    <script id="lib-pdflib">
${safeScript(pdfLibJs)}
    </script>

    <script id="lib-jszip">
${safeScript(jszipJs)}
    </script>

    <script id="lib-pdfjs">
${safeScript(pdfJsBundle)}
    </script>
</head>

<body>
    <input type="file" id="fileInput" accept=".pdf,image/*,.jpg,.jpeg,.png,.webp,.bmp" multiple />

    <h1 class="sr-only">scanitizer</h1>

    <div class="term-win">
        <div class="term-body">
            <div id="term"></div>
        </div>
    </div>

    <script id="lib-scanitizer-offline-config">
window.__SCANITIZER_OFFLINE__ = true;
window.__SCANITIZER_WORKER_CODE__ = ${safeScript(workerJson)};
    </script>

    <script id="app-bundle">
${safeScript(appJsBundle)}
    </script>
</body>

</html>
`;

    fs.writeFileSync(OUTPUT_FILE, offlineHtml, 'utf8');
    const stats = fs.statSync(OUTPUT_FILE);
    const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);
    console.log(`[done] Successfully built ${OUTPUT_FILE} (${sizeMb} MB)`);
}

build().catch((err) => {
    console.error('Build failed:', err);
    process.exit(1);
});
