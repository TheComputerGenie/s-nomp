/**
 * Misc utilities
 *
 * @fileoverview General helper functions used across the project.
 * @author ComputerGenieCo
 * @version 21.7.3
 * @license GPL-3.0-or-later
 * @copyright 2025
 */

exports.range = (start, stop, step) => {
    if (typeof stop === 'undefined') {
        stop = start;
        start = 0;
    }

    if (typeof step === 'undefined') {
        step = 1;
    }

    if ((step > 0 && start >= stop) || (step < 0 && start <= stop)) {
        return [];
    }

    const result = [];
    for (let i = start; step > 0 ? i < stop : i > stop; i += step) {
        result.push(i);
    }

    return result;
};

exports.getReadableHashRateString = hashrate => {
    let i = -1;
    const byteUnits = [' KH', ' MH', ' GH', ' TH', ' PH'];
    do {
        hashrate = hashrate / 1024;
        i++;
    } while (hashrate > 1024);

    return hashrate.toFixed(2) + byteUnits[i];
};

exports.shiftMax256Right = shiftRight => {
    let arr256 = Array.apply(null, new Array(256)).map(Number.prototype.valueOf, 1);
    const arrLeft = Array.apply(null, new Array(shiftRight)).map(Number.prototype.valueOf, 0);
    arr256 = arrLeft.concat(arr256).slice(0, 256);
    const octets = [];
    for (let i = 0; i < 32; i++) {
        octets[i] = 0;
        const bits = arr256.slice(i * 8, i * 8 + 8);
        for (let f = 0; f < bits.length; f++) {
            const multiplier = Math.pow(2, f);
            octets[i] += bits[f] * multiplier;
        }
    }
    return Buffer.from(octets);
};

/**
 * Safely converts a value to a string, sanitizing it by removing non-alphanumeric
 * characters except for dots. Used primarily for worker names and other user inputs.
 *
 * @param {*} s - The value to convert to a string.
 * @returns {string} The sanitized string, or empty string if input is null/undefined.
 */
exports.safeString = function (s) {
    if (s === undefined || s === null) {
        return '';
    }
    return String(s).replace(/[^a-zA-Z0-9.]/g, '');
};
