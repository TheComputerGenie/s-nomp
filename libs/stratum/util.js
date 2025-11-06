/**
 * @fileoverview Stratum utility functions for cryptocurrency mining pool operations.
 * This module provides essential utilities for handling Bitcoin-like cryptocurrency
 * operations including address manipulation, hash calculations, buffer operations,
 * difficulty calculations, and various encoding/decoding functions used in mining
 * pool stratum protocol implementations.
 * 
 * @module libs/stratum/util
 * @requires crypto - Node.js built-in cryptographic functionality
 * @requires base58-native.js - NATIVE Base58 encoding/decoding library
 */

const crypto = require('crypto');

const base58 = require('./base58-native.js');

// NOTE: Replaced external `bignum` dependency with native BigInt helpers so
// this file has no non-native package dependencies. The helper functions
// below operate on Buffers (big-endian) and BigInt to replicate the
// original bignum.fromBuffer / toBuffer behavior used in compact/target
// conversions.

// Convert a big-endian Buffer to a BigInt
function bufferToBigInt(buff) {
    let result = 0n;
    for (let i = 0; i < buff.length; i++) {
        result = (result << 8n) + BigInt(buff[i]);
    }
    return result;
}

// Convert a non-negative BigInt to a minimal big-endian Buffer (no leading zeros)
function bigIntToBuffer(n) {
    if (n === 0n) return Buffer.from([0]);
    let hex = n.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    return Buffer.from(hex, 'hex');
}

/**
 * Creates a cryptocurrency address from an existing address and a RIPEMD160 key.
 * This function extracts the version byte from an existing address and combines it
 * with a new RIPEMD160 key to generate a valid cryptocurrency address with proper
 * checksum validation.
 * 
 * @function addressFromEx
 * @param {string} exAddress - An existing cryptocurrency address to extract version byte from
 * @param {string} ripdm160Key - RIPEMD160 hash key as a hexadecimal string
 * @returns {string|null} Base58-encoded cryptocurrency address, or null if operation fails
 * @example
 * const address = addressFromEx('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 'abcd1234...');
 * console.log(address); // Returns a valid Bitcoin-like address or null
 */
exports.addressFromEx = (exAddress, ripdm160Key) => {
    try {
        const versionByte = exports.getVersionByte(exAddress);
        const addrBase = Buffer.concat([versionByte, Buffer.from(ripdm160Key, 'hex')]);
        const checksum = exports.sha256d(addrBase).subarray(0, 4);
        const address = Buffer.concat([addrBase, checksum]);
        return base58.encode(address);
    } catch (e) {
        return null;
    }
};

/**
 * Extracts the version byte from a Base58-encoded cryptocurrency address.
 * The version byte indicates the type of address (mainnet, testnet, etc.)
 * and is the first byte of the decoded address.
 * 
 * @function getVersionByte
 * @param {string} addr - Base58-encoded cryptocurrency address
 * @returns {Buffer} Single-byte buffer containing the version byte
 * @example
 * const versionByte = getVersionByte('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
 * console.log(versionByte); // Buffer containing version byte (0x00 for Bitcoin mainnet)
 */
exports.getVersionByte = addr => {
    return base58.decode(addr).subarray(0, 1);
};

/**
 * Computes the SHA-256 hash of a buffer.
 * This is a fundamental cryptographic operation used throughout Bitcoin-like
 * cryptocurrency protocols for generating checksums, block hashes, and merkle trees.
 * 
 * @function sha256
 * @param {Buffer} buffer - Input data to hash
 * @returns {Buffer} 32-byte SHA-256 hash digest
 * @example
 * const data = Buffer.from('Hello World', 'utf8');
 * const hash = sha256(data);
 * console.log(hash.toString('hex')); // SHA-256 hash as hex string
 */
exports.sha256 = buffer => {
    const hash1 = crypto.createHash('sha256');
    hash1.update(buffer);
    return hash1.digest();
};

/**
 * Computes double SHA-256 hash (SHA-256 of SHA-256) of a buffer.
 * This is the standard hashing method used in Bitcoin and many other cryptocurrencies
 * for block hashes, transaction IDs, and address checksums. The double hash provides
 * additional security against length extension attacks.
 * 
 * @function sha256d
 * @param {Buffer} buffer - Input data to double hash
 * @returns {Buffer} 32-byte double SHA-256 hash digest
 * @example
 * const data = Buffer.from('Hello World', 'utf8');
 * const doubleHash = sha256d(data);
 * console.log(doubleHash.toString('hex')); // Double SHA-256 hash as hex string
 */
exports.sha256d = buffer => {
    return exports.sha256(exports.sha256(buffer));
};

