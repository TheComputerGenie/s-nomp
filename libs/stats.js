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
/**
 * Stats module converted to class-based implementation
 * Preserves original behavior while making lifecycle explicit.
 */

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

// Small native replacement for async.each used in the original file
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

function rediscreateClient(port, host, pass) {
    const client = redis.createClient(port, host);
    if (pass) {
        client.auth(pass);
    }
    return client;
}

function sortProperties(obj, sortedBy, isNumericSort, reverse) {
    sortedBy = sortedBy || 1;
    isNumericSort = isNumericSort || false;
    reverse = reverse || false;
    const reversed = (reverse) ? -1 : 1;
    const sortable = [];
    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            sortable.push([key, obj[key]]);
        }
    }
    if (isNumericSort) {
        sortable.sort((a, b) => reversed * (a[1][sortedBy] - b[1][sortedBy]));
    } else if (sortedBy === 'name') {
        sortable.sort((a, b) => naturalSort(a[1][sortedBy], b[1][sortedBy]) * reversed);
    } else {
        sortable.sort((a, b) => {
            const x = a[1][sortedBy].toLowerCase(), y = b[1][sortedBy].toLowerCase();
            return x < y ? reversed * -1 : x > y ? reversed : 0;
        });
    }
    function naturalSort(a, b) {
        const ax = [], bx = [];
        a.replace(/(\d+)|(\D+)/g, (_, $1, $2) => {
            ax.push([$1 || Infinity, $2 || '']);
        });
        b.replace(/(\d+)|(\D+)/g, (_, $1, $2) => {
            bx.push([$1 || Infinity, $2 || '']);
        });
        while (ax.length && bx.length) {
            const an = ax.shift(), bn = bx.shift();
            const nn = (an[0] - bn[0]) || an[1].localeCompare(bn[1]);
            if (nn) {
                return nn;
            }
        }
        return ax.length - bx.length;
    }
    return sortable;
}

// Module-scope constants
const magnitude = 100000000;
const coinPrecision = magnitude.toString().length - 1;

// Sorting helpers
function sortPoolsByName(objects) {
    const newObject = {};
    const sortedArray = sortProperties(objects, 'name', false, false);
    for (let i = 0; i < sortedArray.length; i++) {
        newObject[sortedArray[i][0]] = sortedArray[i][1];
    }
    return newObject;
}
function sortBlocks(a, b) {
    const as = parseInt(a.split(':')[2]);
    const bs = parseInt(b.split(':')[2]);
    if (as > bs) {
        return -1;
    }
    if (as < bs) {
        return 1;
    }
    return 0;
}
function sortWorkersByName(objects) {
    const newObject = {};
    const sortedArray = sortProperties(objects, 'name', false, false);
    for (let i = 0; i < sortedArray.length; i++) {
        newObject[sortedArray[i][0]] = sortedArray[i][1];
    }
    return newObject;
}
function sortMinersByHashrate(objects) {
    const newObject = {};
    const sortedArray = sortProperties(objects, 'shares', true, true);
    for (let i = 0; i < sortedArray.length; i++) {
        newObject[sortedArray[i][0]] = sortedArray[i][1];
    }
    return newObject;
}
function sortWorkersByHashrate(a, b) {
    if (a.hashrate === b.hashrate) {
        return 0;
    }
    return (a.hashrate < b.hashrate) ? -1 : 1;
}

class Stats {
    constructor(logger, portalConfig, poolConfigs) {
        this.logger = logger;
        this.portalConfig = portalConfig || {};
        this.poolConfigs = poolConfigs || {};

        this.logSystem = 'Stats';
        this.redisClients = [];
        this.redisStats = null;
        this.statHistory = [];
        this.statPoolHistory = [];
        this.stats = {};
        this.statsString = '';
        this.canDoStats = true;

        // Initialize pool redis clients (reuse by host/port)
        Object.keys(this.poolConfigs).forEach((coin) => {
            if (!this.canDoStats) {
                return;
            }
            const poolConfig = this.poolConfigs[coin];
            const redisConfig = poolConfig.redis;
            for (let i = 0; i < this.redisClients.length; i++) {
                const client = this.redisClients[i];
                if (client.client.port === redisConfig.port && client.client.host === redisConfig.host) {
                    client.coins.push(coin);
                    return;
                }
            }
            this.redisClients.push({ coins: [coin], client: rediscreateClient(redisConfig.port, redisConfig.host, redisConfig.password) });
        });

        // Setup main redis client for stats history
        this.setupStatsRedis();
        this.gatherStatHistory();

        // getReadableHashRateString is now called directly from util with algorithm parameter
    }

