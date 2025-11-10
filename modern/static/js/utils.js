/**
 * Shared client-side utilities for website static scripts
 *
 * This file centralizes helper functions used by multiple static pages.
 * Keeping the implementation in sync with server `libs/utils/misc.js` prevents
 * duplication and makes future updates easier.
 */

/* eslint-env browser */

/**
 * Client-side hashrate formatter synchronized with server implementation in libs/utils/misc.js
 * Differences from earlier client version: restores original threshold logic and unit math so
 * average (client) and current (server) values use identical scaling.
 *
 * @param {number} hashrate - Raw base hashrate (prior to display multiplier)
 * @param {number|string} [multiplierOrAlgo=2] - Either a numeric displayMultiplier or an algorithm name
 * @returns {string} Human readable string (e.g. "412.61 MH/s")
 */
function getReadableHashRateString(hashrate, multiplierOrAlgo = 2) {
    let displayMultiplier = 2;
    if (typeof multiplierOrAlgo === 'number') {
        displayMultiplier = multiplierOrAlgo;
    } else if (typeof multiplierOrAlgo === 'string') {
        // If algorithm name passed and a global map is available, use it; else fallback.
        if (window && window.algoDisplayMultipliers && window.algoDisplayMultipliers[multiplierOrAlgo]) {
            displayMultiplier = window.algoDisplayMultipliers[multiplierOrAlgo];
        }
    }

    hashrate = hashrate * displayMultiplier;

    // Mirror server logic: for small hashrates (< 1,000,000) compress to H/s using (hr/1e6)
    if (hashrate < 1000000) {
        return `${(Math.round(hashrate / 1000) / 1000).toFixed(2)} H/s`;
    }

    const byteUnits = [' H/s', ' KH/s', ' MH/s', ' GH/s', ' TH/s', ' PH/s'];
    const i = Math.floor((Math.log(hashrate / 1000) / Math.log(1000)) - 1);
    hashrate = (hashrate / 1000) / Math.pow(1000, i + 1);
    return hashrate.toFixed(2) + byteUnits[i];
}

// expose globally for existing static scripts to use
window.getReadableHashRateString = getReadableHashRateString;

/**
 * Converts network-level hashrate to a human-readable string (browser copy)
 * Mirrors server-side behavior in `libs/utils/misc.js`.
 *
 * @param {number} hashrate
 * @returns {string}
 */
function getReadableNetworkHashRateString(hashrate) {
    hashrate = (hashrate * 1000000);

    if (hashrate < 1000000) {
        return '0 Sol';
    }

    const byteUnits = [' H/s', ' KH/s', ' MH/s', ' GH/s', ' TH/s', ' PH/s'];
    const i = Math.floor((Math.log(hashrate / 1000) / Math.log(1000)) - 1);
    hashrate = (hashrate / 1000) / Math.pow(1000, i + 1);
    return hashrate.toFixed(2) + byteUnits[i];
}

window.getReadableNetworkHashRateString = getReadableNetworkHashRateString;
