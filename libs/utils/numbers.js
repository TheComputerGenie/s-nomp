/**
 * Numbers utilities
 *
 * @fileoverview Packing and numeric conversion helpers.
 * @author ComputerGenieCo
 * @version 21.7.3
 * @license GPL-3.0-or-later
 * @copyright 2025
 */

exports.varIntBuffer = n => {
    if (n < 0xfd) {
        return Buffer.from([n]);
    } else if (n < 0xffff) {
        const buff = Buffer.alloc(3);
        buff[0] = 0xfd;
        buff.writeUInt16LE(n, 1);
        return buff;
    } else if (n < 0xffffffff) {
        const buff = Buffer.alloc(5);
        buff[0] = 0xfe;
        buff.writeUInt32LE(n, 1);
        return buff;
    } else {
        const buff = Buffer.alloc(9);
        buff[0] = 0xff;
        exports.packUInt16LE(n).copy(buff, 1);
        return buff;
    }
};

exports.varStringBuffer = string => {
    const strBuff = Buffer.from(string, 'utf8');
    return Buffer.concat([exports.varIntBuffer(strBuff.length), strBuff]);
};

exports.serializeNumber = n => {
    if (n >= 1 && n <= 16) {
        return Buffer.from([0x50 + n]);
    }

    let l = 1;
    const buff = Buffer.alloc(9);
    while (n > 0x7f) {
        buff.writeUInt8(n & 0xff, l++);
        n >>= 8;
    }

    buff.writeUInt8(l, 0);
    buff.writeUInt8(n, l++);
    return buff.subarray(0, l);
};

exports.serializeString = s => {
    if (s.length < 253) {
        return Buffer.concat([
            Buffer.from([s.length]),
            Buffer.from(s)
        ]);
    } else if (s.length < 0x10000) {
        return Buffer.concat([
            Buffer.from([253]),
            exports.packUInt16LE(s.length),
            Buffer.from(s)
        ]);
    } else if (s.length < 0x100000000) {
        return Buffer.concat([
            Buffer.from([254]),
            exports.packUInt32LE(s.length),
            Buffer.from(s)
        ]);
    } else {
        return Buffer.concat([
            Buffer.from([255]),
            exports.packUInt16LE(s.length),
            Buffer.from(s)
        ]);
    }
};

exports.packUInt16LE = num => {
    const buff = Buffer.alloc(2);
    buff.writeUInt16LE(num, 0);
    return buff;
};

exports.packInt32LE = num => {
    const buff = Buffer.alloc(4);
    buff.writeInt32LE(num, 0);
    return buff;
};

exports.packInt32BE = num => {
    const buff = Buffer.alloc(4);
    buff.writeInt32BE(num, 0);
    return buff;
};

exports.packUInt32LE = num => {
    const buff = Buffer.alloc(4);
    buff.writeUInt32LE(num, 0);
    return buff;
};

exports.packUInt64LE = num => {
    const buff = Buffer.alloc(8);
    buff.writeUInt32LE(num % Math.pow(2, 32), 0);
    buff.writeUInt32LE(Math.floor(num / Math.pow(2, 32)), 4);
    return buff;
};

exports.packUInt32BE = num => {
    const buff = Buffer.alloc(4);
    buff.writeUInt32BE(num, 0);
    return buff;
};

exports.packInt64LE = num => {
    const buff = Buffer.alloc(8);
    buff.writeUInt32LE(num % Math.pow(2, 32), 0);
    buff.writeUInt32LE(Math.floor(num / Math.pow(2, 32)), 4);
    return buff;
};

// Coin amount helpers (rounding and unit conversions)
/**
 * Round a number to specified decimal places with high precision
 * @param {number} n
 * @param {number} digits
 * @returns {number}
 */
exports.roundTo = function (n, digits) {
    if (digits === undefined) {
        digits = 0;
    }
    const multiplicator = Math.pow(10, digits);
    n = parseFloat((n * multiplicator).toFixed(11));
    const test = (Math.round(n) / multiplicator);
    return +(test.toFixed(digits));
};

/**
 * Convert satoshis (smallest unit) to coin amount using magnitude and precision
 * @param {number} satoshis
 * @param {number} magnitude - number of satoshis per coin (e.g. 1e8)
 * @param {number} coinPrecision - decimal digits for the coin
 * @returns {number}
 */
exports.satoshisToCoins = function (satoshis, magnitude, coinPrecision) {
    return exports.roundTo((satoshis / magnitude), coinPrecision);
};

/**
 * Convert coins to satoshis using magnitude
 * @param {number} coins
 * @param {number} magnitude
 * @returns {number}
 */
exports.coinsToSatoshis = function (coins, magnitude) {
    return Math.round(coins * magnitude);
};

/**
 * Round coin amount to standard precision
 * @param {number} number
 * @param {number} coinPrecision
 * @returns {number}
 */
exports.coinsRound = function (number, coinPrecision) {
    return exports.roundTo(number, coinPrecision);
};
