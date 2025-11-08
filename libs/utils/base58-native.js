/**
 * Base58 native implementation
 *
 * @fileoverview High-performance base58 and base58-check encoding/decoding.
 * @author ComputerGenieCo
 * @version 21.7.3
 * @license GPL-3.0-or-later
 * @copyright 2025
 */

'use strict';
/**
 * based on the older work of:
 * Copyright 2013 BitPay, Inc.
 * Copyright (c) 2011 Stefan Thomas <justmoon@members.fsf.org>
 * Native extensions are
 * Copyright (c) 2011 Andrew Schaaf <andrew@andrewschaaf.com>
 * Parts of this software are based on BitcoinJ
 * Copyright (c) 2011 Google Inc.
 */
const crypto = require('crypto');
// unified bigIntToBuffer from crypto utilities (used for converting BigInt -> Buffer,
// base58 decoder requests empty-buffer-for-zero via opts.zeroEmpty)
const { bigIntToBuffer } = require('./crypto');

// Use native BigInt and modern Buffer APIs.
let globalBuffer = Buffer.alloc(1024);
const zerobuf = Buffer.alloc(0);
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_ZERO = ALPHABET[0];
const ALPHABET_BUF = Buffer.from(ALPHABET, 'ascii');
const ALPHABET_INV = {};
for (let i = 0; i < ALPHABET.length; i++) {
    ALPHABET_INV[ALPHABET[i]] = i;
}

// Helper: convert Buffer (big-endian) to native BigInt
function bufferToBigInt(buf) {
    let result = 0n;
    for (let i = 0; i < buf.length; i++) {
        result = (result << 8n) + BigInt(buf[i]);
    }
    return result;
}

// Vanilla Base58 Encoding
const base58 = {
    encode: function (buf) {
        // accept strings (utf8/hex) or Buffer - coerce to Buffer
        if (typeof buf === 'string') {
            buf = Buffer.from(buf, 'utf8');
        }
        if (!Buffer.isBuffer(buf)) {
            throw new TypeError('encode expects a Buffer or string');
        }

        let str;
        let x = bufferToBigInt(buf);
        let r;

        if (buf.length < 512) {
            str = globalBuffer;
        } else {
            str = Buffer.alloc(buf.length << 1);
        }
        let i = str.length - 1;
        while (x > 0n) {
            // use BigInt division/mod
            const mod = x % 58n;
            r = Number(mod);
            x = x / 58n;
            str[i] = ALPHABET_BUF[r];
            i--;
        }

        // deal with leading zeros
        let j = 0;
        while (buf[j] === 0) {
            str[i] = ALPHABET_BUF[0];
            j++; i--;
        }

        return str.subarray(i + 1, str.length).toString('ascii');
    },

    decode: function (str) {
        if (typeof str !== 'string') {
            throw new TypeError('decode expects a base58 string');
        }
        if (str.length === 0) {
            return zerobuf;
        }

        // validate characters
        for (let k = 0; k < str.length; k++) {
            if (ALPHABET_INV[str[k]] === undefined) {
                throw new Error('invalid base58 character');
            }
        }

        let answer = 0n;
        for (let i = 0; i < str.length; i++) {
            answer = answer * 58n + BigInt(ALPHABET_INV[str[i]]);
        }
        let i = 0;
        while (i < str.length && str[i] === ALPHABET_ZERO) {
            i++;
        }
        if (i > 0) {
            const zb = Buffer.alloc(i);
            zb.fill(0);
            if (i === str.length) {
                return zb;
            }
            const answerBuf = bigIntToBuffer(answer, undefined, { zeroEmpty: true });
            return Buffer.concat([zb, answerBuf], i + answerBuf.length);
        } else {
            return bigIntToBuffer(answer, undefined, { zeroEmpty: true });
        }
    },
};

// Base58Check Encoding
function sha256(data) {
    return crypto.createHash('sha256').update(data).digest();
};

function doubleSHA256(data) {
    return sha256(sha256(data));
};

const base58Check = {
    encode: function (buf) {
        if (!Buffer.isBuffer(buf)) {
            throw new TypeError('base58Check.encode expects a Buffer');
        }
        const checkedBuf = Buffer.alloc(buf.length + 4);
        const hash = doubleSHA256(buf);
        buf.copy(checkedBuf, 0);
        hash.copy(checkedBuf, buf.length);
        return base58.encode(checkedBuf);
    },

    decode: function (s) {
        const buf = base58.decode(s);
        if (buf.length < 4) {
            throw new Error('invalid input: too short');
        }

        const data = buf.subarray(0, -4);
        const csum = buf.subarray(-4);

        const hash = doubleSHA256(data);
        const hash4 = hash.subarray(0, 4);

        // Use timingSafeEqual for constant-time comparison when lengths match
        let match = false;
        if (csum.length === hash4.length) {
            try {
                match = crypto.timingSafeEqual(csum, hash4);
            } catch (e) {
                match = false;
            }
        }
        if (!match) {
            throw new Error('checksum mismatch');
        }

        // Return a copy to avoid returning a slice that might reference a larger buffer
        return Buffer.from(data);
    },
};

// if you frequently do base58 encodings with data larger
// than 512 bytes, you can use this method to expand the
// size of the reusable buffer
exports.setBuffer = function (buf) {
    if (!Buffer.isBuffer(buf)) {
        throw new TypeError('setBuffer expects a Buffer');
    }
    globalBuffer = buf;
};

exports.base58 = base58;
exports.base58Check = base58Check;
exports.encode = base58.encode;
exports.decode = base58.decode;

