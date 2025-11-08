/**
 * @fileoverview Statistics Collection and Management Module for S-NOMP Mining Pool
 * 
 * This module provides comprehensive statistics collection, processing, and management
 * for cryptocurrency mining pools. It handles:
 * 
 * - Real-time hashrate calculations and worker statistics
 * - Balance tracking and payout history for miners
 * - Block discovery and confirmation status
 * - Historical data retention and analysis
 * - Multi-pool support with Redis-based data storage
 * - Network statistics and difficulty monitoring
 * 
 * The module uses Redis as the primary data store and supports multiple mining
 * algorithms through the algos configuration. It calculates worker statistics,
 * pool performance metrics, and provides APIs for web interface data display.
 * 
 * Key Redis Data Structures:
 * - {coin}:hashrate - Time-series hashrate data
 * - {coin}:stats - Pool statistics (blocks, shares, network info)
 * - {coin}:shares:roundCurrent - Current round share distribution
 * - {coin}:balances - Miner balance information
 * - {coin}:payouts - Payment history
 * - {coin}:immature - Pending/immature balances
 * - statHistory - Historical statistics for trending
 * 
 * @author S-NOMP Development Team
 * @requires redis - Redis client for data persistence
 * @requires async - Asynchronous flow control
 * @requires ./stratum/algoProperties.js - Mining algorithm properties
 */

const zlib = require('zlib');

const redis = require('redis');

const os = require('os');

const algos = require('./stratum/algoProperties.js');
const { promisify } = require('util');
const util = require('./utils/util.js');

// Helper to execute a Redis MULTI pipeline and return a Promise
function runMulti(client, commands) {
    return new Promise((resolve, reject) => {
        try {
            client.multi(commands).exec((err, replies) => {
                if (err) {
                    return reject(err);
                }
                resolve(replies);
            });
        } catch (e) {
            reject(e);
        }
    });
}

// Small native replacement for the limited `async` usage in this file.
// Provides `each(collection, iterator, done)` semantics similar to async.each.
function each(collection, iterator, done) {
    if (!collection) {
        if (done) {
            done();
        }
        return;
    }
    const keys = Array.isArray(collection) ? collection.map((_, i) => i) : Object.keys(collection);
    let remaining = keys.length;
    if (remaining === 0) {
        if (done) {
            done();
        }
        return;
    }
    let finished = false;
    keys.forEach((k) => {
        try {
            iterator(collection[k], (err) => {
                if (finished) {
                    return;
                }
                if (err) {
                    finished = true;
                    if (done) {
                        done(err);
                    }
                    return;
                }
                remaining -= 1;
                if (remaining === 0) {
                    if (done) {
                        done();
                    }
                }
            });
        } catch (e) {
            if (!finished) {
                finished = true;
                if (done) {
                    done(e);
                }
            }
        }
    });
}

/**
 * Creates a Redis client with authentication support
 * 
 * This function creates a Redis client connection and handles authentication
 * if a password is provided. It serves as a helper to bypass Redis callback
 * ready check issues that can occur in some Redis configurations.
 * 
 * @param {number} port - Redis server port number
 * @param {string} host - Redis server hostname or IP address
 * @param {string} [pass] - Optional Redis authentication password
 * @returns {Object} Configured Redis client instance
 */
function rediscreateClient(port, host, pass) {
    const client = redis.createClient(port, host);
    if (pass) {
        client.auth(pass);
    }
    return client;
}


/**
 * Sort object properties with flexible sorting options
 * 
 * This utility function converts an object into a sorted array of key-value pairs.
 * It supports both numeric and string sorting, with optional reverse ordering.
 * Special handling is provided for 'name' property sorting using natural sort
 * algorithm for better worker name ordering (e.g., worker1, worker2, worker10).
 * 
 * @param {Object} obj - Object to sort properties from
 * @param {string|number} [sortedBy=1] - Property name to sort by, or 1 for first element
 * @param {boolean} [isNumericSort=false] - True for numeric sorting, false for string sorting
 * @param {boolean} [reverse=false] - True to reverse the sort order
 * @returns {Array<Array>} Array of [key, value] pairs sorted according to criteria
 * 
 * @example
 * // Sort workers by hashrate (numeric, descending)
 * const sortedWorkers = sortProperties(workers, 'hashrate', true, true);
 * 
 * @example
 * // Sort by name using natural sorting
 * const sortedByName = sortProperties(items, 'name', false, false);
 */
function sortProperties(obj, sortedBy, isNumericSort, reverse) {
    sortedBy = sortedBy || 1; // by default first key
    isNumericSort = isNumericSort || false; // by default text sort
    reverse = reverse || false; // by default no reverse

    const reversed = (reverse) ? -1 : 1;

    const sortable = [];
    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            sortable.push([key, obj[key]]);
        }
    }
    if (isNumericSort) {
        sortable.sort((a, b) => {
            return reversed * (a[1][sortedBy] - b[1][sortedBy]);
        });
    } else if (sortedBy === 'name') {
        // Use natural sort for worker names
        sortable.sort((a, b) => {
            return naturalSort(a[1][sortedBy], b[1][sortedBy]) * reversed;
        });
    } else {
        sortable.sort((a, b) => {
            const x = a[1][sortedBy].toLowerCase(),
                y = b[1][sortedBy].toLowerCase();
            return x < y ? reversed * -1 : x > y ? reversed : 0;
        });
    }

    /**
     * Natural sort comparator for alphanumeric strings
     * 
     * This function implements natural sorting, which handles numeric parts
     * within strings intelligently. For example, it will sort "worker1", "worker2", 
     * "worker10" in the correct order rather than lexicographic order.
     * 
     * @param {string} a - First string to compare
     * @param {string} b - Second string to compare
     * @returns {number} Negative if a < b, positive if a > b, 0 if equal
     */
    function naturalSort(a, b) {
        const ax = [], bx = [];
        // Split strings into numeric and non-numeric parts
        a.replace(/(\d+)|(\D+)/g, (_, $1, $2) => {
            ax.push([$1 || Infinity, $2 || '']);
        });
        b.replace(/(\d+)|(\D+)/g, (_, $1, $2) => {
            bx.push([$1 || Infinity, $2 || '']);
        });

        // Compare part by part
        while (ax.length && bx.length) {
            const an = ax.shift(), bn = bx.shift();
            const nn = (an[0] - bn[0]) || an[1].localeCompare(bn[1]);
            if (nn) {
                return nn;
            }
        }
        return ax.length - bx.length;
    }
    return sortable; // array in format [ [ key1, val1 ], [ key2, val2 ], ... ]
}

