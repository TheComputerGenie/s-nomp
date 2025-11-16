/**
 * @fileoverview Pool class - Main mining pool orchestrator
 *
 * This is the core component that orchestrates daemon communication, stratum server,
 * job management, peer-to-peer networking, and block processing for mining pools.
 *
 * @author ComputerGenieCo
 * @version 21.7.3
 * @copyright 2025
 */

const algos = require('./algoProperties.js');
const daemon = require('./daemon.js');
const events = require('events');
const jobManager = require('./jobManager.js');
const peer = require('./peer.js');
const PoolLogger = require('../PoolLogger.js');
const RelayChecker = require('./relayChecker.js');
const stratum = require('./stratum.js');
const util = require('../utils/util.js');
const varDiff = require('./varDiff.js');

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
 * Events emitted:
 * - 'started': Pool initialization complete
 * - 'share': Share submitted (valid or invalid)
 * - 'difficultyUpdate': Worker difficulty adjusted
 * - 'banIP': IP address should be banned
 *
 * @class Pool
 * @extends EventEmitter
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
 */
class Pool extends events.EventEmitter {
    static validateOptions(options, algos) {
        const errors = [];
        if (!options) {
            errors.push('options is required');
            return { isValid: false, errors };
        }
        if (!options.coin || !options.coin.algorithm) {
            errors.push('coin.algorithm is required');
        } else if (!algos.hasAlgorithm(options.coin.algorithm)) {
            errors.push(`The ${options.coin.algorithm} hashing algorithm is not supported`);
        }
        return { isValid: errors.length === 0, errors };
    }

    #logger;
    #logSystem = ' Pool ';
    #logComponent;
    #logThread;
    #forkId;
    #blockPollingIntervalId;
    #jobManagerLastSubmitBlockHex = false;

