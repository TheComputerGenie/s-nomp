/**
 * Shared client-side utilities for website static scripts
 *
 * This file centralizes helper functions used by multiple static pages.
 * Keeping the implementation in sync with server `libs/utils/misc.js` prevents
 * duplication and makes future updates easier.
 */

/* eslint-env browser */

/**
 * Converts raw hashrate value to human-readable string with appropriate units
 * (browser-friendly port of the server util implementation).
 *
 * @param {number} hashrate - Raw hashrate in H/s
 * @returns {string}
 */
function getReadableHashRateString(hashrate) {
    // same behavior as server-side utils: apply scaling multiplier
    hashrate = (hashrate * 2);

    if (hashrate < 1000000) {
        return `${(Math.round(hashrate / 1000) / 1000).toFixed(2)  } H/s`;
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