/**
 * Decodes a Base58-encoded string into a byte array.
 * Base58 is commonly used in cryptocurrency addresses to create human-readable
 * representations of binary data. This implementation follows the Bitcoin Base58
 * alphabet and encoding scheme.
 * 
 * @function base58Decode
 * @param {string} string - Base58-encoded string to decode
 * @returns {Array<number>} Decoded byte array
 * @throws {Error} If the string contains invalid Base58 characters
 * @example
 * const decoded = base58Decode('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
 * console.log(decoded); // [0, 0, 0, ...] (Bitcoin genesis block address)
 */
exports.base58Decode = string => {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const ALPHABET_MAP = {};
    for (let i = 0; i < ALPHABET.length; ++i) {
        ALPHABET_MAP[ALPHABET.charAt(i)] = i;
    }
    const BASE = ALPHABET.length;

    if (string.length === 0) return [];

    let i, j, bytes = [0];
    for (i = 0; i < string.length; ++i) {
        const c = string[i];
        if (!(c in ALPHABET_MAP)) throw new Error('Non-base58 character');

        for (j = 0; j < bytes.length; ++j) bytes[j] *= BASE;
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
    // deal with leading zeros
    for (i = 0; string[i] === '1' && i < string.length - 1; ++i) {
        bytes.push(0);
    }

    return bytes.reverse();
};

/**
 * Decodes a Bech32-encoded string into an object with hrp and data properties.
 * Bech32 is used for SegWit addresses and Sapling shielded addresses in cryptocurrencies.
 * This implementation follows the BIP173 specification for Bech32 encoding.
 * 
 * @function bech32Decode
 * @param {string} bechString - Bech32-encoded string to decode
 * @returns {Object|null} Object with 'hrp' and 'data' properties, or null if invalid
 * @example
 * const decoded = bech32Decode('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
 * console.log(decoded.hrp); // 'bc'
 * console.log(decoded.data); // [0, 14, 20, ...]
 */
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

/**
 * Calculates SHA256 checksum for address validation.
 * Performs double SHA256 hashing and returns the first 4 bytes as hex.
 * This is used for validating cryptocurrency address checksums.
 * 
 * @function sha256Checksum
 * @param {string} payload - Hex string payload to checksum
 * @returns {string} First 8 characters (4 bytes) of double SHA256 hash as hex
 * @example
 * const checksum = sha256Checksum('00000000...');
 * console.log(checksum); // 'abcd1234'
 */
exports.sha256Checksum = payload => {
    return exports.sha256d(Buffer.from(payload, 'hex')).subarray(0, 4).toString('hex');
};

/**
 * Validates a Verus (VRSC) cryptocurrency address.
 * Supports both transparent (base58) and shielded (sapling/bech32) address formats.
 * Verus addresses use specific version bytes and checksum validation.
 * 
 * @function validateVerusAddress
 * @param {string} address - Verus address to validate
 * @returns {boolean} True if address is valid, false otherwise
 * @example
 * const isValid = validateVerusAddress('RGmX85KFyDf6HHekhH9mQ3QKoyPjS6X');
 * console.log(isValid); // true
 */
exports.validateVerusAddress = address => {
    // Valid chars test - only alphanumeric characters allowed
    if (!/^[a-zA-Z0-9]+$/.test(address)) {
        return false;
    }

    // Define valid address types for Verus (production network)
    const validAddressTypes = ['3c', '55', '66']; // Transparent addresses
    const validSaplingPrefixes = ['zs']; // Shielded sapling addresses

    let decoded;

    // Try base58 decode first (transparent addresses)
    try {
        decoded = exports.base58Decode(address);
    } catch (e) {
        // If base58 decode fails, try bech32 for sapling addresses
        if (address.slice(0, 2) === 'zs') {
            decoded = exports.bech32Decode(address);
            if (decoded && decoded.data && decoded.data.length === 69) {
                // Valid sapling address
                return validSaplingPrefixes.includes(decoded.hrp);
            }
        }
        return false;
    }

    // Base58 decode succeeded - validate transparent address
    if (decoded && decoded.length === 25) {
        const checksum = exports.toHex(decoded.slice(-4));
        const body = exports.toHex(decoded.slice(0, 21));
        const goodChecksum = exports.sha256Checksum(body);

        if (checksum === goodChecksum) {
            const addressType = exports.toHex(decoded.slice(0, 1));
            return validAddressTypes.includes(addressType);
        }
    }

    return false;
};

/**
 * Converts a byte array to hexadecimal string.
 * 
 * @function toHex
 * @param {Array<number>|Buffer} arrayOfBytes - Byte array to convert
 * @returns {string} Hexadecimal representation
 */
exports.toHex = arrayOfBytes => {
    let hex = '';
    for (let i = 0; i < arrayOfBytes.length; i++) {
        const byte = arrayOfBytes[i];
        hex += (byte < 16 ? '0' : '') + byte.toString(16);
    }
    return hex;
};

/**
 * Reverses the byte order of a buffer.
 * This is commonly used in cryptocurrency protocols where data needs to be
 * converted between little-endian and big-endian formats. For example,
 * Bitcoin uses little-endian for internal representation but displays
 * hashes in big-endian format for human readability.
 * 
 * @function reverseBuffer
 * @param {Buffer} buff - Input buffer to reverse
 * @returns {Buffer} New buffer with reversed byte order
 * @example
 * const original = Buffer.from([0x01, 0x02, 0x03, 0x04]);
 * const reversed = reverseBuffer(original);
 * console.log(reversed); // Buffer [0x04, 0x03, 0x02, 0x01]
 */
exports.reverseBuffer = buff => {
    const reversed = Buffer.alloc(buff.length);
    for (let i = buff.length - 1; i >= 0; i--) {
        reversed[buff.length - i - 1] = buff[i];
    }

    return reversed;
};

/**
 * Reverses the byte order of a hexadecimal string.
 * Convenience function that converts hex string to buffer, reverses it,
 * and converts back to hex. Useful for endianness conversions in
 * cryptocurrency hash representations.
 * 
 * @function reverseHex
 * @param {string} hex - Hexadecimal string to reverse
 * @returns {string} Hex string with reversed byte order
 * @example
 * const hash = 'abcd1234';
 * const reversed = reverseHex(hash);
 * console.log(reversed); // '3412cdab'
 */
exports.reverseHex = hex => {
    return exports.reverseBuffer(
        Buffer.from(hex, 'hex')
    ).toString('hex');
};

/**
 * Reverses byte order for 32-byte buffers by swapping endianness of 32-bit words.
 * This function performs a two-step process: first converts each 32-bit word from
 * big-endian to little-endian (or vice versa), then reverses the entire buffer.
 * Commonly used for processing 256-bit hashes in cryptocurrency mining.
 * 
 * @function reverseByteOrder
 * @param {Buffer} buff - 32-byte buffer to process (typically a hash)
 * @returns {Buffer} Buffer with reversed byte order and swapped word endianness
 * @example
 * const hash = Buffer.alloc(32); // 32-byte hash buffer
 * const processed = reverseByteOrder(hash);
 * // Returns hash with endianness conversion suitable for mining
 */
exports.reverseByteOrder = buff => {
    for (let i = 0; i < 8; i++) {
        buff.writeUInt32LE(buff.readUInt32BE(i * 4), i * 4);
    }

    return exports.reverseBuffer(buff);
};

/**
 * Converts a hexadecimal hash string to a 32-byte uint256 buffer with reversed byte order.
 * Ensures the input is exactly 32 bytes by padding with zeros if necessary.
 * The result is suitable for use in cryptocurrency mining operations where
 * hashes need to be in little-endian format.
 * 
 * @function uint256BufferFromHash
 * @param {string} hex - Hexadecimal hash string (any length)
 * @returns {Buffer} 32-byte buffer with reversed byte order, zero-padded if needed
 * @example
 * const hash = 'abcd1234';
 * const uint256 = uint256BufferFromHash(hash);
 * console.log(uint256.length); // 32 (padded and reversed)
 */
exports.uint256BufferFromHash = hex => {
    let fromHex = Buffer.from(hex, 'hex');

    if (fromHex.length != 32) {
        const empty = Buffer.alloc(32);
        empty.fill(0);
        fromHex.copy(empty);
        fromHex = empty;
    }

    return exports.reverseBuffer(fromHex);
};

/**
 * Converts a buffer to hexadecimal string with reversed byte order.
 * Convenience function that reverses a buffer and returns its hex representation.
 * Useful for converting internal little-endian representations to big-endian
 * hex strings for display or transmission.
 * 
 * @function hexFromReversedBuffer
 * @param {Buffer} buffer - Input buffer to reverse and convert
 * @returns {string} Hexadecimal string with reversed byte order
 * @example
 * const buffer = Buffer.from([0x01, 0x02, 0x03, 0x04]);
 * const hex = hexFromReversedBuffer(buffer);
 * console.log(hex); // '04030201'
 */
exports.hexFromReversedBuffer = buffer => {
    return exports.reverseBuffer(buffer).toString('hex');
};

/**
 * Creates a variable-length integer buffer according to Bitcoin protocol specification.
 * Variable-length integers (varints) are used to encode integers in a space-efficient
 * way in Bitcoin transactions and other protocol messages. The encoding uses different
 * byte lengths based on the value size.
 * 
 * Encoding rules:
 * - Values < 0xfd: 1 byte (the value itself)
 * - Values < 0xffff: 3 bytes (0xfd + 2-byte little-endian)
 * - Values < 0xffffffff: 5 bytes (0xfe + 4-byte little-endian)
 * - Larger values: 9 bytes (0xff + 8-byte little-endian)
 * 
 * @function varIntBuffer
 * @param {number} n - Integer value to encode
 * @returns {Buffer} Variable-length encoded integer as buffer
 * @see {@link https://en.bitcoin.it/wiki/Protocol_specification#Variable_length_integer}
 * @example
 * const small = varIntBuffer(100);     // 1 byte: [100]
 * const medium = varIntBuffer(1000);   // 3 bytes: [0xfd, 0xe8, 0x03]
 * const large = varIntBuffer(100000);  // 5 bytes: [0xfe, 0xa0, 0x86, 0x01, 0x00]
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

/**
 * Creates a variable-length string buffer with length prefix.
 * Encodes a string with a variable-length integer prefix indicating the string length,
 * followed by the string data. This format is used in Bitcoin protocol for encoding
 * strings in transactions and other messages.
 * 
 * @function varStringBuffer
 * @param {string} string - String to encode
 * @returns {Buffer} Buffer containing varint length + string data
 * @example
 * const encoded = varStringBuffer('Hello');
 * // Returns buffer: [0x05, 'H', 'e', 'l', 'l', 'o']
 * // where 0x05 is the varint-encoded length
 */
exports.varStringBuffer = string => {
    const strBuff = Buffer.from(string);
    return Buffer.concat([exports.varIntBuffer(strBuff.length), strBuff]);
};

/**
 * Serializes a number for use in Bitcoin script operations (CScript format).
 * This function implements the Bitcoin script number serialization as defined in BIP-34.
 * It's used for encoding block heights and timestamps in coinbase transactions.
 * 
 * The serialization follows these rules:
 * - Numbers 1-16 are encoded as single bytes (0x51-0x60)
 * - Other numbers are encoded with a length prefix followed by little-endian bytes
 * - Negative numbers have the high bit set on the most significant byte
 * 
 * @function serializeNumber
 * @param {number} n - Number to serialize (typically block height or timestamp)
 * @returns {Buffer} Serialized number suitable for Bitcoin script inclusion
 * @see {@link https://github.com/bitcoin/bips/blob/master/bip-0034.mediawiki#specification}
 * @see {@link https://en.bitcoin.it/wiki/Script}
 * @example
 * const height = serializeNumber(12345);
 * // Returns buffer with length prefix + little-endian encoded number
 * 
 * const small = serializeNumber(5);
 * // Returns [0x55] for numbers 1-16 (optimized encoding)
 */
exports.serializeNumber = n => {
    // // Old version that is bugged
    // if (n < 0xfd){
    //     var buff = new Buffer(2);
    //     buff[0] = 0x1;
    //     buff.writeUInt8(n, 1);
    //     return buff;
    // } else if (n <= 0xffff){
    //     var buff = new Buffer(4);
    //     buff[0] = 0x3;
    //     buff.writeUInt16LE(n, 1);
    //     return buff;
    // } else if (n <= 0xffffffff){
    //     var buff = new Buffer(5);
    //     buff[0] = 0x4;
    //     buff.writeUInt32LE(n, 1);
    //     return buff;
    // } else{
    //     return new Buffer.concat([new Buffer([0x9]), binpack.packUInt64(n, 'little')]);
    // }

    //New version from TheSeven
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

/**
 * Serializes a string for use in Bitcoin script signatures.
 * This function encodes strings with a length prefix similar to variable-length integers
 * but specifically designed for script signature usage. The encoding varies based on
 * string length to optimize space usage.
 * 
 * Encoding rules:
 * - Length < 253: 1-byte length + string data
 * - Length < 65536: 253 + 2-byte little-endian length + string data  
 * - Length < 4294967296: 254 + 4-byte little-endian length + string data
 * - Longer strings: 255 + 2-byte little-endian length + string data (Note: likely bug in original)
 * 
 * @function serializeString
 * @param {string} s - String to serialize for script usage
 * @returns {Buffer} Serialized string with appropriate length prefix
 * @example
 * const short = serializeString('Hello');
 * // Returns [5, 'H', 'e', 'l', 'l', 'o']
 * 
 * const long = serializeString('Very long string...');  
 * // Returns [253, length_low, length_high, ...string_bytes]
 */
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

/**
 * Packs a 16-bit unsigned integer into a 2-byte little-endian buffer.
 * Little-endian format stores the least significant byte first, which is
 * the standard byte order used in Bitcoin protocol and x86 processors.
 * 
 * @function packUInt16LE
 * @param {number} num - 16-bit unsigned integer (0-65535)
 * @returns {Buffer} 2-byte buffer containing little-endian representation
 * @example
 * const packed = packUInt16LE(0x1234);
 * console.log(packed); // Buffer [0x34, 0x12] (little-endian)
 */
exports.packUInt16LE = num => {
    const buff = Buffer.alloc(2);
    buff.writeUInt16LE(num, 0);
    return buff;
};

/**
 * Packs a 32-bit signed integer into a 4-byte little-endian buffer.
 * Handles both positive and negative integers using two's complement representation.
 * 
 * @function packInt32LE
 * @param {number} num - 32-bit signed integer (-2147483648 to 2147483647)
 * @returns {Buffer} 4-byte buffer containing little-endian representation
 * @example
 * const positive = packInt32LE(123456);
 * const negative = packInt32LE(-123456);
 * console.log(positive); // Little-endian bytes for 123456
 * console.log(negative); // Little-endian two's complement for -123456
 */
exports.packInt32LE = num => {
    const buff = Buffer.alloc(4);
    buff.writeInt32LE(num, 0);
    return buff;
};

/**
 * Packs a 32-bit signed integer into a 4-byte big-endian buffer.
 * Big-endian format stores the most significant byte first, which is
 * network byte order and used in some cryptocurrency protocols for display.
 * 
 * @function packInt32BE
 * @param {number} num - 32-bit signed integer (-2147483648 to 2147483647)
 * @returns {Buffer} 4-byte buffer containing big-endian representation
 * @example
 * const packed = packInt32BE(0x12345678);
 * console.log(packed); // Buffer [0x12, 0x34, 0x56, 0x78] (big-endian)
 */
exports.packInt32BE = num => {
    const buff = Buffer.alloc(4);
    buff.writeInt32BE(num, 0);
    return buff;
};

/**
 * Packs a 32-bit unsigned integer into a 4-byte little-endian buffer.
 * Commonly used for timestamps, block heights, and other numeric values
 * in cryptocurrency protocols that use little-endian encoding.
 * 
 * @function packUInt32LE
 * @param {number} num - 32-bit unsigned integer (0 to 4294967295)
 * @returns {Buffer} 4-byte buffer containing little-endian representation
 * @example
 * const timestamp = packUInt32LE(Date.now() / 1000);
 * console.log(timestamp); // 4-byte little-endian timestamp
 */
exports.packUInt32LE = num => {
    const buff = Buffer.alloc(4);
    buff.writeUInt32LE(num, 0);
    return buff;
};

/**
 * Packs a 32-bit unsigned integer into a 4-byte big-endian buffer.
 * Big-endian format is useful for network protocols and human-readable
 * hash representations where most significant bytes come first.
 * 
 * @function packUInt32BE
 * @param {number} num - 32-bit unsigned integer (0 to 4294967295)
 * @returns {Buffer} 4-byte buffer containing big-endian representation
 * @example
 * const version = packUInt32BE(0x20000000);
 * console.log(version); // Buffer [0x20, 0x00, 0x00, 0x00] (big-endian)
 */
exports.packUInt32BE = num => {
    const buff = Buffer.alloc(4);
    buff.writeUInt32BE(num, 0);
    return buff;
};

/**
 * Packs a 64-bit integer into an 8-byte little-endian buffer.
 * Since JavaScript numbers lose precision beyond 53 bits, this function
 * splits the number into two 32-bit parts for accurate representation.
 * Used for large values like satoshi amounts and difficulty targets.
 * 
 * @function packInt64LE
 * @param {number} num - 64-bit integer value (up to MAX_SAFE_INTEGER)
 * @returns {Buffer} 8-byte buffer containing little-endian representation
 * @example
 * const reward = packInt64LE(5000000000); // 50 BTC in satoshis
 * console.log(reward); // 8-byte little-endian representation
 * 
 * @note For values larger than Number.MAX_SAFE_INTEGER, precision may be lost
 */
exports.packInt64LE = num => {
    const buff = Buffer.alloc(8);
    buff.writeUInt32LE(num % Math.pow(2, 32), 0);
    buff.writeUInt32LE(Math.floor(num / Math.pow(2, 32)), 4);
    return buff;
};

/**
 * Creates an array of numbers in a specified range, similar to Python's range() function.
 * This utility function generates sequences of numbers commonly used for loops,
 * array initialization, and mathematical operations in mining calculations.
 * 
 * @function range
 * @param {number} start - Starting value (or stop value if only one parameter provided)
 * @param {number} [stop] - Ending value (exclusive). If omitted, start becomes stop and start becomes 0
 * @param {number} [step=1] - Step increment (can be negative for reverse ranges)
 * @returns {number[]} Array of numbers from start to stop (exclusive) by step
 * @see {@link http://stackoverflow.com/a/8273091} Original implementation by Tadeck
 * @example
 * const simple = range(5);           // [0, 1, 2, 3, 4]
 * const fromTo = range(2, 8);        // [2, 3, 4, 5, 6, 7]  
 * const withStep = range(0, 10, 2);  // [0, 2, 4, 6, 8]
 * const reverse = range(10, 0, -2);  // [10, 8, 6, 4, 2]
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

/**
 * Converts a public key to a Bitcoin script for Proof-of-Stake (POS) coins.
 * Creates a Pay-to-Public-Key (P2PK) script that directly uses the public key
 * for transaction outputs. This format is commonly used in POS coinbase transactions
 * where rewards are paid directly to a public key rather than an address.
 * 
 * Script format: OP_PUSHDATA(33) + public_key + OP_CHECKSIG
 * - 0x21: Push next 33 bytes (compressed public key)
 * - public_key: 33-byte compressed public key  
 * - 0xac: OP_CHECKSIG opcode
 * 
 * @function pubkeyToScript 
 * @param {string} key - Hexadecimal public key string (must be 66 chars = 33 bytes)
 * @returns {Buffer} 35-byte P2PK script buffer
 * @throws {Error} If public key length is not exactly 66 characters
 * @example
 * const pubkey = '03a1633cafcc01ebfb6d78e39f687a1f0995c62fc95f51ead10a02ee0be551b5dc';
 * const script = pubkeyToScript(pubkey);
 * console.log(script); // [0x21, ...pubkey_bytes..., 0xac]
 */
exports.pubkeyToScript = key => {
    if (key.length !== 66) {
        console.error(`Invalid pubkey: ${key}`);
        throw new Error();
    }

    const pubkey = Buffer.alloc(35);
    pubkey[0] = 0x21;
    pubkey[34] = 0xac;
    Buffer.from(key, 'hex').copy(pubkey, 1);
    return pubkey;
};

/**
 * Converts a mining key to a Pay-to-Public-Key-Hash (P2PKH) script.
 * Creates a standard Bitcoin script that pays to a hash of a public key.
 * This is the most common script type used for regular Bitcoin addresses
 * and mining reward distributions.
 * 
 * Script format: OP_DUP + OP_HASH160 + OP_PUSHDATA(20) + key_hash + OP_EQUALVERIFY + OP_CHECKSIG
 * - 0x76: OP_DUP (duplicate top stack item)
 * - 0xa9: OP_HASH160 (hash top stack item with RIPEMD160(SHA256))
 * - 0x14: Push next 20 bytes (key hash length)
 * - key_hash: 20-byte RIPEMD160 hash of public key
 * - 0x88: OP_EQUALVERIFY (verify equality and mark invalid if false)
 * - 0xac: OP_CHECKSIG (check signature)
 * 
 * @function miningKeyToScript
 * @param {string} key - Hexadecimal mining key hash (typically 20 bytes = 40 chars)
 * @returns {Buffer} Complete P2PKH script buffer
 * @example
 * const keyHash = '89abcdefabbaabbaabbaabbaabbaabbaabbaabba';
 * const script = miningKeyToScript(keyHash);
 * console.log(script); // [0x76, 0xa9, 0x14, ...key_hash..., 0x88, 0xac]
 */
exports.miningKeyToScript = key => {
    const keyBuffer = Buffer.from(key, 'hex');
    return Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), keyBuffer, Buffer.from([0x88, 0xac])]);
};