    setupStatsRedis() {
        if (!this.portalConfig.redis) {
            return;
        }
        this.redisStats = redis.createClient(this.portalConfig.redis.port, this.portalConfig.redis.host);
        this.redisStats.on('error', () => {
            try {
                this.redisStats.auth(this.portalConfig.redis.password);
            } catch (e) { }
        });
    }

    // Load historical stats from redis into memory
    gatherStatHistory() {
        (async () => {
            try {
                if (!this.redisStats) {
                    return;
                }
                const retentionTime = (((Date.now() / 1000) - this.portalConfig.website.stats.historicalRetention) | 0).toString();
                const zrangebyscoreAsync = promisify(this.redisStats.zrangebyscore).bind(this.redisStats);
                const replies = await zrangebyscoreAsync('statHistory', retentionTime, '+inf');
                for (let i = 0; i < replies.length; i++) {
                    const stats = JSON.parse(replies[i]);
                    if (stats.global && stats.global.workers > 0) {
                        this.statHistory.push(stats);
                    }
                }
                this.statHistory = this.statHistory.sort((a, b) => a.time - b.time);
                this.statHistory.forEach((stats) => this.addStatPoolHistory(stats));
            } catch (err) {
                if (this.logger && this.logger.error) {
                    this.logger.error(this.logSystem, 'Historics', `Error when trying to grab historical stats ${JSON.stringify(err)}`);
                }
            }
        })();
    }

    addStatPoolHistory(stats) {
        const data = { time: stats.time, pools: {} };
        for (const pool in stats.pools) {
            data.pools[pool] = { hashrate: stats.pools[pool].hashrate, workerCount: stats.pools[pool].workerCount, blocks: stats.pools[pool].blocks };
        }
        this.statPoolHistory.push(data);
    }

    // Return aggregated blocks from current stats
    getBlocks(cback) {
        const allBlocks = {};
        each(this.stats.pools, (pool, pcb) => {
            if (this.stats.pools[pool.name].pending && this.stats.pools[pool.name].pending.blocks) {
                for (let i = 0; i < this.stats.pools[pool.name].pending.blocks.length; i++) {
                    const blockHeight = this.stats.pools[pool.name].pending.blocks[i].split(':')[2];
                    allBlocks[`${pool.name}-${blockHeight}`] = this.stats.pools[pool.name].pending.blocks[i];
                }
            }
            if (this.stats.pools[pool.name].confirmed && this.stats.pools[pool.name].confirmed.blocks) {
                for (let i = 0; i < this.stats.pools[pool.name].confirmed.blocks.length; i++) {
                    const blockHeight = this.stats.pools[pool.name].confirmed.blocks[i].split(':')[2];
                    allBlocks[`${pool.name}-${blockHeight}`] = this.stats.pools[pool.name].confirmed.blocks[i];
                }
            }
            pcb();
        }, (err) => {
            cback(allBlocks);
        });
    }

    getCoins(cback) {
        if (this.redisClients[0]) {
            this.stats.coins = this.redisClients[0].coins;
        }
        cback();
    }

    getPayout(address, cback) {
        this.getBalanceByAddress(address, (result) => {
            const total = (result && result.totalHeld) ? result.totalHeld : 0;
            cback(util.coinsRound(total, coinPrecision).toFixed(8));
        });
    }