/**
 * Statistics Management Module Constructor
 * 
 * Creates and initializes a comprehensive statistics management system for
 * cryptocurrency mining pools. This module handles real-time statistics
 * collection, historical data management, worker tracking, and balance
 * calculations across multiple pools and cryptocurrencies.
 * 
 * The module automatically sets up Redis connections for each configured
 * pool and begins collecting historical statistics data upon initialization.
 * 
 * @param {Object} logger - Logging system instance for error and info messages
 * @param {Object} portalConfig - Main portal configuration object containing:
 *   @param {Object} portalConfig.redis - Redis connection settings for stats storage
 *   @param {Object} portalConfig.website - Website configuration including:
 *     @param {Object} portalConfig.website.stats - Statistics settings:
 *       @param {number} portalConfig.website.stats.hashrateWindow - Time window for hashrate calculation (seconds)
 *       @param {number} portalConfig.website.stats.historicalRetention - How long to keep historical data (seconds)
 * @param {Object} poolConfigs - Configuration objects for each pool, keyed by coin name:
 *   @param {Object} poolConfigs[coin].redis - Redis connection settings for this pool
 *   @param {Object} poolConfigs[coin].coin - Coin-specific settings (symbol, algorithm, etc.)
 * 
 * @constructor
 * @example
 * const StatsModule = require('./libs/stats');
 * const stats = new StatsModule(logger, portalConfig, poolConfigs);
 */
