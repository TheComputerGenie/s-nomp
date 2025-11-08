/**
 * @file init.js
 * @description
 * Entry point and process manager for the mining pool application. This file
 * performs initial configuration, validates pool configurations, and spawns
 * clustered worker processes for the pool, payment processor, website, and
 * profit switching components. It also starts a CLI listener used for runtime
 * commands.
 *
 * The file runs in two modes depending on whether the process is the master
 * or a worker (cluster.fork):
 *  - Master: reads pool configs, performs validation, spawns worker processes,
 *    and monitors them.
 *  - Worker: based on environment variables, the process becomes a pool
 *    worker, payment processor, website, or profit switch process and runs
 *    the appropriate module.
 *
 * Important behaviors and assumptions:
 *  - Pool configurations live under `pool_configs/` and must contain `enabled`
 *    and `ports` keys. Only enabled pool JSONs are loaded.
 *  - The code supports clustering via `portalConfig.clustering` and will fork
 *    either a fixed number of threads or `os.cpus().length` when `forks: "auto"`.
 *  - Redis is used for time-share tracking and other cross-process state. A
 *    Redis client is created when the first pool config with redis settings is
 *    discovered.
 *
 * The file purposely contains minimal business logic: it wires together
 * existing modules found in `libs/` and orchestrates lifecycle and messaging
 * between processes.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const cluster = require('cluster');

// Use native structuredClone for deep cloning (Node.js v21+)
// `extend` package removed to eliminate external dependency.

const redis = require('redis');

/**
 * PoolLogger: application logging utility providing leveled logs and colors.
 * See `./libs/PoolLogger.js` for implementation details.
 */
const PoolLogger = require('./libs/PoolLogger.js');
/**
 * CliListener: listens on a local TCP port for admin CLI commands and emits
 * events for the master process to act upon.
 */
const CliListener = require('./libs/cliListener.js');
/**
 * PoolWorker: class that manages a pool worker process (stratum handling,
 * connections, mining job distribution). Instantiated in worker processes.
 */
const PoolWorker = require('./libs/poolWorker.js');
/**
 * PaymentProcessor: background process responsible for calculating and
 * executing payouts to miners. Spawned as a dedicated worker process when
 * payment processing is enabled for any pool.
 */
const PaymentProcessor = require('./libs/paymentProcessor.js');
/**
 * Website: web/UI process that serves the pool website and API endpoints.
 */
const Website = require('./libs/website.js');
/**
 * CreateRedisClient: factory that returns a configured redis client used for
 * cross-process state like PPLNT tracking and other shared counters.
 */
const CreateRedisClient = require('./libs/createRedisClient.js');

/**
 * algo properties map — maps algorithm names to algorithm-specific helpers
 * used by the stratum implementation.
 */
const algos = require('./libs/stratum/algoProperties.js');
/**
 * COIN_CONSTANTS: coin-specific constants and defaults. Currently the file
 * assumes Verus-specific constants but copies are made per-pool so that the
 * global constant file is not mutated.
 */
const COIN_CONSTANTS = require('./libs/coinConstants.js');

/**
 * JSON minify utility for removing comments and whitespace from JSON strings.
 * This allows configuration files to contain comments while still being parseable.
 */
// Provide a native JSON.minify implementation to remove the dependency on
// the external `node-json-minify` package. This implementation strips
// single-line (//...) and multi-line (/* ... */) comments and removes
// trailing commas in objects and arrays while preserving string literals.
// It aims to be a drop-in replacement for typical configuration files
// that may include comments and trailing commas.
JSON.minify = JSON.minify || function (text) {
    if (typeof text !== 'string') {
        return text;
    }

    let insideString = false;
    let insideSingleLineComment = false;
    let insideMultiLineComment = false;
    let offset = 0;
    let result = '';

    while (offset < text.length) {
        const char = text[offset];
        const nextChar = text[offset + 1];

        if (insideSingleLineComment) {
            if (char === '\n') {
                insideSingleLineComment = false;
                result += char;
            }
            offset++;
            continue;
        }

        if (insideMultiLineComment) {
            if (char === '*' && nextChar === '/') {
                insideMultiLineComment = false;
                offset += 2;
                continue;
            }
            offset++;
            continue;
        }

        if (insideString) {
            if (char === '\\') {
                // escape sequence, include next char as well
                result += char;
                offset++;
                if (offset < text.length) {
                    result += text[offset];
                }
            } else if (char === '"') {
                insideString = false;
                result += char;
            } else {
                result += char;
            }
            offset++;
            continue;
        }

        // Not inside string or comment
        if (char === '"') {
            insideString = true;
            result += char;
            offset++;
            continue;
        }

        // single-line comment
        if (char === '/' && nextChar === '/') {
            insideSingleLineComment = true;
            offset += 2;
            continue;
        }

        // multi-line comment
        if (char === '/' && nextChar === '*') {
            insideMultiLineComment = true;
            offset += 2;
            continue;
        }

        result += char;
        offset++;
    }

    // Remove trailing commas before } or ]
    // This regex finds a comma followed by optional whitespace and then a closing }
    // or ] and removes the comma.
    result = result.replace(/,\s*(\}|\])/g, '$1');

    return result;
};

