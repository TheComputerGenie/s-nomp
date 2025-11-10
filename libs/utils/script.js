/**
 * Script utilities
 *
 * @fileoverview Helpers for building and converting scriptPubKey/scriptSig formats.
 * @author ComputerGenieCo
 * @version 21.7.3
 * @license GPL-3.0-or-later
 * @copyright 2025
 */

const base58 = require('./base58-native.js');
const bitcoin = require('../utxo');

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

exports.miningKeyToScript = key => {
    const keyBuffer = Buffer.from(key, 'hex');
    return Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), keyBuffer, Buffer.from([0x88, 0xac])]);
};

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
 * Compile a standard Pay-to-Public-Key-Hash (P2PKH) script from a 20-byte hash160.
 * @param {Buffer} addrHash - 20-byte hash160 of the public key
 * @returns {Buffer} compiled scriptPubKey
 */
exports.scriptCompile = addrHash => bitcoin.script.compile([
    bitcoin.opcodes.OP_DUP,
    bitcoin.opcodes.OP_HASH160,
    addrHash,
    bitcoin.opcodes.OP_EQUALVERIFY,
    bitcoin.opcodes.OP_CHECKSIG
]);

