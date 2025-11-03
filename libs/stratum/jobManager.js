const events = require('events');
const crypto = require('crypto');

const bignum = require('bignum');

const util = require('./util.js');
const blockTemplate = require('./blockTemplate.js');

const vh = require('../verushash/build/Release/verushash.node');

const EH_PARAMS_MAP = {
    '144_5': {
        SOLUTION_LENGTH: 202,
        SOLUTION_SLICE: 2,
    },
    '192_7': {
        SOLUTION_LENGTH: 806,
        SOLUTION_SLICE: 6,
    },
    '200_9': {
        SOLUTION_LENGTH: 2694,
        SOLUTION_SLICE: 6,
    }
};

//Unique extranonce per subscriber
const ExtraNonceCounter = function (configInstanceId) {
    const instanceId = configInstanceId || crypto.randomBytes(4).readUInt32LE(0);
    let counter = instanceId << 27;
    this.next = function () {
        const extraNonce = util.packUInt32BE(Math.abs(counter++));
        return extraNonce.toString('hex');
    };
    this.size = 4; //bytes
};

//Unique job per new block template
const JobCounter = function () {
    let counter = 0x0000cccc;

    this.next = function () {
        counter++;
        if (counter % 0xffffffffff === 0) {
            counter = 1;
        }
        return this.cur();
    };

    this.cur = function () {
        return counter.toString(16);
    };
};
function isHexString(s) {
    const check = String(s).toLowerCase();
    if (check.length % 2) {
        return false;
    }
    for (i = 0; i < check.length; i = i + 2) {
        const c = check[i] + check[i + 1];
        if (!isHex(c)) {
            return false;
        }
    }
    return true;
}
function isHex(c) {
    const a = parseInt(c, 16);
    let b = a.toString(16).toLowerCase();
    if (b.length % 2) {
        b = `0${b}`;
    }
    if (b !== c) {
        return false;
    }
    return true;
}

/**
 * Emits:
 * - newBlock(blockTemplate) - When a new block (previously unknown to the JobManager) is added, use this event to broadcast new jobs
 * - share(shareData, blockHex) - When a worker submits a share. It will have blockHex if a block was found
 **/