/**
 * Validate that the main configuration file exists before attempting to load it.
 * The config.json file contains the main portal configuration including Redis settings,
 * clustering options, and default pool configurations.
 */
if (!fs.existsSync('config.json')) {
    console.log('config.json file does not exist. Read the installation/setup instructions.');
    return;
}

/**
 * Main portal configuration loaded from config.json.
 * Contains global settings for the entire mining pool system including:
 * - Redis connection parameters
 * - Clustering configuration
 * - Website settings
 * - Payment processing defaults
 * - Profit switching options
 * - Logging configuration
 * @type {Object}
 */
const portalConfig = JSON.parse(JSON.minify(fs.readFileSync('config.json', { encoding: 'utf8' })));

/**
 * Global in-memory pool configuration object built from files in
 * `pool_configs/`. Populated by buildPoolConfigs()
 * @type {Object<string, Object>}
 */
let poolConfigs;

/**
 * Application logger instance. Wraps console and provides leveled logging.
 * Configured from `portalConfig`.
 * @type {PoolLogger}
 */
const logger = new PoolLogger({
    logLevel: portalConfig.logLevel,
    logColors: portalConfig.logColors
});

/**
 * Optional New Relic APM integration for application performance monitoring.
 * This is a best-effort initialization - if the newrelic module is not installed
 * or configured, the application will continue without monitoring.
 *
 * @see {@link https://newrelic.com/} New Relic APM documentation
 */
try {
    require('newrelic');
    if (cluster.isMaster) {
        logger.debug('NewRelic', 'Monitor', 'New Relic initiated');
    }
} catch (e) {
    // Silently ignore - New Relic is optional
}

/**
 * System resource optimization: attempt to increase file descriptor limits
 * to handle up to 100,000 concurrent connections. This is critical for mining
 * pools that need to support thousands of miners simultaneously.
 *
 * The process involves:
 * 1. Loading the POSIX module (if available)
 * 2. Setting soft and hard limits for file descriptors ('nofile')
 * 3. Dropping root privileges if started with sudo
 *
 * This is a best-effort optimization and gracefully degrades if:
 * - The POSIX module is not installed
 * - The process lacks sufficient privileges
 * - The system doesn't support the requested limits
 *
 * @see {@link https://nodejs.org/api/process.html#process_process_setuid_id} Process setuid documentation
 */
try {
    const posix = require('posix');
    try {
        posix.setrlimit('nofile', { soft: 100000, hard: 100000 });
    } catch (e) {
        if (cluster.isMaster) {
            logger.warn('POSIX', 'Connection Limit', '(Safe to ignore) Must be ran as root to increase resource limits');
        }
    } finally {
        // Find out which user used sudo through the environment variable
        const uid = parseInt(process.env.SUDO_UID);
        // Set our server's uid to that user
        if (uid) {
            process.setuid(uid);
            logger.debug('POSIX', 'Connection Limit', `Raised to 100K concurrent connections, now running as non-root user: ${process.getuid()}`);
        }
    }
} catch (e) {
    if (cluster.isMaster) {
        logger.debug('POSIX', 'Connection Limit', '(Safe to ignore) POSIX module not installed and resource (connection) limit was not raised');
    }
}

/**
 * Worker Process Initialization
 *
 * When this file is executed in a clustered worker process (via cluster.fork),
 * the `process.env.workerType` environment variable defines which specific
 * worker logic should be executed. The master process spawns different types
 * of workers to handle different aspects of the mining pool operation.
 *
 * Worker Types:
 * - 'pool': Handles stratum protocol connections, miner authentication,
 *   job distribution, and share validation. Multiple pool workers can run
 *   in parallel to handle high connection loads.
 *
 * - 'paymentProcessor': Dedicated worker for calculating miner payouts,
 *   processing payment transactions, and updating balances. Runs as a
 *   single background process.
 *
 * - 'website': Serves the web interface, API endpoints, and real-time
 *   statistics. Handles HTTP requests from miners and administrators.
 *
 * Each worker type runs independently and communicates with the master
 * process and other workers through Redis and IPC messaging.
 *
 * @see {@link https://nodejs.org/api/cluster.html} Node.js Cluster documentation
 */
