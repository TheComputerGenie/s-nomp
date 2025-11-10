const events = require('events');

const PoolLogger = require('../PoolLogger.js');

const varDiff = require('./varDiff.js');
const daemon = require('./daemon.js');
const peer = require('./peer.js');
const stratum = require('./stratum.js');
const jobManager = require('./jobManager.js');
const algos = require('./algoProperties.js');
const util = require('../utils/util.js');

/*process.on('uncaughtException', function(err) {
 console.log(err.stack);
 throw err;
 });*/

/**
 * @fileoverview Pool class for managing cryptocurrency mining pool operations.
 * This is the core component that orchestrates daemon communication, stratum server,
 * job management, peer-to-peer networking, and block processing for mining pools.
 *
 * @author v-nomp Community
 * @version 1.0.0
 */

/**
 * Pool class - Main mining pool orchestrator
 *
 * This class manages all aspects of a cryptocurrency mining pool including:
 * - Communication with cryptocurrency daemons (coin nodes)
 * - Stratum mining protocol server for miners
 * - Block template generation and job management
 * - Share processing and validation
 * - Variable difficulty adjustment
 * - Peer-to-peer networking for block notifications
 * - Payment processing coordination
 *
 * @class Pool
 * @extends {EventEmitter}
 * @param {Object} options - Pool configuration options
 * @param {Object} options.coin - Coin-specific configuration (name, symbol, algorithm, etc.)
 * @param {Object} options.ports - Port configurations for different difficulty levels
 * @param {Array} options.daemons - Array of daemon connection configurations
 * @param {Object} options.rewardRecipients - Fee recipients and percentages
 * @param {string} options.address - Pool's payout address
 * @param {Object} [options.p2p] - Peer-to-peer networking configuration
 * @param {Object} [options.logger] - Logger configuration
 * @param {number} [options.blockRefreshInterval] - Block polling interval in ms
 * @param {Function} authorizeFn - Worker authorization callback function
 *
 * @fires Pool#started - When pool is fully initialized and ready
 * @fires Pool#share - When a share is submitted (valid or invalid)
 * @fires Pool#difficultyUpdate - When worker difficulty is adjusted
 * @fires Pool#banIP - When an IP should be banned for malicious behavior
 *
 * @example
 * const pool = new Pool({
 *   coin: { name: 'Bitcoin', symbol: 'BTC', algorithm: 'sha256' },
 *   ports: { 3333: { diff: 1 } },
 *   daemons: [{ host: 'localhost', port: 8332, user: 'rpc', password: 'pass' }],
 *   address: '1PoolAddressHere...'
 * }, (ip, port, workerName, password) => {
 *   // Authorization logic
 *   return { authorized: true, disconnect: false };
 * });
 */