    getTotalSharesByAddress(address, cback) {
        const a = address.split('.')[0];
        const client = this.redisClients[0].client;
        let pindex = 0;
        let totalShares = 0;
        (async () => {
            try {
                const hscanAsync = promisify(client.hscan).bind(client);
                const pools = Object.keys(this.stats.pools || {});
                for (let idx = 0; idx < pools.length; idx++) {
                    pindex++;
                    const poolName = pools[idx];
                    const coin = String(this.stats.pools[poolName].name);
                    const result = await hscanAsync(`${coin}:shares:roundCurrent`, 0, 'match', `${a}*`, 'count', 50000);
                    let workerName = '';
                    let sharesLocal = 0;
                    for (const i in result[1]) {
                        if (Math.abs(i % 2) != 1) {
                            workerName = String(result[1][i]);
                        } else {
                            sharesLocal += parseFloat(result[1][i]);
                        }
                    }
                    if (sharesLocal > 0) {
                        totalShares = sharesLocal;
                    }
                }
                if (totalShares > 0 || (pindex >= Object.keys(this.stats.pools || {}).length)) {
                    cback(totalShares); return;
                }
                cback(0);
            } catch (err) {
                cback(0);
            }
        })();
    }

    getBalanceByAddress(address, cback) {
        const a = address.split('.')[0];
        const client = this.redisClients[0].client;
        const balances = [];
        let totalHeld = 0, totalPaid = 0, totalImmature = 0;
        (async () => {
            try {
                const hscanAsync = promisify(client.hscan).bind(client);
                const pools = Object.keys(this.stats.pools || {});
                for (let idx = 0; idx < pools.length; idx++) {
                    const poolName = pools[idx];
                    const coin = String(this.stats.pools[poolName].name);
                    const pends = await hscanAsync(`${coin}:immature`, 0, 'match', `${a}*`, 'count', 50000);
                    const bals = await hscanAsync(`${coin}:balances`, 0, 'match', `${a}*`, 'count', 50000);
                    const pays = await hscanAsync(`${coin}:payouts`, 0, 'match', `${a}*`, 'count', 50000);
                    let workerName = '', balAmount = 0, paidAmount = 0, pendingAmount = 0;
                    const workers = {};
                    for (const i in pays[1]) {
                        if (Math.abs(i % 2) != 1) {
                            workerName = String(pays[1][i]); workers[workerName] = (workers[workerName] || {});
                        } else {
                            paidAmount = parseFloat(pays[1][i]); workers[workerName].paid = util.coinsRound(paidAmount, coinPrecision); totalPaid += paidAmount;
                        }
                    }
                    for (const b in bals[1]) {
                        if (Math.abs(b % 2) != 1) {
                            workerName = String(bals[1][b]); workers[workerName] = (workers[workerName] || {});
                        } else {
                            balAmount = parseFloat(bals[1][b]); workers[workerName].balance = util.coinsRound(balAmount, coinPrecision); totalHeld += balAmount;
                        }
                    }
                    for (const b in pends[1]) {
                        if (Math.abs(b % 2) != 1) {
                            workerName = String(pends[1][b]); workers[workerName] = (workers[workerName] || {});
                        } else {
                            pendingAmount = parseFloat(pends[1][b]); workers[workerName].immature = util.coinsRound(util.satoshisToCoins(pendingAmount, magnitude, coinPrecision), coinPrecision); totalImmature += pendingAmount;
                        }
                    }
                    for (const w in workers) {
                        balances.push({ worker: String(w), balance: workers[w].balance, paid: workers[w].paid, immature: workers[w].immature });
                    }
                }
                this.stats.balances = balances; this.stats.address = address;
                cback({ totalHeld: util.coinsRound(totalHeld, coinPrecision), totalPaid: util.coinsRound(totalPaid, coinPrecision), totalImmature: util.satoshisToCoins(totalImmature, magnitude, coinPrecision), balances });
            } catch (err) {
                cback('There was an error getting balances');
            }
        })();
    }