if (cluster.isWorker) {

    switch (process.env.workerType) {
        case 'pool':
            new PoolWorker(logger);
            break;
        case 'paymentProcessor':
            PaymentProcessor();
            break;
        case 'website':
            const website = new Website(logger);
            website.start();
            break;
    }

    // Worker should not execute master orchestration code below.
    return;
}

/**
 * Read all pool configuration JSON files under `pool_configs/`, validate them,
 * and merge in default portal options. This function performs several
 * responsibilities:
 *  - Reads enabled JSON files from `pool_configs/`.
 *  - Validates that no two pools claim the same port.
 *  - Clones default pool options from `portalConfig.defaultPoolConfigs` when
 *    missing in the pool-specific file.
 *  - Attaches a copy of global `COIN_CONSTANTS` as `poolOptions.coin` and
 *    lowercases the coin name for keying.
 *  - Filters out pools with unsupported algorithms.
 *
 * Side-effects: may call `process.exit(1)` when fatal validation (e.g. duplicate
 * ports or duplicate coin names) is detected.
 *
 * @returns {Object<string, Object>} Map of coin name -> pool configuration
 */
const buildPoolConfigs = function () {
    const configs = {};
    const configDir = 'pool_configs/';

    const poolConfigFiles = [];

    /**
     * Phase 1: Discovery and Initial Validation
     *
     * Scan the pool_configs directory for JSON configuration files and perform
     * initial filtering. Only files that:
     * - Have a .json extension
     * - Actually exist on the filesystem
     * - Contain valid JSON with an 'enabled: true' property
     *
     * Are loaded into the poolConfigFiles array for further processing.
     */
    fs.readdirSync(configDir).forEach((file) => {
        if (!fs.existsSync(configDir + file) || path.extname(configDir + file) !== '.json') {
            return;
        }
        const poolOptions = JSON.parse(JSON.minify(fs.readFileSync(configDir + file, { encoding: 'utf8' })));
        if (!poolOptions.enabled) {
            return;
        }
        poolOptions.fileName = file;
        poolConfigFiles.push(poolOptions);
    });

    /**
     * Phase 2: Port Conflict Detection
     *
     * Validate that no two pool configurations attempt to use the same port.
     * This is critical because multiple pools cannot bind to the same network
     * port simultaneously. The validation performs an O(n²) comparison of all
     * port configurations across all enabled pools.
     *
     * If a conflict is detected, the application terminates immediately with
     * an error message indicating which pools have conflicting ports.
     *
     * @throws {Error} Terminates process if port conflicts are found
     */
    for (let i = 0; i < poolConfigFiles.length; i++) {
        const ports = Object.keys(poolConfigFiles[i].ports);
        for (let f = 0; f < poolConfigFiles.length; f++) {
            if (f === i) {
                continue;
            }
            const portsF = Object.keys(poolConfigFiles[f].ports);
            for (let g = 0; g < portsF.length; g++) {
                if (ports.indexOf(portsF[g]) !== -1) {
                    logger.error('Master', poolConfigFiles[f].fileName, `Has same configured port of ${portsF[g]} as ${poolConfigFiles[i].fileName}`);
                    process.exit(1);
                    return;
                }
            }
        }
    }

    /**
     * Phase 3: Pool Configuration Processing and Validation
     *
     * For each enabled pool configuration file, this phase:
     * 1. Attaches coin-specific constants and normalizes the coin name
     * 2. Validates that no two pools target the same coin
     * 3. Merges in default configurations from the portal config
     * 4. Validates that the coin's algorithm is supported
     *
     * The processing creates a unified configuration object that combines
     * pool-specific settings with global defaults and coin constants.
     */
    poolConfigFiles.forEach((poolOptions) => {

        /**
         * Coin Profile Assignment
         * Since this pool implementation currently focuses on Verus Coin,
         * we use hardcoded constants but create a copy to avoid mutations
         * affecting other pool instances.
         */
        const coinProfile = { ...COIN_CONSTANTS }; // Make a copy to avoid modifying constants
        poolOptions.coin = coinProfile;
        poolOptions.coin.name = poolOptions.coin.name.toLowerCase();
        poolOptions.redis = portalConfig.redis;

        /**
         * Coin Name Conflict Detection
         * Ensure no two pool configurations target the same coin, which
         * would create ambiguity in routing and statistics tracking.
         */
        if (poolOptions.coin.name in configs) {

            logger.error('Master', poolOptions.fileName, `Pool has same configured coin name ${poolOptions.coin.name} as pool config ${configs[poolOptions.coin.name].fileName}`);

            process.exit(1);
            return;
        }

        /**
         * Default Configuration Merging
         * Apply default pool configurations from the portal config for any
         * settings not explicitly defined in the pool-specific configuration.
         * This uses deep cloning to prevent reference sharing between pools.
         */
        for (const option in portalConfig.defaultPoolConfigs) {
            if (!(option in poolOptions)) {
                const toCloneOption = portalConfig.defaultPoolConfigs[option];
                // Use structuredClone when available for deep cloning plain objects
                // For non-plain values (primitives, arrays, etc.) structuredClone
                // will correctly clone or return the value.
                let clonedOption;
                try {
                    clonedOption = structuredClone(toCloneOption);
                } catch (e) {
                    // Fallback: for environments lacking structuredClone (shouldn't
                    // happen on Node.js v21+), do a JSON-based deep clone for
                    // plain data structures. This preserves current behavior.
                    clonedOption = JSON.parse(JSON.stringify(toCloneOption));
                }
                poolOptions[option] = clonedOption;
            }
        }

        configs[poolOptions.coin.name] = poolOptions;

        /**
         * Algorithm Support Validation
         * Verify that the stratum implementation supports the coin's
         * mining algorithm. Unsupported algorithms are removed from
         * the configuration to prevent runtime errors.
         */
        if (!(coinProfile.algorithm in algos)) {
            logger.error('Master', coinProfile.name, `Cannot run a pool for unsupported algorithm "${coinProfile.algorithm}"`);
            delete configs[poolOptions.coin.name];
        }

    });
    return configs;
};

