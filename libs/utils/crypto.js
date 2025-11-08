/**
 * Crypto utilities
 *
 * @fileoverview Hashing and big-number helper utilities used across the pool.
 * @author ComputerGenieCo
 * @version 21.7.3
 * @license GPL-3.0-or-later
 * @copyright 2025
 */

const crypto = require('crypto');
const misc = require('./misc');

// Convert a big-endian Buffer to a BigInt
function bufferToBigInt(buff) {
    let result = 0n;
    for (let i = 0; i < buff.length; i++) {
        result = (result << 8n) + BigInt(buff[i]);
    }
    return result;
}

// Convert a non-negative BigInt to a big-endian Buffer.
// Parameters:
//   n: BigInt
//   size: optional integer => force output to this exact byte length (left-pad with 0x00 or truncate high bytes)
//   opts: optional object { zeroEmpty: boolean } => if true, return empty Buffer for 0n
function bigIntToBuffer(n, size, opts) {
    const zeroEmpty = opts && opts.zeroEmpty;
    if (n === 0n) {
        if (zeroEmpty) {
            const zb = Buffer.alloc(0);
            if (typeof size === 'number' && size > 0) {
                // honor requested size by returning zero-padded buffer
                return Buffer.alloc(size);
            }
            return zb;
        }
        const z = Buffer.from([0]);
        if (typeof size === 'number') {
            if (z.length < size) return Buffer.concat([Buffer.alloc(size - z.length), z]);
            if (z.length > size) return z.slice(-size);
        }
        return z;
    }

    let hex = n.toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    let buf = Buffer.from(hex, 'hex');

    if (typeof size === 'number') {
        if (buf.length < size) {
            buf = Buffer.concat([Buffer.alloc(size - buf.length), buf]);
        } else if (buf.length > size) {
            buf = buf.slice(-size);
        }
    }
    return buf;
}

exports.bufferToBigInt = bufferToBigInt;
exports.bigIntToBuffer = bigIntToBuffer;

exports.sha256 = buffer => {
    const hash1 = crypto.createHash('sha256');
    hash1.update(buffer);
    return hash1.digest();
};

exports.sha256d = buffer => {
    return exports.sha256(exports.sha256(buffer));
};

exports.bufferToCompactBits = startingBuff => {
    const bigNum = bufferToBigInt(startingBuff);
    let buff = bigIntToBuffer(bigNum);
    buff = buff[0] > 0x7f ? Buffer.concat([Buffer.from([0x00]), buff]) : buff;
    buff = Buffer.concat([Buffer.from([buff.length]), buff]);
    return buff.subarray(0, 4);
};

exports.bignumFromBitsBuffer = bitsBuff => {
    const numBytes = bitsBuff.readUInt8(0);
    const bigBits = bufferToBigInt(bitsBuff.subarray(1));
    const shift = BigInt(8 * (numBytes - 3));
    const target = bigBits * (2n ** shift);
    return target;
};

exports.bignumFromBitsHex = bitsString => {
    return exports.bignumFromBitsBuffer(Buffer.from(bitsString, 'hex'));
};

exports.convertBitsToBuff = bitsBuff => {
    const target = exports.bignumFromBitsBuffer(bitsBuff);
    const resultBuff = bigIntToBuffer(target);
    const buff256 = Buffer.alloc(32);
    buff256.fill(0);
    resultBuff.copy(buff256, buff256.length - resultBuff.length);
    return buff256;
};

exports.getTruncatedDiff = shift => {
    const bitsBuf = misc.buildShifted256Buffer(shift);
    return exports.convertBitsToBuff(exports.bufferToCompactBits(bitsBuf));
};

exports.calculateDifficulty = targetHex => {
    const targetBigInt = BigInt(`0x${targetHex}`);
    const diff1BigInt = BigInt(global.diff1);
    const diff = diff1BigInt / targetBigInt;
    return parseFloat(Number(diff).toFixed(9));
};

// Lightweight BigNum factory (compat shim for previous `bignum` usage)
exports.bignum = (input, base) => {
    class BigNum {
        constructor(val, base) {
            if (typeof val === 'string') {
                if (base === 16) {
                    const h = val.startsWith('0x') ? val : `0x${val}`;
                    this.value = BigInt(h);
                } else if (base === 10 || typeof base === 'undefined') {
                    this.value = BigInt(val);
                } else {
                    this.value = BigInt(parseInt(val, base));
                }
            } else if (typeof val === 'bigint') {
                this.value = val;
            } else if (typeof val === 'number') {
                this.value = BigInt(val);
            } else {
                this.value = BigInt(0);
            }
        }

        toNumber() {
            return Number(this.value);
        }

        toString(radix) {
            return this.value.toString(radix || 10);
        }

        valueOf() {
            return this.value;
        }

        toJSON() {
            return this.toString();
        }
    }

    return new BigNum(input, base);
};
