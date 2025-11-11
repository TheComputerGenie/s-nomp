/**
 * @fileoverview JSON minifier utility
 *
 * Small synchronous JSON minifier used at startup to strip // and C-style
 * block comments and remove trailing commas while preserving string literals.
 *
 * @author ComputerGenieCo
 * @version 21.7.3
 * @copyright 2025
 */
function minify(text) {
    if (typeof text !== 'string') {
        return text;
    }

    let insideString = false;
    let insideSingleLineComment = false;
    let insideMultiLineComment = false;
    let offset = 0;
    let result = '';

    while (offset < text.length) {
        const char = text[offset];
        const nextChar = text[offset + 1];

        if (insideSingleLineComment) {
            if (char === '\n') {
                insideSingleLineComment = false;
                result += char;
            }
            offset++;
            continue;
        }

        if (insideMultiLineComment) {
            if (char === '*' && nextChar === '/') {
                insideMultiLineComment = false;
                offset += 2;
                continue;
            }
            offset++;
            continue;
        }

        if (insideString) {
            if (char === '\\') {
                result += char;
                offset++;
                if (offset < text.length) {
                    result += text[offset];
                }
            } else if (char === '"') {
                insideString = false;
                result += char;
            } else {
                result += char;
            }
            offset++;
            continue;
        }

        if (char === '"') {
            insideString = true;
            result += char;
            offset++;
            continue;
        }

        if (char === '/' && nextChar === '/') {
            insideSingleLineComment = true;
            offset += 2;
            continue;
        }

        if (char === '/' && nextChar === '*') {
            insideMultiLineComment = true;
            offset += 2;
            continue;
        }

        result += char;
        offset++;
    }

    // Remove trailing commas before } or ]
    result = result.replace(/,\s*(\}|\])/g, '$1');
    return result;
}

module.exports = { minify };