/**
 * Round a number to a fixed number of decimal places. This helper avoids
 * floating point accumulation artifacts by using `toFixed` internally.
 *
 * @param {number} n - The number to round
 * @param {number} [digits=0] - Number of fractional digits to keep
 * @returns {number} The rounded value
 */
function roundTo(n, digits) {
    if (digits === undefined) {
        digits = 0;
    }
    const multiplicator = Math.pow(10, digits);
    n = parseFloat((n * multiplicator).toFixed(11));
    const test = (Math.round(n) / multiplicator);
    return +(test.toFixed(digits));
}

/**
 * In-memory trackers used by pplnt (time-share tracking). Keys are coin names
 * mapping to an object keyed by workerAddress.
 * @type {Object<string, Object<string, number>>}
 */
const _lastStartTimes = [];
const _lastShareTimes = [];

/**
 * Spawn pool worker processes according to clustering options in
 * `portalConfig`. Responsibilities:
 *  - Validate that pools have daemons configured and remove invalid pools.
 *  - Create (once) a redis connection for cross-process operations (PPLNT).
 *  - Determine number of forks to create based on `portalConfig.clustering`.
 *  - Fork worker processes and attach messaging handlers for events emitted by
 *    pool workers (banIP, shareTrack, etc.).
 *
 * Side-effects: forks worker processes via `cluster.fork`. Listens for
 * 'exit' events on workers to respawn them on failure.
 */
