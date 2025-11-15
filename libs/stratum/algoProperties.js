/**
 * @fileoverview Algorithm Properties - Mining algorithm configurations
 *
 * Defines mining algorithm properties including difficulty multipliers, hash functions,
 * and other algorithm-specific settings used by the stratum protocol.
 *
 * @author ComputerGenieCo
 * @version 21.7.3
 * @copyright 2025
 */
'use strict';

const diff1 = global.diff1 = 0x0007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;

/**
 * Algorithm configuration class
 *
 * Encapsulates properties for a specific mining algorithm.
 *
 * @class Algorithm
 * @param {Object} options - Algorithm configuration options
 * @param {number} [options.multiplier=1] - Difficulty multiplier
 * @param {number} options.diff - Difficulty value
 * @param {string} [options.hashReserved] - Reserved hash value
 * @param {Function} options.hash - Hash validation function
 * @param {number} [options.displayMultiplier=1] - Display multiplier for hashrate formatting
 */
class Algorithm {
    #multiplier;
    #diff;
    #hashReserved;
    #hash;
    #displayMultiplier;

    constructor(options) {
        this.#multiplier = options.multiplier || 1;
        this.#diff = options.diff;
        this.#hashReserved = options.hashReserved;
        this.#hash = options.hash;
        this.#displayMultiplier = options.displayMultiplier || 1;
    }

    /**
     * Get the difficulty multiplier
     * @returns {number}
     */
    get multiplier() {
        return this.#multiplier;
    }

    /**
     * Get the difficulty value
     * @returns {number}
     */
    get diff() {
        return this.#diff;
    }

    /**
     * Get the reserved hash value
     * @returns {string}
     */
    get hashReserved() {
        return this.#hashReserved;
    }

    /**
     * Get the hash validation function
     * @returns {Function}
     */
    get hash() {
        return this.#hash;
    }

    /**
     * Get the display multiplier for hashrate formatting
     * @returns {number}
     */
    get displayMultiplier() {
        return this.#displayMultiplier;
    }
}

/**
 * Algorithm Properties Manager
 *
 * Manages a collection of mining algorithms and provides access to their properties.
 * Used by the stratum protocol to retrieve algorithm-specific settings.
 *
 * @class AlgoProperties
 */
class AlgoProperties {
    #algorithms = new Map();

    constructor() {
        this.#algorithms.set('verushash', new Algorithm({
            multiplier: 1,
            diff: parseInt('0x0007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'),
            hashReserved: '0000000000000000000000000000000000000000000000000000000000000000',
            displayMultiplier: 2,
            hash: function (coinOptions) {
                return function () {
                    return true;
                };
            }
        }));
        this.#algorithms.set('equihash', new Algorithm({
            multiplier: 1,
            diff: parseInt('0x0007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'),
            displayMultiplier: 2,
            hash: function (coinOptions) {
                let parameters = coinOptions.parameters;
                if (!parameters) {
                    parameters = {
                        N: 200,
                        K: 9,
                        personalization: 'ZcashPoW'
                    };
                }
                const N = parameters.N || 200;
                const K = parameters.K || 9;
                const personalization = parameters.personalization || 'ZcashPoW';
                return function () {
                    return true;
                };
            }
        }));
    }

    /**
     * Get algorithm configuration by name
     * @param {string} name - Algorithm name
     * @returns {Algorithm|null} Algorithm instance or null if not found
     */
    getAlgo(name) {
        return this.#algorithms.get(name) || null;
    }

    /**
     * Get difficulty value for an algorithm
     * @param {string} name - Algorithm name
     * @returns {number} Difficulty value or 0 if not found
     */
    getDiff(name) {
        const algo = this.getAlgo(name);
        return algo ? algo.diff : 0;
    }

    /**
     * Get multiplier value for an algorithm
     * @param {string} name - Algorithm name
     * @returns {number} Multiplier value or 1 if not found
     */
    getMultiplier(name) {
        const algo = this.getAlgo(name);
        return algo ? algo.multiplier : 1;
    }

    /**
     * Get display multiplier value for an algorithm
     * @param {string} name - Algorithm name
     * @returns {number} Display multiplier value or 1 if not found
     */
    getDisplayMultiplier(name) {
        const algo = this.getAlgo(name);
        return algo ? algo.displayMultiplier : 1;
    }

    /**
     * Check if an algorithm is supported
     * @param {string} name - Algorithm name
     * @returns {boolean} True if algorithm exists, false otherwise
     */
    hasAlgorithm(name) {
        return this.#algorithms.has(name);
    }

    /**
     * Get hash function for an algorithm
     * @param {string} name - Algorithm name
     * @param {Object} coinOptions - Coin-specific options
     * @returns {Function|null} Hash function or null if not found
     */
    getHash(name, coinOptions) {
        const algo = this.getAlgo(name);
        if (algo && algo.hash) {
            return algo.hash(coinOptions);
        }
        return null;
    }
}

module.exports = new AlgoProperties();