    getPoolBalancesByAddress(address, callback) {
        const a = address.split('.')[0];
        const client = this.redisClients[0].client;
        const poolBalances = [];
        (async () => {
            try {
                const hscanAsync = promisify(client.hscan).bind(client);
                const pools = Object.keys(this.stats.pools || {});
                for (let idx = 0; idx < pools.length; idx++) {
                    const poolName = pools[idx];
                    const coin = String(poolName);
                    const pends = await hscanAsync(`${coin}:immature`, 0, 'match', `${a}*`, 'count', 50000);
                    const bals = await hscanAsync(`${coin}:balances`, 0, 'match', `${a}*`, 'count', 50000);
                    const pays = await hscanAsync(`${coin}:payouts`, 0, 'match', `${a}*`, 'count', 50000);
                    const workers = {};
                    for (let i = 0; i < pays[1].length; i += 2) {
                        const workerName = String(pays[1][i]); const paidAmount = parseFloat(pays[1][i + 1]); workers[workerName] = workers[workerName] || {}; workers[workerName].paid = util.coinsRound(paidAmount, coinPrecision);
                    }
                    for (let j = 0; j < bals[1].length; j += 2) {
                        const workerName = String(bals[1][j]); const balAmount = parseFloat(bals[1][j + 1]); workers[workerName] = workers[workerName] || {}; workers[workerName].balance = util.coinsRound(balAmount, coinPrecision);
                    }
                    for (let k = 0; k < pends[1].length; k += 2) {
                        const workerName = String(pends[1][k]); const pendingAmount = parseFloat(pends[1][k + 1]); workers[workerName] = workers[workerName] || {}; workers[workerName].immature = util.coinsRound(pendingAmount, coinPrecision);
                    }
                    for (const worker in workers) {
                        poolBalances.push({ pool: poolName, worker: worker, balance: workers[worker].balance || 0, paid: workers[worker].paid || 0, immature: workers[worker].immature || 0 });
                    }
                }
                callback(poolBalances);
            } catch (err) {
                callback('There was an error getting balances');
            }
        })();
    }