const spawnPoolWorkers = function () {

    let redisConfig;
    let connection;

    /**
     * Pre-flight Validation and Redis Setup
     *
     * Before spawning worker processes, validate that each pool has at least
     * one daemon configured for blockchain communication. Pools without daemons
     * cannot function and are removed from the configuration.
     *
     * Additionally, establish a Redis connection for cross-process communication
     * and PPLNT (Pay Per Last N Time) share tracking. Redis is essential for
     * coordinating state between multiple pool worker processes.
     */
    Object.keys(poolConfigs).forEach((coin) => {
        const pcfg = poolConfigs[coin];
        if (!Array.isArray(pcfg.daemons) || pcfg.daemons.length < 1) {
            logger.error('Master', coin, 'No daemons configured so a pool cannot be started for this coin.');
            delete poolConfigs[coin];
        } else if (!connection) {
            redisConfig = pcfg.redis;
            connection = CreateRedisClient(redisConfig);
            if (redisConfig.password != '') {
                connection.auth(redisConfig.password);
                connection.on('error', (err) => {
                    logger.error('redis', coin, `An error occured while attempting to authenticate redis: ${err}`);
                });
            }
            connection.on('ready', () => {
                logger.debug('PPLNT', coin, `TimeShare processing setup with redis (${connection.snompEndpoint})`);
            });
        }
    });

    if (Object.keys(poolConfigs).length === 0) {
        logger.warn('Master', 'PoolSpawner', 'No pool configs exists or are enabled in pool_configs folder. No pools spawned.');
        return;
    }

    const serializedConfigs = JSON.stringify(poolConfigs);

    /**
     * Dynamic Fork Count Calculation
     *
     * Determine the optimal number of pool worker processes to spawn based on
     * the clustering configuration. The logic supports several modes:
     *
     * - Clustering disabled: Single process mode (numForks = 1)
     * - Auto mode: One worker per CPU core for optimal resource utilization
     * - Manual mode: Use the explicitly configured fork count
     * - Invalid config: Fallback to single process mode
     *
     * More worker processes can handle higher connection loads but also
     * increase memory usage and IPC overhead.
     *
     * @returns {number} Number of pool worker processes to spawn
     */
    const numForks = (function () {
        if (!portalConfig.clustering || !portalConfig.clustering.enabled) {
            return 1;
        }
        if (portalConfig.clustering.forks === 'auto') {
            return os.cpus().length;
        }
        if (!portalConfig.clustering.forks || isNaN(portalConfig.clustering.forks)) {
            return 1;
        }
        return portalConfig.clustering.forks;
    })();

    const poolWorkers = {};

    /**
     * Pool Worker Creation and Management
     *
     * Creates a new pool worker process with the specified fork ID and sets up
     * event handlers for process lifecycle management and inter-process communication.
     *
     * The worker process receives:
     * - workerType: 'pool' to identify its role
     * - forkId: Unique identifier for this worker instance
     * - pools: Serialized pool configurations
     * - portalConfig: Serialized portal configuration
     *
     * Event Handlers:
     * - 'exit': Automatically respawn failed workers after a 2-second delay
     * - 'message': Handle IPC messages from the worker (banIP, shareTrack, etc.)
     *
     * @param {number} forkId - Unique identifier for this worker process
     */
    const createPoolWorker = function (forkId) {
        const worker = cluster.fork({
            workerType: 'pool',
            forkId: forkId,
            pools: serializedConfigs,
            portalConfig: JSON.stringify(portalConfig)
        });
        worker.forkId = forkId;
        worker.type = 'pool';
        poolWorkers[forkId] = worker;
        worker.on('exit', (code, signal) => {
            logger.error('Master', 'PoolSpawner', `Fork ${forkId} died, spawning replacement worker...`);
            setTimeout(() => {
                createPoolWorker(forkId);
            }, 2000);
        }).on('message', (msg) => {
            /**
             * Inter-Process Communication Message Handler
             *
             * Processes messages sent from pool worker processes to coordinate
             * actions across the entire pool infrastructure.
             */
            switch (msg.type) {
                /**
                 * IP Ban Coordination
                 * When one worker detects malicious behavior and bans an IP,
                 * propagate the ban to all other pool workers to maintain
                 * consistent security across all connections.
                 */
                case 'banIP':
                    Object.keys(cluster.workers).forEach((id) => {
                        if (cluster.workers[id].type === 'pool') {
                            cluster.workers[id].send({ type: 'banIP', ip: msg.ip });
                        }
                    });
                    break;
                /**
                 * PPLNT Share Tracking
                 * Process valid shares for Pay Per Last N Time calculations.
                 * This tracks the time each worker spends mining to ensure
                 * fair payout distribution based on actual contribution time.
                 */
                case 'shareTrack':
                    // pplnt time share tracking of workers
                    if (msg.isValidShare && !msg.isValidBlock) {
                        const now = Date.now();
                        let lastShareTime = now;
                        let lastStartTime = now;
                        const workerAddress = msg.data.worker.split('.')[0];

                        /**
                         * PPLNT Data Structure Initialization
                         * Ensure tracking objects exist for this coin before
                         * attempting to record time-based share data.
                         */
                        if (!_lastShareTimes[msg.coin]) {
                            _lastShareTimes[msg.coin] = {};
                        }
                        if (!_lastStartTimes[msg.coin]) {
                            _lastStartTimes[msg.coin] = {};
                        }

                        /**
                         * Worker Join Detection
                         * Check if this is the first share from this worker in the
                         * current mining round. New workers get initialized with
                         * current timestamps for both start and last share times.
                         */
                        if (!_lastShareTimes[msg.coin][workerAddress] || !_lastStartTimes[msg.coin][workerAddress]) {
                            _lastShareTimes[msg.coin][workerAddress] = now;
                            _lastStartTimes[msg.coin][workerAddress] = now;
                            logger.debug('PPLNT', msg.coin, `Thread ${msg.thread}`, `${workerAddress} joined.`);
                        }

                        /**
                         * Historical Time Retrieval
                         * Load previously recorded timestamps for this worker
                         * to calculate time differentials for PPLNT scoring.
                         */
                        if (_lastShareTimes[msg.coin][workerAddress] != null && _lastShareTimes[msg.coin][workerAddress] > 0) {
                            lastShareTime = _lastShareTimes[msg.coin][workerAddress];
                            lastStartTime = _lastStartTimes[msg.coin][workerAddress];
                        }

                        const redisCommands = [];

                        /**
                         * Loyalty Detection and Time Tracking
                         *
                         * Determine if the worker has been continuously mining (loyal)
                         * or if they disconnected and reconnected. The 15-minute threshold
                         * (900 seconds) distinguishes between temporary network issues
                         * and actual disconnections.
                         *
                         * For loyal miners, accumulate their mining time in Redis for
                         * PPLNT payout calculations. For miners who reconnected after
                         * a long absence, reset their start time for the new session.
                         */
                        const lastShareTimeUnified = Math.max(redisCommands.push(['hget', `${msg.coin}:lastSeen`, workerAddress]), lastShareTime);
                        const timeChangeSec = roundTo(Math.max(now - lastShareTimeUnified, 0) / 1000, 4);

                        if (timeChangeSec < 900) {
                            // Loyal miner: accumulate mining time for PPLNT calculations
                            redisCommands.push(['hincrbyfloat', `${msg.coin}:shares:timesCurrent`, `${workerAddress}.${poolConfigs[msg.coin].poolId}`, timeChangeSec]);

                            connection.multi(redisCommands).exec((err, replies) => {
                                if (err) {
                                    logger.error('PPLNT', msg.coin, `Thread ${msg.thread}`, `Error with time share processor call to redis ${JSON.stringify(err)}`);
                                }
                            });
                        } else {
                            // Worker reconnected after extended absence: reset session timing
                            _lastStartTimes[workerAddress] = now;
                            logger.debug('PPLNT', msg.coin, `Thread ${msg.thread}`, `${workerAddress} re-joined.`);
                        }

                        /**
                         * Update Last Share Timestamp
                         * Record the current time as this worker's most recent
                         * share submission for future PPLNT calculations.
                         */
                        _lastShareTimes[msg.coin][workerAddress] = now;
                    }

                    /**
                     * Block Found - Reset PPLNT Round
                     * When a valid block is found, reset all PPLNT tracking data
                     * to start fresh for the next mining round. This ensures
                     * that only shares from the current round are considered
                     * for payouts.
                     */
                    if (msg.isValidBlock) {
                        _lastShareTimes[msg.coin] = {};
                        _lastStartTimes[msg.coin] = {};
                    }
                    break;
            }
        });
    };

    let i = 0;
    const spawnInterval = setInterval(() => {
        createPoolWorker(i);
        i++;
        if (i === numForks) {
            clearInterval(spawnInterval);
            logger.debug('Master', 'PoolSpawner', `Spawned ${Object.keys(poolConfigs).length} pool(s) on ${numForks} thread(s)`);
        }
    }, 250);

};

