/**
 * @fileoverview Merkle Tree Implementation for Mining Pool Stratum Server
 * 
 * This module provides utilities for calculating Merkle tree roots used in Bitcoin-like
 * cryptocurrency mining. The Merkle tree is a binary tree structure that efficiently
 * summarizes all transactions in a block, creating a single hash (the Merkle root)
 * that represents all transactions.
 * 
 * The Merkle root is crucial for:
 * - Block validation and verification
 * - Efficient transaction proof-of-inclusion
 * - Creating block headers for mining
 * 
 * This implementation handles the specific requirements of mining pool operations,
 * including proper byte order handling and integration with RPC data from cryptocurrency daemons.
 * 
 * @author S-NOMP Mining Pool
 * @version 1.0.0
 * @requires promise - For promisifying callback-based functions
 * @requires merkle-bitcoin - Bitcoin-specific Merkle tree calculation library
 * @requires ./util.js - Utility functions for buffer operations
 */

const Promise = require('promise');
const merklebitcoin = Promise.denodeify(require('merkle-bitcoin'));
const util = require('./util.js');

/**
 * Calculates the Merkle root from an array of transaction hashes.
 * 
 * This is an internal helper function that uses the merkle-bitcoin library
 * to compute the Merkle tree and extract the root hash. The merkle-bitcoin
 * library returns an object with multiple properties, and we specifically
 * need the root from the third property (index 2).
 * 
 * @private
 * @function calcRoot
 * @param {string[]} hashes - Array of transaction hashes in hexadecimal format
 * @returns {string} The calculated Merkle root as a hexadecimal string
 * 
 * @example
 * // Calculate root for multiple transaction hashes
 * const hashes = ['abc123...', 'def456...', 'ghi789...'];
 * const root = calcRoot(hashes);
 * console.log(root); // Returns the Merkle root hash
 */
function calcRoot(hashes) {
    // Use the merkle-bitcoin library to calculate the Merkle tree
    const result = merklebitcoin(hashes);

    // Debug logging (commented out) - useful for development/troubleshooting
    //console.log(Object.values(result)[2].root);

    // Extract and return the root hash from the result object
    // The merkle-bitcoin library returns an object with multiple properties,
    // and the root is located at index 2 when converted to values array
    return Object.values(result)[2].root;
}

/**
 * Generates the Merkle root for a block's transactions.
 * 
 * This is the main exported function that constructs a complete list of transaction
 * hashes (including the coinbase/generation transaction) and calculates the Merkle root.
 * 
 * The function performs several important operations:
 * 1. Prepares the coinbase transaction hash with proper byte order
 * 2. Adds all other transaction hashes from the RPC data
 * 3. Handles the special case of single-transaction blocks
 * 4. Calculates and returns the final Merkle root
 * 
 * @public
 * @function getRoot
 * @param {Object} rpcData - RPC response data from the cryptocurrency daemon
 * @param {Object[]} rpcData.transactions - Array of transaction objects from the daemon
 * @param {string} rpcData.transactions[].hash - Transaction hash in hexadecimal format
 * @param {string} generateTxRaw - Raw coinbase/generation transaction in hexadecimal format
 * @returns {string} The calculated Merkle root as a hexadecimal string
 * 
 * @example
 * // Typical usage in mining pool context
 * const rpcData = {
 *   transactions: [
 *     { hash: 'abc123...' },
 *     { hash: 'def456...' }
 *   ]
 * };
 * const coinbaseTx = '01000000...'; // Raw coinbase transaction
 * const merkleRoot = getRoot(rpcData, coinbaseTx);
 * 
 * @example
 * // Single transaction block (coinbase only)
 * const rpcData = { transactions: [] };
 * const coinbaseTx = '01000000...';
 * const merkleRoot = getRoot(rpcData, coinbaseTx); // Returns coinbase hash directly
 */
exports.getRoot = function (rpcData, generateTxRaw) {
    // Initialize hashes array with the coinbase transaction
    // The coinbase transaction bytes need to be reversed to match Bitcoin's
    // little-endian byte order convention for transaction hashes
    hashes = [util.reverseBuffer(Buffer.from(generateTxRaw, 'hex')).toString('hex')];

    // Add all other transaction hashes from the RPC data
    // These transaction hashes are already in the correct format from the daemon
    rpcData.transactions.forEach((value) => {
        hashes.push(value.hash);
    });

    // Special case: If there's only one transaction (coinbase only),
    // the Merkle root is simply the coinbase transaction hash
    // This optimization avoids unnecessary Merkle tree calculation
    if (hashes.length === 1) {
        return hashes[0];
    }

    // Calculate the Merkle root using the complete hash list
    const result = calcRoot(hashes);
    return result;
};
