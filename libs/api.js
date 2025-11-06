const redis = require('redis');

const stats = require('./stats.js');

/**
 * API Module for Mining Pool Portal
 * 
 * This module handles HTTP API requests for the mining pool, providing endpoints
 * for statistics, worker information, payments, and real-time data streaming.
 * It serves as the main interface for external applications and the web frontend
 * to access pool data and statistics.
 * 
 * @module API
 * @param {Object} logger - Logger instance for logging API events and errors
 * @param {Object} portalConfig - Main portal configuration object
 * @param {Object} poolConfigs - Configuration objects for all configured pools
 * @returns {Object} API handler object with request handling methods
 */
module.exports = function (logger, portalConfig, poolConfigs) {

    const _this = this;

    /**
     * Portal statistics instance
     * Handles all statistical data collection, processing, and retrieval
     * @type {stats}
     */
    const portalStats = this.stats = new stats(logger, portalConfig, poolConfigs);

    /**
     * Active live statistics connections
     * Stores WebSocket-like connections for real-time statistics streaming
     * Key: unique connection ID, Value: response object for the connection
     * @type {Object.<string, Object>}
     */
    this.liveStatConnections = {};

    /**
     * Main API request handler
     * 
     * Routes incoming HTTP requests to appropriate handlers based on the method parameter.
     * Supports multiple endpoints including statistics, blocks, worker data, and payments.
     * 
     * @method handleApiRequest
     * @param {Object} req - Express request object containing URL parameters and query data
     * @param {Object} res - Express response object for sending data back to client
     * @param {Function} next - Express next middleware function for unhandled requests
     * @returns {void}
     */
    this.handleApiRequest = function (req, res, next) {

        switch (req.params.method) {
            case 'stats':
                // Return current pool statistics in JSON format
                // Includes hashrates, worker counts, block data, and network information
                res.header('Content-Type', 'application/json');
                res.end(portalStats.statsString);
                return;
            case 'pool_stats':
                // Return historical pool statistics data
                // Used for generating charts and trend analysis on the frontend
                res.header('Content-Type', 'application/json');
                res.end(JSON.stringify(portalStats.statPoolHistory));
                return;
            case 'blocks':
            case 'getblocksstats':
                // Retrieve block statistics and information
                // Includes found blocks, pending blocks, and block rewards
                portalStats.getBlocks((data) => {
                    res.header('Content-Type', 'application/json');
                    res.end(JSON.stringify(data));
                });
                break;
            case 'worker_balances':
                // Get worker balance information for a specific miner address
                // URL format: /api/worker_balances?<address>
                // Returns formatted balance data grouped by pool
                res.header('Content-Type', 'application/json');
                if (req.url.indexOf('?') > 0) {
                    const url_parms = req.url.split('?');
                    if (url_parms.length > 0) {
                        let address = url_parms[1] || null;
                        if (address != null && address.length > 0) {
                            // Extract base address (remove worker name if present)
                            address = address.split('.')[0];
                            //portalStats.getPoolBalancesByAddress(address, function(balances) {
                            //	res.end(JSON.stringify(balances));
                            //});
                            // Get balance data for the specified address across all pools
                            portalStats.getPoolBalancesByAddress(address, (balances) => {
                                // Object to store formatted balance data grouped by pool
                                const formattedBalances = {};

                                // Process each balance record and group by pool
                                balances.forEach((balance) => {
                                    // Initialize pool object if it doesn't exist
                                    if (!formattedBalances[balance.pool]) {
                                        formattedBalances[balance.pool] = {
                                            name: balance.pool,
                                            totalPaid: 0,      // Total amount paid to this address
                                            totalBalance: 0,   // Current confirmed balance
                                            totalImmature: 0,  // Unconfirmed/immature balance
                                            workers: []        // Individual worker details
                                        };
                                    }

                                    // Accumulate totals for this pool
                                    formattedBalances[balance.pool].totalPaid += balance.paid;
                                    formattedBalances[balance.pool].totalBalance += balance.balance;
                                    formattedBalances[balance.pool].totalImmature += balance.immature;

                                    // Add individual worker information
                                    formattedBalances[balance.pool].workers.push({
                                        name: balance.worker,
                                        balance: balance.balance,
                                        paid: balance.paid,
                                        immature: balance.immature
                                    });
                                    // Round values to 8 decimal places to avoid floating point precision issues
                                    formattedBalances[balance.pool].totalPaid = (Math.round(formattedBalances[balance.pool].totalPaid * 100000000) / 100000000);
                                    formattedBalances[balance.pool].totalBalance = (Math.round(formattedBalances[balance.pool].totalBalance * 100000000) / 100000000);
                                    formattedBalances[balance.pool].totalImmature = (Math.round(formattedBalances[balance.pool].totalImmature * 100000000) / 100000000);
                                });

                                // Convert object to array format for response
                                const finalBalances = Object.values(formattedBalances);
                                res.end(JSON.stringify(finalBalances));
                            });
                        } else {
                            // Return error for invalid or empty address
                            res.end(JSON.stringify({ result: 'error', message: 'Invalid wallet address' }));
                        }
                    } else {
                        // Return error for malformed URL parameters
                        res.end(JSON.stringify({ result: 'error', message: 'Invalid URL parameters' }));
                    }
                } else {
                    // Return error when no URL parameters are provided
                    res.end(JSON.stringify({ result: 'error', message: 'URL parameters not found' }));
                }
                return;
            case 'payments':
                // Get payment information for all pools
                // Returns pending blocks and payment history for each pool
                const poolBlocks = [];
                for (const pool in portalStats.stats.pools) {
                    poolBlocks.push({
                        name: pool,
                        pending: portalStats.stats.pools[pool].pending,    // Pending block rewards
                        payments: portalStats.stats.pools[pool].payments   // Historical payments
                    });
                }
                res.header('Content-Type', 'application/json');
                res.end(JSON.stringify(poolBlocks));
                return;
            case 'worker_stats':
                // Get comprehensive worker statistics for a specific miner address
                // URL format: /api/worker_stats?<address>
                // Returns worker performance, balances, shares, and historical data
                res.header('Content-Type', 'application/json');
                if (req.url.indexOf('?') > 0) {
                    const url_parms = req.url.split('?');
                    if (url_parms.length > 0) {
                        const history = {};    // Historical hashrate data for each worker
                        const workers = {};    // Current worker statistics
                        let address = url_parms[1] || null;
                        //res.end(portalStats.getWorkerStats(address));
                        if (address != null && address.length > 0) {
                            // Extract base miner address (remove worker name if present)
                            address = address.split('.')[0];
                            // Get miner's balance information across all pools and workers
                            portalStats.getBalanceByAddress(address, (balances) => {
                                // Get current round share total for the address
                                portalStats.getTotalSharesByAddress(address, (shares) => {
                                    let totalHash = parseFloat(0.0);   // Combined hashrate of all workers
                                    const totalShares = shares;         // Total shares submitted in current round
                                    let networkSols = 0;                // Network difficulty/solutions per second
                                    // Build historical hashrate data for all workers belonging to this address
                                    for (const h in portalStats.statHistory) {
                                        for (const pool in portalStats.statHistory[h].pools) {
                                            for (const w in portalStats.statHistory[h].pools[pool].workers) {
                                                // Check if worker belongs to the requested address
                                                if (w.startsWith(address)) {
                                                    // Initialize history array for this worker if needed
                                                    if (history[w] == null) {
                                                        history[w] = [];
                                                    }
                                                    // Add hashrate data point if available
                                                    if (portalStats.statHistory[h].pools[pool].workers[w].hashrate) {
                                                        history[w].push({
                                                            time: portalStats.statHistory[h].time,
                                                            hashrate: portalStats.statHistory[h].pools[pool].workers[w].hashrate
                                                        });
                                                    }
                                                }
                                            }
                                            // order check...
                                            //console.log(portalStats.statHistory[h].time);
                                        }
                                    }
                                    // Collect current worker statistics and balance information
                                    for (const pool in portalStats.stats.pools) {
                                        for (const w in portalStats.stats.pools[pool].workers) {
                                            // Check if worker belongs to the requested address
                                            if (w.startsWith(address)) {
                                                // Copy worker statistics
                                                workers[w] = portalStats.stats.pools[pool].workers[w];
                                                // Add balance information for this worker
                                                for (const b in balances.balances) {
                                                    if (w == balances.balances[b].worker) {
                                                        workers[w].paid = balances.balances[b].paid;
                                                        workers[w].balance = balances.balances[b].balance;
                                                    }
                                                }
                                                // Ensure balance fields have default values
                                                workers[w].balance = (workers[w].balance || 0);
                                                workers[w].paid = (workers[w].paid || 0);
                                                // Accumulate total hashrate across all workers
                                                totalHash += portalStats.stats.pools[pool].workers[w].hashrate;
                                                // Get network difficulty information
                                                networkSols = portalStats.stats.pools[pool].poolStats.networkSols;
                                            }
                                        }
                                    }
                                    // Return comprehensive worker statistics response
                                    res.end(JSON.stringify({
                                        miner: address,                         // The miner's address
                                        totalHash: totalHash,                   // Combined hashrate of all workers
                                        totalShares: totalShares,               // Total shares in current round
                                        networkSols: networkSols,               // Network difficulty
                                        immature: balances.totalImmature,       // Unconfirmed balance
                                        balance: balances.totalHeld,            // Confirmed balance
                                        paid: balances.totalPaid,               // Total amount paid
                                        workers: workers,                       // Individual worker details
                                        history: history                        // Historical hashrate data
                                    }));
                                });
                            });
                        } else {
                            // Return error for invalid address
                            res.end(JSON.stringify({ result: 'error' }));
                        }
                    } else {
                        // Return error for malformed URL parameters
                        res.end(JSON.stringify({ result: 'error' }));
                    }
                } else {
                    // Return error when no URL parameters are provided
                    res.end(JSON.stringify({ result: 'error' }));
                }
                return;
            case 'miner_live_stats':
                // Get lightweight miner statistics for real-time updates (no history data)
                // URL format: /api/miner_live_stats?<address>
                // Returns current worker stats, balances, and shares without historical data
                // This endpoint is optimized for frequent polling to reduce bandwidth usage
                res.header('Content-Type', 'application/json');
                if (req.url.indexOf('?') > 0) {
                    const url_parms = req.url.split('?');
                    if (url_parms.length > 0) {
                        const workers = {};    // Current worker statistics (no history)
                        let address = url_parms[1] || null;
                        if (address != null && address.length > 0) {
                            // Extract base miner address (remove worker name if present)
                            address = address.split('.')[0];
                            // Get miner's balance information across all pools and workers
                            portalStats.getBalanceByAddress(address, (balances) => {
                                // Get current round share total for the address
                                portalStats.getTotalSharesByAddress(address, (shares) => {
                                    let totalHash = parseFloat(0.0);   // Combined hashrate of all workers
                                    const totalShares = shares;         // Total shares submitted in current round
                                    let networkSols = 0;                // Network difficulty/solutions per second

                                    // Collect ONLY current worker statistics (skip historical data processing)
                                    for (const pool in portalStats.stats.pools) {
                                        for (const w in portalStats.stats.pools[pool].workers) {
                                            // Check if worker belongs to the requested address
                                            if (w.startsWith(address)) {
                                                // Copy worker statistics
                                                workers[w] = portalStats.stats.pools[pool].workers[w];
                                                // Add balance information for this worker
                                                for (const b in balances.balances) {
                                                    if (w == balances.balances[b].worker) {
                                                        workers[w].paid = balances.balances[b].paid;
                                                        workers[w].balance = balances.balances[b].balance;
                                                    }
                                                }
                                                // Ensure balance fields have default values
                                                workers[w].balance = (workers[w].balance || 0);
                                                workers[w].paid = (workers[w].paid || 0);
                                                // Accumulate total hashrate across all workers
                                                totalHash += portalStats.stats.pools[pool].workers[w].hashrate;
                                                // Get network difficulty information
                                                networkSols = portalStats.stats.pools[pool].poolStats.networkSols;
                                            }
                                        }
                                    }
                                    // Return lightweight statistics response (NO HISTORY DATA)
                                    res.end(JSON.stringify({
                                        miner: address,                         // The miner's address
                                        totalHash: totalHash,                   // Combined hashrate of all workers
                                        totalShares: totalShares,               // Total shares in current round
                                        networkSols: networkSols,               // Network difficulty
                                        immature: balances.totalImmature,       // Unconfirmed balance
                                        balance: balances.totalHeld,            // Confirmed balance
                                        paid: balances.totalPaid,               // Total amount paid
                                        workers: workers                        // Individual worker details (no history)
                                        // NOTE: 'history' field is intentionally omitted for performance
                                    }));
                                });
                            });
                        } else {
                            // Return error for invalid address
                            res.end(JSON.stringify({ result: 'error' }));
                        }
                    } else {
                        // Return error for malformed URL parameters
                        res.end(JSON.stringify({ result: 'error' }));
                    }
                } else {
                    // Return error when no URL parameters are provided
                    res.end(JSON.stringify({ result: 'error' }));
                }
                return;
            case 'live_stats':
                // Set up Server-Sent Events (SSE) connection for real-time statistics
                // Allows the frontend to receive live updates without polling
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',    // SSE content type
                    'Cache-Control': 'no-cache',            // Prevent caching
                    'Connection': 'keep-alive'              // Keep connection open
                });
                res.write('\n');
                // Generate unique ID for this connection
                const uid = Math.random().toString();
                // Store connection for broadcasting updates
                _this.liveStatConnections[uid] = res;
                res.flush();
                // Clean up connection when client disconnects
                req.on('close', () => {
                    delete _this.liveStatConnections[uid];
                });
                return;
            default:
                // Pass unhandled requests to next middleware
                next();
        }
    };

    /**
     * Administrative API request handler
     * 
     * Handles admin-specific API endpoints that require elevated privileges.
     * Currently supports retrieving pool configuration data.
     * 
     * @method handleAdminApiRequest
     * @param {Object} req - Express request object containing URL parameters
     * @param {Object} res - Express response object for sending data back to client
     * @param {Function} next - Express next middleware function for unhandled requests
     * @returns {void}
     */
    this.handleAdminApiRequest = function (req, res, next) {
        switch (req.params.method) {
            case 'pools': {
                // Return pool configuration data for administrative purposes
                // Contains sensitive configuration information
                res.end(JSON.stringify({ result: poolConfigs }));
                return;
            }
            default:
                // Pass unhandled admin requests to next middleware
                next();
        }
    };

};
