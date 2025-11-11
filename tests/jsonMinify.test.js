/**
 * @fileoverview Unit tests for libs/utils/jsonMinify.js
 *
 * Simple node-based tests that validate the JSON minifier's handling of
 * comments, trailing commas, and string literal edge cases.
 *
 * @author ComputerGenieCo
 * @version 21.7.3
 * @copyright 2025
 */

const assert = require('assert');
const { minify } = require('../libs/utils/jsonMinify');

console.log('Running jsonMinify tests...');

// Helper to run a single case
function runCase(input, expected) {
    const parsed = JSON.parse(minify(input));
    assert.deepStrictEqual(parsed, expected);
}

// 1) strip // and /* */ comments
runCase(
    `{
    // single line comment
    "a": 1, /* inline block comment */
    "b": "x"
  }`,
    { a: 1, b: 'x' }
);

// 2) trailing commas in arrays and objects
runCase(
    `{
    "arr": [1,2,3,],
    "obj": {"x":1,}
  }`,
    { arr: [1, 2, 3], obj: { x: 1 } }
);

// 3) escaped quotes and strings containing comment-like text
runCase(
    `{
    "s": "this is not // a comment",
    "t": "not /* a comment */ either"
  }`,
    { s: 'this is not // a comment', t: 'not /* a comment */ either' }
);

// 4) unicode and large numbers
runCase(
    '{ "u": "\\u2603", "n": 12345678901234567890 }',
    { u: '\u2603', n: 12345678901234567890 }
);

console.log('All jsonMinify tests passed');
