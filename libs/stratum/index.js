/**
 * @fileoverview Stratum module - Core stratum protocol utilities
 *
 * Provides the Stratum class for creating mining pools and accessing stratum-related
 * utilities such as daemon interface, variable difficulty management, and general
 * utility functions.
 *
 * @author ComputerGenieCo
 * @version 21.7.3
 * @copyright 2025
 */
require('./algoProperties.js');

const pool = require('./pool.js');

/**
 * Stratum
 *
 * Core stratum protocol implementation class. Provides methods for creating pools
 * and access to stratum-related utilities.
 *
 * @class Stratum
 */
class Stratum {
    get daemon() {
        return require('./daemon.js');
    }

    get varDiff() {
        return require('./varDiff.js');
    }

    get util() {
        return require('../utils/util.js');
    }

    /**
     * Create a new mining pool instance.
     * @param {Object} poolOptions - Configuration options for the pool
     * @param {Function} authorizeFn - Authorization function for miners
     * @returns {Pool} A new pool instance
     */
    createPool(poolOptions, authorizeFn) {
        const newPool = new pool(poolOptions, authorizeFn);
        return newPool;
    }
}

module.exports = new Stratum();