/**
 * Converts a cryptocurrency address to a Pay-to-Public-Key-Hash (P2PKH) script.
 * Decodes a Base58-encoded address and extracts the public key hash to create
 * a standard P2PKH script. This is used for Proof-of-Work (POW) coins to format
 * wallet addresses for use in generation transaction outputs (coinbase rewards).
 * 
 * Address format: version_byte + pubkey_hash(20 bytes) + checksum(4 bytes) = 25/26 bytes total
 * The function extracts the 20-byte pubkey hash and creates a P2PKH script.
 * 
 * @function addressToScript
 * @param {string} addr - Base58-encoded cryptocurrency address
 * @returns {Buffer} P2PKH script buffer (25 bytes total)
 * @throws {Error} If address length is invalid (not 25 or 26 bytes when decoded)
 * @throws {Error} If Base58 decoding fails
 * @example
 * const address = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
 * const script = addressToScript(address);
 * console.log(script); // [0x76, 0xa9, 0x14, ...pubkey_hash..., 0x88, 0xac]
 */
exports.addressToScript = addr => {
    const decoded = base58.decode(addr);

    if (decoded.length !== 25 && decoded.length !== 26) {
        console.error(`invalid address length for ${addr}`);
        throw new Error();
    }

    if (!decoded) {
        console.error(`base58 decode failed for ${addr}`);
        throw new Error();
    }

    const pubkey = decoded.subarray(1, -4);

    return Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), pubkey, Buffer.from([0x88, 0xac])]);
};

