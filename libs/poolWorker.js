/**
 * Pool worker module
 *
 * This module is instantiated in a child worker process and is responsible for:
 * - creating and starting Stratum pools for each configured coin
 * - wiring share/auth/difficulty handlers into the pool
 * - handling IPC messages from the master process (banIP, blocknotify, coinswitch)
 * - managing proxy-switching servers (listen on ports and forward miners to configured pools)
 *
 * The exported function is invoked with a `logger` object and reads configuration via
 * environment variables:
 * - `process.env.pools` (JSON string of pool configurations)
 * - `process.env.portalConfig` (JSON string of portal-level config such as switching)
 * - `process.env.forkId` (worker index used in log sub-categories)
 *
 * This file prefers runtime configuration via environment variables because it runs in
 * forked worker processes. The module mutates `this` (exports methods) so the parent
 * process can call helper functions like `getFirstPoolForAlgorithm` and
 * `setDifficultyForProxyPort` via the worker's exported object.
 */

const Stratum = require('./stratum');
const redis = require('redis');
const net = require('net');

const ShareProcessor = require('./shareProcessor.js');
const CreateRedisClient = require('./createRedisClient.js');

/**
 * Construct pool worker in a forked process.
 *
 * @param {Object} logger - Logger instance with methods {debug, error, alert, fatal, ...} used throughout the worker
 *
 * Behavior / side-effects:
 * - Reads `process.env.pools` and `process.env.portalConfig` and parses them as JSON.
 * - Creates a Redis client (via `CreateRedisClient`) and uses it to persist proxy state.
 * - Creates Stratum pools for each configured coin and starts them.
 * - Registers IPC handlers on `process.on('message')` to respond to master messages.
 *
 * Exposed instance methods on `this`:
 * - getFirstPoolForAlgorithm(algorithm): returns the first matching pool name for an algorithm
 * - setDifficultyForProxyPort(pool, coin, algo): copy proxy-switching diff/varDiff to a pool
 */
