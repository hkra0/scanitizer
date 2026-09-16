import './browser-globals.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    insertAt,
    removeItem,
    canCollapsePdf,
    collapsePdfPages,
    expandPdfStack,
    totalPageCount,
} from '../js/arrange.js';

test('insertAt moves items properly without altering unaffected elements', () => {
    const list = ['A', 'B', 'C', 'D'];

    // Move A (index 0) to slot 3 (between C and D) -> final index is 2
    assert.deepEqual(insertAt(list, 0, 3), ['B', 'C', 'A', 'D']);

    // Move D (index 3) to slot 0 (before A) -> final index is 0
    assert.deepEqual(insertAt(list, 3, 0), ['D', 'A', 'B', 'C']);

    // Move B (index 1) to slot 1 or 2 -> no change
    assert.deepEqual(insertAt(list, 1, 1), ['A', 'B', 'C', 'D']);
    assert.deepEqual(insertAt(list, 1, 2), ['A', 'B', 'C', 'D']);

    // Move B (index 1) to end (slot 4)
    assert.deepEqual(insertAt(list, 1, 4), ['A', 'C', 'D', 'B']);
});

test('removeItem removes target item by id', () => {
    const items = [
        { id: 'item_1', name: 'a.png' },
        { id: 'item_2', name: 'b.pdf' },
        { id: 'item_3', name: 'c.png' },
    ];

    const afterRemove = removeItem(items, 'item_2');
    assert.equal(afterRemove.length, 2);
    assert.deepEqual(afterRemove.map((it) => it.id), ['item_1', 'item_3']);

    // Removing non-existent item returns same elements
    assert.deepEqual(removeItem(items, 'non_existent'), items);
});

test('undo and redo history stacks correctly restore and re-apply states', () => {
    const history = [];
    const redoStack = [];
    let current = [
        { id: 'item_1', name: 'a.png' },
        { id: 'item_2', name: 'b.png' },
    ];

    // Action 1: delete item_2
    history.push(current.slice());
    redoStack.length = 0;
    current = removeItem(current, 'item_2');
    assert.equal(current.length, 1);

    // Undo Action 1
    redoStack.push(current.slice());
    current = history.pop();
    assert.equal(current.length, 2);
    assert.equal(current[1].id, 'item_2');

    // Redo Action 1
    history.push(current.slice());
    current = redoStack.pop();
    assert.equal(current.length, 1);
    assert.equal(current[0].id, 'item_1');

    // Undo again
    redoStack.push(current.slice());
    current = history.pop();
    assert.equal(current.length, 2);

    // New action clears redo stack
    history.push(current.slice());
    redoStack.length = 0;
    current = removeItem(current, 'item_1');
    assert.equal(redoStack.length, 0);
});

test('canCollapsePdf only allows contiguous, complete, ordered pages', () => {
    const stackId = 'stack_1';
    const originalPages = [
        { type: 'pdf-page', stackId, pageNumber: 1, originalPageCount: 3 },
        { type: 'pdf-page', stackId, pageNumber: 2, originalPageCount: 3 },
        { type: 'pdf-page', stackId, pageNumber: 3, originalPageCount: 3 },
    ];

    // Perfect sequence can collapse
    assert.equal(canCollapsePdf(originalPages, stackId), true);

    // Order reversed cannot collapse
    const reordered = [
        { type: 'pdf-page', stackId, pageNumber: 2, originalPageCount: 3 },
        { type: 'pdf-page', stackId, pageNumber: 1, originalPageCount: 3 },
        { type: 'pdf-page', stackId, pageNumber: 3, originalPageCount: 3 },
    ];
    assert.equal(canCollapsePdf(reordered, stackId), false);

    // Interleaved with another item cannot collapse
    const interleaved = [
        { type: 'pdf-page', stackId, pageNumber: 1, originalPageCount: 3 },
        { type: 'image', id: 'img_1' },
        { type: 'pdf-page', stackId, pageNumber: 2, originalPageCount: 3 },
        { type: 'pdf-page', stackId, pageNumber: 3, originalPageCount: 3 },
    ];
    assert.equal(canCollapsePdf(interleaved, stackId), false);

    // Missing page cannot collapse
    const missing = [
        { type: 'pdf-page', stackId, pageNumber: 1, originalPageCount: 3 },
        { type: 'pdf-page', stackId, pageNumber: 2, originalPageCount: 3 },
    ];
    assert.equal(canCollapsePdf(missing, stackId), false);
});