/**
 * Administrative CLI Listener
 *
 * Starts a TCP server that listens for administrative commands, allowing
 * runtime control of the mining pool without requiring process restarts.
 * This is essential for production deployments where uptime is critical.
 *
 * Supported Commands:
 *
 * - blocknotify <coin> <hash>
 *   Forwards block notifications from the coin daemon to all pool workers.
 *   Typically called by daemon's blocknotify script when new blocks are found.
 *
 * - coinswitch <coin> [switchKey]
 *   Initiates a coin switch operation for profit optimization. Can specify
 *   a particular switch configuration or let the system auto-select based
 *   on algorithm compatibility.
 *
 * - reloadpool <coin>
 *   Instructs pool workers to reload configuration for a specific coin
 *   without requiring a full restart. Useful for updating daemon connections
 *   or pool-specific settings.
 *
 * Security Note: The CLI listener only binds to the configured server address
 * (default: 127.0.0.1) and should not be exposed to untrusted networks.
 *
 * @see {@link CliListener} For detailed command protocol and usage
 */
const startCliListener = function () {

    const cliPort = portalConfig.cliPort;
    const cliServer = portalConfig.cliServer || '127.0.0.1';

    const listener = new CliListener(cliServer, cliPort);
    listener.on('log', (text) => {
        logger.debug('Master', 'CLI', text);
    }).on('command', (command, params, options, reply) => {

        switch (command) {
            case 'blocknotify':
                Object.keys(cluster.workers).forEach((id) => {
                    cluster.workers[id].send({ type: 'blocknotify', coin: params[0], hash: params[1] });
                });
                reply('Pool workers notified');
                break;
            case 'coinswitch':
                processCoinSwitchCommand(params, options, reply);
                break;
            case 'reloadpool':
                Object.keys(cluster.workers).forEach((id) => {
                    cluster.workers[id].send({ type: 'reloadpool', coin: params[0] });
                });
                reply(`reloaded pool ${params[0]}`);
                break;
            default:
                reply(`unrecognized command "${command}"`);
                break;
        }
    }).start();
};

