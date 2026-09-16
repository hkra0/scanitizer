// Parse and validate page ranges like "1,3,5,6-10,8～12".
// Zero dependencies, supports full-width punctuation and digits.

/**
 * Normalizes input string: converts full-width digits and punctuation to ASCII.
 *
 * @param {string} str
 * @returns {string}
 */
function normalizeInput(str) {
    if (!str) return '';
    return str
        // NFKC decomposes full-width characters (e.g. １２３ -> 123)
        .normalize('NFKC')
        .replace(/[，、]/g, ',')
        .replace(/[~～–—至]/g, '-')
        .trim();
}

/**
 * Parses a page range string into 0-based page indices.
 *
 * @param {string} input - User input string, e.g. "1, 3, 5-10"
 * @param {number} totalPages - Total pages available in the document
 * @returns {{
 *   valid: boolean,
 *   pages: number[],       // 0-based indices
 *   pageNumbers: number[], // 1-based page numbers
 *   isAll: boolean,
 *   error?: 'out_of_range' | 'invalid_format' | 'empty'
 * }}
 */
export function parsePageRange(input, totalPages) {
    if (totalPages <= 0) {
        return { valid: false, pages: [], pageNumbers: [], isAll: false, error: 'empty' };
    }

    const norm = normalizeInput(input);
    if (!norm || norm.toLowerCase() === 'all') {
        const allPages = Array.from({ length: totalPages }, (_, i) => i);
        return {
            valid: true,
            pages: allPages,
            pageNumbers: allPages.map((i) => i + 1),
            isAll: true,
        };
    }

    const tokens = norm.split(',').map((t) => t.trim()).filter(Boolean);
    if (tokens.length === 0) {
        return { valid: false, pages: [], pageNumbers: [], isAll: false, error: 'empty' };
    }

    const collected = new Set();

    for (const token of tokens) {
        if (/^\d+$/.test(token)) {
            const num = parseInt(token, 10);
            if (num < 1 || num > totalPages) {
                return { valid: false, pages: [], pageNumbers: [], isAll: false, error: 'out_of_range' };
            }
            collected.add(num);
        } else {
            const rangeMatch = token.match(/^(\d+)\s*-\s*(\d+)$/);
            if (!rangeMatch) {
                return { valid: false, pages: [], pageNumbers: [], isAll: false, error: 'invalid_format' };
            }
            const start = parseInt(rangeMatch[1], 10);
            const end = parseInt(rangeMatch[2], 10);
            if (start < 1 || start > totalPages || end < 1 || end > totalPages) {
                return { valid: false, pages: [], pageNumbers: [], isAll: false, error: 'out_of_range' };
            }
            const min = Math.min(start, end);
            const max = Math.max(start, end);
            for (let i = min; i <= max; i++) {
                collected.add(i);
            }
        }
    }

    const sorted = Array.from(collected).sort((a, b) => a - b);
    if (sorted.length === 0) {
        return { valid: false, pages: [], pageNumbers: [], isAll: false, error: 'empty' };
    }

    return {
        valid: true,
        pages: sorted.map((p) => p - 1),
        pageNumbers: sorted,
        isAll: sorted.length === totalPages,
    };
}

/**
 * Validates a page range string without returning full arrays.
 *
 * @param {string} input
 * @param {number} totalPages
 * @returns {boolean}
 */
export function isValidPageRange(input, totalPages) {
    return parsePageRange(input, totalPages).valid;
}
