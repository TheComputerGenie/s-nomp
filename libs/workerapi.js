/**
 * @fileoverview Worker API - lightweight HTTP API exposing pool statistics
 *
 * This module provides a minimal HTTP interface used by monitoring systems
 * to inspect worker and pool statistics.
 *
 * @author ComputerGenieCo
 * @version 21.7.3
 * @copyright 2025
 */
const http = require('http');
const { URL } = require('url');
const os = require('os');

/**
 * WorkerAPI
 *
 * Minimal HTTP API for exposing worker/pool statistics. Construct with a
 * listening port, call `start(poolObj)` to attach to a pool object that emits
 * 'started' and 'share' events. Call `stop()` to shut down the HTTP server and
 * remove listeners.
 *
 * @class WorkerAPI
 * @param {number} listen - Port number for the HTTP server
 */
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
class WorkerAPI {
    constructor(listen) {
        this.listen = listen;
        this.server = http.createServer((req, res) => {
            try {
                const base = `http://${req.headers.host || 'localhost'}`;
                const url = new URL(req.url, base);

                if (req.method === 'GET' && url.pathname === '/stats') {
                    const body = JSON.stringify({
                        'clients': Object.keys(this.poolObj.stratumServer.getStratumClients()).length,
                        'counters': this.counters,
                        'lastEvents': this.lastEvents
                    });

                    if (req.method === 'HEAD') {
                        res.writeHead(200, {
                            'Content-Type': 'application/json',
                            'Content-Length': Buffer.byteLength(body),
                            'Cache-Control': 'no-store'
                        });
                        return res.end();
                    }

                    res.writeHead(200, {
                        'Content-Type': 'application/json; charset=utf-8',
                        'Content-Length': Buffer.byteLength(body),
                        'Cache-Control': 'no-store'
                    });
                    return res.end(body);
                }

                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Not Found');
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Internal Server Error');
                console.error('Worker API request handler error:', err);
            }
        });

        this.counters = {
            validShares: 0,
            validBlocks: 0,
            invalidShares: 0
        };

        this.lastEvents = {
            lastValidShare: 0,
            lastValidBlock: 0,
            lastInvalidShare: 0
        };
    }

    /**
     * Initializes and starts the Worker API HTTP server
     *
     * This method establishes the connection between the Worker API and the main pool object,
     * sets up event listeners for share processing, and starts the HTTP server once the pool
     * is ready. The API server will begin accepting requests and tracking statistics after
     * the pool emits the 'started' event.
     *
    * @param {Object} poolObj - Pool object (EventEmitter) that emits 'started' and 'share'
    * @param {Object} poolObj.stratumServer - Stratum server instance for client management
    * @param {Function} poolObj.stratumServer.getStratumClients - Returns active client connections
    * @fires poolObj#started
    * @fires poolObj#share
    * @returns {void}
     */
    start(poolObj) {
        this.poolObj = poolObj;

        this.poolObj.once('started', () => {
            this.server.listen(this.listen, (error) => {
                if (error) {
                    console.error('Worker API failed to start:', error);
                } else {
                    console.log(`Worker API listening on port ${this.listen}`);
                }
            });
        })
            .on('share', (isValidShare, isValidBlock, shareData) => {
                const now = Date.now();

                if (isValidShare) {
                    this.counters.validShares++;
                    this.lastEvents.lastValidShare = now;

                    if (isValidBlock) {
                        this.counters.validBlocks++;
                        this.lastEvents.lastValidBlock = now;
                    }
                } else {
                    this.counters.invalidShares++;
                    this.lastEvents.lastInvalidShare = now;
                }
            });
    }

    stop() {
        try {
            if (this.server && this.server.close) {
                this.server.close();
            }
            if (this.poolObj && this.poolObj.removeAllListeners) {
                this.poolObj.removeAllListeners('share');
            }
        } catch (e) {
            console.error('Error stopping WorkerAPI:', e);
        }
    }
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
module.exports = WorkerAPI;