/**
 * Coin Switch Command Processor
 *
 * Handles the 'coinswitch' CLI command by validating parameters and
 * coordinating the switch across all pool worker processes. This function
 * serves as a validation and routing layer - the actual mining target
 * switch logic is implemented within individual pool worker processes.
 *
 * Command Validation:
 * - Ensures required coin name is provided
 * - Validates switch key exists in portal configuration (if specified)
 * - Verifies algorithm compatibility between current pools and target coin
 * - Confirms target coin is actually configured and enabled
 *
 * Switch Modes:
 * 1. Explicit Switch Key: Use a pre-configured switch profile by name
 * 2. Algorithm-based: Auto-select switch profiles matching the algorithm
 *
 * The switch message is broadcast to all pool workers, which will then
 * coordinate the actual mining target change, difficulty adjustments,
 * and miner notifications.
 *
 * @param {Array<string>} params - Positional CLI parameters [coinName, switchKey?]
 * @param {Object} options - Named CLI options (e.g., { algorithm: 'sha256' })
 * @param {Function} reply - Callback function for CLI response
 */
const processCoinSwitchCommand = function (params, options, reply) {

    const logSystem = 'CLI';
    const logComponent = 'coinswitch';

    /**
     * Unified error handling for CLI responses.
     * Sends error message to CLI client and logs it for debugging.
     *
     * @param {string} msg - Error message to send and log
     */
    const replyError = function (msg) {
        reply(msg);
        logger.error(logSystem, logComponent, msg);
    };

    /**
     * Parameter Validation Phase
     * Ensure all required parameters are provided and valid before
     * attempting to process the coin switch request.
     */
    if (!params[0]) {
        replyError('Coin name required');
        return;
    }

    /**
     * Switch Mode Validation
     * The command supports two modes:
     * 1. Explicit switch key: params[1] specifies a pre-configured switch profile
     * 2. Algorithm-based: options.algorithm auto-selects compatible switch profiles
     */
    if (!params[1] && !options.algorithm) {
        replyError('If switch key is not provided then algorithm options must be specified');
        return;
    } else if (params[1] && !portalConfig.switching[params[1]]) {
        replyError(`Switch key not recognized: ${params[1]}`);
        return;
    } else if (options.algorithm && !Object.keys(portalConfig.switching).filter((s) => {
        return portalConfig.switching[s].algorithm === options.algorithm;
    })[0]) {
        replyError(`No switching options contain the algorithm ${options.algorithm}`);
        return;
    }

    /**
     * Target Coin Validation
     * Verify that the requested coin is actually configured and enabled
     * in the current pool configuration.
     */
    const messageCoin = params[0].toLowerCase();
    const newCoin = Object.keys(poolConfigs).filter((p) => {
        return p.toLowerCase() === messageCoin;
    })[0];

    if (!newCoin) {
        replyError(`Switch message to coin that is not recognized: ${messageCoin}`);
        return;
    }

    /**
     * Switch Profile Selection
     * Determine which switch profiles to activate based on the command mode:
     * - Explicit mode: Use the specified switch key
     * - Algorithm mode: Find all enabled switches matching the algorithm
     */
    const switchNames = [];

    if (params[1]) {
        // Explicit switch key provided
        switchNames.push(params[1]);
    } else {
        // Auto-select all enabled switches for the specified algorithm
        for (const name in portalConfig.switching) {
            if (portalConfig.switching[name].enabled && portalConfig.switching[name].algorithm === options.algorithm) {
                switchNames.push(name);
            }
        }
    }

    /**
     * Algorithm Compatibility Check & Switch Execution
     * For each selected switch profile, verify algorithm compatibility
     * between the switch configuration and target coin, then broadcast
     * the switch message to all worker processes.
     */
    switchNames.forEach((name) => {
        if (poolConfigs[newCoin].coin.algorithm !== portalConfig.switching[name].algorithm) {
            replyError(`Cannot switch a ${portalConfig.switching[name].algorithm
            } algo pool to coin ${newCoin} with ${poolConfigs[newCoin].coin.algorithm} algo`);
            return;
        }

        /**
         * Broadcast switch command to all worker processes.
         * Workers will coordinate the actual mining target change,
         * update difficulty settings, and notify connected miners.
         */
        Object.keys(cluster.workers).forEach((id) => {
            cluster.workers[id].send({ type: 'coinswitch', coin: newCoin, switchName: name });
        });
    });

    reply('Switch message sent to pool workers');

};

/**
 * Payment Processor Worker Management
 *
 * Spawns a dedicated payment processor worker if any pool has payment
 * processing enabled. The payment processor is responsible for:
 *
 * - Calculating miner payouts based on share contributions and PPLNT data
 * - Generating and sending cryptocurrency transactions to miner wallets
 * - Managing payment thresholds and scheduling
 * - Handling payment failures and retry logic
 * - Updating balance records and payment history
 *
 * The payment processor runs as a single background worker to ensure
 * transaction consistency and avoid double-payments. It periodically
 * processes payouts according to the configured schedule.
 *
 * Process Lifecycle:
 * - Only spawns if at least one pool has payment processing enabled
 * - Automatically respawns if the worker process crashes
 * - Receives serialized pool configurations for payment settings
 *
 * @see {@link PaymentProcessor} For detailed payment processing logic
 */
