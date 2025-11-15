/**
 * @fileoverview Merkle Tree utilities
 *
 * Provides utilities for generating Merkle tree roots from transaction data
 * for stratum mining protocol.
 *
 * @author ComputerGenieCo
 * @version 21.7.3
 * @copyright 2025
 */

'use strict';

const crypto = require('crypto');
const util = require('../utils/util.js');

/**
 * MerkleTree utility class
 *
 * Provides static methods for Merkle tree operations.
 *
 * @class MerkleTree
 */
class MerkleTree {
    static #sha256d(buffer) {
        return crypto.createHash('sha256').update(crypto.createHash('sha256').update(buffer).digest()).digest();
    }

    static #reverse(buffer) {
        const reversed = Buffer.alloc(buffer.length);
        for (let i = 0; i < buffer.length; i++) {
            reversed[i] = buffer[buffer.length - 1 - i];
        }
        return reversed;
    }

    static #generate(array, options) {
        options = options || {};
        const reverseHashes = options.reverse !== false;

        if (array.length === 1) {
            return { root: array[0] };
        }

        let hashes = array.map(h => Buffer.from(h, 'hex'));

        if (reverseHashes) {
            hashes = hashes.map(this.#reverse);
        }

        while (hashes.length > 1) {
            const newHashes = [];
            for (let i = 0; i < hashes.length; i += 2) {
                const a = hashes[i];
                const b = (i + 1 < hashes.length) ? hashes[i + 1] : a;
                const combined = Buffer.concat([a, b]);
                const hash = this.#sha256d(combined);
                newHashes.push(hash);
            }
            hashes = newHashes;
        }

        let root = hashes[0];
        if (reverseHashes) {
            root = this.#reverse(root);
        }

        return { root: root.toString('hex') };
    }

    /**
     * Get the Merkle root from RPC data and generation transaction raw.
     * @param {Object} rpcData - The RPC data containing transactions.
     * @param {string} generateTxRaw - The raw generation transaction.
     * @returns {string} The Merkle root hash.
     */
    static getRoot(rpcData, generateTxRaw) {
        const txs = rpcData.transactions;
        const txCount = txs.length;

        if (txCount === 0) {
            return util.reverseBuffer(Buffer.from(generateTxRaw, 'hex')).toString('hex');
        }

        const hashes = new Array(txCount + 1);
        hashes[0] = util.reverseBuffer(Buffer.from(generateTxRaw, 'hex')).toString('hex');

        for (let i = 0; i < txCount; i++) {
            hashes[i + 1] = txs[i].hash;
        }

        const result = this.#generate(hashes);
        return result.root;
    }
}

module.exports = MerkleTree;