module.exports = function (logger, portalConfig, poolConfigs) {

    const _this = this;

    const logSystem = 'Stats';

    /** @type {Array<Object>} Array of Redis client objects with associated coin lists */
    const redisClients = [];

    /** @type {Object} Redis client for statistics storage */
    let redisStats;

    /** @type {Array<Object>} Historical statistics data for trending analysis */
    this.statHistory = [];

    /** @type {Array<Object>} Pool-specific historical data */
    this.statPoolHistory = [];

    /** @type {Object} Current comprehensive statistics object */
    this.stats = {};

    /** @type {string} JSON string representation of current stats for storage */
    this.statsString = '';

    // Initialize Redis connections and load historical data
    setupStatsRedis();
    gatherStatHistory();

    const canDoStats = true;

    /**
     * Initialize Redis clients for each pool configuration
     * 
     * This section creates Redis client connections for each configured pool.
     * It optimizes connections by reusing clients that connect to the same
     * Redis instance (same host/port), grouping multiple coins under a
     * single client when possible.
     */
    Object.keys(poolConfigs).forEach((coin) => {
        if (!canDoStats) {
            return;
        }

        const poolConfig = poolConfigs[coin];
        const redisConfig = poolConfig.redis;

        // Check if we already have a client for this Redis instance
        for (let i = 0; i < redisClients.length; i++) {
            const client = redisClients[i];
            if (client.client.port === redisConfig.port && client.client.host === redisConfig.host) {
                client.coins.push(coin);
                return;
            }
        }

        // Create new Redis client for this instance
        redisClients.push({
            coins: [coin],
            client: rediscreateClient(redisConfig.port, redisConfig.host, redisConfig.password)
        });
    });

    /**
     * Initialize Redis client for statistics storage
     * 
     * Sets up the main Redis connection used for storing historical statistics
     * and portal-wide data. This client is separate from pool-specific clients
     * and handles authentication on connection errors.
     * 
     * @private
     */
    function setupStatsRedis() {
        redisStats = redis.createClient(portalConfig.redis.port, portalConfig.redis.host);
        redisStats.on('error', (err) => {
            // Authenticate on connection error (common Redis pattern)
            redisStats.auth(portalConfig.redis.password);
        });
    }

    /**
     * Retrieve all blocks (pending and confirmed) from all pools
     * 
     * Aggregates block data from all configured pools, including both pending
     * and confirmed blocks. Each block is keyed by a combination of pool name
     * and block height for unique identification across pools.
     * 
     * Block data format: "timestamp:blockHash:blockHeight:transactionHash:difficulty:sharesDiff"
     * 
     * @param {Function} cback - Callback function to receive results
     * @param {Object} cback.allBlocks - Object containing all blocks keyed by "poolName-blockHeight"
     * 
     * @example
     * stats.getBlocks((allBlocks) => {
     *   console.log(allBlocks);
     *   // { "VRSC-12345": "1234567890:abc123...:12345:def456...:1000:500" }
     * });
     */
    this.getBlocks = function (cback) {
        const allBlocks = {};
        each(_this.stats.pools, (pool, pcb) => {

            // Process pending blocks
            if (_this.stats.pools[pool.name].pending && _this.stats.pools[pool.name].pending.blocks) {
                for (let i = 0; i < _this.stats.pools[pool.name].pending.blocks.length; i++) {
                    const blockHeight = _this.stats.pools[pool.name].pending.blocks[i].split(':')[2];
                    allBlocks[`${pool.name}-${blockHeight}`] = _this.stats.pools[pool.name].pending.blocks[i];
                }
            }

            // Process confirmed blocks
            if (_this.stats.pools[pool.name].confirmed && _this.stats.pools[pool.name].confirmed.blocks) {
                for (let i = 0; i < _this.stats.pools[pool.name].confirmed.blocks.length; i++) {
                    const blockHeight = _this.stats.pools[pool.name].confirmed.blocks[i].split(':')[2];
                    allBlocks[`${pool.name}-${blockHeight}`] = _this.stats.pools[pool.name].confirmed.blocks[i];
                }
            }

            pcb();
        }, (err) => {
            cback(allBlocks);
        });
    };

    /**
     * Load historical statistics from Redis storage
     * 
     * Retrieves historical statistics data within the configured retention period
     * and populates the statHistory array. Only statistics with active workers
     * are included to avoid empty data points. The data is sorted chronologically
     * and processed to build pool-specific historical data.
     * 
     * @private
     */
    function gatherStatHistory() {
        (async () => {
            try {
                // Calculate cutoff time based on retention policy
                const retentionTime = (((Date.now() / 1000) - portalConfig.website.stats.historicalRetention) | 0).toString();

                const zrangebyscoreAsync = promisify(redisStats.zrangebyscore).bind(redisStats);
                const replies = await zrangebyscoreAsync('statHistory', retentionTime, '+inf');

                // Parse and filter historical data
                for (let i = 0; i < replies.length; i++) {
                    const stats = JSON.parse(replies[i]);
                    // Only include stats with active workers to avoid empty data points
                    if (stats.global && stats.global.workers > 0) {
                        _this.statHistory.push(stats);
                    }
                }

                // Sort chronologically for proper trending analysis
                _this.statHistory = _this.statHistory.sort((a, b) => {
                    return a.time - b.time;
                });

                // Build pool-specific historical data from main history
                _this.statHistory.forEach((stats) => {
                    addStatPoolHistory(stats);
                });
            } catch (err) {
                logger.error(logSystem, 'Historics', `Error when trying to grab historical stats ${JSON.stringify(err)}`);
            }
        })();
    }

    function getWorkerStats(address) {
        address = address.split('.')[0];
        if (address.length > 0 && address.startsWith('t')) {
            for (const h in statHistory) {
                for (const pool in statHistory[h].pools) {

                    statHistory[h].pools[pool].workers.sort(sortWorkersByHashrate);

                    for (const w in statHistory[h].pools[pool].workers) {
                        if (w.startsWith(address)) {
                            if (history[w] == null) {
                                history[w] = [];
                            }
                            if (workers[w] == null && stats.pools[pool].workers[w] != null) {
                                workers[w] = stats.pools[pool].workers[w];
                            }
                            if (statHistory[h].pools[pool].workers[w].hashrate) {
                                history[w].push({ time: statHistory[h].time, hashrate: statHistory[h].pools[pool].workers[w].hashrate });
                            }
                        }
                    }
                }
            }
            return JSON.stringify({ 'workers': workers, 'history': history });
        }
        return null;
    }

    /**
     * Add statistics to pool-specific historical data
     * 
     * Extracts key pool metrics from full statistics and adds them to the
     * pool history for trending analysis. Only essential metrics are stored
     * to minimize memory usage while preserving trend data.
     * 
     * @private
     * @param {Object} stats - Full statistics object
     */
    function addStatPoolHistory(stats) {
        const data = {
            time: stats.time,
            pools: {}
        };

        // Extract essential metrics for each pool
        for (const pool in stats.pools) {
            data.pools[pool] = {
                hashrate: stats.pools[pool].hashrate,        // Pool hashrate for trending
                workerCount: stats.pools[pool].workerCount,  // Active worker count
                blocks: stats.pools[pool].blocks             // Block status counts
            };
        }

        _this.statPoolHistory.push(data);
    }

    /**
     * Mathematical Constants and Utility Functions
     * 
     * These functions handle cryptocurrency amount conversions and precision
     * calculations, following the standard satoshi (smallest unit) convention.
     */

    /** @const {number} Base unit multiplier (100,000,000 satoshis = 1 coin) */
    const magnitude = 100000000;

    /** @const {number} Decimal precision for coin amounts */
    const coinPrecision = magnitude.toString().length - 1;

    // readableSeconds has been moved to libs/utils/misc.js and is exported via util.getReadableTimeString

    /**
     * Get list of configured coins/pools
     * 
     * Returns the list of coin identifiers that are currently configured
     * and available for statistics collection. This is typically used by
     * the web interface to determine which pools to display.
     * 
     * @param {Function} cback - Callback function
     */
    this.getCoins = function (cback) {
        _this.stats.coins = redisClients[0].coins;
        cback();
    };

    this.getPayout = function (address, cback) {
        // The original waterfall performed a single async step; call directly.
        _this.getBalanceByAddress(address, (result) => {
            const total = (result && result.totalHeld) ? result.totalHeld : 0;
            cback(util.coinsRound(total, coinPrecision).toFixed(8));
        });
    };

    /**
     * Get total shares for a specific miner address across all pools
     * 
     * Retrieves the total number of shares contributed by a specific miner
     * address in the current mining round. This includes all workers associated
     * with the address (identified by the part before the first dot).
     * 
     * Uses Redis HSCAN to efficiently search through large share datasets
     * with pattern matching for all workers belonging to the address.
     * 
     * @param {string} address - Miner address (e.g., "tAddr1234.worker1")
     * @param {Function} cback - Callback function
     * @param {number} cback.totalShares - Total shares contributed by this address
     * 
     * @example
     * stats.getTotalSharesByAddress('tAddr1234.worker1', (totalShares) => {
     *   console.log(`Address has contributed ${totalShares} shares this round`);
     * });
     */
    this.getTotalSharesByAddress = function (address, cback) {
        // Extract base address (before first dot) to include all workers
        const a = address.split('.')[0];
        const client = redisClients[0].client,
            coins = redisClients[0].coins,
            shares = [];

        let pindex = parseInt(0);
        let totalShares = parseFloat(0);

        (async () => {
            try {
                const hscanAsync = promisify(client.hscan).bind(client);
                const pools = Object.keys(_this.stats.pools);
                for (let idx = 0; idx < pools.length; idx++) {
                    pindex++;
                    const poolName = pools[idx];
                    const coin = String(_this.stats.pools[poolName].name);

                    // HSCAN returns [cursor, [k, v, k, v...]]
                    const result = await hscanAsync(`${coin}:shares:roundCurrent`, 0, 'match', `${a}*`, 'count', 50000);
                    let workerName = '';
                    let shares = 0;
                    for (const i in result[1]) {
                        if (Math.abs(i % 2) != 1) {
                            workerName = String(result[1][i]);
                        } else {
                            shares += parseFloat(result[1][i]);
                        }
                    }
                    if (shares > 0) {
                        totalShares = shares;
                    }
                }

                if (totalShares > 0 || (pindex >= Object.keys(_this.stats.pools).length)) {
                    cback(totalShares);
                    return;
                }
                cback(0);
            } catch (err) {
                cback(0);
            }
        })();
    };

    /**
     * Get comprehensive balance information for a miner address
     * 
     * Retrieves complete balance information for a miner including current
     * balances, payment history, and immature (pending) balances across all
     * pools. The function aggregates data from multiple Redis hash structures
     * and provides both individual worker details and totals.
     * 
     * Redis Keys Used:
     * - {coin}:balances - Current confirmed balances ready for payout
     * - {coin}:payouts - Historical payout amounts
     * - {coin}:immature - Immature balances from recently found blocks
     * 
     * @param {string} address - Miner address (e.g., "tAddr1234.worker1")
     * @param {Function} cback - Callback function
     * @param {Object} cback.result - Balance information object:
     *   @param {number} cback.result.totalHeld - Total confirmed balance across all pools
     *   @param {number} cback.result.totalPaid - Total amount paid historically
     *   @param {number} cback.result.totalImmature - Total immature balance
     *   @param {Array<Object>} cback.result.balances - Per-worker balance details
     * 
     * @example
     * stats.getBalanceByAddress('tAddr1234', (result) => {
     *   console.log(`Total balance: ${result.totalHeld} coins`);
     *   console.log(`Total paid: ${result.totalPaid} coins`);
     *   result.balances.forEach(worker => {
     *     console.log(`${worker.worker}: ${worker.balance} confirmed, ${worker.immature} pending`);
     *   });
     * });
     */
    this.getBalanceByAddress = function (address, cback) {

        // Extract base address to include all workers
        const a = address.split('.')[0];

        const client = redisClients[0].client,
            coins = redisClients[0].coins,
            balances = [];

        let totalHeld = parseFloat(0);
        let totalPaid = parseFloat(0);
        let totalImmature = parseFloat(0);

        (async () => {
            try {
                const hscanAsync = promisify(client.hscan).bind(client);
                const pools = Object.keys(_this.stats.pools);
                for (let idx = 0; idx < pools.length; idx++) {
                    const poolName = pools[idx];
                    const coin = String(_this.stats.pools[poolName].name);

                    const pends = await hscanAsync(`${coin}:immature`, 0, 'match', `${a}*`, 'count', 50000);
                    const bals = await hscanAsync(`${coin}:balances`, 0, 'match', `${a}*`, 'count', 50000);
                    const pays = await hscanAsync(`${coin}:payouts`, 0, 'match', `${a}*`, 'count', 50000);

                    let workerName = '';
                    let balAmount = 0;
                    let paidAmount = 0;
                    let pendingAmount = 0;

                    const workers = {};

                    // Process payout history (HSCAN returns alternating keys/values)
                    for (const i in pays[1]) {
                        if (Math.abs(i % 2) != 1) {
                            workerName = String(pays[1][i]);
                            workers[workerName] = (workers[workerName] || {});
                        } else {
                            paidAmount = parseFloat(pays[1][i]);
                            workers[workerName].paid = util.coinsRound(paidAmount, coinPrecision);
                            totalPaid += paidAmount;
                        }
                    }

                    // Process confirmed balances
                    for (const b in bals[1]) {
                        if (Math.abs(b % 2) != 1) {
                            workerName = String(bals[1][b]);
                            workers[workerName] = (workers[workerName] || {});
                        } else {
                            balAmount = parseFloat(bals[1][b]);
                            workers[workerName].balance = util.coinsRound(balAmount, coinPrecision);
                            totalHeld += balAmount;
                        }
                    }

                    // Process immature balances (stored in satoshis)
                    for (const b in pends[1]) {
                        if (Math.abs(b % 2) != 1) {
                            workerName = String(pends[1][b]);
                            workers[workerName] = (workers[workerName] || {});
                        } else {
                            pendingAmount = parseFloat(pends[1][b]);
                            workers[workerName].immature = util.coinsRound(util.satoshisToCoins(pendingAmount, magnitude, coinPrecision), coinPrecision);
                            totalImmature += pendingAmount;
                        }
                    }

                    // Build worker balance array
                    for (const w in workers) {
                        balances.push({
                            worker: String(w),
                            balance: workers[w].balance,
                            paid: workers[w].paid,
                            immature: workers[w].immature
                        });
                    }
                }

                // Store results in stats object for potential reuse
                _this.stats.balances = balances;
                _this.stats.address = address;

                // Return comprehensive balance information
                cback({
                    totalHeld: util.coinsRound(totalHeld, coinPrecision),
                    totalPaid: util.coinsRound(totalPaid, coinPrecision),
                    totalImmature: util.satoshisToCoins(totalImmature, magnitude, coinPrecision),
                    balances
                });
            } catch (err) {
                cback('There was an error getting balances');
            }
        })();
    };

    this.getPoolBalancesByAddress = function (address, callback) {
        const a = address.split('.')[0];

        const client = redisClients[0].client,
            coins = redisClients[0].coins,
            poolBalances = [];

        (async () => {
            try {
                const hscanAsync = promisify(client.hscan).bind(client);
                const pools = Object.keys(_this.stats.pools);
                for (let idx = 0; idx < pools.length; idx++) {
                    const poolName = pools[idx];
                    const coin = String(poolName);

                    const pends = await hscanAsync(`${coin}:immature`, 0, 'match', `${a}*`, 'count', 50000);
                    const bals = await hscanAsync(`${coin}:balances`, 0, 'match', `${a}*`, 'count', 50000);
                    const pays = await hscanAsync(`${coin}:payouts`, 0, 'match', `${a}*`, 'count', 50000);

                    const workers = {};

                    // Process payouts
                    for (let i = 0; i < pays[1].length; i += 2) {
                        const workerName = String(pays[1][i]);
                        const paidAmount = parseFloat(pays[1][i + 1]);

                        workers[workerName] = workers[workerName] || {};
                        workers[workerName].paid = util.coinsRound(paidAmount, coinPrecision);
                    }

                    // Process balances
                    for (let j = 0; j < bals[1].length; j += 2) {
                        const workerName = String(bals[1][j]);
                        const balAmount = parseFloat(bals[1][j + 1]);

                        workers[workerName] = workers[workerName] || {};
                        workers[workerName].balance = util.coinsRound(balAmount, coinPrecision);
                    }

                    // Process immature balances
                    for (let k = 0; k < pends[1].length; k += 2) {
                        const workerName = String(pends[1][k]);
                        const pendingAmount = parseFloat(pends[1][k + 1]);

                        workers[workerName] = workers[workerName] || {};
                        workers[workerName].immature = util.coinsRound(pendingAmount, coinPrecision);
                    }

                    // Push balances for each worker to the poolBalances array
                    for (const worker in workers) {
                        poolBalances.push({
                            pool: poolName,
                            worker: worker,
                            balance: workers[worker].balance || 0,
                            paid: workers[worker].paid || 0,
                            immature: workers[worker].immature || 0
                        });
                    }
                }

                callback(poolBalances);
            } catch (err) {
                callback('There was an error getting balances');
            }
        })();
    };

    /**
     * Generate comprehensive global statistics for all pools
     * 
     * This is the main statistics collection method that gathers real-time data
     * from all configured pools and generates comprehensive statistics including:
     * - Hashrate calculations and worker statistics
     * - Block status and confirmation tracking
     * - Payment history and share distribution
     * - Network statistics and mining luck calculations
     * - Historical data management and retention
     * 
     * The method uses Redis pipelining for efficient data collection and
     * implements automatic data cleanup based on the configured hashrate window.
     * Results are stored both in memory and persisted to Redis for historical analysis.
     * 
     * @param {Function} callback - Callback function called when statistics are complete
     * 
     * @example
     * stats.getGlobalStats(() => {
     *   console.log('Statistics updated:', stats.stats);
     *   console.log('Current hashrate:', stats.stats.global.hashrate);
     * });
     */
    this.getGlobalStats = function (callback) {

        const statGatherTime = Date.now() / 1000 | 0;

        let allCoinStats = {};

        (async () => {
            try {
                for (let rcIndex = 0; rcIndex < redisClients.length; rcIndex++) {
                    const client = redisClients[rcIndex];
                    // Calculate time window for hashrate calculations
                    const windowTime = (((Date.now() / 1000) - portalConfig.website.stats.hashrateWindow) | 0).toString();
                    const redisCommands = [];

                    /**
                     * Redis command templates for statistics collection
                     * 
                     * These commands are executed for each coin in a Redis pipeline:
                     * 1. Clean old hashrate data outside the window
                     * 2. Get current hashrate data within window
                     * 3. Get pool statistics (blocks, shares, network info)
                     * 4. Get block counts by status
                     * 5. Get actual block data
                     * 6. Get current round share and time data
                     * 7. Get recent payment history
                     */
                    const redisCommandTemplates = [
                        ['zremrangebyscore', ':hashrate', '-inf', `(${windowTime}`],  // Clean old hashrate data
                        ['zrangebyscore', ':hashrate', windowTime, '+inf'],           // Get current hashrate data
                        ['hgetall', ':stats'],                                        // Pool statistics
                        ['scard', ':blocksPending'],                                  // Pending block count
                        ['scard', ':blocksConfirmed'],                               // Confirmed block count
                        ['scard', ':blocksKicked'],                                  // Orphaned block count
                        ['smembers', ':blocksPending'],                              // Pending block details
                        ['smembers', ':blocksConfirmed'],                            // Confirmed block details
                        ['hgetall', ':shares:roundCurrent'],                         // Current round shares
                        ['hgetall', ':blocksPendingConfirms'],                       // Block confirmation status
                        ['zrange', ':payments', -100, -1],                          // Recent payment history (last 100)
                        ['hgetall', ':shares:timesCurrent']                         // Current round timing data
                    ];

                    const commandsPerCoin = redisCommandTemplates.length;

                    // Build Redis commands for each coin by prefixing with coin name
                    client.coins.map((coin) => {
                        redisCommandTemplates.map((t) => {
                            const clonedTemplates = t.slice(0);
                            clonedTemplates[1] = coin + clonedTemplates[1];  // Prefix Redis key with coin name
                            redisCommands.push(clonedTemplates);
                        });
                    });

                    // Execute all commands in a single Redis pipeline for efficiency
                    let replies;
                    try {
                        replies = await runMulti(client.client, redisCommands);
                    } catch (err) {
                        logger.error(logSystem, 'Global', `error with getting global stats ${JSON.stringify(err)}`);
                        throw err;
                    }

                    // Process Redis replies for each coin (replies are grouped by commandsPerCoin)
                    for (let i = 0; i < replies.length; i += commandsPerCoin) {
                        const coinName = client.coins[i / commandsPerCoin | 0];

                        // Extract market statistics if available
                        let marketStats = {};
                        if (replies[i + 2]) {
                            if (replies[i + 2].coinmarketcap) {
                                marketStats = replies[i + 2] ? (JSON.parse(replies[i + 2].coinmarketcap)[0] || 0) : 0;
                            }
                        }
                        /**
                         * Construct comprehensive coin statistics object
                         * 
                         * This object contains all statistical data for a single cryptocurrency pool:
                         * - Basic pool information (name, symbol, algorithm)
                         * - Raw hashrate data for worker processing
                         * - Pool performance metrics (shares, blocks, payouts)
                         * - Network status information (difficulty, connections, version)
                         * - Block tracking (pending, confirmed, orphaned)
                         * - Current round data (shares, timing)
                         * - Recent payment history
                         */
                        const coinStats = {
                            name: coinName,
                            symbol: poolConfigs[coinName].coin.symbol.toUpperCase(),
                            algorithm: poolConfigs[coinName].coin.algorithm,
                            hashrates: replies[i + 1],  // Raw hashrate data: ["shares:worker:timestamp", ...]

                            // Pool performance and network statistics
                            poolStats: {
                                validShares: replies[i + 2] ? (replies[i + 2].validShares || 0) : 0,
                                validBlocks: replies[i + 2] ? (replies[i + 2].validBlocks || 0) : 0,
                                invalidShares: replies[i + 2] ? (replies[i + 2].invalidShares || 0) : 0,
                                totalPaid: replies[i + 2] ? (replies[i + 2].totalPaid || 0) : 0,
                                networkBlocks: replies[i + 2] ? (replies[i + 2].networkBlocks || 0) : 0,
                                networkSols: replies[i + 2] ? (replies[i + 2].networkSols || 0) : 0,
                                networkSolsString: util.getReadableNetworkHashRateString(replies[i + 2] ? (replies[i + 2].networkSols || 0) : 0),
                                networkDiff: replies[i + 2] ? (replies[i + 2].networkDiff || 0) : 0,
                                networkConnections: replies[i + 2] ? (replies[i + 2].networkConnections || 0) : 0,
                                networkVersion: replies[i + 2] ? (replies[i + 2].networkSubVersion || 0) : 0,
                                networkProtocolVersion: replies[i + 2] ? (replies[i + 2].networkProtocolVersion || 0) : 0
                            },

                            marketStats: marketStats,  // External market data (price, volume, etc.)

                            // Block status counts
                            blocks: {
                                pending: replies[i + 3],      // Count of pending blocks
                                confirmed: replies[i + 4],    // Count of confirmed blocks  
                                orphaned: replies[i + 5]      // Count of orphaned blocks
                            },

                            // Detailed block information
                            pending: {
                                blocks: replies[i + 6].sort(sortBlocks),  // All pending blocks, sorted by height
                                confirms: (replies[i + 9] || {})          // Block confirmation status tracking
                            },

                            confirmed: {
                                blocks: replies[i + 7].sort(sortBlocks).slice(0, 50)  // Last 50 confirmed blocks
                            },

                            payments: [],                                    // Recent payment history (populated below)
                            currentRoundShares: (replies[i + 8] || {}),    // Current round share distribution
                            currentRoundTimes: (replies[i + 11] || {}),    // Worker timing data for current round
                            maxRoundTime: 0,                               // Maximum time any worker has been mining this round
                            shareCount: 0                                  // Total shares in current round
                        };
                        // Process recent payment history (stored as JSON strings in Redis)
                        for (let j = replies[i + 10].length; j > 0; j--) {
                            let jsonObj;
                            try {
                                jsonObj = JSON.parse(replies[i + 10][j - 1]);
                            } catch (e) {
                                // Skip invalid JSON entries
                                jsonObj = null;
                            }
                            if (jsonObj !== null) {
                                coinStats.payments.push(jsonObj);
                            }
                        }
                        allCoinStats[coinStats.name] = (coinStats);
                    }
                    // sort pools alphabetically
                }
                // sort pools alphabetically
                allCoinStats = sortPoolsByName(allCoinStats);

                const portalStats = {
                    time: statGatherTime,
                    global: {
                        workers: 0,
                        hashrate: 0
                    },
                    algos: {},
                    pools: allCoinStats
                };

                /**
                 * Process worker and miner statistics for each coin
                 * 
                 * This section processes the raw hashrate data to calculate individual
                 * worker and miner statistics. The hashrate data format is:
                 * "shares:workerName:timestamp"
                 * 
                 * Key concepts:
                 * - Worker: Individual mining connection (e.g., "tAddr123.rig1")  
                 * - Miner: Base address that owns multiple workers (e.g., "tAddr123")
                 * - Shares: Proof-of-work submissions (positive = valid, negative = invalid)
                 * - Difficulty: Current mining difficulty for the worker
                 */
                Object.keys(allCoinStats).forEach((coin) => {
                    const coinStats = allCoinStats[coin];
                    coinStats.workers = {};   // Individual worker statistics
                    coinStats.miners = {};    // Aggregated miner statistics (by base address)
                    coinStats.shares = 0;     // Total shares for this coin

                    // Process each hashrate entry
                    coinStats.hashrates.forEach((ins) => {
                        const parts = ins.split(':');
                        const workerShares = parseFloat(parts[0]);    // Share count (can be negative for invalid)
                        const miner = parts[1].split('.')[0];         // Base miner address
                        const worker = parts[1];                      // Full worker identifier
                        const diff = Math.round(parts[0] * 8192);     // Mining difficulty calculation
                        const lastShare = parseInt(parts[2]);         // Timestamp of last share

                        if (workerShares > 0) {
                            // Valid shares processing
                            coinStats.shares += workerShares;
                            // Build or update worker statistics
                            if (worker in coinStats.workers) {
                                // Update existing worker
                                coinStats.workers[worker].shares += workerShares;
                                coinStats.workers[worker].diff = diff;
                                if (lastShare > coinStats.workers[worker].lastShare) {
                                    coinStats.workers[worker].lastShare = lastShare;
                                }
                            } else {
                                // Initialize new worker with default statistics
                                coinStats.workers[worker] = {
                                    lastShare: 0,              // Timestamp of most recent share
                                    name: worker,              // Full worker identifier
                                    diff: diff,                // Current mining difficulty
                                    shares: workerShares,      // Valid share count within time window
                                    invalidshares: 0,          // Invalid share count
                                    currRoundShares: 0,        // Shares contributed to current block round
                                    currRoundTime: 0,          // Time spent mining current round
                                    hashrate: null,            // Calculated hashrate (filled later)
                                    hashrateString: null,      // Human-readable hashrate
                                    luckDays: null,            // Expected days to find a block solo
                                    luckHours: null,           // Expected hours to find a block solo
                                    paid: 0,                   // Total amount paid to this worker
                                    balance: 0                 // Current unpaid balance
                                };
                            }
                            // Build or update miner statistics (aggregated across all workers)
                            if (miner in coinStats.miners) {
                                // Update existing miner
                                coinStats.miners[miner].shares += workerShares;
                                if (lastShare > coinStats.miners[miner].lastShare) {
                                    coinStats.miners[miner].lastShare = lastShare;
                                }
                            } else {
                                // Initialize new miner with aggregated statistics
                                coinStats.miners[miner] = {
                                    lastShare: 0,              // Most recent share across all workers
                                    name: miner,               // Base miner address
                                    shares: workerShares,      // Total shares across all workers
                                    invalidshares: 0,          // Total invalid shares
                                    currRoundShares: 0,        // Current round contribution
                                    currRoundTime: 0,          // Time spent in current round
                                    hashrate: null,            // Combined hashrate of all workers
                                    hashrateString: null,      // Human-readable combined hashrate
                                    luckDays: null,            // Expected solo mining time (days)
                                    luckHours: null            // Expected solo mining time (hours)
                                };
                            }
                        } else {
                            // Invalid shares processing (workerShares is negative)

                            // Build or update worker invalid share statistics
                            if (worker in coinStats.workers) {
                                coinStats.workers[worker].invalidshares -= workerShares; // Convert negative to positive
                                coinStats.workers[worker].diff = diff;
                            } else {
                                // Initialize worker with invalid shares only
                                coinStats.workers[worker] = {
                                    lastShare: 0,
                                    name: worker,
                                    diff: diff,
                                    shares: 0,
                                    invalidshares: -workerShares,  // Convert negative to positive count
                                    currRoundShares: 0,
                                    currRoundTime: 0,
                                    hashrate: null,
                                    hashrateString: null,
                                    luckDays: null,
                                    luckHours: null,
                                    paid: 0,
                                    balance: 0
                                };
                            }
                            // build miner stats
                            if (miner in coinStats.miners) {
                                coinStats.miners[miner].invalidshares -= workerShares; // workerShares is negative number!
                            } else {
                                coinStats.miners[miner] = {
                                    lastShare: 0,
                                    name: miner,
                                    shares: 0,
                                    invalidshares: -workerShares,
                                    currRoundShares: 0,
                                    currRoundTime: 0,
                                    hashrate: null,
                                    hashrateString: null,
                                    luckDays: null,
                                    luckHours: null
                                };
                            }
                        }
                    });

                    // Sort miners by hashrate for display purposes
                    coinStats.miners = sortMinersByHashrate(coinStats.miners);

                    /**
                     * Hashrate Calculation Algorithm
                     * 
                     * Hashrate is calculated using the formula:
                     * hashrate = (shareMultiplier * totalShares) / timeWindow
                     * 
                     * Where:
                     * - shareMultiplier = 2^32 / algorithm_multiplier
                     * - totalShares = sum of all valid shares in time window
                     * - timeWindow = configured hashrate calculation window (seconds)
                     * 
                     * This gives us hashes per second for the pool.
                     */
                    const shareMultiplier = Math.pow(2, 32) / algos[coinStats.algorithm].multiplier;
                    coinStats.hashrate = shareMultiplier * coinStats.shares / portalConfig.website.stats.hashrateWindow;
                    coinStats.hashrateString = _this.getReadableHashRateString(coinStats.hashrate);

                    /**
                     * Mining Luck Calculation
                     * 
                     * Calculates expected time to find a block based on:
                     * - Network hashrate vs pool hashrate ratio
                     * - Network block time (55 seconds for most chains)
                     * - Pool's percentage of total network hashrate
                     * 
                     * Formula: (networkHashrate / poolHashrate) * blockTime
                     */
                    const _blocktime = 55;  // Average block time in seconds
                    const _networkHashRate = parseFloat(coinStats.poolStats.networkSols) * 1.2;  // Network hashrate with adjustment
                    const _myHashRate = (coinStats.hashrate / 1000000) * 2;  // Pool hashrate in comparable units

                    coinStats.luckDays = ((_networkHashRate / _myHashRate * _blocktime) / (24 * 60 * 60)).toFixed(3);
                    coinStats.luckHours = ((_networkHashRate / _myHashRate * _blocktime) / (60 * 60)).toFixed(3);

                    // Set basic counts for this pool
                    coinStats.minerCount = Object.keys(coinStats.miners).length;
                    coinStats.workerCount = Object.keys(coinStats.workers).length;
                    portalStats.global.workers += coinStats.workerCount;

                    /* algorithm specific global stats */
                    const algo = coinStats.algorithm;
                    if (!portalStats.algos.hasOwnProperty(algo)) {
                        portalStats.algos[algo] = {
                            workers: 0,
                            hashrate: 0,
                            hashrateString: null
                        };
                    }
                    portalStats.algos[algo].hashrate += coinStats.hashrate;
                    portalStats.algos[algo].workers += Object.keys(coinStats.workers).length;

                    /**
                     * Current Round Statistics Processing
                     * 
                     * Process data for the current mining round (block being worked on):
                     * - Aggregate shares contributed by each worker/miner
                     * - Track timing data for round duration analysis
                     * - Update worker and miner objects with round-specific data
                     */
                    let _shareTotal = parseFloat(0);
                    let _maxTimeShare = parseFloat(0);

                    // Process current round share distribution
                    for (const worker in coinStats.currentRoundShares) {
                        const miner = worker.split('.')[0];  // Extract base miner address

                        // Add to miner's round total
                        if (miner in coinStats.miners) {
                            coinStats.miners[miner].currRoundShares += parseFloat(coinStats.currentRoundShares[worker]);
                        }

                        // Add to worker's round total
                        if (worker in coinStats.workers) {
                            coinStats.workers[worker].currRoundShares += parseFloat(coinStats.currentRoundShares[worker]);
                        }

                        _shareTotal += parseFloat(coinStats.currentRoundShares[worker]);
                    }

                    // Process current round timing data
                    for (const worker in coinStats.currentRoundTimes) {
                        const time = parseFloat(coinStats.currentRoundTimes[worker]);

                        // Track maximum round time for any worker
                        if (_maxTimeShare < time) {
                            _maxTimeShare = time;
                        }

                        const miner = worker.split('.')[0];  // Extract base miner address

                        // Update miner's round time (use maximum across all workers)
                        if (miner in coinStats.miners && coinStats.miners[miner].currRoundTime < time) {
                            coinStats.miners[miner].currRoundTime = time;
                        }
                    }

                    // Set round statistics for this coin
                    coinStats.shareCount = _shareTotal;
                    coinStats.maxRoundTime = _maxTimeShare;
                    coinStats.maxRoundTimeString = util.getReadableTimeString(_maxTimeShare);

                    /**
                     * Calculate individual worker hashrates and mining luck
                     * 
                     * For each worker, calculate:
                     * - Individual hashrate based on shares contributed
                     * - Solo mining luck (time to find block alone)
                     * - Inherit timing data from parent miner
                     */
                    for (const worker in coinStats.workers) {
                        // Calculate worker's individual hashrate
                        const _workerRate = shareMultiplier * coinStats.workers[worker].shares / portalConfig.website.stats.hashrateWindow;
                        const _wHashRate = (_workerRate / 1000000) * 2;  // Convert to comparable units

                        // Calculate solo mining luck for this worker
                        coinStats.workers[worker].luckDays = ((_networkHashRate / _wHashRate * _blocktime) / (24 * 60 * 60)).toFixed(3);
                        coinStats.workers[worker].luckHours = ((_networkHashRate / _wHashRate * _blocktime) / (60 * 60)).toFixed(3);

                        // Set hashrate values
                        coinStats.workers[worker].hashrate = _workerRate;
                        coinStats.workers[worker].hashrateString = _this.getReadableHashRateString(_workerRate);

                        // Inherit current round time from parent miner
                        const miner = worker.split('.')[0];
                        if (miner in coinStats.miners) {
                            coinStats.workers[worker].currRoundTime = coinStats.miners[miner].currRoundTime;
                        }
                    }

                    /**
                     * Calculate miner hashrates and mining luck
                     * 
                     * For each miner (aggregated across all workers):
                     * - Combined hashrate of all workers
                     * - Solo mining luck based on combined hashrate
                     */
                    for (const miner in coinStats.miners) {
                        // Calculate miner's combined hashrate
                        const _workerRate = shareMultiplier * coinStats.miners[miner].shares / portalConfig.website.stats.hashrateWindow;
                        const _wHashRate = (_workerRate / 1000000) * 2;

                        // Calculate solo mining luck for combined hashrate
                        coinStats.miners[miner].luckDays = ((_networkHashRate / _wHashRate * _blocktime) / (24 * 60 * 60)).toFixed(3);
                        coinStats.miners[miner].luckHours = ((_networkHashRate / _wHashRate * _blocktime) / (60 * 60)).toFixed(3);

                        // Set combined hashrate values
                        coinStats.miners[miner].hashrate = _workerRate;
                        coinStats.miners[miner].hashrateString = _this.getReadableHashRateString(_workerRate);
                    }

                    // Sort workers alphabetically for consistent display
                    coinStats.workers = sortWorkersByName(coinStats.workers);

                    // Clean up temporary data used for calculations
                    delete coinStats.hashrates;  // Raw hashrate data no longer needed
                    delete coinStats.shares;     // Total share count no longer needed
                });

                /**
                 * Finalize algorithm-specific statistics
                 * 
                 * Generate human-readable hashrate strings for each algorithm's
                 * combined statistics across all pools using that algorithm.
                 */
                Object.keys(portalStats.algos).forEach((algo) => {
                    const algoStats = portalStats.algos[algo];
                    algoStats.hashrateString = _this.getReadableHashRateString(algoStats.hashrate);
                });

                // Store completed statistics in the module
                _this.stats = portalStats;

                /**
                 * Historical Data Management
                 * 
                 * Save statistics to history if there are active workers, but only
                 * save essential data to minimize storage requirements. Remove
                 * detailed worker information and temporary round data.
                 */
                if (portalStats.global.workers > 0) {
                    // Create a lightweight copy for historical storage
                    const saveStats = JSON.parse(JSON.stringify(portalStats));
                    Object.keys(saveStats.pools).forEach((pool) => {
                        // Remove large, non-essential data for historical storage
                        delete saveStats.pools[pool].pending;           // Detailed pending blocks
                        delete saveStats.pools[pool].confirmed;         // Detailed confirmed blocks  
                        delete saveStats.pools[pool].currentRoundShares; // Current round share data
                        delete saveStats.pools[pool].currentRoundTimes;  // Current round timing data
                        delete saveStats.pools[pool].payments;          // Payment history
                        delete saveStats.pools[pool].miners;            // Detailed miner data
                    });

                    // Store for API access and add to history
                    _this.statsString = JSON.stringify(saveStats);
                    _this.statHistory.push(saveStats);

                    // Add to pool-specific history for trending
                    addStatPoolHistory(portalStats);

                    /**
                     * Historical Data Retention
                     * 
                     * Automatically clean up old historical data based on the
                     * configured retention period to prevent unlimited growth.
                     */
                    const retentionTime = (((Date.now() / 1000) - portalConfig.website.stats.historicalRetention) | 0);

                    // Clean up in-memory history
                    for (let i = 0; i < _this.statHistory.length; i++) {
                        if (retentionTime < _this.statHistory[i].time) {
                            if (i > 0) {
                                _this.statHistory = _this.statHistory.slice(i);
                                _this.statPoolHistory = _this.statPoolHistory.slice(i);
                            }
                            break;
                        }
                    }

                    // Save to Redis and clean up old Redis data
                    redisStats.multi([
                        ['zadd', 'statHistory', statGatherTime, _this.statsString],
                        ['zremrangebyscore', 'statHistory', '-inf', `(${retentionTime}`]
                    ]).exec((err, replies) => {
                        if (err) {
                            logger.error(logSystem, 'Historics', `Error adding stats to historics ${JSON.stringify(err)}`);
                        }
                    });
                }

                // invoke caller callback
                if (typeof callback === 'function') {
                    callback();
                }
            } catch (err) {
                logger.error(logSystem, 'Global', `error getting all stats${JSON.stringify(err)}`);
                if (typeof callback === 'function') {
                    callback();
                }
            }
        })();

    };

    /**
     * Sort pools alphabetically by name
     * 
     * @private
     * @param {Object} objects - Pool objects to sort
     * @returns {Object} New object with pools sorted by name
     */
    function sortPoolsByName(objects) {
        const newObject = {};
        const sortedArray = sortProperties(objects, 'name', false, false);
        for (let i = 0; i < sortedArray.length; i++) {
            const key = sortedArray[i][0];
            const value = sortedArray[i][1];
            newObject[key] = value;
        }
        return newObject;
    }

    /**
     * Sort blocks by height (descending - newest first)
     * 
     * Block format: "timestamp:blockHash:blockHeight:transactionHash:difficulty:sharesDiff"
     * Extracts block height (index 2) and sorts in descending order.
     * 
     * @private
     * @param {string} a - First block string
     * @param {string} b - Second block string  
     * @returns {number} Sort comparison result
     */
    function sortBlocks(a, b) {
        const as = parseInt(a.split(':')[2]);  // Extract block height
        const bs = parseInt(b.split(':')[2]);
        if (as > bs) {
            return -1;  // Newer blocks first
        }
        if (as < bs) {
            return 1;
        }
        return 0;
    }

    /**
     * Sort workers alphabetically by name using natural sorting
     * 
     * @private
     * @param {Object} objects - Worker objects to sort
     * @returns {Object} New object with workers sorted by name
     */
    function sortWorkersByName(objects) {
        const newObject = {};
        const sortedArray = sortProperties(objects, 'name', false, false);
        for (let i = 0; i < sortedArray.length; i++) {
            const key = sortedArray[i][0];
            const value = sortedArray[i][1];
            newObject[key] = value;
        }
        return newObject;
    }

    /**
     * Sort miners by hashrate (descending - highest first)
     * 
     * Uses share count as a proxy for hashrate during sorting phase.
     * 
     * @private
     * @param {Object} objects - Miner objects to sort
     * @returns {Object} New object with miners sorted by hashrate
     */
    function sortMinersByHashrate(objects) {
        const newObject = {};
        const sortedArray = sortProperties(objects, 'shares', true, true);  // Numeric, descending
        for (let i = 0; i < sortedArray.length; i++) {
            const key = sortedArray[i][0];
            const value = sortedArray[i][1];
            newObject[key] = value;
        }
        return newObject;
    }

    /**
     * Compare function for sorting workers by hashrate
     * 
     * @private
     * @param {Object} a - First worker object
     * @param {Object} b - Second worker object
     * @returns {number} Sort comparison result
     */
    function sortWorkersByHashrate(a, b) {
        if (a.hashrate === b.hashrate) {
            return 0;
        } else {
            return (a.hashrate < b.hashrate) ? -1 : 1;
        }
    }

    // Delegate to central util implementation to avoid duplicate logic across the codebase
    this.getReadableHashRateString = util.getReadableHashRateString;

    /**
     * Convert network hashrate to human-readable string format
     * 
     * Similar to getReadableHashRateString but specifically for network hashrate
     * with different scaling factors. Used for displaying network statistics.
     * 
     * @private
     * @param {number} hashrate - Network hashrate value
     * @returns {string} Formatted network hashrate string
     */
    // Use util.getReadableNetworkHashRateString (centralized in libs/utils/misc.js)
};
