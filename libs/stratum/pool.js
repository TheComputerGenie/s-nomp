const events = require('events');
const async = require('async');

const PoolLogger = require('../logUtil.js');

const varDiff = require('./varDiff.js');
const daemon = require('./daemon.js');
const peer = require('./peer.js');
const stratum = require('./stratum.js');
const jobManager = require('./jobManager.js');
const algos = require('./algoProperties.js');
const util = require('./util.js');

/*process.on('uncaughtException', function(err) {
 console.log(err.stack);
 throw err;
 });*/

const pool = module.exports = function pool(options, authorizeFn) {

    this.options = options;
    const logger = new PoolLogger(this.options.logger || {});

    const logSystem = ' Pool ';
    const logComponent = options.coin.name;
    const forkId = process.env.forkId || '0';
    const logSubCat = `Thread ${parseInt(forkId) + 1}`;

    const _this = this;
    let blockPollingIntervalId;


    if (!(options.coin.algorithm in algos)) {
        logger.error(logSystem, logComponent, logSubCat, `The ${options.coin.algorithm} hashing algorithm is not supported.`);
        throw new Error();
    }


    this.start = function () {
        SetupVarDiff();
        SetupApi();
        SetupDaemonInterface(() => {
            DetectCoinData(() => {
                SetupRecipients();
                SetupJobManager();
                OnBlockchainSynced(() => {
                    GetFirstJob(() => {
                        SetupBlockPolling();
                        SetupPeer();
                        StartStratumServer(() => {
                            OutputPoolInfo();
                            _this.emit('started');
                        });
                    });
                });
            });
        });
    };


    function GetFirstJob(finishedCallback) {

        GetBlockTemplate((error, result) => {
            if (error) {
                logger.error(logSystem, logComponent, logSubCat, 'Error with getblocktemplate on creating first job, server cannot start');
                return;
            }

            const portWarnings = [];

            const networkDiffAdjusted = options.initStats.difficulty;

            Object.keys(options.ports).forEach((port) => {
                const portDiff = options.ports[port].diff;
                if (networkDiffAdjusted < portDiff) {
                    portWarnings.push(`port ${port} w/ diff ${portDiff}`);
                }
            });

            //Only let the first fork show synced status or the log wil look flooded with it
            if (portWarnings.length > 0 && (!process.env.forkId || process.env.forkId === '0')) {
                const warnMessage = `Network diff of ${networkDiffAdjusted} is lower than ${portWarnings.join(' and ')}`;
                logger.warn(logSystem, logComponent, logSubCat, warnMessage);
            }

            finishedCallback();

        });
    }


    function OutputPoolInfo() {

        const startMessage = `\r\n\t\t\t\t\t\tStratum Pool Server Started for ${options.coin.name
            } [${options.coin.symbol.toUpperCase()}] {${options.coin.algorithm}}`;
        if (process.env.forkId && process.env.forkId !== '0') {
            logger.debug(logSystem, logComponent, logSubCat, startMessage);
            return;
        }
        const infoLines = [startMessage,
            `Network Connected:\t${options.testnet ? 'Testnet' : 'Mainnet'}`,
            `Detected Reward Type:\t${options.coin.reward}`,
            `Current Block Height:\t${_this.jobManager.currentJob.rpcData.height}`,
            `Current Block Diff:\t${_this.jobManager.currentJob.difficulty * algos[options.coin.algorithm].multiplier}`,
            `Current Connect Peers:\t${options.initStats.connections}`,
            `Network Difficulty:\t${options.initStats.difficulty}`,
            `Network Hash Rate:\t${util.getReadableHashRateString(options.initStats.networkHashRate)}`,
            `Stratum Port(s):\t${_this.options.initStats.stratumPorts.join(', ')}`,
            `Pool Fee Percent:\t${_this.options.feePercent}%`
        ];

        if (typeof options.blockRefreshInterval === 'number' && options.blockRefreshInterval > 0) {
            infoLines.push(`Block polling every:\t${options.blockRefreshInterval} ms`);
        }

        logger.info(logSystem, logComponent, logSubCat, infoLines.join('\n\t\t\t\t\t\t'));
    }


    function OnBlockchainSynced(syncedCallback) {

        const checkSynced = function (displayNotSynced) {
            _this.daemon.cmd('getblocktemplate', [], (results) => {
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

                    //Only let the first fork show synced status or the log wil look flooded with it
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


        function generateProgress() {

            _this.daemon.cmd('getinfo', [], (results) => {
                const blockCount = results.sort((a, b) => {
                    return b.response.blocks - a.response.blocks;
                })[0].response.blocks;

                //get list of peers and their highest block height to compare to ours
                _this.daemon.cmd('getpeerinfo', [], (results) => {

                    const peers = results[0].response;
                    const totalBlocks = peers.sort((a, b) => {
                        return b.startingheight - a.startingheight;
                    })[0].startingheight;

                    const percent = (blockCount / totalBlocks * 100).toFixed(2);
                    logger.warn(logSystem, logComponent, logSubCat, `Downloaded ${percent}% of blockchain from ${peers.length} peers`);
                });

            });
        };

    }


    function SetupApi() {
        if (typeof (options.api) !== 'object' || typeof (options.api.start) !== 'function') {
        } else {
            options.api.start(_this);
        }
    }


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


    function SetupVarDiff() {
        _this.varDiff = {};
        Object.keys(options.ports).forEach((port) => {
            if (options.ports[port].varDiff) {
                _this.setVarDiff(port, options.ports[port].varDiff);
            }
        });
    }


    /*
     Coin daemons either use submitblock or getblocktemplate for submitting new blocks
     */
    function SubmitBlock(height, blockHex, callback) {

        let rpcCommand, rpcArgs;
        if (options.hasSubmitMethod) {
            rpcCommand = 'submitblock';
            // if pbaas solution version is 7 or higher, use submitmergedblock
            const solution_ver = parseInt(util.reverseBuffer(Buffer.from(blockHex.substr(286, 8), 'hex')).toString('hex'), 16);
            if (solution_ver > 6) {
                rpcCommand = 'submitmergedblock';
            }
            rpcArgs = [blockHex];
        } else {
            rpcCommand = 'getblocktemplate';
            rpcArgs = [{ 'mode': 'submit', 'data': blockHex }];
        }

        _this.daemon.cmd(rpcCommand,
            rpcArgs,
            (results) => {
                for (let i = 0; i < results.length; i++) {
                    const result = results[i];
                    if (result.error) {
                        logger.error(logSystem, logComponent, logSubCat, `rpc error with daemon instance ${result.instance.index} when submitting block with ${rpcCommand} ${JSON.stringify(result.error)}`
                        );
                        return;
                    } else if (result.response === 'rejected') {
                        logger.error(logSystem, logComponent, logSubCat, `Daemon instance ${result.instance.index} rejected a supposedly valid block`);
                        return;
                    }
                }
                logger.debug(logSystem, logComponent, logSubCat, `Submitted Block using ${rpcCommand} successfully to daemon instance(s)`);
                callback();
            }
        );
    }

    function SetupRecipients() {
        const recipients = [];
        options.feePercent = 0;
        options.rewardRecipients = options.rewardRecipients || {};

        for (const r in options.rewardRecipients) {
            const percent = options.rewardRecipients[r];
            const rObj = {
                percent: percent,
                address: r
            };
            recipients.push(rObj);
            options.feePercent += percent;
        }

        if (recipients.length === 0) {
            logger.error(logSystem, logComponent, logSubCat, 'No rewardRecipients have been setup which means no fees will be taken');
        }
        options.recipients = recipients;
    }

    let jobManagerLastSubmitBlockHex = false;

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
            //console.log('share :', isValidShare, isValidBlock, shareData)
            const isValidShare = !shareData.error;
            let isValidBlock = !!blockHex;
            const emitShare = function () {
                _this.emit('share', isValidShare, isValidBlock, shareData);
            };

            /*
             If we calculated that the block solution was found,
             before we emit the share, lets submit the block,
             then check if it was accepted using RPC getblock
             */

            if (!isValidBlock) {
                emitShare();
            } else {
                if (jobManagerLastSubmitBlockHex === blockHex) {
                    logger.warn(logSystem, logComponent, logSubCat, `Warning, ignored duplicate submit block ${blockHex}`);
                } else {
                    jobManagerLastSubmitBlockHex = blockHex;
                    SubmitBlock(shareData.height, blockHex, () => {
                        if (!shareData.blockOnlyPBaaS) {
                            CheckBlockAccepted(shareData.blockHash, (isAccepted, tx) => {
                                isValidBlock = isAccepted === true;
                                if (isValidBlock === true) {
                                    shareData.txHash = tx;
                                } else {
                                    shareData.error = tx;
                                }
                                emitShare();
                                GetBlockTemplate((error, result, foundNewBlock) => {
                                    if (foundNewBlock) {
                                        logger.debug(logSystem, logComponent, logSubCat, 'Block notification via RPC after block submission');
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
            logger[severity](logSystem, logComponent, logSubCat, message);
        });
    }


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


    function DetectCoinData(finishedCallback) {

        const batchRpcCalls = [
            ['validateaddress', [options.address]],
            ['getdifficulty', []],
            ['getinfo', []],
            ['getmininginfo', []],
            ['submitblock', []]
        ];

        _this.daemon.batchCmd(batchRpcCalls, (error, results) => {
            if (error || !results) {
                logger.error(logSystem, logComponent, logSubCat, `Could not start pool, error with init batch RPC call: ${JSON.stringify(error)}`);
                return;
            }

            const rpcResults = {};

            for (let i = 0; i < results.length; i++) {
                const rpcCall = batchRpcCalls[i][0];
                const r = results[i];
                rpcResults[rpcCall] = r.result || r.error;

                if (rpcCall !== 'submitblock' && (r.error || !r.result)) {
                    logger.error(logSystem, logComponent, logSubCat, `Could not start pool, error with init RPC ${rpcCall} - ${JSON.stringify(r.error)}`);
                    return;
                }
            }

            if (!rpcResults.validateaddress.isvalid) {
                logger.error(logSystem, logComponent, logSubCat, 'Daemon reports address is not valid');
                return;
            }

            if (isNaN(rpcResults.getdifficulty) && 'proof-of-stake' in rpcResults.getdifficulty) {
                options.coin.reward = 'POS';
            } else {
                options.coin.reward = 'POW';
            }


            /* POS coins must use the pubkey in coinbase transaction, and pubkey is
             only given if address is owned by wallet.*/
            if (options.coin.reward === 'POS' && typeof (rpcResults.validateaddress.pubkey) === 'undefined') {
                logger.error(logSystem, logComponent, logSubCat, 'The address provided is not from the daemon wallet - this is required for POS coins.');
                return;
            }

            options.poolAddressScript = (function () {
                return util.addressToScript(rpcResults.validateaddress.address);
            })();

            options.testnet = rpcResults.getinfo.testnet;
            options.protocolVersion = rpcResults.getinfo.protocolversion;
            options.startHeight = rpcResults.getinfo.blocks;
            options.initStats = {
                connections: rpcResults.getinfo.connections,
                difficulty: rpcResults.getinfo.difficulty * algos[options.coin.algorithm].multiplier,
                networkHashRate: rpcResults.getmininginfo.networkhashps
            };


            if (rpcResults.submitblock.message === 'Method not found') {
                options.hasSubmitMethod = false;
            } else if (rpcResults.submitblock.code === -1) {
                options.hasSubmitMethod = true;
            } else {
                logger.error(logSystem, logComponent, logSubCat, `Could not detect block submission RPC method, ${JSON.stringify(results)}`);
                return;
            }

            finishedCallback();

        });
    }


    function StartStratumServer(finishedCallback) {
        _this.stratumServer = new stratum.Server(options, authorizeFn);

        _this.stratumServer.on('started', () => {
            options.initStats.stratumPorts = Object.keys(options.ports);
            _this.stratumServer.broadcastMiningJobs(_this.jobManager.currentJob.getJobParams());
            finishedCallback();

        }).on('broadcastTimeout', () => {
            logger.debug(logSystem, logComponent, logSubCat, `No new blocks for ${options.jobRebroadcastTimeout} seconds - updating transactions & rebroadcasting work`);

            GetBlockTemplate((error, rpcData, processedBlock) => {
                if (error || processedBlock) {
                    return;
                }
                // Update transactions & rebroadcast work using the latest template
                if (!rpcData) {
                    return;
                }
                // Avoid duplicate update if this rpcData was already processed by jobManager
                if (_this.jobManager.isRpcDataProcessed && _this.jobManager.isRpcDataProcessed(rpcData)) {
                    return;
                }
                _this.jobManager.updateCurrentJob(rpcData);
            });

        }).on('client.connected', (client) => {
            if (typeof (_this.varDiff[client.socket.localPort]) !== 'undefined') {
                _this.varDiff[client.socket.localPort].manageClient(client);
            }

            client.on('difficultyChanged', (diff) => {
                _this.emit('difficultyUpdate', client.workerName, diff);

            }).on('subscription', function (params, resultCallback) {

                const extraNonce = _this.jobManager.extraNonceCounter.next();
                resultCallback(null,
                    extraNonce,
                    extraNonce
                );

                if (typeof (options.ports[client.socket.localPort]) !== 'undefined' && options.ports[client.socket.localPort].diff) {
                    this.sendDifficulty(options.ports[client.socket.localPort].diff);
                } else {
                    this.sendDifficulty(8);
                }

                this.sendMiningJob(_this.jobManager.currentJob.getJobParams());

            }).on('submit', (params, resultCallback) => {
                const result = _this.jobManager.processShare(
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
                logger.warn(logSystem, logComponent, logSubCat, `Malformed message from ${client.getLabel()}: ${message}`);

            }).on('socketError', (err) => {
                logger.warn(logSystem, logComponent, logSubCat, `Socket error from ${client.getLabel()}: ${JSON.stringify(err)}`);

            }).on('socketTimeout', (reason) => {
                logger.warn(logSystem, logComponent, logSubCat, `Connected timed out for ${client.getLabel()}: ${reason}`);

            }).on('socketDisconnect', () => {
                //logger.debug(logSystem, logComponent, logSubCat, 'Socket disconnected from ' + client.getLabel());

            }).on('kickedBannedIP', (remainingBanTime) => {
                logger.debug(logSystem, logComponent, logSubCat, `Rejected incoming connection from ${client.remoteAddress} banned for ${remainingBanTime} more seconds`);

            }).on('forgaveBannedIP', () => {
                logger.debug(logSystem, logComponent, logSubCat, `Forgave banned IP ${client.remoteAddress}`);

            }).on('unknownStratumMethod', (fullMessage) => {
                logger.debug(logSystem, logComponent, logSubCat, `Unknown stratum method from ${client.getLabel()}: ${fullMessage.method}`);

            }).on('socketFlooded', () => {
                logger.warn(logSystem, logComponent, logSubCat, `Detected socket flooding from ${client.getLabel()}`);

            }).on('tcpProxyError', (data) => {
                logger.error(logSystem, logComponent, logSubCat, `Client IP detection failed, tcpProxyProtocol is enabled yet did not receive proxy protocol message, instead got data: ${data}`);

            }).on('bootedBannedWorker', () => {
                logger.warn(logSystem, logComponent, logSubCat, `Booted worker ${client.getLabel()} who was connected from an IP address that was just banned`);

            }).on('triggerBan', (reason) => {
                logger.warn(logSystem, logComponent, logSubCat, `Banned triggered for ${client.getLabel()}: ${reason}`);
                _this.emit('banIP', client.remoteAddress, client.workerName);
            });
        });
    }


    function SetupBlockPolling() {
        if (typeof options.blockRefreshInterval !== 'number' || options.blockRefreshInterval <= 0) {
            logger.debug(logSystem, logComponent, logSubCat, 'Block template polling has been disabled');
            return;
        }

        const pollingInterval = options.blockRefreshInterval;

        blockPollingIntervalId = setInterval(() => {
            GetBlockTemplate((error, rpcData, newJob) => {
                if (newJob) {
                    logger.debug(logSystem, logComponent, logSubCat, 'Block update via RPC polling');
                }
            });
        }, pollingInterval);
    }


    function GetBlockTemplate(callback) {
        // used to dedupe identical getblocktemplate responses coming from
        // multiple daemon instances when daemon.cmd is run with streamResults=true
        const processedGbtKeys = new Set();

        function getCurrentBlockHeight() {
            _this.daemon.cmd('getblockcount',
                [],
                (result) => {
                    const next = parseInt(result[0].response);
                    getBlockSubsidyandTemplate(next + 1);
                });
        }

        function getBlockSubsidyandTemplate(next_height) {
            _this.daemon.cmd('getblocksubsidy',
                [],
                (result) => {
                    if (result.error) {
                        callback(result.error);
                    } else {
                        getBlockTemplate(next_height, result[0].response);
                    }
                });
        }

        function getBlockTemplate(next_height, subsidy) {
            const gbtFunction = 'getblocktemplate';
            const gbtArgs = { 'capabilities': ['coinbasetxn', 'workid', 'coinbase/append'] };
            _this.daemon.cmd(gbtFunction,
                [gbtArgs],
                (result) => {
                    // results may stream from multiple daemon instances; dedupe identical payloads
                    try {
                        const key = result.response && result.response.previousblockhash ? `${result.response.previousblockhash}_${result.response.curtime}` : null;
                        if (key && processedGbtKeys.has(key)) {
                            // ignore duplicate streamed result
                            return;
                        }
                        if (key) {
                            processedGbtKeys.add(key);
                        }
                    } catch (e) { }

                    if (result.error) {
                        logger.error(logSystem, logComponent, logSubCat, `getblocktemplate call failed for daemon instance ${result.instance.index} with error ${JSON.stringify(result.error)}`);
                        callback(result.error);
                    } else {

                        result.response.miner = subsidy.miner;
                        result.response.founders = (subsidy.founders || subsidy.community);

                        // I hate to do this but vision coin doesn't send the
                        // correct response for getblocksubsidy so this allows
                        // us to override.
                        if (options.coin.rewardMinersPercent) {
                            result.response.miner = options.coin.blockReward * options.coin.rewardMinersPercent;
                        }

                        if (options.coin.rewardFoundersPercent) {
                            result.response.founders = options.coin.blockReward * options.coin.rewardFoundersPercent;
                        }

                        result.response.securenodes = (subsidy.securenodes || 0);
                        result.response.supernodes = (subsidy.supernodes || 0);

                        const processedNewBlock = _this.jobManager.processTemplate(result.response);
                        callback(null, result.response, processedNewBlock);
                        callback = () => { };
                    }
                }, true
            );
        }

        function getVerusBlockTemplate() {
            const gbtFunction = 'getblocktemplate';
            const gbtArgs = { 'capabilities': ['coinbasetxn', 'workid', 'coinbase/append'] };
            _this.daemon.cmd(gbtFunction,
                [gbtArgs],
                (result) => {
                    if (result.error) {
                        logger.error(logSystem, logComponent, logSubCat, `getblocktemplate call failed for daemon instance ${result.instance.index} with error ${JSON.stringify(result.error)}`);
                        callback(result.error);
                    } else {

                        result.response.miner = result.response.coinbasetxn.coinbasevalue / 100000000;
                        result.response.founders = 0;
                        result.response.securenodes = 0;
                        result.response.supernodes = 0;

                        const processedNewBlock = _this.jobManager.processTemplate(result.response);
                        callback(null, result.response, processedNewBlock);
                        callback = () => { };
                    }
                }, true
            );
        }

        // If algo is verushash, the daemon will build the block, so there's no need for a blockheight or blocksubsidy.
        if (options.coin.algorithm == 'verushash') {
            getVerusBlockTemplate();
        } else {
            getCurrentBlockHeight();
        }
    }


    function CheckBlockAccepted(blockHash, callback) {
        //setTimeout(function(){
        _this.daemon.cmd('getblock',
            [blockHash],
            (results) => {
                const validResults = results.filter((result) => {
                    return result.response && (result.response.hash === blockHash);
                });
                // do we have any results?
                if (validResults.length >= 1) {
                    // check for invalid blocks with negative confirmations
                    if (validResults[0].response.confirmations >= 0) {
                        // accepted valid block!
                        callback(true, validResults[0].response.tx[0]);
                    } else {
                        // reject invalid block, due to confirmations
                        callback(false, { 'confirmations': validResults[0].response.confirmations });
                    }
                    return;
                }
                // invalid block, rejected
                callback(false, { 'unknown': 'check coin daemon logs' });
            }
        );
    }


    /**
     * This method is being called from the blockNotify so that when a new block is discovered by the daemon
     * We can inform our miners about the newly found block
     **/
    this.processBlockNotify = function (blockHash, sourceTrigger) {
        logger.warn(logSystem, logComponent, logSubCat, `Block notification via ${sourceTrigger}:  now working on ${parseInt(_this.jobManager.currentJob.rpcData.height) + 1}`);
        if (typeof (_this.jobManager) !== 'undefined' &&
            typeof (_this.jobManager.currentJob) !== 'undefined' &&
            //typeof(_this.jobManager.currentJob.rpcData.previousblockhash) !== 'undefined' &&
            //blockHash !== _this.jobManager.currentJob.rpcData.previousblockhash) {
            // * Note, on verus, we may get the same block hash because a PBaaS chain has changed
            //         so we need to generate a new block template to get the update ...
            typeof (_this.jobManager.currentJob.rpcData.previousblockhash) !== 'undefined') {
            GetBlockTemplate((error, result) => {
                if (error) {
                    logger.error(logSystem, logComponent, logSubCat, `Block notify error getting block template for ${options.coin.name}`);
                }
            });
        }
    };

    this.relinquishMiners = function (filterFn, resultCback) {
        const origStratumClients = this.stratumServer.getStratumClients();

        const stratumClients = [];
        Object.keys(origStratumClients).forEach((subId) => {
            stratumClients.push({ subId: subId, client: origStratumClients[subId] });
        });
        async.filter(
            stratumClients,
            filterFn,
            (clientsToRelinquish) => {
                clientsToRelinquish.forEach((cObj) => {
                    cObj.client.removeAllListeners();
                    _this.stratumServer.removeStratumClientBySubId(cObj.subId);
                });

                process.nextTick(() => {
                    resultCback(
                        clientsToRelinquish.map(
                            (item) => {
                                return item.client;
                            }
                        )
                    );
                });
            }
        );
    };


    this.attachMiners = function (miners) {
        miners.forEach((clientObj) => {
            _this.stratumServer.manuallyAddStratumClient(clientObj);
        });
        _this.stratumServer.broadcastMiningJobs(_this.jobManager.currentJob.getJobParams());

    };


    this.getStratumServer = function () {
        return _this.stratumServer;
    };


    this.setVarDiff = function (port, varDiffConfig) {
        if (typeof (_this.varDiff[port]) !== 'undefined') {
            _this.varDiff[port].removeAllListeners();
        }
        _this.varDiff[port] = new varDiff(port, varDiffConfig);
        _this.varDiff[port].on('newDifficulty', (client, newDiff) => {

            /* We request to set the newDiff @ the next difficulty retarget
             (which should happen when a new job comes in - AKA BLOCK) */
            client.enqueueNextDifficulty(newDiff);

            /*if (options.varDiff.mode === 'fast'){
             //Send new difficulty, then force miner to use new diff by resending the
             //current job parameters but with the "clean jobs" flag set to false
             //so the miner doesn't restart work and submit duplicate shares
             client.sendDifficulty(newDiff);
             const job = _this.jobManager.currentJob.getJobParams();
             job[8] = false;
             client.sendMiningJob(job);
             }*/

        });
    };

};
pool.prototype.__proto__ = events.EventEmitter.prototype;
