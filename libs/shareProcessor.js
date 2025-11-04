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
 * Share Processor Factory Function
 * 
 * Creates and returns a share processor instance configured for a specific pool.
 * This factory pattern allows multiple pool instances to have their own share processors
 * while sharing the same codebase.
 * 
 * @param {Object} logger - Logging utility instance for debugging and error reporting
 * @param {Object} poolConfig - Pool configuration object containing coin and Redis settings
 * @param {Object} poolConfig.redis - Redis connection configuration
 * @param {string} poolConfig.redis.host - Redis server hostname
 * @param {number} poolConfig.redis.port - Redis server port
 * @param {string} [poolConfig.redis.password] - Redis authentication password (optional)
 * @param {Object} poolConfig.coin - Coin-specific configuration
 * @param {string} poolConfig.coin.name - Name/symbol of the cryptocurrency being mined
 * 
 * @returns {Object} Share processor instance with handleShare method
 */
module.exports = function (logger, poolConfig) {

    // Extract configuration values for easier access
    const redisConfig = poolConfig.redis;
    const coin = poolConfig.coin.name;

    // Set up logging identifiers for this processor instance
    /** @type {string} Process fork identifier for multi-threaded operations */
    const forkId = process.env.forkId;
    /** @type {string} Main system identifier for logging */
    const logSystem = 'Pool';
    /** @type {string} Component identifier (coin name) for logging */
    const logComponent = coin;
    /** @type {string} Sub-category with thread number for debugging multi-threaded scenarios */
    const logSubCat = `Thread ${parseInt(forkId) + 1}`;

    /** @type {Object} Redis client connection instance */
    /** @type {Object} Redis client connection instance */
    const connection = CreateRedisClient(redisConfig);

    // Authenticate with Redis if password is provided
    if (redisConfig.password) {
        connection.auth(redisConfig.password);
    }

    // Set up Redis connection event handlers for monitoring and debugging

    /**
     * Redis 'ready' event handler
     * Fired when the Redis connection is established and ready to accept commands
     */
    connection.on('ready', () => {
        logger.debug(logSystem, logComponent, logSubCat, `Share processing setup with redis (${connection.snompEndpoint})`);
    });

    /**
     * Redis 'error' event handler
     * Handles Redis connection errors and logs them for debugging
     * @param {Error} err - The error object containing details about the Redis error
     */
    connection.on('error', (err) => {
        logger.error(logSystem, logComponent, logSubCat, `Redis client had an error: ${JSON.stringify(err)}`);
    });

    /**
     * Redis 'end' event handler
     * Fired when the Redis connection is terminated
     */
    connection.on('end', () => {
        logger.error(logSystem, logComponent, logSubCat, 'Connection to redis database has been ended');
    });
    /**
     * Redis Version Check
     * 
     * Validates that the Redis server version meets minimum requirements.
     * The pool requires Redis 2.6+ for proper multi-command support and other features.
     * 
     * @param {Error|null} error - Error object if the INFO command failed
     * @param {string} response - Raw Redis INFO response containing server information
     */
    connection.info((error, response) => {
        if (error) {
            logger.error(logSystem, logComponent, logSubCat, 'Redis version check failed');
            return;
        }

        // Parse Redis INFO response to extract version information
        const parts = response.split('\r\n');
        let version;
        let versionString;

        // Look for the redis_version field in the INFO response
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

        // Validate Redis version meets minimum requirements
        if (!version) {
            logger.error(logSystem, logComponent, logSubCat, 'Could not detect redis version - but be super old or broken');
        } else if (version < 2.6) {
            logger.error(logSystem, logComponent, logSubCat, `You're using redis version ${versionString} the minimum required version is 2.6. Follow the damn usage instructions...`);
        }
    });

    /**
     * Handle Share Processing
     * 
     * Main method for processing mining shares. This function handles both valid and invalid shares,
     * tracks statistics, manages round data, and processes block discoveries for both main chain
     * and PBaaS (Public Blockchains as a Service) blocks.
     * 
     * @param {boolean} isValidShare - Whether the submitted share meets difficulty requirements
     * @param {boolean} isValidBlock - Whether the share represents a valid block discovery
     * @param {Object} shareData - Complete share information from the mining client
     * @param {string} shareData.worker - Worker identifier (usually wallet.workername)
     * @param {number} shareData.difficulty - Share difficulty value
     * @param {string} [shareData.blockHash] - Block hash if this share found a block
     * @param {string} [shareData.txHash] - Transaction hash for block rewards
     * @param {number} [shareData.height] - Block height for main chain blocks
     * @param {boolean} [shareData.blockOnlyPBaaS] - True if block is PBaaS-only (not main chain)
     * 
     * @returns {void}
     */
    this.handleShare = function (isValidShare, isValidBlock, shareData) {

        /** @type {Array<Array>} Array of Redis commands to execute atomically */
        const redisCommands = [];
        /** @type {number} Current timestamp for tracking when shares/blocks were found */
        const dateNow = Date.now();

        // Process valid shares: update worker contributions and statistics
        if (isValidShare) {
            // Track PBaaS share contributions for this worker
            redisCommands.push(['hincrbyfloat', `${coin}:shares:pbaasCurrent`, shareData.worker, shareData.difficulty]);
            // Track main chain round share contributions for this worker
            redisCommands.push(['hincrbyfloat', `${coin}:shares:roundCurrent`, shareData.worker, shareData.difficulty]);
            // Increment pool-wide valid share counter
            redisCommands.push(['hincrby', `${coin}:stats`, 'validShares', 1]);
            // Update worker's last activity timestamp for monitoring
            redisCommands.push(['hset', `${coin}:lastSeen`, shareData.worker, dateNow]);
        } else {
            // Track invalid shares for pool statistics and potential abuse detection
            redisCommands.push(['hincrby', `${coin}:stats`, 'invalidShares', 1]);
        }

        /**
         * Hashrate Data Storage
         * 
         * Store share data in a sorted set for hashrate calculations. Uses timestamp as score
         * to enable time-based queries for generating worker and pool hashrate statistics.
         * 
         * Data format: "difficulty:worker:timestamp"
         * - Positive difficulty for valid shares
         * - Negative difficulty for invalid shares (helps identify problem workers)
         */
        const hashrateData = [isValidShare ? shareData.difficulty : -shareData.difficulty, shareData.worker, dateNow];
        redisCommands.push(['zadd', `${coin}:hashrate`, dateNow / 1000 | 0, hashrateData.join(':')]);

        // Process block discoveries
        if (isValidBlock) {
            /**
             * PBaaS Block Tracking
             * Add all valid blocks to PBaaS pending set for later processing.
             * PBaaS blocks require special handling and validation.
             */
            redisCommands.push(['sadd', `${coin}:pbaasPending`, [shareData.blockHash, shareData.worker, dateNow].join(':')]);

            /**
             * Main Chain Block Processing
             * Handle blocks that are part of the main blockchain (not PBaaS-only)
             */
            if (!shareData.blockOnlyPBaaS) {
                // Archive current round data by renaming to include block height
                redisCommands.push(['rename', `${coin}:shares:roundCurrent`, `${coin}:shares:round${shareData.height}`]);
                redisCommands.push(['rename', `${coin}:shares:timesCurrent`, `${coin}:shares:times${shareData.height}`]);

                // Add block to pending confirmation queue with all relevant data
                redisCommands.push(['sadd', `${coin}:blocksPending`, [shareData.blockHash, shareData.txHash, shareData.height, shareData.worker, dateNow].join(':')]);

                // Increment valid block counter for pool statistics
                redisCommands.push(['hincrby', `${coin}:stats`, 'validBlocks', 1]);
            }
        } else if (shareData.blockHash) {
            /**
             * Invalid Block Tracking
             * Track blocks that were found but failed validation.
             * This helps identify network issues or configuration problems.
             */
            redisCommands.push(['hincrby', `${coin}:stats`, 'invalidBlocks', 1]);
        }

        /**
         * Execute Redis Commands Atomically
         * 
         * Use Redis MULTI/EXEC to ensure all share processing commands are executed
         * atomically. This prevents data inconsistency if the process crashes or
         * if there are concurrent operations.
         * 
         * @param {Error|null} err - Error object if the multi-command execution failed
         * @param {Array} replies - Array of responses from each Redis command
         */
        connection.multi(redisCommands).exec((err, replies) => {
            if (err) {
                logger.error(logSystem, logComponent, logSubCat, `Error with share processor multi ${JSON.stringify(err)}`);
            }
            // Note: Successful execution is silent to avoid log spam during normal operation
            // Individual command failures within the multi would be logged via Redis client
        });
    };

};