module.exports = function (logger) {

    const _this = this;

    // Pool-level configuration and portal config are supplied via environment variables
    const poolConfigs = JSON.parse(process.env.pools);
    const portalConfig = JSON.parse(process.env.portalConfig);

    const forkId = process.env.forkId;

    // Map of poolName -> pool object created by Stratum.createPool()
    const pools = {};

    // Proxy switch configuration state in-memory. Populated from `portalConfig.switching` and possibly restored from Redis
    const proxySwitch = {};

    // Redis client used to persist and restore proxy state between restarts
    const redisClient = CreateRedisClient(portalConfig.redis);
    if (portalConfig.redis.password) {
        redisClient.auth(portalConfig.redis.password);
    }

    /**
     * IPC message handler
     *
     * The worker listens for messages from the master process. Recognized messages:
     * - { type: 'banIP', ip }
     *   Adds `ip` to banned list on all active pools' stratum servers.
     *
     * - { type: 'blocknotify', coin, hash }
     *   Attempts to find a pool matching `coin` and invokes its `processBlockNotify` with the provided `hash`.
     *
     * - { type: 'coinswitch', switchName, coin }
     *   Handles proxy switching requests: moves miners from the current pool to the new pool for the
     *   given switchName. Persists the new state to Redis under hash 'proxyState'.
     */
    // Handle messages from master process sent via IPC
    process.on('message', (message) => {
        switch (message.type) {

            case 'banIP':
                // Add the banned IP to every pool's stratum server (if available)
                for (const p in pools) {
                    if (pools[p].stratumServer) {
                        pools[p].stratumServer.addBannedIP(message.ip);
                    }
                }
                break;

            case 'blocknotify':

                // Find the pool whose name case-insensitively matches the coin in the message
                const messageCoin = message.coin.toLowerCase();
                const poolTarget = Object.keys(pools).filter((p) => {
                    return p.toLowerCase() === messageCoin;
                })[0];

                if (poolTarget) {
                    // `processBlockNotify` is a pool-level helper that forwards block notifications to the daemon
                    pools[poolTarget].processBlockNotify(message.hash, 'blocknotify script');
                }

                break;

            // IPC message for pool switching
            case 'coinswitch':
                {
                    const logSystem = 'Proxy';
                    const logComponent = 'Switch';
                    const logSubCat = `Thread ${parseInt(forkId) + 1}`;

                    const switchName = message.switchName;

                    const newCoin = message.coin;

                    const algo = poolConfigs[newCoin].coin.algorithm;

                    const newPool = pools[newCoin];
                    const oldCoin = proxySwitch[switchName].currentPool;
                    const oldPool = pools[oldCoin];
                    const proxyPorts = Object.keys(proxySwitch[switchName].ports);

                    if (newCoin == oldCoin) {
                        logger.debug(logSystem, logComponent, logSubCat, `Switch message would have no effect - ignoring ${newCoin}`);
                        break;
                    }

                    logger.debug(logSystem, logComponent, logSubCat, `Proxy message for ${algo} from ${oldCoin} to ${newCoin}`);

                    if (newPool) {
                        // Ask the old pool to relinquish miners that are attached to "auto-switch" ports.
                        oldPool.relinquishMiners(
                            (miner, cback) => {
                                // relinquish miners that are attached to one of the "Auto-switch" ports and leave the others there.
                                cback(proxyPorts.indexOf(miner.client.socket.localPort.toString()) !== -1);
                            },
                            (clients) => {
                                // Attach the relinquished clients to the new pool
                                newPool.attachMiners(clients);
                            }
                        );
                        proxySwitch[switchName].currentPool = newCoin;

                        // Persist the new proxy mapping for this algorithm into Redis
                        redisClient.hset('proxyState', algo, newCoin, (error, obj) => {
                            if (error) {
                                logger.error(logSystem, logComponent, logSubCat, `Redis error writing proxy config: ${JSON.stringify(err)}`);
                            } else {
                                logger.debug(logSystem, logComponent, logSubCat, `Last proxy state saved to redis for ${algo}`);
                            }
                        });

                    }
                }
                break;
        }
    });


    // Iterate configured pools and create Stratum pool instances
    Object.keys(poolConfigs).forEach((coin) => {

        const poolOptions = poolConfigs[coin];

        const logSystem = 'Pool';
        const logSystem2 = 'Block';
        const logSystem3 = 'Worker';
        const logComponent = coin;
        const logSubCat = `Thread ${parseInt(forkId) + 1}`;

        // handlers are small adapter functions that connect the Stratum pool to the share/authorize logic
        const handlers = {
            auth: function () { },
            share: function () { },
            diff: function () { }
        };

        // Internal share processor responsible for crediting shares and payments
        const shareProcessor = new ShareProcessor(logger, poolOptions);

        /**
         * Authorization handler used by Stratum when a miner attempts to authenticate.
         * It supports three modes based on poolOptions:
         * - Disabled validation: when `poolOptions.validateWorkerUsername !== true`, any username is accepted.
         * - Banned addresses list: if `poolOptions.bannedAddresses.enabled` and the username is in the banned list, reject.
         * - Wallet address validation: uses native Verus address validation to check VRSC addresses.
         *
         * @param {number} port - Port the client connected to (used for per-port rules)
         * @param {string} workerName - The submitted worker name / username
         * @param {string} password - Password string supplied by the miner
         * @param {function} authCallback - callback(authorized:boolean)
         */
        handlers.auth = function (port, workerName, password, authCallback) {
            let isvalid;
            if (poolOptions.bannedAddresses.banned.indexOf(workerName) !== -1 && poolOptions.bannedAddresses.enabled == true) {
                // Banned addresses return false if that option is enabled
                isvalid = false;
            } else if (poolOptions.validateWorkerUsername !== true) {
                // Addresses are not checked for validity
                isvalid = true;
            } else {
                // Validation of Public and Identity addresses (coin-specific; here VRSC)
                isvalid = Stratum.util.validateVerusAddress(String(workerName).split('.')[0]);
                /*
                // Validation of sapling addreses (disabled until paymentProcessor.js can handle sapling payments)
                if(isvalid !== true){
                    var isvalid = Stratum.util.validateVerusAddress(String(address).split(".")[0]);
                }
*/
            }
            authCallback(isvalid);
        };

        /**
         * Share handler that forwards accepted/rejected share events to the share processor.
         * @param {boolean} isValidShare
         * @param {boolean} isValidBlock
         * @param {Object} data - Share metadata from the stratum pool
         */
        handlers.share = function (isValidShare, isValidBlock, data) {
            shareProcessor.handleShare(isValidShare, isValidBlock, data);
        };

        /**
         * Adapter passed to Stratum pools to perform authorization and log the attempt.
         * The signature matches what `Stratum.createPool` expects.
         *
         * @param {string} ip - remote address
         * @param {number} port - local listening port
         * @param {string} workerName - worker/username
         * @param {string} password - worker password
         * @param {function} callback - (result) => void, where result contains authorized, error, disconnect
         */
        const authorizeFN = function (ip, port, workerName, password, callback) {
            handlers.auth(port, workerName, password, (authorized) => {

                const authString = authorized ? 'Authorized' : 'Unauthorized ';

                logger.debug(logSystem3, logComponent, logSubCat, `${authString} ${workerName}:${password} [${ip}]`);
                callback({
                    error: null,
                    authorized: authorized,
                    disconnect: false
                });
            });
        };


        // Create the Stratum pool and wire up events we care about
        const pool = Stratum.createPool(poolOptions, authorizeFN, logger);
        pool.on('share', (isValidShare, isValidBlock, data) => {

            const shareData = JSON.stringify(data);

            // Logging for block finds or rejected blocks
            if (data.blockHash && !isValidBlock) {
                logger.error(logSystem2, logComponent, logSubCat, `We thought a block was found but it was rejected by the daemon, share data: ${shareData}`);
            } else if (isValidBlock) {
                if (!data.blockOnlyPBaaS) {
                    logger.error(logSystem2, logComponent, logSubCat, `Block found: ${data.blockHash} [${data.height}] by ${data.worker}`);
                } else {
                    logger.error(logSystem2, logComponent, logSubCat, `PBaaS found: ${data.blockHash} by ${data.worker}`);
                }
            }

            // Log suspiciously large share diffs with appropriate severity
            if (isValidShare) {
                if (data.shareDiff > 10000000000) {
                    logger.fatal(logSystem3, logComponent, logSubCat, `Share was found with diff higher than 10,000,000,000! ${((data.shareDiff / data.blockDiff) * 100).toFixed(2)}%`);
                } else if (data.shareDiff > 1000000000) {
                    logger.error(logSystem3, logComponent, logSubCat, `Share was found with diff higher than 1,000,000,000! ${((data.shareDiff / data.blockDiff) * 100).toFixed(2)}%`);
                } else if (data.shareDiff > 100000000) {
                    logger.alert(logSystem3, logComponent, logSubCat, `Share was found with diff higher than 100,000,000! ${((data.shareDiff / data.blockDiff) * 100).toFixed(2)}%`);
                }
                //logger.debug(logSystem, logComponent, logSubCat, 'Share accepted at diff ' + data.difficulty + '/' + data.shareDiff + ' by ' + data.worker + ' [' + data.ip + ']' );
            } else if (!isValidShare) {
                logger.debug(logSystem3, logComponent, logSubCat, `Share rejected: ${shareData}`);
            }

            // handle the share with the configured processor
            handlers.share(isValidShare, isValidBlock, data);

            // send to master for pplnt time tracking
            process.send({ type: 'shareTrack', thread: (parseInt(forkId) + 1), coin: poolOptions.coin.name, isValidShare: isValidShare, isValidBlock: isValidBlock, data: data });

        }).on('difficultyUpdate', (workerName, diff) => {
            // Controlled by config: defaultPoolConfigs.showDifficultyUpdate (default true)
            const show = (portalConfig && portalConfig.defaultPoolConfigs && typeof portalConfig.defaultPoolConfigs.showDifficultyUpdate !== 'undefined') ? !!portalConfig.defaultPoolConfigs.showDifficultyUpdate : true;
            if (show) {
                logger.debug(logSystem3, logComponent, logSubCat, `Difficulty update to diff ${diff} workerName=${JSON.stringify(workerName)}`);
            }
            handlers.diff(workerName, diff);
        }).on('log', (severity, text) => {
            // Route pool log events through the provided logger
            logger[severity](logSystem, logComponent, logSubCat, text);
        }).on('banIP', (ip, worker) => {
            // Forward ban requests to master process so it can propagate to all workers
            process.send({ type: 'banIP', ip: ip });
        }).on('started', () => {
            // When the pool starts, ensure any proxy switching ports that use the same algorithm
            // inherit the configured diff/varDiff settings
            _this.setDifficultyForProxyPort(pool, poolOptions.coin.name, poolOptions.coin.algorithm);
        });

        pool.start();
        pools[poolOptions.coin.name] = pool;
    });


    // Setup proxy switching if configured in the portal config
    if (portalConfig.switching) {

        const logSystem = 'Switching';
        const logComponent = 'Setup';
        const logSubCat = `Thread ${parseInt(forkId) + 1}`;

        let proxyState = {};

        // Load proxy state for each algorithm from redis which allows NOMP to resume operation
        // on the last pool it was using when reloaded or restarted
        logger.debug(logSystem, logComponent, logSubCat, 'Loading last proxy state from redis');

        /*redisClient.on('error', function(err){
            logger.debug(logSystem, logComponent, logSubCat, 'Pool configuration failed: ' + err);
        });*/

        // Restore any previously persisted proxy state and then create the listening servers
        redisClient.hgetall('proxyState', (error, obj) => {
            if (!error && obj) {
                proxyState = obj;
                logger.debug(logSystem, logComponent, logSubCat, 'Last proxy state loaded from redis');
            }

            // Setup proxySwitch object to control proxy operations from configuration and any restored
            // state. Each algorithm has a listening port, current coin name, and an active pool to
            // which traffic is directed when activated in the config.
            // In addition, the proxy config also takes diff and varDiff parameters that override the
            // defaults for the standard config of the coin.
            Object.keys(portalConfig.switching).forEach((switchName) => {

                const algorithm = portalConfig.switching[switchName].algorithm;

                if (!portalConfig.switching[switchName].enabled) {
                    return;
                }


                const initalPool = proxyState.hasOwnProperty(algorithm) ? proxyState[algorithm] : _this.getFirstPoolForAlgorithm(algorithm);
                proxySwitch[switchName] = {
                    algorithm: algorithm,
                    ports: portalConfig.switching[switchName].ports,
                    currentPool: initalPool,
                    servers: []
                };


                Object.keys(proxySwitch[switchName].ports).forEach((port) => {
                    const f = net.createServer((socket) => {
                        const currentPool = proxySwitch[switchName].currentPool;

                        logger.debug(logSystem, 'Connect', logSubCat, `Connection to ${switchName} from ${socket.remoteAddress} on ${port} routing to ${currentPool}`);

                        if (pools[currentPool]) {
                            pools[currentPool].getStratumServer().handleNewClient(socket);
                        } else {
                            pools[initalPool].getStratumServer().handleNewClient(socket);
                        }

                    }).listen(parseInt(port), () => {
                        logger.debug(logSystem, logComponent, logSubCat, `Switching "${switchName
                            }" listening for ${algorithm
                            } on port ${port
                            } into ${proxySwitch[switchName].currentPool}`);
                    });
                    proxySwitch[switchName].servers.push(f);
                });

            });
        });
    }

    /**
     * Find the first configured pool name that uses the supplied algorithm.
     *
     * @param {string} algorithm - algorithm name (e.g., 'verushash')
     * @returns {string} poolName - first found pool name or empty string if none is found
     */
    this.getFirstPoolForAlgorithm = function (algorithm) {
        let foundCoin = '';
        Object.keys(poolConfigs).forEach((coinName) => {
            if (poolConfigs[coinName].coin.algorithm == algorithm) {
                if (foundCoin === '') {
                    foundCoin = coinName;
                }
            }
        });
        return foundCoin;
    };

    /**
     * Copy configured diff/varDiff settings for matching proxy-switch ports into a pool.
     *
     * This is called when a Stratum pool emits 'started' to ensure that proxy ports which forward
     * to this pool have the correct difficulty and vardiff settings applied.
     *
     * @param {Object} pool - pool instance returned by Stratum.createPool
     * @param {string} coin - coin name this pool services
     * @param {string} algo - algorithm name for this pool
     */
    this.setDifficultyForProxyPort = function (pool, coin, algo) {
        const logSystem = 'Switching';
        const logComponent = 'Setup';

        logger.debug(logSystem, logComponent, algo, 'Setting proxy difficulties after pool start');

        Object.keys(portalConfig.switching).forEach((switchName) => {
            if (!portalConfig.switching[switchName].enabled) {
                return;
            }

            const switchAlgo = portalConfig.switching[switchName].algorithm;
            if (pool.options.coin.algorithm !== switchAlgo) {
                return;
            }

            // we know the switch configuration matches the pool's algo, so setup the diff and 
            // vardiff for each of the switch's ports
            for (const port in portalConfig.switching[switchName].ports) {

                if (portalConfig.switching[switchName].ports[port].varDiff) {
                    pool.setVarDiff(port, portalConfig.switching[switchName].ports[port].varDiff);
                }

                if (portalConfig.switching[switchName].ports[port].diff) {
                    if (!pool.options.ports.hasOwnProperty(port)) {
                        pool.options.ports[port] = {};
                    }
                    pool.options.ports[port].diff = portalConfig.switching[switchName].ports[port].diff;
                }
            }
        });
    };
};
