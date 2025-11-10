/**
 * Misc utilities
 *
 * @fileoverview General helper functions used across the project.
 * @author ComputerGenieCo
 * @version 21.7.3
 * @license GPL-3.0-or-later
 * @copyright 2025
 */

const algos = require('../stratum/algoProperties.js');

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

exports.getReadableHashRateString = (hashrate, algorithm) => {
    let displayMultiplier = 2; // Default multiplier for backward compatibility
    if (algorithm) {
        displayMultiplier = algos.getDisplayMultiplier(algorithm);
    }
    hashrate = (hashrate * displayMultiplier);

    if (hashrate < 1000000) {
        return `${(Math.round(hashrate / 1000) / 1000).toFixed(2)} H/s`;
    }

    const byteUnits = [' H/s', ' KH/s', ' MH/s', ' GH/s', ' TH/s', ' PH/s'];
    const i = Math.floor((Math.log(hashrate / 1000) / Math.log(1000)) - 1);
    hashrate = (hashrate / 1000) / Math.pow(1000, i + 1);
    return hashrate.toFixed(2) + byteUnits[i];
};

/**
 * Build a 256-bit (32-byte) Buffer where the first `shift` bits are 0 and the remaining bits are 1.
 * Bits are packed little-endian into bytes (bit 0 is LSB of octet 0).
 *
 * @param {number} shift - number of zero bits to prefix (clamped to [0,256])
 * @returns {Buffer}
 */
exports.buildShifted256Buffer = function (shift) {
    const s = Math.max(0, Math.min(256, (shift | 0)));
    const octets = new Uint8Array(32);
    for (let bitIndex = 0; bitIndex < 256; bitIndex++) {
        if (bitIndex >= s) {
            const octetIndex = (bitIndex >> 3);
            const bitPos = bitIndex & 7;
            octets[octetIndex] |= (1 << bitPos);
        }
    }
    return Buffer.from(octets);
};

exports.shiftMax256Right = shiftRight => {
    return exports.buildShifted256Buffer(shiftRight);
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

/**
 * Formats network hashrate for display purposes
 *
 * This function is similar to getReadableHashRateString but applies a
 * network-specific scaling factor and returns a short string for very
 * low values (e.g., '0 Sol'). Kept here to centralize display logic for
 * both server-side modules and any other consumers.
 *
 * @param {number} hashrate - Raw network hashrate value
 * @returns {string}
 */
exports.getReadableNetworkHashRateString = function (hashrate) {
    hashrate = (hashrate * 1000000);

    if (hashrate < 1000000) {
        return '0 Sol';
    }

    const byteUnits = [' H/s', ' KH/s', ' MH/s', ' GH/s', ' TH/s', ' PH/s'];
    const i = Math.floor((Math.log(hashrate / 1000) / Math.log(1000)) - 1);
    hashrate = (hashrate / 1000) / Math.pow(1000, i + 1);
    return hashrate.toFixed(2) + byteUnits[i];
};

/**
 * Convert seconds to human-readable time format
 *
 * Converts a duration in seconds to a readable string format showing
 * days, hours, minutes, and seconds. Automatically adjusts the display
 * to show the most significant units (e.g., omits days if duration < 1 day).
 *
 * @param {number} t - Duration in seconds
 * @returns {string} Formatted time string (e.g., "2d 3h 45m 12s", "1h 30m 5s", "45s")
 */
exports.getReadableTimeString = function (t) {
    let seconds = Math.round(t);
    let minutes = Math.floor(seconds / 60);
    let hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    // Calculate remaining units after extracting larger units
    hours = hours - (days * 24);
    minutes = minutes - (days * 24 * 60) - (hours * 60);
    seconds = seconds - (days * 24 * 60 * 60) - (hours * 60 * 60) - (minutes * 60);

    // Return most appropriate format based on duration
    if (days > 0) {
        return (`${days}d ${hours}h ${minutes}m ${seconds}s`);
    }
    if (hours > 0) {
        return (`${hours}h ${minutes}m ${seconds}s`);
    }
    if (minutes > 0) {
        return (`${minutes}m ${seconds}s`);
    }
    return (`${seconds}s`);
};
