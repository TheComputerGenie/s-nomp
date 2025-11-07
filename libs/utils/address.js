/**
 * Address utilities
 *
 * @fileoverview Utilities for decoding and validating cryptocurrency addresses.
 * @author ComputerGenieCo
 * @version 21.7.3
 * @license GPL-3.0-or-later
 * @copyright 2025
 */

const base58 = require('./base58-native.js');
const { sha256d } = require('./crypto');
const { toHex } = require('./encoding');

exports.base58Decode = string => {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const ALPHABET_MAP = {};
    for (let i = 0; i < ALPHABET.length; ++i) {
        ALPHABET_MAP[ALPHABET.charAt(i)] = i;
    }
    const BASE = ALPHABET.length;

    if (string.length === 0) {
        return [];
    }

    let i, j;
    const bytes = [0];
    for (i = 0; i < string.length; ++i) {
        const c = string[i];
        if (!(c in ALPHABET_MAP)) {
            throw new Error('Non-base58 character');
        }

        for (j = 0; j < bytes.length; ++j) {
            bytes[j] *= BASE;
        }
        bytes[0] += ALPHABET_MAP[c];

        let carry = 0;
        for (j = 0; j < bytes.length; ++j) {
            bytes[j] += carry;
            carry = bytes[j] >> 8;
            bytes[j] &= 0xff;
        }

        while (carry) {
            bytes.push(carry & 0xff);
            carry >>= 8;
        }
    }
    for (i = 0; string[i] === '1' && i < string.length - 1; ++i) {
        bytes.push(0);
    }

    return bytes.reverse();
};

exports.getVersionByte = addr => {
    return base58.decode(addr).subarray(0, 1);
};

exports.addressFromEx = (exAddress, ripdm160Key) => {
    try {
        const versionByte = exports.getVersionByte(exAddress);
        const addrBase = Buffer.concat([versionByte, Buffer.from(ripdm160Key, 'hex')]);
        const checksum = sha256d(addrBase).subarray(0, 4);
        const address = Buffer.concat([addrBase, checksum]);
        return base58.encode(address);
    } catch (e) {
        return null;
    }
};

exports.bech32Decode = bechString => {
    const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

    function polymod(values) {
        let chk = 1;
        for (let p = 0; p < values.length; ++p) {
            const top = chk >> 25;
            chk = (chk & 0x1ffffff) << 5 ^ values[p];
            for (let i = 0; i < 5; ++i) {
                if ((top >> i) & 1) {
                    chk ^= GENERATOR[i];
                }
            }
        }
        return chk;
    }

    function hrpExpand(hrp) {
        const ret = [];
        let p;
        for (p = 0; p < hrp.length; ++p) {
            ret.push(hrp.charCodeAt(p) >> 5);
        }
        ret.push(0);
        for (p = 0; p < hrp.length; ++p) {
            ret.push(hrp.charCodeAt(p) & 31);
        }
        return ret;
    }

    function verifyChecksum(hrp, data) {
        return polymod(hrpExpand(hrp).concat(data)) === 1;
    }

    let p;
    let has_lower = false;
    let has_upper = false;
    for (p = 0; p < bechString.length; ++p) {
        if (bechString.charCodeAt(p) < 33 || bechString.charCodeAt(p) > 126) {
            return null;
        }
        if (bechString.charCodeAt(p) >= 97 && bechString.charCodeAt(p) <= 122) {
            has_lower = true;
        }
        if (bechString.charCodeAt(p) >= 65 && bechString.charCodeAt(p) <= 90) {
            has_upper = true;
        }
    }
    if (has_lower && has_upper) {
        return null;
    }
    bechString = bechString.toLowerCase();
    const pos = bechString.lastIndexOf('1');
    if (pos < 1 || pos + 7 > bechString.length || bechString.length > 90) {
        return null;
    }
    const hrp = bechString.substring(0, pos);
    const data = [];
    for (p = pos + 1; p < bechString.length; ++p) {
        const d = CHARSET.indexOf(bechString.charAt(p));
        if (d === -1) {
            return null;
        }
        data.push(d);
    }
    if (!verifyChecksum(hrp, data)) {
        return null;
    }
    return { hrp: hrp, data: data.slice(0, data.length - 6) };
};

exports.sha256Checksum = payload => {
    return sha256d(Buffer.from(payload, 'hex')).subarray(0, 4).toString('hex');
};

exports.validateVerusAddress = address => {
    if (!/^[a-zA-Z0-9]+$/.test(address)) {
        return false;
    }

    const validAddressTypes = ['3c', '55', '66'];
    const validSaplingPrefixes = ['zs'];

    let decoded;
    try {
        decoded = exports.base58Decode(address);
    } catch (e) {
        if (address.slice(0, 2) === 'zs') {
            decoded = exports.bech32Decode(address);
            if (decoded && decoded.data && decoded.data.length === 69) {
                return validSaplingPrefixes.includes(decoded.hrp);
            }
        }
        return false;
    }

    if (decoded && decoded.length === 25) {
        const checksum = toHex(decoded.slice(-4));
        const body = toHex(decoded.slice(0, 21));
        const goodChecksum = exports.sha256Checksum(body);

        if (checksum === goodChecksum) {
            const addressType = toHex(decoded.slice(0, 1));
            return validAddressTypes.includes(addressType);
        }
    }

    return false;
};