/**
 * Converts a raw hash rate value to a human-readable string with appropriate units.
 * Automatically scales the hash rate and selects the most appropriate unit (KH, MH, GH, TH, PH)
 * to make large numbers more readable for display in mining statistics and dashboards.
 * 
 * Units progression: H/s → KH/s → MH/s → GH/s → TH/s → PH/s
 * Each unit represents 1024x the previous unit (binary scaling).
 * 
 * @function getReadableHashRateString
 * @param {number} hashrate - Raw hash rate value in hashes per second
 * @returns {string} Formatted hash rate string with appropriate unit suffix
 * @example
 * const rate1 = getReadableHashRateString(1500);      // "1.46 KH"
 * const rate2 = getReadableHashRateString(2500000);   // "2.38 MH" 
 * const rate3 = getReadableHashRateString(5000000000); // "4.66 GH"
 */
exports.getReadableHashRateString = hashrate => {
    let i = -1;
    const byteUnits = [' KH', ' MH', ' GH', ' TH', ' PH'];
    do {
        hashrate = hashrate / 1024;
        i++;
    } while (hashrate > 1024);

    return hashrate.toFixed(2) + byteUnits[i];
};

/**
 * Creates a difficulty target by right-shifting the maximum 256-bit value.
 * This function generates non-truncated maximum difficulty (diff1) values by performing
 * bitwise right-shift operations on the maximum possible uint256 value. The result
 * represents the target threshold that block hashes must be below to be considered valid.
 * 
 * The algorithm:
 * 1. Creates an array representing all 256 bits set to 1 (maximum uint256)
 * 2. Prepends 'shiftRight' number of zero bits
 * 3. Truncates to maintain 256 bits total (effectively right-shifting)
 * 4. Converts the bit array to a 32-byte buffer representation
 * 
 * @function shiftMax256Right
 * @param {number} shiftRight - Number of bits to right-shift the maximum value
 * @returns {Buffer} 32-byte buffer representing the shifted difficulty target
 * @example
 * const target = shiftMax256Right(32); // Shift max value right by 32 bits
 * console.log(target); // 32-byte buffer with difficulty target
 * 
 * // Higher shiftRight values = easier difficulty (larger target)
 * // Lower shiftRight values = harder difficulty (smaller target)
 */
