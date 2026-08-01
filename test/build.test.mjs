// The one decision the builder is not allowed to make: a page that had no scan
// on it may be carried into the output, but it may never be dropped. The
// pages that have to be carried are named here, and the test keeps the naming
// honest — a wrong answer quietly changes the output's page count, which is
// the failure no screen would ever report.

import './browser-globals.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { keptPageNumbers } from '../js/pdf/build.js';

test('keptPageNumbers names every page the extraction skipped', () => {
    assert.deepEqual(
        keptPageNumbers([{ page: 1 }, { page: 3 }], 4),
        [2, 4],
    );
});

test('keptPageNumbers returns nothing for a pure scan', () => {
    assert.deepEqual(
        keptPageNumbers([{ page: 1 }, { page: 2 }, { page: 3 }], 3),
        [],
    );
});

test('keptPageNumbers ignores the order the scans arrived in', () => {
    assert.deepEqual(
        keptPageNumbers([{ page: 5 }, { page: 1 }, { page: 3 }], 5),
        [2, 4],
    );
});

test('keptPageNumbers keeps a leading cover page in its place', () => {
    assert.deepEqual(
        keptPageNumbers([{ page: 2 }, { page: 3 }], 3),
        [1],
    );
});

test('keptPageNumbers counts a document with no scans at all', () => {
    assert.deepEqual(
        keptPageNumbers([], 3),
        [1, 2, 3],
    );
});