    getGlobalStats(callback) {
        const statGatherTime = Date.now() / 1000 | 0;
        let allCoinStats = {};
        (async () => {
            try {
                for (let rcIndex = 0; rcIndex < this.redisClients.length; rcIndex++) {
                    const client = this.redisClients[rcIndex];
                    const windowTime = (((Date.now() / 1000) - this.portalConfig.website.stats.hashrateWindow) | 0).toString();
                    const redisCommands = [];
                    const redisCommandTemplates = [['zremrangebyscore', ':hashrate', '-inf', `(${windowTime}`], ['zrangebyscore', ':hashrate', windowTime, '+inf'], ['hgetall', ':stats'], ['scard', ':blocksPending'], ['scard', ':blocksConfirmed'], ['scard', ':blocksKicked'], ['smembers', ':blocksPending'], ['smembers', ':blocksConfirmed'], ['hgetall', ':shares:roundCurrent'], ['hgetall', ':blocksPendingConfirms'], ['zrange', ':payments', -100, -1], ['hgetall', ':shares:timesCurrent']];
                    const commandsPerCoin = redisCommandTemplates.length;
                    client.coins.map((coin) => {
                        redisCommandTemplates.map((t) => {
                            const clonedTemplates = t.slice(0); clonedTemplates[1] = coin + clonedTemplates[1]; redisCommands.push(clonedTemplates);
                        });
                    });
                    let replies;
                    try {
                        replies = await runMulti(client.client, redisCommands);
                    } catch (err) {
                        if (this.logger && this.logger.error) {
                            this.logger.error(this.logSystem, 'Global', `error with getting global stats ${JSON.stringify(err)}`);
                        } throw err;
                    }
                    for (let i = 0; i < replies.length; i += commandsPerCoin) {
                        const coinName = client.coins[i / commandsPerCoin | 0];
                        const coinStats = {
                            name: coinName,
                            symbol: this.poolConfigs[coinName].coin.symbol.toUpperCase(),
                            algorithm: this.poolConfigs[coinName].coin.algorithm,
                            // expose displayMultiplier for front-end formatting
                            displayMultiplier: algos.getDisplayMultiplier(this.poolConfigs[coinName].coin.algorithm),
                            hashrates: replies[i + 1],
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
                            blocks: {
                                pending: replies[i + 3],
                                confirmed: replies[i + 4],
                                orphaned: replies[i + 5]
                            },
                            pending: {
                                blocks: replies[i + 6].sort(sortBlocks),
                                confirms: (replies[i + 9] || {})
                            },
                            confirmed: {
                                blocks: replies[i + 7].sort(sortBlocks).slice(0, 10)
                            },
                            payments: [],
                            currentRoundShares: (replies[i + 8] || {}),
                            currentRoundTimes: (replies[i + 11] || {}),
                            maxRoundTime: 0,
                            shareCount: 0
                        };
                        for (let j = replies[i + 10].length; j > 0; j--) {
                            let jsonObj;
                            try {
                                jsonObj = JSON.parse(replies[i + 10][j - 1]);
                            } catch (e) {
                                jsonObj = null;
                            }
                            if (jsonObj !== null) {
                                // Normalize payment object to fields expected by templates
                                const normalized = {};
                                normalized.txid = jsonObj.txid || jsonObj.tx || jsonObj.id || '';
                                normalized.time = jsonObj.time || jsonObj.t || Date.now();
                                // amount: prefer 'amount', else sum paid mapping if present
                                if (typeof jsonObj.amount !== 'undefined') {
                                    normalized.amount = jsonObj.amount;
                                } else if (jsonObj.paid && typeof jsonObj.paid === 'object') {
                                    let s = 0;
                                    Object.keys(jsonObj.paid).forEach(k => {
                                        const v = parseFloat(jsonObj.paid[k]);
                                        if (!Number.isNaN(v)) {
                                            s += v;
                                        }
                                    });
                                    normalized.amount = s;
                                } else {
                                    normalized.amount = jsonObj.paid || 0;
                                }
                                normalized.workers = jsonObj.workers || jsonObj.miners || (jsonObj.paid && typeof jsonObj.paid === 'object' ? Object.keys(jsonObj.paid).length : 0);
                                normalized.shares = typeof jsonObj.shares !== 'undefined' ? jsonObj.shares : 0;
                                normalized.blocks = jsonObj.blocks || normalized.txid || '';
                                normalized.paid = jsonObj.paid || {};

                                coinStats.payments.push(normalized);
                            }
                        }
                        allCoinStats[coinStats.name] = (coinStats);
                    }
                }

                allCoinStats = sortPoolsByName(allCoinStats);
                const portalStats = { time: statGatherTime, global: { workers: 0, hashrate: 0 }, algos: {}, pools: allCoinStats };

                Object.keys(allCoinStats).forEach((coin) => {
                    const coinStats = allCoinStats[coin];
                    coinStats.workers = {};
                    coinStats.miners = {};
                    coinStats.shares = 0;

                    coinStats.hashrates.forEach((ins) => {
                        const parts = ins.split(':');
                        const workerShares = parseFloat(parts[0]);
                        const miner = parts[1].split('.')[0];
                        const worker = parts[1];
                        const diff = Math.round(parts[0] * 8192);
                        const lastShare = parseInt(parts[2]);

                        if (workerShares > 0) {
                            coinStats.shares += workerShares;
                            if (worker in coinStats.workers) {
                                coinStats.workers[worker].shares += workerShares; coinStats.workers[worker].diff = diff; if (lastShare > coinStats.workers[worker].lastShare) {
                                    coinStats.workers[worker].lastShare = lastShare;
                                }
                            } else {
                                coinStats.workers[worker] = { lastShare: 0, name: worker, diff: diff, shares: workerShares, invalidshares: 0, currRoundShares: 0, currRoundTime: 0, hashrate: null, hashrateString: null, luckDays: null, luckHours: null, paid: 0, balance: 0 };
                            }
                            if (miner in coinStats.miners) {
                                coinStats.miners[miner].shares += workerShares; if (lastShare > coinStats.miners[miner].lastShare) {
                                    coinStats.miners[miner].lastShare = lastShare;
                                }
                            } else {
                                coinStats.miners[miner] = { lastShare: 0, name: miner, shares: workerShares, invalidshares: 0, currRoundShares: 0, currRoundTime: 0, hashrate: null, hashrateString: null, luckDays: null, luckHours: null };
                            }
                        } else {
                            if (worker in coinStats.workers) {
                                coinStats.workers[worker].invalidshares -= workerShares; coinStats.workers[worker].diff = diff;
                            } else {
                                coinStats.workers[worker] = { lastShare: 0, name: worker, diff: diff, shares: 0, invalidshares: -workerShares, currRoundShares: 0, currRoundTime: 0, hashrate: null, hashrateString: null, luckDays: null, luckHours: null, paid: 0, balance: 0 };
                            }
                            if (miner in coinStats.miners) {
                                coinStats.miners[miner].invalidshares -= workerShares;
                            } else {
                                coinStats.miners[miner] = { lastShare: 0, name: miner, shares: 0, invalidshares: -workerShares, currRoundShares: 0, currRoundTime: 0, hashrate: null, hashrateString: null, luckDays: null, luckHours: null };
                            }
                        }
                    });

                    coinStats.miners = sortMinersByHashrate(coinStats.miners);
                    const shareMultiplier = Math.pow(2, 32) / algos.getMultiplier(coinStats.algorithm);
                    coinStats.hashrate = shareMultiplier * coinStats.shares / this.portalConfig.website.stats.hashrateWindow;
                    coinStats.hashrateString = util.getReadableHashRateString(coinStats.hashrate, coinStats.algorithm);

                    const _blocktime = 55;
                    const _networkHashRate = parseFloat(coinStats.poolStats.networkSols) * 1.2;
                    const _myHashRate = (coinStats.hashrate / 1000000) * 2;

                    if (_myHashRate > 0) {
                        coinStats.luckDays = ((_networkHashRate / _myHashRate * _blocktime) / (24 * 60 * 60)).toFixed(3);
                        coinStats.luckHours = ((_networkHashRate / _myHashRate * _blocktime) / (60 * 60)).toFixed(3);
                    } else {
                        coinStats.luckDays = '0.000';
                        coinStats.luckHours = '0.000';
                    }

                    coinStats.minerCount = Object.keys(coinStats.miners).length;
                    coinStats.workerCount = Object.keys(coinStats.workers).length;
                    portalStats.global.workers += coinStats.workerCount;

                    const algo = coinStats.algorithm;
                    if (!portalStats.algos.hasOwnProperty(algo)) {
                        // include displayMultiplier per-algo so clients can format correctly
                        portalStats.algos[algo] = { workers: 0, hashrate: 0, hashrateString: null, displayMultiplier: algos.getDisplayMultiplier(algo) };
                    }
                    portalStats.algos[algo].hashrate += coinStats.hashrate;
                    portalStats.algos[algo].workers += Object.keys(coinStats.workers).length;

                    let _shareTotal = 0, _maxTimeShare = 0;
                    for (const worker in coinStats.currentRoundShares) {
                        const miner = worker.split('.')[0]; if (miner in coinStats.miners) {
                            coinStats.miners[miner].currRoundShares += parseFloat(coinStats.currentRoundShares[worker]);
                        } if (worker in coinStats.workers) {
                            coinStats.workers[worker].currRoundShares += parseFloat(coinStats.currentRoundShares[worker]);
                        } _shareTotal += parseFloat(coinStats.currentRoundShares[worker]);
                    }
                    for (const worker in coinStats.currentRoundTimes) {
                        const time = parseFloat(coinStats.currentRoundTimes[worker]); if (_maxTimeShare < time) {
                            _maxTimeShare = time;
                        } const miner = worker.split('.')[0]; if (miner in coinStats.miners && coinStats.miners[miner].currRoundTime < time) {
                            coinStats.miners[miner].currRoundTime = time;
                        }
                    }
                    coinStats.shareCount = _shareTotal;
                    coinStats.maxRoundTime = _maxTimeShare;
                    coinStats.maxRoundTimeString = util.getReadableTimeString(_maxTimeShare);

                    for (const worker in coinStats.workers) {
                        const _workerRate = shareMultiplier * coinStats.workers[worker].shares / this.portalConfig.website.stats.hashrateWindow;
                        const _wHashRate = (_workerRate / 1000000) * 2;

                        if (_wHashRate > 0) {
                            coinStats.workers[worker].luckDays = ((_networkHashRate / _wHashRate * _blocktime) / (24 * 60 * 60)).toFixed(3);
                            coinStats.workers[worker].luckHours = ((_networkHashRate / _wHashRate * _blocktime) / (60 * 60)).toFixed(3);
                        } else {
                            coinStats.workers[worker].luckDays = '0.000';
                            coinStats.workers[worker].luckHours = '0.000';
                        }
                        coinStats.workers[worker].hashrate = _workerRate;
                        coinStats.workers[worker].hashrateString = util.getReadableHashRateString(_workerRate, coinStats.algorithm);

                        const miner = worker.split('.')[0];
                        if (miner in coinStats.miners) {
                            coinStats.workers[worker].currRoundTime = coinStats.miners[miner].currRoundTime;
                        }
                    }

                    for (const miner in coinStats.miners) {
                        const _workerRate = shareMultiplier * coinStats.miners[miner].shares / this.portalConfig.website.stats.hashrateWindow;
                        const _wHashRate = (_workerRate / 1000000) * 2;

                        if (_wHashRate > 0) {
                            coinStats.miners[miner].luckDays = ((_networkHashRate / _wHashRate * _blocktime) / (24 * 60 * 60)).toFixed(3);
                            coinStats.miners[miner].luckHours = ((_networkHashRate / _wHashRate * _blocktime) / (60 * 60)).toFixed(3);
                        } else {
                            coinStats.miners[miner].luckDays = '0.000';
                            coinStats.miners[miner].luckHours = '0.000';
                        }
                        coinStats.miners[miner].hashrate = _workerRate;
                        coinStats.miners[miner].hashrateString = util.getReadableHashRateString(_workerRate, coinStats.algorithm);
                    }

                    coinStats.workers = sortWorkersByName(coinStats.workers);
                    delete coinStats.hashrates; delete coinStats.shares;
                });

                Object.keys(portalStats.algos).forEach((algoKey) => {
                    const algoStats = portalStats.algos[algoKey]; algoStats.hashrateString = util.getReadableHashRateString(algoStats.hashrate, algoKey);
                });
                this.stats = portalStats;

                if (portalStats.global.workers > 0) {
                    const saveStats = JSON.parse(JSON.stringify(portalStats));
                    Object.keys(saveStats.pools).forEach((pool) => {
                        delete saveStats.pools[pool].pending; delete saveStats.pools[pool].confirmed; delete saveStats.pools[pool].currentRoundShares; delete saveStats.pools[pool].currentRoundTimes; delete saveStats.pools[pool].payments; delete saveStats.pools[pool].miners;
                    });
                    this.statsString = JSON.stringify(saveStats);
                    this.statHistory.push(saveStats);
                    this.addStatPoolHistory(portalStats);
                    const retentionTime = (((Date.now() / 1000) - this.portalConfig.website.stats.historicalRetention) | 0);
                    for (let i = 0; i < this.statHistory.length; i++) {
                        if (retentionTime < this.statHistory[i].time) {
                            if (i > 0) {
                                this.statHistory = this.statHistory.slice(i); this.statPoolHistory = this.statPoolHistory.slice(i);
                            } break;
                        }
                    }
                    this.redisStats.multi([['zadd', 'statHistory', statGatherTime, this.statsString], ['zremrangebyscore', 'statHistory', '-inf', `(${retentionTime}`]]).exec((err) => {
                        if (err && this.logger && this.logger.error) {
                            this.logger.error(this.logSystem, 'Historics', `Error adding stats to historics ${JSON.stringify(err)}`);
                        }
                    });
                }

                if (typeof callback === 'function') {
                    callback();
                }
            } catch (err) {
                if (this.logger && this.logger.error) {
                    this.logger.error(this.logSystem, 'Global', `error getting all stats: ${err.message || err}`);
                } if (typeof callback === 'function') {
                    callback();
                }
            }
        })();
    }

    getCoinTotals(coin, options, cb) {
        if (this.stats && this.stats.pools && this.stats.pools[coin]) {
            cb(this.stats.pools[coin]);
        } else {
            cb(null);
        }
    }

    close() {
        try {
            this.redisClients.forEach((c) => {
                try {
                    c.client.quit();
                } catch (e) {
                    try {
                        c.client.end(true);
                    } catch (e2) { }
                }
            });
        } catch (e) { }
        try {
            if (this.redisStats) {
                this.redisStats.quit();
            }
        } catch (e) {
            try {
                this.redisStats.end(true);
            } catch (e2) { }
        }
    }
}

module.exports = Stats;