exports.shiftMax256Right = shiftRight => {
    //Max value uint256 (an array of ones representing 256 enabled bits)
    let arr256 = Array.apply(null, new Array(256)).map(Number.prototype.valueOf, 1);

    //An array of zero bits for how far the max uint256 is shifted right
    const arrLeft = Array.apply(null, new Array(shiftRight)).map(Number.prototype.valueOf, 0);

    //Add zero bits to uint256 and remove the bits shifted out
    arr256 = arrLeft.concat(arr256).slice(0, 256);

    //An array of bytes to convert the bits to, 8 bits in a byte so length will be 32
    const octets = [];

    for (let i = 0; i < 32; i++) {
        octets[i] = 0;

        //The 8 bits for this byte
        const bits = arr256.slice(i * 8, i * 8 + 8);

        //Bit math to add the bits into a byte
        for (let f = 0; f < bits.length; f++) {
            const multiplier = Math.pow(2, f);
            octets[i] += bits[f] * multiplier;
        }
    }

    return Buffer.from(octets);
};

/**
 * Converts a buffer representing a large number to compact bits format.
 * Compact bits is a compressed representation used in Bitcoin blocks to store
 * the difficulty target. It consists of a length byte followed by the most
 * significant bytes of the target value.
 * 
 * Format: [length_byte][most_significant_bytes...]
 * - If the high bit of the first data byte is set, prepend 0x00 to avoid
 *   the value being interpreted as negative
 * - The length byte indicates how many bytes follow
 * - Only the first 3 bytes of data are kept (4 bytes total)
 * 
 * @function bufferToCompactBits
 * @param {Buffer} startingBuff - Buffer containing the target value to compress
 * @returns {Buffer} 4-byte compact bits representation
 * @example
 * const target = Buffer.from('00000000ffff0000000000000000000000000000000000000000000000000000', 'hex');
 * const compact = bufferToCompactBits(target);
 * console.log(compact); // 4-byte compact representation like [0x1d, 0x00, 0xff, 0xff]
 */