const JobManager = module.exports = function JobManager(options) {


    //private members

    const _this = this;
    const jobCounter = new JobCounter();

    const shareMultiplier = algos[options.coin.algorithm].multiplier;

    //public members

    this.extraNonceCounter = new ExtraNonceCounter(options.instanceId);

    this.currentJob;
    this.validJobs = {};
    this.lastCleanJob = Date.now();
    // recent processed getblocktemplate keys to dedupe RPC responses across
    // different result objects (key: previousblockhash_curtime -> timestamp)
    const processedGbtKeys = new Map();
    const PROCESSED_GBT_TTL = 15000; // ms

    this.isRpcDataProcessed = function (rpcData) {
        if (!rpcData || !rpcData.previousblockhash) {
            return false;
        }
        const key = `${rpcData.previousblockhash}_${rpcData.curtime}`;
        const ts = processedGbtKeys.get(key);
        if (!ts) {
            return false;
        }
        if ((Date.now() - ts) > PROCESSED_GBT_TTL) {
            processedGbtKeys.delete(key);
            return false;
        }
        return true;
    };

    this.markRpcDataProcessed = function (rpcData) {
        if (!rpcData || !rpcData.previousblockhash) {
            return;
        }
        const key = `${rpcData.previousblockhash}_${rpcData.curtime}`;
        processedGbtKeys.set(key, Date.now());
    };

    const hashDigest = algos[options.coin.algorithm].hash(options.coin);

    const coinbaseHasher = (function () {
        switch (options.coin.algorithm) {
            default:
                return util.sha256d;
        }
    })();


    const blockHasher = (function () {
        switch (options.coin.algorithm) {
            case 'sha1':
                return function (d) {
                    return util.reverseBuffer(util.sha256d(d));
                };
            default:
                return function (d) {
                    return util.reverseBuffer(util.sha256(d));
                };
        }
    })();

    this.updateCurrentJob = function (rpcData) {
        // create and apply an update using a new template
        const tmpBlockTemplate = new blockTemplate(
            jobCounter.next(),
            rpcData,
            _this.extraNoncePlaceholder,
            options.recipients,
            options.address,
            options.poolHex,
            options.coin
        );

        applyUpdateFromTemplate(tmpBlockTemplate);
    };

    // Helper to apply an update using a prepared BlockTemplate instance.
    // This lets callers reuse a single constructed template (avoid double construction).
    function applyUpdateFromTemplate(tmpBlockTemplate) {
        // if any non-canonical data has changed, this is a new block template (even if the height didn't change)
        let cleanJob = typeof (_this.currentJob) === 'undefined';
        if (!cleanJob) {
            // check non-canonical data for changes and force clean job
            if (_this.currentJob.prevHashReversed != tmpBlockTemplate.prevHashReversed) {
                cleanJob = true;
            }
            if (_this.currentJob.merkleRootReversed != tmpBlockTemplate.merkleRootReversed) {
                cleanJob = true;
            }
            if (_this.currentJob.finalSaplingRootHashReversed != tmpBlockTemplate.finalSaplingRootHashReversed) {
                cleanJob = true;
            }
            if (_this.currentJob.rpcData.bits != tmpBlockTemplate.rpcData.bits) {
                cleanJob = true;
            }
            if (_this.currentJob.rpcData.solution != tmpBlockTemplate.rpcData.solution) {
                cleanJob = true;
            }
        }
        // do not send too many clean jobs too fast
        if ((Date.now() - _this.lastCleanJob) < 15000) {
            cleanJob = false;
        }
        if (cleanJob) {
            _this.lastCleanJob = Date.now();
        }

        _this.currentJob = tmpBlockTemplate;

        _this.emit('updatedBlock', tmpBlockTemplate, cleanJob);

        _this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;
    }

    //returns true if processed a new block
    this.processTemplate = function (rpcData) {
        // generate template for processing
        const tmpBlockTemplate = new blockTemplate(
            jobCounter.next(),
            rpcData,
            _this.extraNoncePlaceholder,
            options.recipients,
            options.address,
            options.poolHex,
            options.coin
        );
        // if any non-canonical data has changed, this is a new block template (even if the height didn't change)
        let cleanJob = typeof (_this.currentJob) === 'undefined';
        if (!cleanJob) {
            // if outdated block ignore ...
            if (rpcData.height < _this.currentJob.rpcData.height) {
                return false;
            }

            // check non-canonical data for changes and force clean job
            if (_this.currentJob.prevHashReversed != tmpBlockTemplate.prevHashReversed) {
                cleanJob = true;
            }
            if (_this.currentJob.merkleRootReversed != tmpBlockTemplate.merkleRootReversed) {
                cleanJob = true;
            }
            if (_this.currentJob.finalSaplingRootHashReversed != tmpBlockTemplate.finalSaplingRootHashReversed) {
                cleanJob = true;
            }
            if (_this.currentJob.rpcData.bits != tmpBlockTemplate.rpcData.bits) {
                cleanJob = true;
            }
            if (_this.currentJob.rpcData.solution != tmpBlockTemplate.rpcData.solution) {
                cleanJob = true;
            }
        }
        // if not a new clean block template
        if (!cleanJob) {
            return false;
        }

        const newBlock = !this.currentJob || (rpcData.height !== _this.currentJob.rpcData.height);
        if (!newBlock) {
            // reuse the tmpBlockTemplate to apply updates instead of constructing another
            applyUpdateFromTemplate(tmpBlockTemplate);
            // mark the rpcData as processed in a shared map to dedupe other callers
            _this.markRpcDataProcessed(tmpBlockTemplate.rpcData);
            return false;
        }

        // accept new template
        this.currentJob = tmpBlockTemplate;
        this.lastCleanJob = Date.now();

        this.validJobs = {};
        _this.emit('newBlock', tmpBlockTemplate);

        this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;
        // mark rpcData processed so other callers see it's already handled
        _this.markRpcDataProcessed(tmpBlockTemplate.rpcData);

        return true;

    };

    this.processShare = function (jobId, previousDifficulty, difficulty, extraNonce1, extraNonce2, nTime, nonce, ipAddress, port, workerName, soln) {
        const shareError = function (error) {
            _this.emit('share', {
                job: jobId,
                ip: ipAddress,
                worker: workerName,
                difficulty: difficulty,
                error: error[1]
            });
            return { error: error, result: null };
        };

        //console.log('processShare ck1: ', jobId, previousDifficulty, difficulty, extraNonce1, extraNonce2, nTime, nonce, ipAddress, port, workerName, soln)

        const submitTime = Date.now() / 1000 | 0;

        const job = this.validJobs[jobId];

        if (typeof job === 'undefined' || job.jobId != jobId) {
            if (options.acceptOldJobShares) {
                // Accept old job share for hashrate accuracy in solo mining
                _this.emit('share', {
                    job: jobId,
                    ip: ipAddress,
                    port: port,
                    worker: workerName,
                    height: _this.currentJob ? _this.currentJob.rpcData.height : 0,
                    blockReward: _this.currentJob ? _this.currentJob.rpcData.reward : 0,
                    difficulty: difficulty,
                    shareDiff: difficulty.toFixed(8),
                    blockDiff: _this.currentJob ? _this.currentJob.difficulty : 0,
                    blockDiffActual: _this.currentJob ? _this.currentJob.difficulty : 0,
                    blockHash: null,
                    blockHashInvalid: false,
                    blockOnlyPBaaS: false
                }, null);
                return { result: true, error: null };
            } else {
                return shareError([21, 'job not found']);
            }
        }

        if (nTime.length !== 8) {
            console.log('incorrect size of ntime');
            return shareError([20, 'incorrect size of ntime']);
        }

        const nTimeInt = parseInt(nTime.substr(6, 2) + nTime.substr(4, 2) + nTime.substr(2, 2) + nTime.substr(0, 2), 16);

        if (Number.isNaN(nTimeInt)) {
            // console.log('Invalid nTime: ', nTimeInt, nTime)
            return shareError([20, 'invalid ntime']);
        }

        if (nTimeInt != job.rpcData.curtime) {
            // console.log('ntime out of range !(', submitTime + 7200, '<', nTimeInt, '<', job.rpcData.curtime, ') original: ', nTime)
            return shareError([20, 'ntime out of range']);
        }

        // console.log(
        //     'ntime', nTime,
        //     'buffered', util.reverseBuffer(new Buffer(nTime, 'hex')),
        //     'inted', parseInt(util.reverseBuffer(new Buffer(nTime, 'hex')).toString('hex'), 16),
        //     'nTimeInt', nTimeInt,
        //     '(', submitTime + 7200, '<', nTimeInt, '<', job.rpcData.curtime, ')'
        // )

        //console.log('processShare ck3')

        if (nonce.length !== 64) {
            console.log('incorrect size of nonce');
            return shareError([20, 'incorrect size of nonce']);
        }

        /**
         * TODO: This is currently accounting only for equihash. make it smarter.
         */
        let parameters = options.coin.parameters;
        if (!parameters) {
            parameters = {
                N: 200,
                K: 9,
                personalization: 'ZcashPoW'
            };
        }

        const N = parameters.N || 200;
        const K = parameters.K || 9;
        const expectedLength = EH_PARAMS_MAP[`${N}_${K}`].SOLUTION_LENGTH || 2694;
        const solutionSlice = EH_PARAMS_MAP[`${N}_${K}`].SOLUTION_SLICE || 0;

        if (soln.length !== expectedLength) {
            console.log(`Error: Incorrect size of solution (${soln.length}), expected ${expectedLength}`);
            return shareError([20, `Error: Incorrect size of solution (${soln.length}), expected ${expectedLength}`]);
        }
        if (soln.substr(6, 8) !== job.rpcData.solution.substr(0, 8)) {
            console.log(`Error: Incorrect solution version (${soln.substr(6, 8)}), expected ${job.rpcData.solution.substr(0, 8)}`);
            return shareError([20, `invalid solution version (${soln.substr(6, 8)}), expected ${job.rpcData.solution.substr(0, 8)}`]);
        }
        if (!isHexString(extraNonce2)) {
            console.log('invalid hex in extraNonce2');
            return shareError([20, 'invalid hex in extraNonce2']);
        }
        if (!job.registerSubmit(nonce, soln)) {
            return shareError([22, 'duplicate share']);
        }

        // when pbaas activates use block header nonce from daemon, pool/miner can no longer manipulate
        const solution_ver = parseInt(util.reverseBuffer(Buffer.from(job.rpcData.solution.substr(0, 8), 'hex')).toString('hex'), 16);
        if (solution_ver > 6) {
            nonce = undefined;
            // verify pool nonce presence in solution
            const solExtraData = soln.substr(-30);
            if (solExtraData.indexOf(extraNonce1) < 0) {
                return shareError([20, 'invalid solution, pool nonce missing']);
            }
        }

        const headerBuffer = job.serializeHeader(nTime, nonce); // 144 bytes (doesn't contain soln)
        const headerSolnBuffer = Buffer.concat([headerBuffer, Buffer.from(soln, 'hex')]);
        let headerHash;

        switch (options.coin.algorithm) {
            case 'verushash':
                //console.log('processShare ck6a, buffer length: ', headerSolnBuffer.length)
                if (job.rpcData.version > 4 && job.rpcData.solution !== undefined) {
                    // make sure verus solution version matches expected version
                    if (soln.substr(solutionSlice, 2) !== job.rpcData.solution.substr(0, 2)) {
                        return shareError([22, 'invalid solution version']);
                    }

                    if (soln.substr(solutionSlice, 2) == '03') {
                        headerHash = vh.hash2b1(headerSolnBuffer);
                    } else {
                        headerHash = vh.hash2b2(headerSolnBuffer);
                    }
                } else if (job.rpcData.version > 4) {
                    headerHash = vh.hash2b(headerSolnBuffer);
                } else {
                    headerHash = vh.hash(headerSolnBuffer);
                }
                break;
            default:
                //console.log('processShare ck6b')
                headerHash = util.sha256d(headerSolnBuffer);
                break;
        };

        //console.log('processShare ck7')

        const headerBigNum = bignum.fromBuffer(headerHash, { endian: 'little', size: 32 });

        let blockHashInvalid;
        let blockHash;
        let blockHex;

        const shareDiff = diff1 / headerBigNum.toNumber() * shareMultiplier;
        const blockDiffAdjusted = job.difficulty * shareMultiplier;

        //console.log('processShare ck8')

        // check if valid solution
        if (hashDigest(headerBuffer, Buffer.from(soln.slice(solutionSlice), 'hex')) !== true) {
            //console.log('invalid solution');
            return shareError([20, 'invalid solution']);
        }

        // pbaas minimal merged mining target
        let isOnlyPBaaS = false;
        let target = job.target;
        if (job.merged_target) {
            target = job.merged_target;
        }

        //check if block candidate
        if (headerBigNum.le(target)) {
            //console.log('begin serialization');
            blockHex = job.serializeBlock(headerBuffer, Buffer.from(soln, 'hex')).toString('hex');
            blockHash = util.reverseBuffer(headerHash).toString('hex');
            // check if pbaas only submission
            if (!headerBigNum.le(job.target)) {
                isOnlyPBaaS = true;
            }

            //console.log('end serialization');
        } else {
            //console.log('low difficulty share');
            if (options.emitInvalidBlockHashes) {
                blockHashInvalid = util.reverseBuffer(util.sha256d(headerSolnBuffer)).toString('hex');
            }

            //Check if share didn't reached the miner's difficulty)
            if (shareDiff / difficulty < 0.99) {

                //Check if share matched a previous difficulty from before a vardiff retarget
                if (previousDifficulty && shareDiff >= previousDifficulty) {
                    difficulty = previousDifficulty;
                } else {
                    // Allow low-diff shares if configured for solo mining
                    if (!options.acceptLowDiffShares) {
                        return shareError([23, `low difficulty share of ${shareDiff}`]);
                    }
                }
            }
        }

        /*
        console.log('validSoln: ' + hashDigest(headerBuffer, Buffer.from(soln.slice(6), 'hex')));
        console.log('job: ' + jobId);
        console.log('ip: ' + ipAddress);
        console.log('port: ' + port);
        console.log('worker: ' + workerName);
        console.log('height: ' + job.rpcData.height);
        console.log('blockReward: ' + job.rpcData.reward);
        console.log('difficulty: ' + difficulty);
        console.log('shareDiff: ' + shareDiff.toFixed(8));
        console.log('blockDiff: ' + blockDiffAdjusted);
        console.log('blockDiffActual: ' + job.difficulty);
        console.log('blockHash: ' + blockHash);
        console.log('blockHashInvalid: ' + blockHashInvalid);
        */

        _this.emit('share', {
            job: jobId,
            ip: ipAddress,
            port: port,
            worker: workerName,
            height: job.rpcData.height,
            blockReward: job.rpcData.reward,
            difficulty: difficulty,
            shareDiff: shareDiff.toFixed(8),
            blockDiff: blockDiffAdjusted,
            blockDiffActual: job.difficulty,
            blockHash: blockHash,
            blockHashInvalid: blockHashInvalid,
            blockOnlyPBaaS: isOnlyPBaaS
        }, blockHex);

        return { result: true, error: null, blockHash: blockHash };
    };
};
JobManager.prototype.__proto__ = events.EventEmitter.prototype;
