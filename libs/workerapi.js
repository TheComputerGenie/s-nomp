const express = require('express');
const os = require('os');

/**
 * Worker API Module - Provides HTTP API endpoints for monitoring pool worker statistics
 * 
 * This module creates an Express HTTP server that exposes real-time statistics about
 * the mining pool's worker performance, including share validation, block discovery,
 * and client connection metrics. It's designed to be used by monitoring systems,
 * dashboards, or administrative tools to track pool health and performance.
 * 
 * @class WorkerAPI
 * @param {number} listen - The port number on which the HTTP API server should listen
 * @example
 * const WorkerAPI = require('./workerapi');
 * const api = new WorkerAPI(3001);
 * api.start(poolObject);
 */
function workerapi(listen) {
    /** @private {WorkerAPI} Reference to this instance for use in callbacks */
    const _this = this;

    /** @private {express.Application} Express application instance for handling HTTP requests */
    const app = express();

    /**
     * Cumulative counters for tracking pool performance metrics
     * These counters increment throughout the pool's lifetime and are never reset
     * @private {Object}
     * @property {number} validShares - Total number of valid shares submitted by miners
     * @property {number} validBlocks - Total number of valid blocks found by the pool
     * @property {number} invalidShares - Total number of invalid/rejected shares
     */
    const counters = {
        validShares: 0,
        validBlocks: 0,
        invalidShares: 0
    };

    /**
     * Timestamps of the most recent events for performance monitoring
     * Used to track when the last activity occurred in each category
     * @private {Object}
     * @property {number} lastValidShare - Timestamp (milliseconds since epoch) of last valid share
     * @property {number} lastValidBlock - Timestamp (milliseconds since epoch) of last valid block
     * @property {number} lastInvalidShare - Timestamp (milliseconds since epoch) of last invalid share
     */
    const lastEvents = {
        lastValidShare: 0,
        lastValidBlock: 0,
        lastInvalidShare: 0
    };

    /**
     * GET /stats endpoint - Returns comprehensive pool statistics
     * 
     * This endpoint provides real-time statistics about the mining pool's current state,
     * including active client connections, cumulative performance counters, and timestamps
     * of recent events. This data is typically consumed by monitoring dashboards,
     * administrative interfaces, or automated alerting systems.
     * 
     * @route GET /stats
     * @returns {Object} JSON response containing pool statistics
     * @returns {number} returns.clients - Number of currently connected mining clients
     * @returns {Object} returns.counters - Cumulative performance counters
     * @returns {number} returns.counters.validShares - Total valid shares received
     * @returns {number} returns.counters.validBlocks - Total valid blocks found
     * @returns {number} returns.counters.invalidShares - Total invalid shares rejected
     * @returns {Object} returns.lastEvents - Timestamps of most recent events
     * @returns {number} returns.lastEvents.lastValidShare - Last valid share timestamp
     * @returns {number} returns.lastEvents.lastValidBlock - Last valid block timestamp
     * @returns {number} returns.lastEvents.lastInvalidShare - Last invalid share timestamp
     * 
     * @example
     * // Example response:
     * {
     *   "clients": 15,
     *   "counters": {
     *     "validShares": 12543,
     *     "validBlocks": 3,
     *     "invalidShares": 45
     *   },
     *   "lastEvents": {
     *     "lastValidShare": 1699123456789,
     *     "lastValidBlock": 1699120000000,
     *     "lastInvalidShare": 1699123400000
     *   }
     * }
     */
    app.get('/stats', (req, res) => {
        res.send({
            // Get current count of active stratum client connections
            'clients': Object.keys(_this.poolObj.stratumServer.getStratumClients()).length,
            // Return cumulative performance counters
            'counters': counters,
            // Return timestamps of most recent events
            'lastEvents': lastEvents
        });
    });


    /**
     * Initializes and starts the Worker API HTTP server
     * 
     * This method establishes the connection between the Worker API and the main pool object,
     * sets up event listeners for share processing, and starts the HTTP server once the pool
     * is ready. The API server will begin accepting requests and tracking statistics after
     * the pool emits the 'started' event.
     * 
     * @method start
     * @param {Object} poolObj - The main pool object that manages mining operations
     * @param {Object} poolObj.stratumServer - Stratum server instance for client management
     * @param {Function} poolObj.stratumServer.getStratumClients - Returns active client connections
     * @param {EventEmitter} poolObj - Pool object that emits 'started' and 'share' events
     * 
     * @fires poolObj#started - Emitted when the pool is ready to accept connections
     * @fires poolObj#share - Emitted when a share is processed by the pool
     * 
     * @example
     * const api = new WorkerAPI(3001);
     * api.start(myPoolObject);
     */
    this.start = function (poolObj) {
        // Store reference to the pool object for accessing stratum clients and events
        this.poolObj = poolObj;

        // Wait for the pool to be fully initialized before starting the HTTP server
        this.poolObj.once('started', () => {
            /**
             * Start the Express HTTP server on the specified port
             * The server will begin accepting API requests for statistics
             */
            app.listen(listen, (error) => {
                if (error) {
                    console.error('Worker API failed to start:', error);
                } else {
                    console.log(`Worker API listening on port ${listen}`);
                }
            });
        })
            /**
             * Listen for share events from the pool to update statistics
             * This event is emitted every time a miner submits a share (valid or invalid)
             * 
             * @listens poolObj#share
             * @param {boolean} isValidShare - Whether the submitted share is valid
             * @param {boolean} isValidBlock - Whether the share represents a valid block solution
             * @param {Object} shareData - Additional data about the share (unused in stats)
             */
            .on('share', (isValidShare, isValidBlock, shareData) => {
                // Record the current timestamp for event tracking
                const now = Date.now();

                if (isValidShare) {
                    // Increment valid share counter and update timestamp
                    counters.validShares++;
                    lastEvents.lastValidShare = now;

                    // If this valid share is also a block solution
                    if (isValidBlock) {
                        // Increment block counter and update block timestamp
                        counters.validBlocks++;
                        lastEvents.lastValidBlock = now;
                    }
                } else {
                    // Increment invalid share counter and update timestamp
                    counters.invalidShares++;
                    lastEvents.lastInvalidShare = now;
                }
            });
    };
}

/**
 * Export the WorkerAPI constructor function
 * 
 * This module exports the workerapi constructor function which can be used to create
 * new instances of the Worker API server. Each instance manages its own HTTP server
 * and statistics tracking for a specific pool.
 * 
 * @module WorkerAPI
 * @exports {Function} workerapi - Constructor function for creating Worker API instances
 */
module.exports = workerapi;