    constructor(options, authorizeFn) {
        super();
        this.options = options;
        this.isValid = true;

        const portalConfig = JSON.parse(process.env.portalConfig);

        this.#logger = new PoolLogger({
            logLevel: portalConfig.logLevel,
            logColors: portalConfig.logColors,
            mainThreadOnly: false
        });

        this.#logComponent = options.coin.name;

        this.#forkId = process.env.forkId || '0';

        this.#logThread = this.#forkId;

        if (!algos.hasAlgorithm(options.coin.algorithm)) {
            this.#logger.error(this.#logSystem, this.#logComponent, this.#logThread, `The ${options.coin.algorithm} hashing algorithm is not supported.`);
            this.isValid = false;
        }

        this.authorizeFn = authorizeFn;
    }

    /**
     * Start the mining pool by initializing all components in the correct order.
     * @returns {void}
     */
    start() {
        if (!this.isValid) {
            this.#logger.error(this.#logSystem, this.#logComponent, this.#logThread, 'Pool cannot start due to invalid configuration');
            return;
        }
        this.#setupVarDiff();
        this.#setupApi();
        this.#setupDaemonInterface(() => {
            this.#detectCoinData(() => {
                this.#setupRecipients();
                this.#setupJobManager();
                this.#onBlockchainSynced(() => {
                    this.#getFirstJob(() => {
                        this.#setupBlockPolling();
                        this.#setupPeer();
                        this.#startStratumServer(() => {
                            this.#outputPoolInfo();
                            this.emit('started');
                        });
                    });
                });
            });
        });
    }

    #getFirstJob(finishedCallback) {
        util.getBlockTemplate(this.daemon, this.options, this.jobManager, this.#logger, this.#logSystem, this.#logComponent, this.#logThread, (error, result) => {
            if (error) {
                this.#logger.error(this.#logSystem, this.#logComponent, this.#logThread, 'Error with getblocktemplate on creating first job, server cannot start');
                return;
            }

            const portWarnings = [];

            const networkDiffAdjusted = this.options.initStats.difficulty;

            Object.keys(this.options.ports).forEach((port) => {
                const portDiff = this.options.ports[port].diff;

                if (networkDiffAdjusted < portDiff) {
                    portWarnings.push(`port ${port} w/ diff ${portDiff}`);
                }
            });

            if (portWarnings.length > 0) {
                const warnMessage = `Network diff of ${networkDiffAdjusted} is lower than ${portWarnings.join(' and ')}`;
                this.#logger.warn(this.#logSystem, this.#logComponent, this.#logThread, warnMessage);
            }

            finishedCallback();
        });
    }

    #outputPoolInfo() {
        const startMessage = `\r\n\t\t\t\t\t\tStratum Pool Server Started for ${this.options.coin.name
        } [${this.options.coin.symbol.toUpperCase()}] {${this.options.coin.algorithm}}`;

        const infoLines = [startMessage,
            `Network Connected:\t${this.options.testnet ? 'Testnet' : 'Mainnet'}`,
            `Detected Reward Type:\t${this.options.coin.reward}`,
            `Current Block Height:\t${this.jobManager.currentJob.rpcData.height}`,
            `Current Block Diff:\t${this.jobManager.currentJob.difficulty * algos.getMultiplier(this.options.coin.algorithm)}`,
            `Current Connect Peers:\t${this.options.initStats.connections}`,
            `Network Difficulty:\t${this.options.initStats.difficulty}`,
            `Network Hash Rate:\t${util.getReadableHashRateString(this.options.initStats.networkHashRate, this.options.coin.algorithm)}`,
            `Stratum Port(s):\t${this.options.initStats.stratumPorts.join(', ')}`,
            `Pool Fee Percent:\t${this.options.feePercent}%`
        ];

        if (typeof this.options.blockRefreshInterval === 'number' && this.options.blockRefreshInterval > 0) {
            infoLines.push(`Block polling every:\t${this.options.blockRefreshInterval} ms`);
        }

        this.#logger.info(this.#logSystem, this.#logComponent, this.#logThread, infoLines.join('\n\t\t\t\t\t\t'), true);
    }

    #onBlockchainSynced(syncedCallback) {
        const checkSynced = (displayNotSynced) => {
            this.daemon.cmd('getblocktemplate', [], (results) => {
                const synced = results.every((r) => {
                    return !r.error || r.error.code !== -9;
                });

                if (synced) {
                    syncedCallback();
                } else {
                    if (displayNotSynced) {
                        displayNotSynced();
                    }

                    setTimeout(checkSynced, 5000);

                    this.#generateProgress();
                }
            });
        };
        checkSynced(() => {
            this.#logger.error(this.#logSystem, this.#logComponent, this.#logThread, 'Daemon is still syncing with network (download blockchain) - server will be started once synced');
        });
    }

    #generateProgress() {
        this.daemon.cmd('getinfo', [], (results) => {
            const blockCount = results.sort((a, b) => {
                return b.response.blocks - a.response.blocks;
            })[0].response.blocks;

            this.daemon.cmd('getpeerinfo', [], (results) => {
                const peers = results[0].response;

                const totalBlocks = peers.sort((a, b) => {
                    return b.startingheight - a.startingheight;
                })[0].startingheight;

                const percent = (blockCount / totalBlocks * 100).toFixed(2);
                this.#logger.warn(this.#logSystem, this.#logComponent, this.#logThread, `Downloaded ${percent}% of blockchain from ${peers.length} peers`);
            });
        });
    }

    #setupApi() {
        if (typeof (this.options.api) !== 'object' || typeof (this.options.api.start) !== 'function') {
        } else {
            this.options.api.start(this);
        }
    }

    #setupPeer() {
        if (!this.options.p2p || !this.options.p2p.enabled) {
            return;
        }

        if (this.options.testnet && !this.options.coin.peerMagicTestnet) {
            this.#logger.error(this.#logSystem, this.#logComponent, this.#logThread, 'p2p cannot be enabled in testnet without peerMagicTestnet set in coin configuration');
            return;
        } else if (!this.options.coin.peerMagic) {
            this.#logger.error(this.#logSystem, this.#logComponent, this.#logThread, 'p2p cannot be enabled without peerMagic set in coin configuration');
            return;
        }

        this.options.startHeight = this.jobManager.currentJob.rpcData.height;
        this.peer = new peer(this.options);
        this.relayChecker = new RelayChecker(this.daemon, this.options, this.jobManager, this.#logger, this.#logSystem, this.#logComponent, this.#logThread);
        this.peer.on('connected', () => {
            this.#logger.debug(this.#logSystem, this.#logComponent, this.#logThread, 'p2p connection successful');
        }).on('connectionRejected', () => {
            this.#logger.error(this.#logSystem, this.#logComponent, this.#logThread, 'p2p connection failed - rejected by peer');
        }).on('disconnected', () => {
            this.#logger.warn(this.#logSystem, this.#logComponent, this.#logThread, 'p2p peer node disconnected - attempting reconnection...');
        }).on('connectionFailed', (e) => {
            this.#logger.error(this.#logSystem, this.#logComponent, this.#logThread, 'p2p connection failed - likely incorrect host or port');
        }).on('socketError', (e) => {
            if (e.code !== 'ECONNRESET') {
                this.#logger.error(this.#logSystem, this.#logComponent, this.#logThread, `p2p had a socket error ${JSON.stringify(e)}`);
            }
        }).on('error', (msg) => {
            this.#logger.warn(this.#logSystem, this.#logComponent, this.#logThread, `p2p had an error ${msg}`);
        }).on('blockFound', (hash) => {
            this.processBlockNotify(hash, 'p2p');
        }).on('transactionReceived', (txHash) => {
            this.relayChecker.checkTransaction(txHash);
        });
    }

    #setupVarDiff() {
        this.varDiff = {};

        Object.keys(this.options.ports).forEach((port) => {
            if (this.options.ports[port].varDiff) {
                this.setVarDiff(port, this.options.ports[port].varDiff);
            }
        });
    }

    #setupRecipients() {
        const recipients = [];
        this.options.feePercent = 0;

        this.options.rewardRecipients = this.options.rewardRecipients || {};

        for (const r in this.options.rewardRecipients) {
            const percent = this.options.rewardRecipients[r];

            const rObj = {
                percent: percent,
                address: r
            };
            recipients.push(rObj);

            this.options.feePercent += percent;
        }

        if (recipients.length === 0) {
            this.#logger.error(this.#logSystem, this.#logComponent, this.#logThread, 'No rewardRecipients have been setup which means no fees will be taken', true);
        }

        this.options.recipients = recipients;
    }

    #setupJobManager() {
        this.jobManager = new jobManager(this.options);

        this.jobManager.on('newBlock', (blockTemplate) => {
            if (this.stratumServer) {
                this.stratumServer.broadcastMiningJobs(blockTemplate.getJobParams());
            }
        }).on('updatedBlock', (blockTemplate, cleanjob) => {
            if (this.stratumServer) {
                const job = blockTemplate.getJobParams();
                job[7] = cleanjob;
                this.stratumServer.broadcastMiningJobs(job);
            }
        }).on('share', (shareData, blockHex) => {
            const isValidShare = !shareData.error;

            let isValidBlock = !!blockHex;

            const emitShare = () => {
                this.emit('share', isValidShare, isValidBlock, shareData);
            };

            if (!isValidBlock) {
                emitShare();
            } else {
                if (this.#jobManagerLastSubmitBlockHex === blockHex) {
                    this.#logger.warn(this.#logSystem, this.#logComponent, this.#logThread, `Warning, ignored duplicate submit block ${blockHex}`);
                } else {
                    this.#jobManagerLastSubmitBlockHex = blockHex;

                    util.submitBlock(this.daemon, this.options, this.#logger, this.#logSystem, this.#logComponent, this.#logThread, shareData.height, blockHex, () => {
                        if (!shareData.blockOnlyPBaaS) {
                            util.checkBlockAccepted(this.daemon, this.#logger, this.#logSystem, this.#logComponent, this.#logThread, shareData.blockHash, (isAccepted, tx) => {
                                isValidBlock = isAccepted === true;

                                if (isValidBlock === true) {
                                    shareData.txHash = tx;
                                } else {
                                    shareData.error = tx;
                                }

                                emitShare();

                                util.getBlockTemplate(this.daemon, this.options, this.jobManager, this.#logger, this.#logSystem, this.#logComponent, this.#logThread, (error, result, foundNewBlock) => {
                                    if (foundNewBlock) {
                                        this.#logger.debug(this.#logSystem, this.#logComponent, this.#logThread, 'Block notification via RPC after block submission');
                                    }
                                });
                            });
                        } else {
                            emitShare();
                        }
                    });
                }
            }
        }).on('log', (severity, message) => {
            this.#logger[severity](this.#logSystem, this.#logComponent, this.#logThread, message);
        });
    }

    #setupDaemonInterface(finishedCallback) {
        if (!Array.isArray(this.options.daemons) || this.options.daemons.length < 1) {
            this.#logger.error(this.#logSystem, this.#logComponent, this.#logThread, 'No daemons have been configured - pool cannot start');
            return;
        }

        this.daemon = new daemon.interface(this.options.daemons, ((severity, message) => {
            this.#logger[severity](this.#logSystem, this.#logComponent, this.#logThread, message);
        }));

        this.daemon.once('online', () => {
            finishedCallback();
        }).on('connectionFailed', (error) => {
            this.#logger.error(this.#logSystem, this.#logComponent, this.#logThread, `Failed to connect daemon(s): ${JSON.stringify(error)}`);
        }).on('error', (message) => {
            this.#logger.error(this.#logSystem, this.#logComponent, this.#logThread, message);
        });

        this.daemon.init();
    }

    #detectCoinData(finishedCallback) {
        const batchRpcCalls = [
            ['validateaddress', [this.options.address]],
            ['getdifficulty', []],
            ['getinfo', []],
            ['getmininginfo', []],
            ['submitblock', []]
        ];

        this.daemon.batchCmd(batchRpcCalls, (error, results) => {
            if (error || !results) {
                this.#logger.error(this.#logSystem, this.#logComponent, this.#logThread, `Could not start pool, error with init batch RPC call: ${JSON.stringify(error)}`);
                return;
            }

            const rpcResults = {};

            for (let i = 0; i < results.length; i++) {
                const rpcCall = batchRpcCalls[i][0];
                const r = results[i];

                rpcResults[rpcCall] = r.result || r.error;

                if (rpcCall !== 'submitblock' && (r.error || !r.result)) {
                    this.#logger.error(this.#logSystem, this.#logComponent, this.#logThread, `Could not start pool, error with init RPC ${rpcCall} - ${JSON.stringify(r.error)}`);
                    return;
                }
            }

            if (!rpcResults.validateaddress.isvalid) {
                this.#logger.error(this.#logSystem, this.#logComponent, this.#logThread, 'Daemon reports address is not valid');
                return;
            }

            if (isNaN(rpcResults.getdifficulty) && 'proof-of-stake' in rpcResults.getdifficulty) {
                this.options.coin.reward = 'POS';
            } else {
                this.options.coin.reward = 'POW';
            }

            if (this.options.coin.reward === 'POS' && typeof (rpcResults.validateaddress.pubkey) === 'undefined') {
                this.#logger.error(this.#logSystem, this.#logComponent, this.#logThread, 'The address provided is not from the daemon wallet - this is required for POS coins.');
                return;
            }

            this.options.poolAddressScript = (function () {
                return util.addressToScript(rpcResults.validateaddress.address);
            })();

            this.options.testnet = rpcResults.getinfo.testnet;
            this.options.protocolVersion = rpcResults.getinfo.protocolversion;
            this.options.startHeight = rpcResults.getinfo.blocks;

            this.options.initStats = {
                connections: rpcResults.getinfo.connections,
                difficulty: rpcResults.getinfo.difficulty * algos.getMultiplier(this.options.coin.algorithm),
                networkHashRate: rpcResults.getmininginfo.networkhashps
            };

            if (rpcResults.submitblock.message === 'Method not found') {
                this.options.hasSubmitMethod = false;
            } else if (rpcResults.submitblock.code === -1) {
                this.options.hasSubmitMethod = true;
            } else {
                this.#logger.error(this.#logSystem, this.#logComponent, this.#logThread, `Could not detect block submission RPC method, ${JSON.stringify(results)}`);
                return;
            }

            finishedCallback();
        });
    }

    #startStratumServer(finishedCallback) {
        const stratumOptions = { ...this.options, algorithm: this.options.coin.algorithm };
        this.stratumServer = new stratum.Server(stratumOptions, this.authorizeFn, algos);

        this.stratumServer.on('started', () => {
            this.options.initStats.stratumPorts = Object.keys(this.options.ports);

            this.stratumServer.broadcastMiningJobs(this.jobManager.currentJob.getJobParams());

            finishedCallback();
        }).on('broadcastTimeout', () => {
            this.#logger.debug(this.#logSystem, this.#logComponent, this.#logThread, `No new blocks for ${this.options.jobRebroadcastTimeout} seconds - updating transactions & rebroadcasting work`);

            util.getBlockTemplate(this.daemon, this.options, this.jobManager, this.#logger, this.#logSystem, this.#logComponent, this.#logThread, (error, rpcData, processedBlock) => {
                if (error || processedBlock) {
                    return;
                }

                if (!rpcData) {
                    return;
                }

                if (this.jobManager.isRpcDataProcessed && this.jobManager.isRpcDataProcessed(rpcData)) {
                    return;
                }

                this.jobManager.updateCurrentJob(rpcData);
            });
        }).on('client.connected', (client) => {
            if (typeof (this.varDiff[client.socket.localPort]) !== 'undefined') {
                this.varDiff[client.socket.localPort].manageClient(client);
            }

            client.on('difficultyChanged', (diff) => {
                this.emit('difficultyUpdate', client.workerName, diff);
            }).on('subscription', (params, resultCallback) => {
                const extraNonce = this.jobManager.extraNonceCounter.next();

                resultCallback(null,
                    extraNonce,
                    extraNonce
                );

                if (typeof (this.options.ports[client.socket.localPort]) !== 'undefined' && this.options.ports[client.socket.localPort].diff) {
                    client.sendDifficulty(this.options.ports[client.socket.localPort].diff);
                } else {
                    client.sendDifficulty(8);
                }

                client.sendMiningJob(this.jobManager.currentJob.getJobParams());
            }).on('submit', (params, resultCallback) => {
                const result = this.jobManager.processShare(
                    params.jobId,
                    client.previousDifficulty,
                    client.difficulty,
                    client.extraNonce1,
                    params.extraNonce2,
                    params.nTime,
                    params.nonce,
                    client.remoteAddress,
                    client.socket.localPort,
                    params.name,
                    params.soln
                );

                resultCallback(result.error, result.result ? true : null);
            }).on('malformedMessage', (message) => {
                this.#logger.warn(this.#logSystem, this.#logComponent, this.#logThread, `Malformed message from ${client.getLabel()}: ${message}`);
            }).on('socketError', (err) => {
                this.#logger.warn(this.#logSystem, this.#logComponent, this.#logThread, `Socket error from ${client.getLabel()}: ${JSON.stringify(err)}`);
            }).on('socketTimeout', (reason) => {
                this.#logger.warn(this.#logSystem, this.#logComponent, this.#logThread, `Connected timed out for ${client.getLabel()}: ${reason}`);
            }).on('socketDisconnect', () => {
            }).on('kickedBannedIP', (remainingBanTime) => {
                this.#logger.debug(this.#logSystem, this.#logComponent, this.#logThread, `Rejected incoming connection from ${client.remoteAddress} banned for ${remainingBanTime} more seconds`);
            }).on('forgaveBannedIP', () => {
                this.#logger.debug(this.#logSystem, this.#logComponent, this.#logThread, `Forgave banned IP ${client.remoteAddress}`);
            }).on('unknownStratumMethod', (fullMessage) => {
                this.#logger.debug(this.#logSystem, this.#logComponent, this.#logThread, `Unknown stratum method from ${client.getLabel()}: ${fullMessage.method}`);
            }).on('socketFlooded', () => {
                this.#logger.warn(this.#logSystem, this.#logComponent, this.#logThread, `Detected socket flooding from ${client.getLabel()}`);
            }).on('tcpProxyError', (data) => {
                this.#logger.error(this.#logSystem, this.#logComponent, this.#logThread, `Client IP detection failed, tcpProxyProtocol is enabled yet did not receive proxy protocol message, instead got data: ${data}`);
            }).on('bootedBannedWorker', () => {
                this.#logger.warn(this.#logSystem, this.#logComponent, this.#logThread, `Booted worker ${client.getLabel()} who was connected from an IP address that was just banned`);
            }).on('triggerBan', (reason) => {
                this.#logger.warn(this.#logSystem, this.#logComponent, this.#logThread, `Banned triggered for ${client.getLabel()}: ${reason}`);
                this.emit('banIP', client.remoteAddress, client.workerName);
            });
        });
    }

    #setupBlockPolling() {
        if (typeof this.options.blockRefreshInterval !== 'number' || this.options.blockRefreshInterval <= 0) {
            this.#logger.debug(this.#logSystem, this.#logComponent, this.#logThread, 'Block template polling has been disabled');
            return;
        }

        const pollingInterval = this.options.blockRefreshInterval;

        this.#blockPollingIntervalId = setInterval(() => {
            util.getBlockTemplate(this.daemon, this.options, this.jobManager, this.#logger, this.#logSystem, this.#logComponent, this.#logThread, (error, rpcData, newJob) => {
                if (newJob) {
                    this.#logger.debug(this.#logSystem, this.#logComponent, this.#logThread, 'Block update via RPC polling');
                }
            });
        }, pollingInterval);
    }

    /**
     * Process block notifications from external sources.
     * @param {string} blockHash - Hash of the newly discovered block
     * @param {string} sourceTrigger - Source of the notification (e.g., 'p2p', 'blocknotify')
     * @returns {void}
     */
    processBlockNotify(blockHash, sourceTrigger) {
        this.#logger.warn(this.#logSystem, this.#logComponent, this.#logThread,
            `Block notification via ${sourceTrigger}:  now working on ${parseInt(this.jobManager.currentJob.rpcData.height) + 1}`, true);

        if (typeof (this.jobManager) !== 'undefined' &&
            typeof (this.jobManager.currentJob) !== 'undefined' &&
            typeof (this.jobManager.currentJob.rpcData.previousblockhash) !== 'undefined') {
            util.getBlockTemplate(this.daemon, this.options, this.jobManager, this.#logger, this.#logSystem, this.#logComponent, this.#logThread, (error, result) => {
                if (error) {
                    this.#logger.error(this.#logSystem, this.#logComponent, this.#logThread,
                        `Block notify error getting block template for ${this.options.coin.name}`);
                }
            });
        }
    }

    /**
     * Relinquish (transfer) miners from this pool instance to another.
     * @param {Function} filterFn - Function to determine which clients to transfer
     * @param {Function} resultCback - Callback that receives array of relinquished clients
     * @returns {void}
     */
    relinquishMiners(filterFn, resultCback) {
        const origStratumClients = this.stratumServer.getStratumClients();

        const stratumClients = [];
        Object.keys(origStratumClients).forEach((subId) => {
            stratumClients.push({
                subId: subId,
                client: origStratumClients[subId]
            });
        });

        Promise.all(stratumClients.map(cObj => new Promise((resolve) => {
            filterFn(cObj.client, (shouldInclude) => {
                resolve(shouldInclude ? cObj : null);
            });
        }))).then((results) => {
            const clientsToRelinquish = results.filter(item => item !== null);

            clientsToRelinquish.forEach((cObj) => {
                cObj.client.removeAllListeners();

                this.stratumServer.removeStratumClientBySubId(cObj.subId);
            });

            process.nextTick(() => {
                resultCback(
                    clientsToRelinquish.map((item) => {
                        return item.client;
                    })
                );
            });
        });
    }

    /**
     * Attach miners (stratum clients) to this pool instance.
     * @param {Array} miners - Array of stratum client objects to attach
     * @returns {void}
     */
    attachMiners(miners) {
        miners.forEach((clientObj) => {
            this.stratumServer.manuallyAddStratumClient(clientObj);
        });

        this.stratumServer.broadcastMiningJobs(this.jobManager.currentJob.getJobParams());
    }

    /**
     * Get the stratum server instance.
     * @returns {StratumServer} The stratum server instance
     */
    getStratumServer() {
        return this.stratumServer;
    }

    /**
     * Set up or update variable difficulty for a specific port.
     * @param {number} port - Port number to configure variable difficulty for
 * @param {Object} varDiffConfig - Variable difficulty configuration
     * @returns {void}
     */
    setVarDiff(port, varDiffConfig) {
        if (typeof (this.varDiff[port]) !== 'undefined') {
            this.varDiff[port].removeAllListeners();
        }

        this.varDiff[port] = new varDiff(port, varDiffConfig);

        if (!this.varDiff[port].isValid) {
            this.#logger.warn(this.#logSystem, this.#logComponent, this.#logThread, `VarDiff for port ${port} has invalid config, using defaults.`);
        }

        this.varDiff[port].on('newDifficulty', (client, newDiff) => {
            client.enqueueNextDifficulty(newDiff);
        });
    }
}

module.exports = Pool;