exports.bufferToCompactBits = startingBuff => {
    // Convert buffer (big-endian) to BigInt, then to minimal big-endian buffer
    const bigNum = bufferToBigInt(startingBuff);
    let buff = bigIntToBuffer(bigNum);

    // If high bit set, prepend 0x00 to avoid being interpreted as negative
    buff = buff[0] > 0x7f ? Buffer.concat([Buffer.from([0x00]), buff]) : buff;

    buff = Buffer.concat([Buffer.from([buff.length]), buff]);
    return buff.subarray(0, 4);
};

/**
 * Converts a compact bits buffer to a bignum target value.
 * This function decodes the compact bits format used in Bitcoin block headers
 * to represent difficulty targets. The compact format compresses large 256-bit
 * target values into just 4 bytes.
 * 
 * Decoding algorithm:
 * - First byte (numBytes): indicates the length of the uncompressed target
 * - Remaining bytes: contain the most significant bytes of the target
 * - Formula: bigBits * 2^(8 * (numBytes - 3))
 * 
 * @function bignumFromBitsBuffer
 * @param {Buffer} bitsBuff - 4-byte compact bits buffer from block header
 * @returns {bignum} Large integer representing the full 256-bit target
 * @see {@link https://en.bitcoin.it/wiki/Target}
 * @example
 * const compactBits = Buffer.from([0x1d, 0x00, 0xff, 0xff]);
 * const target = bignumFromBitsBuffer(compactBits);
 * console.log(target.toString(16)); // Full 256-bit target as hex string
 */