const pool = module.exports = function pool(options, authorizeFn) {

    /** @type {Object} Pool configuration options */
    this.options = options;

    /** @type {PoolLogger} Logger instance for pool operations */
    const logger = new PoolLogger(this.options.logger || {});

    /** @type {string} Log system identifier */
    const logSystem = ' Pool ';

    /** @type {string} Log component (coin name) */
    const logComponent = options.coin.name;

    /** @type {string} Fork identifier for multi-process setups */
    const forkId = process.env.forkId || '0';

    /** @type {string} Log subcategory with thread number */
    const logSubCat = `Thread ${parseInt(forkId) + 1}`;

    /** @type {Pool} Reference to this instance */
    const _this = this;

    /** @type {NodeJS.Timeout|null} Block polling interval timer */
    let blockPollingIntervalId;

    // Validate that the specified algorithm is supported
    if (!algos.hasAlgorithm(options.coin.algorithm)) {
        logger.error(logSystem, logComponent, logSubCat, `The ${options.coin.algorithm} hashing algorithm is not supported.`);
        throw new Error();
    }

    /**
     * Starts the mining pool by initializing all components in the correct order.
     * This method orchestrates the entire pool startup sequence:
     * 1. Variable difficulty setup
     * 2. API initialization
     * 3. Daemon interface setup
     * 4. Coin data detection
     * 5. Recipients setup
     * 6. Job manager initialization
     * 7. Blockchain sync verification
     * 8. Initial job creation
     * 9. Block polling setup
     * 10. P2P peer setup
     * 11. Stratum server startup
     *
     * @method start
     * @memberof Pool
     * @fires Pool#started - When all initialization is complete
     */
    this.start = function () {
        // Initialize components in dependency order - each step builds on the previous

        // Step 1: Setup variable difficulty algorithms for all configured ports
        SetupVarDiff();

        // Step 2: Initialize API endpoints if configured (optional component)
        SetupApi();

        // Step 3: Establish daemon connections - this is critical as all other components depend on it
        SetupDaemonInterface(() => {
            // Step 4: Gather coin-specific information from daemon (network type, reward structure, etc.)
            DetectCoinData(() => {
                // Step 5: Configure fee recipients and calculate total pool fees
                SetupRecipients();

                // Step 6: Initialize job manager for creating and managing mining work
                SetupJobManager();

                // Step 7: Wait for blockchain to be fully synced before accepting miners
                OnBlockchainSynced(() => {
                    // Step 8: Generate the first mining job to validate everything works
                    GetFirstJob(() => {
                        // Step 9: Setup block polling for backup block notifications
                        SetupBlockPolling();

                        // Step 10: Initialize P2P networking for faster block notifications
                        SetupPeer();

                        // Step 11: Start the stratum server to accept miner connections
                        StartStratumServer(() => {
                            // Step 12: Display pool information and emit started event
                            OutputPoolInfo();
                            _this.emit('started');
                        });
                    });
                });
            });
        });
    };

    /**
     * Gets the first job template and validates port difficulty settings.
     * This function ensures the pool can generate work and warns about
     * port difficulties that are higher than the current network difficulty.
     *
     * @function GetFirstJob
     * @private
     * @param {Function} finishedCallback - Callback to execute when first job is ready
     */
    function GetFirstJob(finishedCallback) {
        // Attempt to get the first block template to ensure daemon is responsive
        // and we can generate valid mining jobs before accepting connections
        util.getBlockTemplate(_this.daemon, options, _this.jobManager, logger, logSystem, logComponent, logSubCat, (error, result) => {
            if (error) {
                // Critical failure - if we can't get a block template, the pool cannot function
                logger.error(logSystem, logComponent, logSubCat, 'Error with getblocktemplate on creating first job, server cannot start');
                return;
            }

            // Validate port difficulty configurations against current network difficulty
            const portWarnings = [];

            // Get network difficulty adjusted for this algorithm's multiplier
            const networkDiffAdjusted = options.initStats.difficulty;

            // Check each configured port's minimum difficulty
            Object.keys(options.ports).forEach((port) => {
                const portDiff = options.ports[port].diff;

                // Warn if port difficulty is higher than network difficulty
                // This means miners on this port might have difficulty finding valid shares
                if (networkDiffAdjusted < portDiff) {
                    portWarnings.push(`port ${port} w/ diff ${portDiff}`);
                }
            });

            // Only show warnings from the main process to avoid log spam in multi-process setups
            if (portWarnings.length > 0 && (!process.env.forkId || process.env.forkId === '0')) {
                const warnMessage = `Network diff of ${networkDiffAdjusted} is lower than ${portWarnings.join(' and ')}`;
                logger.warn(logSystem, logComponent, logSubCat, warnMessage);
            }

            // First job validation complete - proceed with pool startup
            finishedCallback();
        });
    }

    /**
     * Outputs comprehensive pool information to the log.
     * Displays startup information including network status, block info,
     * difficulty, hash rate, and configuration details. Only the main
     * thread (forkId 0) displays this information to avoid log flooding.
     *
     * @function OutputPoolInfo
     * @private
     */
    function OutputPoolInfo() {
        // Create formatted startup message with coin identification
        const startMessage = `\r\n\t\t\t\t\t\tStratum Pool Server Started for ${options.coin.name
        } [${options.coin.symbol.toUpperCase()}] {${options.coin.algorithm}}`;

        // In multi-process setups, only show detailed info from main process (forkId 0)
        // Other processes just log a simple debug message to avoid cluttered logs
        if (process.env.forkId && process.env.forkId !== '0') {
            logger.debug(logSystem, logComponent, logSubCat, startMessage);
            return;
        }

        // Build comprehensive pool information display
        const infoLines = [startMessage,
            // Network information
            `Network Connected:\t${options.testnet ? 'Testnet' : 'Mainnet'}`,
            `Detected Reward Type:\t${options.coin.reward}`, // POW or POS

            // Current blockchain status
            `Current Block Height:\t${_this.jobManager.currentJob.rpcData.height}`,
            `Current Block Diff:\t${_this.jobManager.currentJob.difficulty * algos.getMultiplier(options.coin.algorithm)}`,

            // Network health indicators
            `Current Connect Peers:\t${options.initStats.connections}`,
            `Network Difficulty:\t${options.initStats.difficulty}`,
            `Network Hash Rate:\t${util.getReadableHashRateString(options.initStats.networkHashRate, options.coin.algorithm)}`,

            // Pool configuration
            `Stratum Port(s):\t${_this.options.initStats.stratumPorts.join(', ')}`,
            `Pool Fee Percent:\t${_this.options.feePercent}%`
        ];

        // Add block polling information if enabled
        if (typeof options.blockRefreshInterval === 'number' && options.blockRefreshInterval > 0) {
            infoLines.push(`Block polling every:\t${options.blockRefreshInterval} ms`);
        }

        // Output all information as a single formatted log entry
        logger.info(logSystem, logComponent, logSubCat, infoLines.join('\n\t\t\t\t\t\t'));
    }

    /**
     * Waits for the blockchain to be fully synchronized before proceeding.
     * Continuously checks if the daemon is synced by attempting to get a block template.
     * Shows sync progress by comparing local block count with peers' highest block.
     *
     * @function OnBlockchainSynced
     * @private
     * @param {Function} syncedCallback - Callback to execute when blockchain is synced
     */
    function OnBlockchainSynced(syncedCallback) {
        // Inner function to check if daemon is synchronized with the network
        const checkSynced = function (displayNotSynced) {
            // Use getblocktemplate to check sync status - this fails with error -9 when not synced
            _this.daemon.cmd('getblocktemplate', [], (results) => {
                // Check if all daemon instances are synced
                // A daemon is considered synced if getblocktemplate doesn't return error code -9
                const synced = results.every((r) => {
                    return !r.error || r.error.code !== -9; // -9 = "Bitcoin is downloading blocks..."
                });

                if (synced) {
                    // All daemons are synced - proceed with pool startup
                    syncedCallback();
                } else {
                    // Still syncing - display message if this is the first check
                    if (displayNotSynced) {
                        displayNotSynced();
                    }

                    // Schedule next sync check in 5 seconds
                    setTimeout(checkSynced, 5000);

                    // Only main process shows sync progress to avoid log spam
                    if (!process.env.forkId || process.env.forkId === '0') {
                        generateProgress();
                    }
                }
            });
        };
        checkSynced(() => {
            //Only let the first fork show synced status or the log wil look flooded with it
            if (!process.env.forkId || process.env.forkId === '0') {
                logger.error(logSystem, logComponent, logSubCat, 'Daemon is still syncing with network (download blockchain) - server will be started once synced');
            }
        });

        // Inner function to display blockchain sync progress
        function generateProgress() {
            // Get current block count from daemon
            _this.daemon.cmd('getinfo', [], (results) => {
                // Find the daemon instance with the highest block count
                // (in case of multiple daemons, some might be slightly ahead)
                const blockCount = results.sort((a, b) => {
                    return b.response.blocks - a.response.blocks;
                })[0].response.blocks;

                // Get peer information to determine the target block height
                _this.daemon.cmd('getpeerinfo', [], (results) => {
                    const peers = results[0].response;

                    // Find the peer with the highest starting height
                    // This represents the current network tip
                    const totalBlocks = peers.sort((a, b) => {
                        return b.startingheight - a.startingheight;
                    })[0].startingheight;

                    // Calculate and display sync progress percentage
                    const percent = (blockCount / totalBlocks * 100).toFixed(2);
                    logger.warn(logSystem, logComponent, logSubCat, `Downloaded ${percent}% of blockchain from ${peers.length} peers`);
                });
            });
        };

    }

    /**
     * Initializes the API component if configured.
     * The API provides endpoints for pool statistics, worker information,
     * and administrative functions. This is optional and only starts if
     * an API object with a start method is provided in options.
     *
     * @function SetupApi
     * @private
     */
    function SetupApi() {
        if (typeof (options.api) !== 'object' || typeof (options.api.start) !== 'function') {
        } else {
            options.api.start(_this);
        }
    }

    /**
     * Sets up peer-to-peer networking for faster block notifications.
     * P2P allows the pool to receive block notifications directly from
     * the network instead of relying solely on polling. This reduces
     * latency and improves pool responsiveness to new blocks.
     *
     * @function SetupPeer
     * @private
     */
    function SetupPeer() {
        if (!options.p2p || !options.p2p.enabled) {
            return;
        }

        if (options.testnet && !options.coin.peerMagicTestnet) {
            logger.error(logSystem, logComponent, logSubCat, 'p2p cannot be enabled in testnet without peerMagicTestnet set in coin configuration');
            return;
        } else if (!options.coin.peerMagic) {
            logger.error(logSystem, logComponent, logSubCat, 'p2p cannot be enabled without peerMagic set in coin configuration');
            return;
        }

        _this.peer = new peer(options);
        _this.peer.on('connected', () => {
            logger.debug(logSystem, logComponent, logSubCat, 'p2p connection successful');
        }).on('connectionRejected', () => {
            logger.error(logSystem, logComponent, logSubCat, 'p2p connection failed - rejected by peer');
        }).on('disconnected', () => {
            logger.warn(logSystem, logComponent, logSubCat, 'p2p peer node disconnected - attempting reconnection...');
        }).on('connectionFailed', (e) => {
            logger.error(logSystem, logComponent, logSubCat, 'p2p connection failed - likely incorrect host or port');
        }).on('socketError', (e) => {
            logger.error(logSystem, logComponent, logSubCat, `p2p had a socket error ${JSON.stringify(e)}`);
        }).on('error', (msg) => {
            logger.warn(logSystem, logComponent, logSubCat, `p2p had an error ${msg}`);
        }).on('blockFound', (hash) => {
            _this.processBlockNotify(hash, 'p2p');
        });
    }

    /**
     * Initializes variable difficulty adjustment for each configured port.
     * Variable difficulty automatically adjusts mining difficulty for
     * individual miners based on their hash rate to maintain optimal
     * share submission frequency (typically every 10-15 seconds).
     *
     * @function SetupVarDiff
     * @private
     */
    function SetupVarDiff() {
        // Initialize variable difficulty container for all ports
        _this.varDiff = {};

        // Iterate through all configured ports
        Object.keys(options.ports).forEach((port) => {
            // Only setup variable difficulty if configured for this port
            if (options.ports[port].varDiff) {
                // Create and configure variable difficulty instance for this port
                // This will automatically adjust miner difficulty based on their hash rate
                _this.setVarDiff(port, options.ports[port].varDiff);
            }
        });
    }

    /**
     * Configures reward recipients and calculates total pool fee percentage.
     * Sets up the addresses and percentages for pool fees, which are
     * deducted from block rewards before distributing to miners.
     * Recipients typically include pool operator fees, development funds, etc.
     *
     * @function SetupRecipients
     * @private
     */
    function SetupRecipients() {
        // Initialize recipients array and fee tracking
        const recipients = [];
        options.feePercent = 0;

        // Ensure rewardRecipients exists (could be undefined in config)
        options.rewardRecipients = options.rewardRecipients || {};

        // Process each configured fee recipient
        for (const r in options.rewardRecipients) {
            const percent = options.rewardRecipients[r];

            // Create recipient object with address and fee percentage
            const rObj = {
                percent: percent,  // Percentage of block reward (e.g., 1.5 for 1.5%)
                address: r         // Payout address for this recipient
            };
            recipients.push(rObj);

            // Accumulate total fee percentage
            options.feePercent += percent;
        }

        // Warn if no fees are configured (unusual for a pool)
        if (recipients.length === 0) {
            logger.error(logSystem, logComponent, logSubCat, 'No rewardRecipients have been setup which means no fees will be taken');
        }

        // Store processed recipients for use by payment processor
        options.recipients = recipients;
    }

    /** @type {string|false} Tracks last submitted block hex to prevent duplicates */
    let jobManagerLastSubmitBlockHex = false;

    /**
     * Initializes the job manager for handling block templates and mining jobs.
     * The job manager is responsible for:
     * - Creating mining jobs from block templates
     * - Processing submitted shares
     * - Validating solutions
     * - Managing job updates and broadcasts
     *
     * Sets up event handlers for:
     * - newBlock: When a new block template is received
     * - updatedBlock: When an existing template is updated
     * - share: When a miner submits a share
     * - log: For job manager logging
     *
     * @function SetupJobManager
     * @private
     */
    function SetupJobManager() {

        _this.jobManager = new jobManager(options);

        _this.jobManager.on('newBlock', (blockTemplate) => {
            //Check if stratumServer has been initialized yet
            if (_this.stratumServer) {
                _this.stratumServer.broadcastMiningJobs(blockTemplate.getJobParams());
            }
        }).on('updatedBlock', (blockTemplate, cleanjob) => {
            //Check if stratumServer has been initialized yet
            if (_this.stratumServer) {
                const job = blockTemplate.getJobParams();
                job[7] = cleanjob;
                _this.stratumServer.broadcastMiningJobs(job);
            }
        }).on('share', (shareData, blockHex) => {
            // Process a submitted share from a miner
            // shareData contains all information about the share submission
            // blockHex is present only if this share solves a block

            // Determine if the share is valid (no processing errors)
            const isValidShare = !shareData.error;

            // Determine if this share solves a block (blockHex provided)
            let isValidBlock = !!blockHex;

            // Function to emit the final share event
            const emitShare = function () {
                _this.emit('share', isValidShare, isValidBlock, shareData);
            };

            // Handle different share types
            if (!isValidBlock) {
                // Regular share - emit immediately
                emitShare();
            } else {
                // Potential block solution - need to submit and verify

                // Prevent duplicate block submissions (can happen with network latency)
                if (jobManagerLastSubmitBlockHex === blockHex) {
                    logger.warn(logSystem, logComponent, logSubCat, `Warning, ignored duplicate submit block ${blockHex}`);
                } else {
                    // Track this block hex to prevent duplicates
                    jobManagerLastSubmitBlockHex = blockHex;

                    // Submit the block to the network
                    util.submitBlock(_this.daemon, options, logger, logSystem, logComponent, logSubCat, shareData.height, blockHex, () => {
                        // Handle different block types
                        if (!shareData.blockOnlyPBaaS) {
                            // Standard block - verify acceptance via RPC
                            util.checkBlockAccepted(_this.daemon, logger, logSystem, logComponent, logSubCat, shareData.blockHash, (isAccepted, tx) => {
                                // Update block status based on network acceptance
                                isValidBlock = isAccepted === true;

                                if (isValidBlock === true) {
                                    // Block accepted - store transaction hash
                                    shareData.txHash = tx;
                                } else {
                                    // Block rejected - store error information
                                    shareData.error = tx;
                                }

                                // Emit the share event with final status
                                emitShare();

                                // Request new block template after successful submission
                                util.getBlockTemplate(_this.daemon, options, _this.jobManager, logger, logSystem, logComponent, logSubCat, (error, result, foundNewBlock) => {
                                    if (foundNewBlock) {
                                        logger.debug(logSystem, logComponent, logSubCat, 'Block notification via RPC after block submission');
                                    }
                                });
                            });
                        } else {
                            // PBaaS-only block - emit immediately (no verification needed)
                            emitShare();
                        }
                    });
                }
            }
        }).on('log', (severity, message) => {
            logger[severity](logSystem, logComponent, logSubCat, message);
        });
    }

    /**
     * Establishes connection interface to cryptocurrency daemon(s).
     * The daemon interface handles all RPC communication with coin daemons,
     * including block templates, share validation, and network information.
     * Supports multiple daemon instances for redundancy and load balancing.
     *
     * @function SetupDaemonInterface
     * @private
     * @param {Function} finishedCallback - Callback when daemon connection is established
     */
    function SetupDaemonInterface(finishedCallback) {

        if (!Array.isArray(options.daemons) || options.daemons.length < 1) {
            logger.error(logSystem, logComponent, logSubCat, 'No daemons have been configured - pool cannot start');
            return;
        }

        _this.daemon = new daemon.interface(options.daemons, ((severity, message) => {
            logger[severity](logSystem, logComponent, logSubCat, message);
        }));

        _this.daemon.once('online', () => {
            finishedCallback();

        }).on('connectionFailed', (error) => {
            logger.error(logSystem, logComponent, logSubCat, `Failed to connect daemon(s): ${JSON.stringify(error)}`);

        }).on('error', (message) => {
            logger.error(logSystem, logComponent, logSubCat, message);

        });

        _this.daemon.init();
    }

    /**
     * Detects and validates coin-specific data from the daemon.
     * Performs initial RPC calls to gather essential information:
     * - Address validation (ensures pool payout address is valid)
     * - Network difficulty and mining info
     * - Blockchain info (height, connections, protocol version)
     * - Block submission method detection
     * - Reward type detection (POW vs POS)
     *
     * For POS coins, validates that the address is owned by the wallet
     * (required for pubkey inclusion in coinbase transactions).
     *
     * @function DetectCoinData
     * @private
     * @param {Function} finishedCallback - Callback when coin data detection is complete
     */
    function DetectCoinData(finishedCallback) {
        // Batch RPC calls to gather essential coin and network information
        const batchRpcCalls = [
            ['validateaddress', [options.address]],  // Validate pool payout address
            ['getdifficulty', []],                   // Get current network difficulty
            ['getinfo', []],                         // Get general blockchain info
            ['getmininginfo', []],                   // Get mining-specific info
            ['submitblock', []]                      // Test if submitblock method exists
        ];

        // Execute all RPC calls simultaneously for efficiency
        _this.daemon.batchCmd(batchRpcCalls, (error, results) => {
            if (error || !results) {
                logger.error(logSystem, logComponent, logSubCat, `Could not start pool, error with init batch RPC call: ${JSON.stringify(error)}`);
                return;
            }

            // Parse results into a more accessible format
            const rpcResults = {};

            for (let i = 0; i < results.length; i++) {
                const rpcCall = batchRpcCalls[i][0];
                const r = results[i];

                // Store either the successful result or the error
                rpcResults[rpcCall] = r.result || r.error;

                // Validate that all required calls succeeded (except submitblock test)
                if (rpcCall !== 'submitblock' && (r.error || !r.result)) {
                    logger.error(logSystem, logComponent, logSubCat, `Could not start pool, error with init RPC ${rpcCall} - ${JSON.stringify(r.error)}`);
                    return;
                }
            }

            // Validate the pool payout address
            if (!rpcResults.validateaddress.isvalid) {
                logger.error(logSystem, logComponent, logSubCat, 'Daemon reports address is not valid');
                return;
            }

            // Detect coin reward mechanism (Proof of Work vs Proof of Stake)
            if (isNaN(rpcResults.getdifficulty) && 'proof-of-stake' in rpcResults.getdifficulty) {
                // Difficulty object with proof-of-stake field indicates POS coin
                options.coin.reward = 'POS';
            } else {
                // Numeric difficulty indicates POW coin
                options.coin.reward = 'POW';
            }

            // Special validation for POS coins
            /* POS coins must include the pubkey in coinbase transactions
               The pubkey is only provided if the address is owned by the wallet */
            if (options.coin.reward === 'POS' && typeof (rpcResults.validateaddress.pubkey) === 'undefined') {
                logger.error(logSystem, logComponent, logSubCat, 'The address provided is not from the daemon wallet - this is required for POS coins.');
                return;
            }

            // Convert pool address to script format for coinbase transactions
            options.poolAddressScript = (function () {
                return util.addressToScript(rpcResults.validateaddress.address);
            })();

            // Store network and daemon information
            options.testnet = rpcResults.getinfo.testnet;                    // Testnet vs Mainnet
            options.protocolVersion = rpcResults.getinfo.protocolversion;   // Protocol version for compatibility
            options.startHeight = rpcResults.getinfo.blocks;                // Starting block height

            // Initialize statistics for pool info display
            options.initStats = {
                connections: rpcResults.getinfo.connections,                                           // Peer connections
                difficulty: rpcResults.getinfo.difficulty * algos.getMultiplier(options.coin.algorithm), // Adjusted difficulty
                networkHashRate: rpcResults.getmininginfo.networkhashps                               // Network hash rate
            };

            // Detect which block submission method the daemon supports
            if (rpcResults.submitblock.message === 'Method not found') {
                // Daemon doesn't support submitblock - use getblocktemplate
                options.hasSubmitMethod = false;
            } else if (rpcResults.submitblock.code === -1) {
                // Expected error code when calling submitblock without parameters
                options.hasSubmitMethod = true;
            } else {
                // Unexpected response - cannot determine submission method
                logger.error(logSystem, logComponent, logSubCat, `Could not detect block submission RPC method, ${JSON.stringify(results)}`);
                return;
            }

            // Coin data detection complete
            finishedCallback();
        });
    }

    /**
     * Starts the Stratum mining protocol server.
     * The Stratum server handles all miner connections and communication:
     * - Worker authentication and subscription
     * - Mining job distribution
     * - Share submission processing
     * - Difficulty adjustments
     * - Connection management and banning
     *
     * Sets up extensive event handlers for:
     * - Server lifecycle events (started, broadcastTimeout)
     * - Client connection events
     * - Mining protocol events (subscription, share submission)
     * - Error and security events (malformed messages, flooding, bans)
     *
     * @function StartStratumServer
     * @private
     * @param {Function} finishedCallback - Callback when stratum server is ready
     */
    function StartStratumServer(finishedCallback) {
        // Create the stratum server instance with pool options and authorization function
        // The authorizeFn allows custom worker authentication logic
        // Pass the algorithm name for proper difficulty calculation
        const stratumOptions = { ...options, algorithm: options.coin.algorithm };
        _this.stratumServer = new stratum.Server(stratumOptions, authorizeFn, algos);

        // === SERVER LIFECYCLE EVENTS ===

        _this.stratumServer.on('started', () => {
            // Server successfully started and is listening on configured ports

            // Store active stratum ports for pool information display
            options.initStats.stratumPorts = Object.keys(options.ports);

            // Send initial mining job to any early-connecting miners
            // This ensures miners immediately receive work upon connection
            _this.stratumServer.broadcastMiningJobs(_this.jobManager.currentJob.getJobParams());

            // Signal that stratum server initialization is complete
            finishedCallback();
        }).on('broadcastTimeout', () => {
            // Triggered when no new blocks have been found for jobRebroadcastTimeout seconds
            // This prevents miners from working on stale transactions
            logger.debug(logSystem, logComponent, logSubCat, `No new blocks for ${options.jobRebroadcastTimeout} seconds - updating transactions & rebroadcasting work`);

            // Request fresh block template to update transaction set
            util.getBlockTemplate(_this.daemon, options, _this.jobManager, logger, logSystem, logComponent, logSubCat, (error, rpcData, processedBlock) => {
                // Handle errors or already processed blocks
                if (error || processedBlock) {
                    return;
                }

                // Verify we received valid template data
                if (!rpcData) {
                    return;
                }

                // Prevent duplicate processing if jobManager already handled this template
                // This can happen if multiple events trigger template requests simultaneously
                if (_this.jobManager.isRpcDataProcessed && _this.jobManager.isRpcDataProcessed(rpcData)) {
                    return;
                }

                // Update current job with fresh transactions and broadcast to miners
                // This will trigger a 'updatedBlock' event and send new work to all miners
                _this.jobManager.updateCurrentJob(rpcData);
            });

        }).on('client.connected', (client) => {
            // === NEW CLIENT CONNECTION PROCESSING ===
            // A miner has successfully connected to the stratum server

            // Check if variable difficulty is configured for this client's port
            if (typeof (_this.varDiff[client.socket.localPort]) !== 'undefined') {
                // Register client with variable difficulty manager
                // This will monitor the client's share submission rate and adjust difficulty accordingly
                _this.varDiff[client.socket.localPort].manageClient(client);
            }

            // === CLIENT EVENT HANDLERS ===
            // Set up event listeners for this specific client connection

            client.on('difficultyChanged', (diff) => {
                // Variable difficulty system has adjusted this client's difficulty
                // Emit pool-level event for external monitoring/statistics
                _this.emit('difficultyUpdate', client.workerName, diff);

            }).on('subscription', function (params, resultCallback) {
                // === MINING SUBSCRIPTION SETUP ===
                // Client is requesting to subscribe for mining work (stratum method: mining.subscribe)

                // Generate unique extra nonce for this subscription
                // Extra nonce ensures each miner works on unique block variants
                const extraNonce = _this.jobManager.extraNonceCounter.next();

                // Respond with subscription details (subscription ID, extra nonce 1, extra nonce 2 size)
                resultCallback(null,
                    extraNonce,  // subscription ID and extra nonce 1
                    extraNonce   // extra nonce 2 size (same value for simplicity)
                );

                // === INITIAL DIFFICULTY ASSIGNMENT ===
                // Set starting difficulty based on port configuration
                if (typeof (options.ports[client.socket.localPort]) !== 'undefined' && options.ports[client.socket.localPort].diff) {
                    // Use configured difficulty for this port
                    this.sendDifficulty(options.ports[client.socket.localPort].diff);
                } else {
                    // Fallback to default difficulty if not configured
                    this.sendDifficulty(8);
                }

                // === SEND INITIAL MINING JOB ===
                // Immediately provide work to the newly subscribed miner
                this.sendMiningJob(_this.jobManager.currentJob.getJobParams());

            }).on('submit', (params, resultCallback) => {
                // === SHARE SUBMISSION PROCESSING ===
                // Miner is submitting a potential solution (stratum method: mining.submit)

                // Process the submitted share through job manager
                // This validates the share, checks difficulty, and determines if it solves a block
                const result = _this.jobManager.processShare(
                    params.jobId,               // Job identifier from the mining job
                    client.previousDifficulty,  // Previous difficulty (for vardiff calculations)
                    client.difficulty,          // Current difficulty target
                    client.extraNonce1,         // Client's unique extra nonce
                    params.extraNonce2,         // Miner-generated extra nonce
                    params.nTime,               // Timestamp from miner
                    params.nonce,               // The solution nonce
                    client.remoteAddress,       // Miner's IP address
                    client.socket.localPort,    // Port used for connection
                    params.name,                // Worker name
                    params.soln                 // Solution data (for Equihash-based algos)
                );

                // Send response back to miner (true for accepted shares, error for rejected)
                resultCallback(result.error, result.result ? true : null);

            }).on('malformedMessage', (message) => {
                // === ERROR HANDLING: MALFORMED MESSAGES ===
                // Client sent invalid JSON-RPC or non-compliant stratum message
                // This could indicate a buggy miner, attack attempt, or network corruption
                logger.warn(logSystem, logComponent, logSubCat, `Malformed message from ${client.getLabel()}: ${message}`);

            }).on('socketError', (err) => {
                // === ERROR HANDLING: SOCKET ERRORS ===
                // Low-level network errors (connection reset, timeout, etc.)
                logger.warn(logSystem, logComponent, logSubCat, `Socket error from ${client.getLabel()}: ${JSON.stringify(err)}`);

            }).on('socketTimeout', (reason) => {
                // === ERROR HANDLING: CONNECTION TIMEOUTS ===
                // Client hasn't sent data within the configured timeout period
                logger.warn(logSystem, logComponent, logSubCat, `Connected timed out for ${client.getLabel()}: ${reason}`);

            }).on('socketDisconnect', () => {
                // === CLIENT DISCONNECTION ===
                // Client has disconnected (normal or abnormal termination)
                // Commented out to reduce log noise - this is a common occurrence
                //logger.debug(logSystem, logComponent, logSubCat, 'Socket disconnected from ' + client.getLabel());

            }).on('kickedBannedIP', (remainingBanTime) => {
                // === SECURITY: BANNED IP REJECTION ===
                // Attempted connection from a previously banned IP address
                // Connection was automatically rejected by the ban system
                logger.debug(logSystem, logComponent, logSubCat, `Rejected incoming connection from ${client.remoteAddress} banned for ${remainingBanTime} more seconds`);

            }).on('forgaveBannedIP', () => {
                // === SECURITY: BAN FORGIVENESS ===
                // A banned IP has been forgiven (ban expired or manually lifted)
                logger.debug(logSystem, logComponent, logSubCat, `Forgave banned IP ${client.remoteAddress}`);

            }).on('unknownStratumMethod', (fullMessage) => {
                // === PROTOCOL HANDLING: UNKNOWN METHODS ===
                // Client sent a stratum method that we don't recognize
                // Could be a newer protocol version or custom extension
                logger.debug(logSystem, logComponent, logSubCat, `Unknown stratum method from ${client.getLabel()}: ${fullMessage.method}`);

            }).on('socketFlooded', () => {
                // === SECURITY: FLOOD DETECTION ===
                // Client is sending data too rapidly (potential DoS attack)
                // This triggers automatic connection throttling or banning
                logger.warn(logSystem, logComponent, logSubCat, `Detected socket flooding from ${client.getLabel()}`);

            }).on('tcpProxyError', (data) => {
                // === PROXY PROTOCOL ERROR ===
                // TCP proxy protocol is enabled but we received invalid proxy headers
                // This indicates misconfiguration or bypassing of load balancer
                logger.error(logSystem, logComponent, logSubCat, `Client IP detection failed, tcpProxyProtocol is enabled yet did not receive proxy protocol message, instead got data: ${data}`);

            }).on('bootedBannedWorker', () => {
                // === SECURITY: RETROACTIVE BAN ENFORCEMENT ===
                // A connected worker's IP was banned while they were connected
                // The worker has been disconnected to enforce the ban
                logger.warn(logSystem, logComponent, logSubCat, `Booted worker ${client.getLabel()} who was connected from an IP address that was just banned`);

            }).on('triggerBan', (reason) => {
                // === SECURITY: BAN TRIGGER ===
                // Client behavior has triggered an automatic ban
                // Reasons: share flooding, invalid shares, malicious behavior, etc.
                logger.warn(logSystem, logComponent, logSubCat, `Banned triggered for ${client.getLabel()}: ${reason}`);

                // Emit pool-level ban event for external ban management systems
                // This allows centralized ban coordination across multiple pool instances
                _this.emit('banIP', client.remoteAddress, client.workerName);
            });
        });
    }

    /**
     * Sets up periodic block template polling from the daemon.
     * Block polling is a fallback mechanism to ensure the pool receives
     * new block notifications even if P2P notifications fail. The polling
     * interval should be balanced between responsiveness and daemon load.
     *
     * Polling can be disabled by setting blockRefreshInterval to 0 or negative.
     *
     * @function SetupBlockPolling
     * @private
     */
    function SetupBlockPolling() {
        if (typeof options.blockRefreshInterval !== 'number' || options.blockRefreshInterval <= 0) {
            logger.debug(logSystem, logComponent, logSubCat, 'Block template polling has been disabled');
            return;
        }

        const pollingInterval = options.blockRefreshInterval;

        blockPollingIntervalId = setInterval(() => {
            util.getBlockTemplate(_this.daemon, options, _this.jobManager, logger, logSystem, logComponent, logSubCat, (error, rpcData, newJob) => {
                if (newJob) {
                    logger.debug(logSystem, logComponent, logSubCat, 'Block update via RPC polling');
                }
            });
        }, pollingInterval);
    }

    // getBlockTemplate moved to libs/utils/rpc.js and is invoked via util.getBlockTemplate

    // checkBlockAccepted moved to libs/utils/rpc.js and is invoked via util.checkBlockAccepted

    /**
     * Processes block notifications from external sources.
     *
     * This method is called when a new block is discovered by the daemon
     * or received via P2P networking. It triggers a new block template
     * request to update all miners with fresh work.
     *
     * Block notifications can come from:
     * - Block notify scripts (external process calling this method)
     * - P2P peer connections
     * - Manual triggers
     *
     * For Verus-based coins, the same block hash might be received multiple
     * times due to PBaaS chain updates, so template regeneration is always performed.
     *
     * @method processBlockNotify
     * @memberof Pool
     * @param {string} blockHash - Hash of the newly discovered block
     * @param {string} sourceTrigger - Source of the notification (e.g., 'p2p', 'blocknotify')
     */
    this.processBlockNotify = function (blockHash, sourceTrigger) {
        // Log the block notification and calculate next working height
        logger.warn(logSystem, logComponent, logSubCat,
            `Block notification via ${sourceTrigger}:  now working on ${parseInt(_this.jobManager.currentJob.rpcData.height) + 1}`);

        // Verify that job manager is properly initialized before processing
        if (typeof (_this.jobManager) !== 'undefined' &&
            typeof (_this.jobManager.currentJob) !== 'undefined' &&
            typeof (_this.jobManager.currentJob.rpcData.previousblockhash) !== 'undefined') {

            // Note: For Verus-based coins, we may receive the same block hash multiple times
            // due to PBaaS (Public Blockchains as a Service) chain updates.
            // In these cases, we still need to generate a new block template to get updates
            // rather than checking if the hash differs from our current previous block hash.

            // Request new block template to update miners with fresh work
            util.getBlockTemplate(_this.daemon, options, _this.jobManager, logger, logSystem, logComponent, logSubCat, (error, result) => {
                if (error) {
                    logger.error(logSystem, logComponent, logSubCat,
                        `Block notify error getting block template for ${options.coin.name}`);
                }
                // If successful, the jobManager will automatically broadcast new jobs
                // to all connected miners via the 'newBlock' event handler
            });
        }
    };

    /**
     * Relinquishes (transfers) miners from this pool instance to another.
     *
     * This method is used in multi-process pool setups where miners need
     * to be moved between pool instances for load balancing or failover.
     * The filter function determines which miners should be transferred.
     *
     * Process:
     * 1. Get all current stratum clients
     * 2. Filter clients based on provided criteria
     * 3. Remove event listeners from selected clients
     * 4. Remove clients from this pool's stratum server
     * 5. Return client objects for attachment to another pool
     *
     * @method relinquishMiners
     * @memberof Pool
     * @param {Function} filterFn - Function to determine which clients to transfer
     * @param {Function} resultCback - Callback that receives array of relinquished clients
     *
     * @example
     * pool.relinquishMiners((client, callback) => {
     *   // Transfer miners from a specific port
     *   callback(client.socket.localPort === 3333);
     * }, (clients) => {
     *   console.log(`Transferred ${clients.length} miners`);
     * });
     */
    this.relinquishMiners = function (filterFn, resultCback) {
        // Get current stratum client connections from the server
        const origStratumClients = this.stratumServer.getStratumClients();

        // Convert client map to array format for easier processing
        // Each element contains both the subscription ID and client object
        const stratumClients = [];
        Object.keys(origStratumClients).forEach((subId) => {
            stratumClients.push({
                subId: subId,                    // Subscription identifier
                client: origStratumClients[subId] // Client connection object
            });
        });

        // Use Promise.all to determine which clients match the filter criteria
        Promise.all(stratumClients.map(cObj => new Promise((resolve) => {
            filterFn(cObj.client, (shouldInclude) => {
                resolve(shouldInclude ? cObj : null);
            });
        }))).then((results) => {
            const clientsToRelinquish = results.filter(item => item !== null);

            // Process each client that should be transferred
            clientsToRelinquish.forEach((cObj) => {
                // Clean up event listeners to prevent memory leaks
                cObj.client.removeAllListeners();

                // Remove client from this pool's stratum server
                _this.stratumServer.removeStratumClientBySubId(cObj.subId);
            });

            // Use nextTick to ensure cleanup completes before callback
            process.nextTick(() => {
                // Return array of client objects for attachment to another pool
                resultCback(
                    clientsToRelinquish.map((item) => {
                        return item.client;
                    })
                );
            });
        });
    };

    /**
     * Attaches miners (stratum clients) to this pool instance.
     *
     * This method is the counterpart to relinquishMiners, used to receive
     * miners that were transferred from another pool instance. After attachment,
     * all miners are immediately sent the current mining job.
     *
     * @method attachMiners
     * @memberof Pool
     * @param {Array} miners - Array of stratum client objects to attach
     *
     * @example
     * pool.attachMiners(transferredClients);
     */
    this.attachMiners = function (miners) {
        // Add each transferred miner to this pool's stratum server
        miners.forEach((clientObj) => {
            // Manually register the client connection with our stratum server
            // This bypasses the normal connection process since these are pre-existing connections
            _this.stratumServer.manuallyAddStratumClient(clientObj);
        });

        // Immediately send current mining job to all newly attached miners
        // This ensures they start working on the current block without delay
        _this.stratumServer.broadcastMiningJobs(_this.jobManager.currentJob.getJobParams());
    };

    /**
     * Gets the stratum server instance.
     *
     * Provides access to the underlying stratum server for external
     * components that need direct access to server functionality,
     * such as statistics collection or administrative operations.
     *
     * @method getStratumServer
     * @memberof Pool
     * @returns {StratumServer} The stratum server instance
     */
    this.getStratumServer = function () {
        return _this.stratumServer;
    };

    /**
     * Sets up or updates variable difficulty for a specific port.
     *
     * Variable difficulty automatically adjusts mining difficulty for individual
     * miners to maintain optimal share submission rates. This method can be used
     * to reconfigure difficulty settings during runtime.
     *
     * When a new difficulty is calculated:
     * - The new difficulty is queued for the next job (clean jobs)
     * - Miners receive updated difficulty with the next mining job
     * - This ensures smooth transitions without work interruption
     *
     * @method setVarDiff
     * @memberof Pool
     * @param {number} port - Port number to configure variable difficulty for
     * @param {Object} varDiffConfig - Variable difficulty configuration
     * @param {number} varDiffConfig.minDiff - Minimum difficulty allowed
     * @param {number} varDiffConfig.maxDiff - Maximum difficulty allowed
     * @param {number} varDiffConfig.targetTime - Target time between shares (seconds)
     * @param {number} varDiffConfig.retargetTime - How often to adjust difficulty (seconds)
     * @param {number} varDiffConfig.variancePercent - Allowed variance before adjustment
     *
     * @example
     * pool.setVarDiff(3333, {
     *   minDiff: 1,
     *   maxDiff: 512,
     *   targetTime: 15,
     *   retargetTime: 90,
     *   variancePercent: 30
     * });
     */
    this.setVarDiff = function (port, varDiffConfig) {
        // Clean up existing variable difficulty instance if it exists
        if (typeof (_this.varDiff[port]) !== 'undefined') {
            // Remove all event listeners to prevent memory leaks
            _this.varDiff[port].removeAllListeners();
        }

        // Create new variable difficulty instance for this port
        _this.varDiff[port] = new varDiff(port, varDiffConfig);

        // Set up event handler for difficulty adjustments
        _this.varDiff[port].on('newDifficulty', (client, newDiff) => {
            // Queue the new difficulty for the next job dispatch
            // This ensures smooth transitions without interrupting current work
            // The difficulty change will take effect when a new block is found
            client.enqueueNextDifficulty(newDiff);

            /* Alternative fast mode implementation (currently disabled):
             * In fast mode, difficulty changes are applied immediately:
             * 1. Send new difficulty to miner
             * 2. Resend current job with clean_jobs=false
             * 3. Miner continues current work at new difficulty
             *
             * This reduces latency but may cause more share variance
             *
             * if (options.varDiff.mode === 'fast'){
             *     client.sendDifficulty(newDiff);
             *     const job = _this.jobManager.currentJob.getJobParams();
             *     job[8] = false;  // clean_jobs = false
             *     client.sendMiningJob(job);
             * }
             */
        });
    };

};

/**
 * Set up inheritance from EventEmitter.
 * This allows the Pool class to emit and listen for events,
 * enabling loose coupling between components and reactive programming patterns.
 *
 * Events emitted by Pool:
 * - 'started': Pool initialization complete
 * - 'share': Share submitted (valid or invalid)
 * - 'difficultyUpdate': Worker difficulty adjusted
 * - 'banIP': IP address should be banned
 */
pool.prototype.__proto__ = events.EventEmitter.prototype;