const startPaymentProcessor = function () {

    /**
     * Check if any pool has payment processing enabled before spawning
     * the dedicated payment worker process.
     */
    let enabledForAny = false;
    for (const pool in poolConfigs) {
        const p = poolConfigs[pool];
        const enabled = p.enabled && p.paymentProcessing && p.paymentProcessing.enabled;
        if (enabled) {
            enabledForAny = true;
            break;
        }
    }

    if (!enabledForAny) {
        return;
    }

    const worker = cluster.fork({
        workerType: 'paymentProcessor',
        pools: JSON.stringify(poolConfigs)
    });

    /**
     * Payment processor crash recovery: automatically respawn the worker
     * after a brief delay to ensure payment processing continuity.
     */
    worker.on('exit', (code, signal) => {
        logger.error('Master', 'Payment Processor', 'Payment processor died, spawning replacement...');
        setTimeout(() => {
            startPaymentProcessor(poolConfigs);
        }, 2000);
    });
};

/**
 * Website Worker Management
 *
 * Spawns the web interface worker when website functionality is enabled
 * in the portal configuration. The website worker provides:
 *
 * - Public-facing web interface for miners and administrators
 * - RESTful API endpoints for pool statistics and miner data
 * - Real-time WebSocket connections for live updates
 * - Administrative dashboard for pool management
 * - Mobile-responsive interface for monitoring on-the-go
 *
 * The website worker runs independently from pool workers to ensure
 * web interface availability even during high mining loads or pool
 * worker restarts.
 *
 * Configuration:
 * - Receives both pool configurations and portal settings
 * - Website-specific settings (ports, SSL, etc.) from portalConfig
 * - Pool data for statistics and monitoring displays
 *
 * @see {@link Website} For web server implementation details
 */
const startWebsite = function () {

    if (!portalConfig.website.enabled) {
        return;
    }

    const worker = cluster.fork({
        workerType: 'website',
        pools: JSON.stringify(poolConfigs),
        portalConfig: JSON.stringify(portalConfig)
    });

    /**
     * Website worker crash recovery: automatically respawn the web server
     * to maintain interface availability for miners and administrators.
     */
    worker.on('exit', (code, signal) => {
        logger.error('Master', 'Website', 'Website process died, spawning replacement...');
        setTimeout(() => {
            startWebsite(portalConfig, poolConfigs);
        }, 2000);
    });
};

/**
 * Application Bootstrap and Initialization
 *
 * Main entry point that orchestrates the complete mining pool startup sequence.
 * This IIFE (Immediately Invoked Function Expression) executes the initialization
 * in a carefully ordered sequence to ensure proper system startup.
 *
 * Initialization Sequence:
 *
 * 1. **Pool Configuration Loading** (`buildPoolConfigs`)
 *    - Scans pool_configs/ directory for enabled pool definitions
 *    - Validates port conflicts and coin name uniqueness
 *    - Merges pool-specific settings with portal defaults
 *    - Filters out pools with unsupported algorithms
 *
 * 2. **Pool Worker Spawning** (`spawnPoolWorkers`)
 *    - Establishes Redis connection for cross-process communication
 *    - Calculates optimal worker count based on clustering configuration
 *    - Spawns multiple pool worker processes to handle miner connections
 *    - Sets up IPC handlers for worker coordination (bans, share tracking)
 *
 * 3. **Background Service Startup**
 *    - Payment Processor: Handles automated miner payouts (if enabled)
 *    - Website: Serves web interface and API endpoints (if enabled)
 *    - Profit Switcher: Automated profit optimization (if enabled)
 *
 * 4. **CLI Listener** (`startCliListener`)
 *    - Enables runtime administration via TCP commands
 *    - Supports block notifications, coin switching, pool reloading
 *
 * This initialization approach ensures:
 * - Dependencies are available before dependent services start
 * - Core mining functionality is prioritized over auxiliary features
 * - Failed initialization steps prevent potentially problematic partial startup
 * - All worker processes have access to validated configurations
 *
 * @see {@link buildPoolConfigs} Pool configuration validation and loading
 * @see {@link spawnPoolWorkers} Worker process management and IPC setup
 */
(function init() {

    poolConfigs = buildPoolConfigs();

    spawnPoolWorkers();

    startPaymentProcessor();

    startWebsite();

    startCliListener();

})();