exports.bignumFromBitsBuffer = bitsBuff => {
    const numBytes = bitsBuff.readUInt8(0);
    const bigBits = bufferToBigInt(bitsBuff.subarray(1));
    const shift = BigInt(8 * (numBytes - 3));
    const target = bigBits * (2n ** shift);
    return target;
};

/**
 * Converts a compact bits hex string to a bignum target value.
 * Convenience wrapper around bignumFromBitsBuffer that accepts a hex string
 * instead of a buffer. Commonly used when processing block template data
 * received as JSON where bits values are hex-encoded strings.
 * 
 * @function bignumFromBitsHex
 * @param {string} bitsString - Hexadecimal string representation of compact bits (8 hex chars = 4 bytes)
 * @returns {bignum} Large integer representing the full 256-bit target
 * @example
 * const bitsHex = '1d00ffff';  // Compact bits as hex string
 * const target = bignumFromBitsHex(bitsHex);
 * console.log(target.toString(16)); // Full target value
 */
exports.bignumFromBitsHex = bitsString => {
    return exports.bignumFromBitsBuffer(Buffer.from(bitsString, 'hex'));
};

/**
 * Converts compact bits to a full 32-byte target buffer.
 * Expands the compressed compact bits format back to a full 256-bit (32-byte)
 * target value suitable for comparison with block hashes. The result is
 * right-padded with zeros to ensure exactly 32 bytes.
 * 
 * @function convertBitsToBuff
 * @param {Buffer} bitsBuff - 4-byte compact bits buffer
 * @returns {Buffer} 32-byte buffer containing the full target value (big-endian)
 * @example
 * const compactBits = Buffer.from([0x1d, 0x00, 0xff, 0xff]);
 * const fullTarget = convertBitsToBuff(compactBits);
 * console.log(fullTarget.length); // 32
 * console.log(fullTarget.toString('hex')); // Full 64-character hex target
 */
