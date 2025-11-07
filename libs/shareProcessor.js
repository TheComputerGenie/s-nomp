/**
 * @fileoverview Share Processor - handles share processing and Redis persistence
 *
 * Processes miner shares, stores hashrate data, updates round and block state,
 * and records statistics in Redis.
 *
 * @author ComputerGenieCo
 * @version 21.7.3
 * @copyright 2025
 */
const redis = require('redis');
const Stratum = require('./stratum');
const CreateRedisClient = require('./createRedisClient.js');

/**
 * @fileoverview Share Processor Module
 * 
 * This module handles share processing for cryptocurrency mining pools in internal payment processing mode.
 * It manages the storage and tracking of mining shares, block discoveries, and worker statistics using Redis.
 * 
 * The module stores data with the following Redis structure:
 * - Shares: {coin}:shares:roundCurrent and {coin}:shares:round{height}
 * - Statistics: {coin}:stats (validShares, invalidShares, validBlocks, invalidBlocks)
 * - Hashrate data: {coin}:hashrate (sorted set with timestamp scores)
 * - Worker activity: {coin}:lastSeen
 * - Pending blocks: {coin}:blocksPending and {coin}:pbaasPending
 * 
 * @author Mining Pool Software
 * @version 1.0.0
 */

/**
 * ShareProcessor
 *
 * Processes shares for a pool and persists statistics to Redis. Construct with
 * a logger and pool configuration and call `handleShare(isValid, isBlock, data)`
 * to record share information.
 *
 * @class ShareProcessor
 * @param {Object} logger - Logger with debug/error methods
 * @param {Object} poolConfig - Pool configuration (expects `.redis` and `.coin`)
 * @param {Object} poolConfig.redis - Redis connection options
 * @param {Object} poolConfig.coin - Coin configuration (expects `.name`)
 */
class ShareProcessor {
    constructor(logger, poolConfig) {
        this.logger = logger;
        this.poolConfig = poolConfig;

        this.redisConfig = poolConfig.redis;
        this.coin = poolConfig.coin.name;

        const forkId = process.env.forkId;
        this.logSystem = 'Pool';
        this.logComponent = this.coin;
        this.logSubCat = `Thread ${parseInt(forkId) + 1}`;

        this.connection = CreateRedisClient(this.redisConfig);

        if (this.redisConfig.password) {
            this.connection.auth(this.redisConfig.password);
        }

        this.connection.on('ready', () => {
            this.logger.debug(this.logSystem, this.logComponent, this.logSubCat, `Share processing setup with redis (${this.connection.snompEndpoint})`);
        });

        this.connection.on('error', (err) => {
            this.logger.error(this.logSystem, this.logComponent, this.logSubCat, `Redis client had an error: ${JSON.stringify(err)}`);
        });

        this.connection.on('end', () => {
            this.logger.error(this.logSystem, this.logComponent, this.logSubCat, 'Connection to redis database has been ended');
        });

        this.connection.info((error, response) => {
            if (error) {
                this.logger.error(this.logSystem, this.logComponent, this.logSubCat, 'Redis version check failed');
                return;
            }

            const parts = response.split('\r\n');
            let version;
            let versionString;

            for (let i = 0; i < parts.length; i++) {
                if (parts[i].indexOf(':') !== -1) {
                    const valParts = parts[i].split(':');
                    if (valParts[0] === 'redis_version') {
                        versionString = valParts[1];
                        version = parseFloat(versionString);
                        break;
                    }
                }
            }

            if (!version) {
                this.logger.error(this.logSystem, this.logComponent, this.logSubCat, 'Could not detect redis version - but be super old or broken');
            } else if (version < 2.6) {
                this.logger.error(this.logSystem, this.logComponent, this.logSubCat, `You're using redis version ${versionString} the minimum required version is 2.6. Follow the damn usage instructions...`);
            }
        });
    }

    handleShare(isValidShare, isValidBlock, shareData) {
        const redisCommands = [];
        const dateNow = Date.now();

        if (isValidShare) {
            redisCommands.push(['hincrbyfloat', `${this.coin}:shares:pbaasCurrent`, shareData.worker, shareData.difficulty]);
            redisCommands.push(['hincrbyfloat', `${this.coin}:shares:roundCurrent`, shareData.worker, shareData.difficulty]);
            redisCommands.push(['hincrby', `${this.coin}:stats`, 'validShares', 1]);
            redisCommands.push(['hset', `${this.coin}:lastSeen`, shareData.worker, dateNow]);
        } else {
            redisCommands.push(['hincrby', `${this.coin}:stats`, 'invalidShares', 1]);
        }

        const hashrateData = [isValidShare ? shareData.difficulty : -shareData.difficulty, shareData.worker, dateNow];
        redisCommands.push(['zadd', `${this.coin}:hashrate`, dateNow / 1000 | 0, hashrateData.join(':')]);

        if (isValidBlock) {
            redisCommands.push(['sadd', `${this.coin}:pbaasPending`, [shareData.blockHash, shareData.worker, dateNow].join(':')]);

            if (!shareData.blockOnlyPBaaS) {
                redisCommands.push(['rename', `${this.coin}:shares:roundCurrent`, `${this.coin}:shares:round${shareData.height}`]);
                redisCommands.push(['rename', `${this.coin}:shares:timesCurrent`, `${this.coin}:shares:times${shareData.height}`]);
                redisCommands.push(['sadd', `${this.coin}:blocksPending`, [shareData.blockHash, shareData.txHash, shareData.height, shareData.worker, dateNow].join(':')]);
                redisCommands.push(['hincrby', `${this.coin}:stats`, 'validBlocks', 1]);
            }
        } else if (shareData.blockHash) {
            redisCommands.push(['hincrby', `${this.coin}:stats`, 'invalidBlocks', 1]);
        }

        this.connection.multi(redisCommands).exec((err, replies) => {
            if (err) {
                this.logger.error(this.logSystem, this.logComponent, this.logSubCat, `Error with share processor multi ${JSON.stringify(err)}`);
            }
        });
    }
}

module.exports = ShareProcessor;