exports.convertBitsToBuff = bitsBuff => {
    const target = exports.bignumFromBitsBuffer(bitsBuff);
    const resultBuff = bigIntToBuffer(target);
    const buff256 = Buffer.alloc(32);
    buff256.fill(0);
    resultBuff.copy(buff256, buff256.length - resultBuff.length);
    return buff256;
};

/**
 * Generates a truncated difficulty target by shifting and compacting operations.
 * This function creates a difficulty target through a multi-step process:
 * 1. Shifts the maximum 256-bit value right by specified amount
 * 2. Converts to compact bits format (compression)
 * 3. Expands back to full 32-byte buffer (decompression)
 * 
 * The truncation occurs during the compact bits conversion, where precision
 * is reduced to fit the 4-byte compact format. This is used for generating
 * standardized difficulty levels in mining pools.
 * 
 * @function getTruncatedDiff
 * @param {number} shift - Number of bits to right-shift the maximum value
 * @returns {Buffer} 32-byte truncated difficulty target buffer
 * @example
 * const diffTarget = getTruncatedDiff(32);
 * console.log(diffTarget); // 32-byte target with truncation from compact conversion
 * 
 * // Larger shift = easier difficulty (higher target value)
 * // Smaller shift = harder difficulty (lower target value)
 */
exports.getTruncatedDiff = shift => {
    return exports.convertBitsToBuff(
        exports.bufferToCompactBits(
            exports.shiftMax256Right(shift)
        )
    );
};

/**
 * Calculates mining difficulty from a target hash value.
 * Difficulty represents how hard it is to find a valid block hash below the target.
 * The calculation uses the standard formula: difficulty = diff1_target / current_target
 * 
 * The function:
 * 1. Converts the hex target string to a BigInt for precise arithmetic
 * 2. Uses the global diff1 constant (maximum target for difficulty 1)
 * 3. Performs division to get the difficulty multiplier
 * 4. Returns a floating-point result rounded to 9 decimal places
 * 
 * @function calculateDifficulty
 * @param {string} targetHex - Target hash as big-endian hex string (without 0x prefix)
 * @returns {number} Calculated difficulty value (1.0 = easiest, higher = harder)
 * @example
 * const target = '00000000ffff0000000000000000000000000000000000000000000000000000';
 * const difficulty = calculateDifficulty(target);
 * console.log(difficulty); // e.g., 16777216.000000000
 * 
 * @note Requires global.diff1 to be set from libs/stratum/algoProperties.js
 * @note Lower target values result in higher difficulty numbers
 */
exports.calculateDifficulty = targetHex => {
    // Uses the project's hardcoded diff1 from `libs/stratum/algoProperties.js` (global.diff1)
    const targetBigInt = BigInt(`0x${targetHex}`);
    const diff1BigInt = BigInt(global.diff1);
    const diff = diff1BigInt / targetBigInt;
    return parseFloat(Number(diff).toFixed(9));
};
