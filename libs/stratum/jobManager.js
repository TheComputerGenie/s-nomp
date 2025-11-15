/**
 * @fileoverview Job Manager for Stratum Mining Pool
 *
 * Manages mining jobs for a stratum mining pool, handling job creation,
 * distribution to miners, share validation, block template management,
 * and duplicate submission detection.
 *
 * @author ComputerGenieCo
 * @version 21.7.3
 * @copyright 2025
 */

const algoProperties = require('./algoProperties.js');
const blockTemplate = require('./blockTemplate.js');
const crypto = require('crypto');
const events = require('events');
const util = require('../utils/util.js');
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

const ExtraNonceCounter = function (configInstanceId) {
    const instanceId = configInstanceId || crypto.randomBytes(4).readUInt32LE(0);
    let counter = instanceId << 27;
    this.next = function () {
        const extraNonce = util.packUInt32BE(Math.abs(counter++));
        return extraNonce.toString('hex');
    };
    this.size = 4;
};

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

/**
 * Job Manager
 *
 * Core component for managing mining jobs in a stratum mining pool. Handles
 * job creation from blockchain templates, distribution to miners, share
 * validation, block detection, and job lifecycle management.
 *
 * Events emitted:
 * - 'newBlock' (blockTemplate) - When a new block template is processed
 * - 'updatedBlock' (blockTemplate, isCleanJob) - When a block template is updated
 * - 'share' (shareData, blockHex) - When a miner submits a share
 *
 * @class JobManager
 * @extends EventEmitter
 * @param {Object} options - Configuration options for the job manager
 * @param {Object} options.coin - Coin configuration including algorithm settings
 * @param {string} options.coin.algorithm - Mining algorithm (e.g., 'verushash', 'equihash')
 * @param {Object} options.coin.parameters - Algorithm-specific parameters
 * @param {Array} options.recipients - List of reward recipients
 * @param {string} options.address - Pool's payout address
 * @param {string} options.poolHex - Pool identifier in hex format
 * @param {number} [options.instanceId] - Unique instance ID for this pool process
 * @param {boolean} [options.acceptOldJobShares=false] - Accept shares for expired jobs
 * @param {boolean} [options.acceptLowDiffShares=false] - Accept low-difficulty shares
 * @param {boolean} [options.emitInvalidBlockHashes=false] - Emit hashes for invalid blocks
 */
class JobManager extends events.EventEmitter {
    #options;
    #jobCounter;
    #shareMultiplier;
    #processedGbtKeys;
    #PROCESSED_GBT_TTL;
    #hashDigest;
    #coinbaseHasher;
    #blockHasher;

    constructor(options) {
        super();
        this.#options = options;
        this.#jobCounter = new JobCounter();
        this.#shareMultiplier = algoProperties.getMultiplier(options.coin.algorithm);
        this.#processedGbtKeys = new Map();
        this.#PROCESSED_GBT_TTL = 15000;
        this.#hashDigest = algoProperties.getHash(options.coin.algorithm, options.coin);
        this.#coinbaseHasher = (function () {
            switch (options.coin.algorithm) {
                default:
                    return util.sha256d;
            }
        })();
        this.#blockHasher = (function () {
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
        this.extraNonceCounter = new ExtraNonceCounter(options.instanceId);
        this.currentJob;
        this.validJobs = {};
        this.lastCleanJob = Date.now();
        this.extraNoncePlaceholder = Buffer.alloc(this.extraNonceCounter.size);
    }

    #isHexString(s) {
        const check = String(s).toLowerCase();
        if (check.length % 2) {
            return false;
        }
        for (let i = 0; i < check.length; i = i + 2) {
            const c = check[i] + check[i + 1];
            if (!this.#isHex(c)) {
                return false;
            }
        }
        return true;
    }

    #isHex(c) {
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
     * Checks if RPC data has already been processed recently.
     *
     * Prevents duplicate processing of identical block templates.
     *
     * @param {Object} rpcData - Block template data from RPC call
     * @param {string} rpcData.previousblockhash - Hash of previous block
     * @param {number} rpcData.curtime - Current blockchain time
     * @returns {boolean} True if this template was processed recently
     */
    isRpcDataProcessed(rpcData) {
        if (!rpcData || !rpcData.previousblockhash) {
            return false;
        }
        const key = `${rpcData.previousblockhash}_${rpcData.curtime}`;
        const ts = this.#processedGbtKeys.get(key);
        if (!ts) {
            return false;
        }
        if ((Date.now() - ts) > this.#PROCESSED_GBT_TTL) {
            this.#processedGbtKeys.delete(key);
            return false;
        }
        return true;
    }

    /**
     * Marks RPC data as processed to prevent duplicate handling.
     *
     * @param {Object} rpcData - Block template data from RPC call
     * @param {string} rpcData.previousblockhash - Hash of previous block
     * @param {number} rpcData.curtime - Current blockchain time
     * @returns {void}
     */
    markRpcDataProcessed(rpcData) {
        if (!rpcData || !rpcData.previousblockhash) {
            return;
        }
        const key = `${rpcData.previousblockhash}_${rpcData.curtime}`;
        this.#processedGbtKeys.set(key, Date.now());
    }

    /**
     * Updates the current job with new RPC data without full reprocessing.
     *
     * Creates a new block template and applies it as an update for efficiency.
     *
     * @param {Object} rpcData - New block template data from blockchain RPC
     * @param {string} rpcData.previousblockhash - Hash of previous block
     * @param {number} rpcData.height - Block height
     * @param {number} rpcData.curtime - Current blockchain time
     * @param {string} rpcData.bits - Difficulty target in compact format
     * @returns {void}
     */
    updateCurrentJob(rpcData) {
        const tmpBlockTemplate = new blockTemplate(
            this.#jobCounter.next(),
            rpcData,
            this.extraNoncePlaceholder,
            this.#options
        );
        this.#applyUpdateFromTemplate(tmpBlockTemplate);
    }

    #applyUpdateFromTemplate(tmpBlockTemplate) {
        let cleanJob = typeof (this.currentJob) === 'undefined';
        if (!cleanJob) {
            if (this.currentJob.prevHashReversed != tmpBlockTemplate.prevHashReversed) {
                cleanJob = true;
            }
            if (this.currentJob.merkleRootReversed != tmpBlockTemplate.merkleRootReversed) {
                cleanJob = true;
            }
            if (this.currentJob.finalSaplingRootHashReversed != tmpBlockTemplate.finalSaplingRootHashReversed) {
                cleanJob = true;
            }
            if (this.currentJob.rpcData.bits != tmpBlockTemplate.rpcData.bits) {
                cleanJob = true;
            }
            if (this.currentJob.rpcData.solution != tmpBlockTemplate.rpcData.solution) {
                cleanJob = true;
            }
        }
        if ((Date.now() - this.lastCleanJob) < 15000) {
            cleanJob = false;
        }
        if (cleanJob) {
            this.lastCleanJob = Date.now();
        }
        this.currentJob = tmpBlockTemplate;
        this.emit('updatedBlock', tmpBlockTemplate, cleanJob);
        this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;
    }

    /**
     * Processes a new block template from the blockchain daemon.
     *
     * Determines whether the template represents a new block, update, or duplicate.
     * Handles deduplication and manages the job lifecycle.
     *
     * @param {Object} rpcData - Block template data from getblocktemplate RPC call
     * @param {number} rpcData.height - Block height
     * @param {string} rpcData.previousblockhash - Hash of previous block
     * @param {number} rpcData.curtime - Current blockchain time
     * @param {string} rpcData.bits - Difficulty target in compact format
     * @param {Array} rpcData.transactions - List of transactions to include
     * @param {string} [rpcData.solution] - Solution format version for Zcash-based coins
     * @returns {boolean} True if a new block was processed, false otherwise
     */
    processTemplate(rpcData) {
        const tmpBlockTemplate = new blockTemplate(
            this.#jobCounter.next(),
            rpcData,
            this.extraNoncePlaceholder,
            this.#options
        );
        let cleanJob = typeof (this.currentJob) === 'undefined';
        if (!cleanJob) {
            if (rpcData.height < this.currentJob.rpcData.height) {
                return false;
            }
            if (this.currentJob.prevHashReversed != tmpBlockTemplate.prevHashReversed) {
                cleanJob = true;
            }
            if (this.currentJob.merkleRootReversed != tmpBlockTemplate.merkleRootReversed) {
                cleanJob = true;
            }
            if (this.currentJob.finalSaplingRootHashReversed != tmpBlockTemplate.finalSaplingRootHashReversed) {
                cleanJob = true;
            }
            if (this.currentJob.rpcData.bits != tmpBlockTemplate.rpcData.bits) {
                cleanJob = true;
            }
            if (this.currentJob.rpcData.solution != tmpBlockTemplate.rpcData.solution) {
                cleanJob = true;
            }
        }
        if (!cleanJob) {
            return false;
        }
        const newBlock = !this.currentJob || (rpcData.height !== this.currentJob.rpcData.height);
        if (!newBlock) {
            this.#applyUpdateFromTemplate(tmpBlockTemplate);
            this.markRpcDataProcessed(tmpBlockTemplate.rpcData);
            return false;
        }
        this.currentJob = tmpBlockTemplate;
        this.lastCleanJob = Date.now();
        this.validJobs = {};
        this.emit('newBlock', tmpBlockTemplate);
        this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;
        this.markRpcDataProcessed(tmpBlockTemplate.rpcData);
        return true;
    }

    /**
     * Processes and validates a submitted share from a miner.
     *
     * Validates the submission, checks for duplicates, verifies proof-of-work,
     * determines if it qualifies as a block, and emits appropriate events.
     *
     * @param {string} jobId - Unique identifier for the mining job
     * @param {number} previousDifficulty - Previous difficulty for vardiff transitions
     * @param {number} difficulty - Current target difficulty for this miner
     * @param {string} extraNonce1 - Pool-assigned extra nonce
     * @param {string} extraNonce2 - Miner-chosen extra nonce
     * @param {string} nTime - Block timestamp in hex format (8 characters)
     * @param {string} nonce - Mining nonce in hex format (64 characters)
     * @param {string} ipAddress - Miner's IP address for logging
     * @param {number} port - Connection port for logging
     * @param {string} workerName - Miner/worker identifier
     * @param {string} soln - Equihash/VerusHash solution
     * @returns {Object} Result object with success/error status and block hash if found
     * @returns {boolean} returns.result - True if share was accepted
     * @returns {Array|null} returns.error - Error array [code, message] or null
     * @returns {string|null} returns.blockHash - Block hash if block was found
     */
    processShare(jobId, previousDifficulty, difficulty, extraNonce1, extraNonce2, nTime, nonce, ipAddress, port, workerName, soln) {
        const shareError = (error) => {
            this.emit('share', {
                job: jobId,
                ip: ipAddress,
                worker: workerName,
                difficulty: difficulty,
                error: error[1]
            });
            return { error: error, result: null };
        };
        const submitTime = Date.now() / 1000 | 0;
        const job = this.validJobs[jobId];
        if (typeof job === 'undefined' || job.jobId != jobId) {
            if (this.#options.acceptOldJobShares) {
                this.emit('share', {
                    job: jobId,
                    ip: ipAddress,
                    port: port,
                    worker: workerName,
                    height: this.currentJob ? this.currentJob.rpcData.height : 0,
                    blockReward: this.currentJob ? this.currentJob.rpcData.reward : 0,
                    difficulty: difficulty,
                    shareDiff: difficulty.toFixed(8),
                    blockDiff: this.currentJob ? this.currentJob.difficulty : 0,
                    blockDiffActual: this.currentJob ? this.currentJob.difficulty : 0,
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
        const nTimeInt = parseInt(nTime.slice(6, 8) + nTime.slice(4, 6) + nTime.slice(2, 4) + nTime.slice(0, 2), 16);
        if (Number.isNaN(nTimeInt)) {
            return shareError([20, 'invalid ntime']);
        }
        if (nTimeInt != job.rpcData.curtime) {
            return shareError([20, 'ntime out of range']);
        }
        if (nonce.length !== 64) {
            console.log('incorrect size of nonce');
            return shareError([20, 'incorrect size of nonce']);
        }
        let parameters = this.#options.coin.parameters;
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
        if (soln.slice(6, 14) !== job.rpcData.solution.slice(0, 8)) {
            console.log(`Error: Incorrect solution version (${soln.slice(6, 14)}), expected ${job.rpcData.solution.slice(0, 8)}`);
            return shareError([20, `invalid solution version (${soln.slice(6, 14)}), expected ${job.rpcData.solution.slice(0, 8)}`]);
        }
        if (!this.#isHexString(extraNonce2)) {
            console.log('invalid hex in extraNonce2');
            return shareError([20, 'invalid hex in extraNonce2']);
        }
        if (!job.registerSubmit(nonce, soln)) {
            return shareError([22, 'duplicate share']);
        }
        const solution_ver = parseInt(util.reverseBuffer(Buffer.from(job.rpcData.solution.substr(0, 8), 'hex')).toString('hex'), 16);
        if (solution_ver > 6) {
            nonce = undefined;
            const solExtraData = soln.substr(-30);
            if (solExtraData.indexOf(extraNonce1) < 0) {
                return shareError([20, 'invalid solution, pool nonce missing']);
            }
        }
        const headerBuffer = job.serializeHeader(nTime, nonce);
        const headerSolnBuffer = Buffer.concat([headerBuffer, Buffer.from(soln, 'hex')]);
        let headerHash;
        switch (this.#options.coin.algorithm) {
            case 'verushash':
                if (job.rpcData.version > 4 && job.rpcData.solution !== undefined) {
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
                headerHash = util.sha256d(headerSolnBuffer);
                break;
        }
        const headerBigInt = this.#bufferToBigIntLE(headerHash);
        let blockHashInvalid;
        let blockHash;
        let blockHex;
        const headerNumApprox = this.#bigIntToNumberSafe(headerBigInt);
        const shareDiff = diff1 / headerNumApprox * this.#shareMultiplier;
        const blockDiffAdjusted = job.difficulty * this.#shareMultiplier;
        if (this.#hashDigest(headerBuffer, Buffer.from(soln.slice(solutionSlice), 'hex')) !== true) {
            return shareError([20, 'invalid solution']);
        }
        let isOnlyPBaaS = false;
        let target = job.target;
        if (job.merged_target) {
            target = job.merged_target;
        }
        const targetBigInt = this.#anyToBigInt(target);
        const jobTargetBigInt = this.#anyToBigInt(job.target);
        if (headerBigInt <= targetBigInt) {
            blockHex = job.serializeBlock(headerBuffer, Buffer.from(soln, 'hex')).toString('hex');
            blockHash = util.reverseBuffer(headerHash).toString('hex');
            if (!(headerBigInt <= jobTargetBigInt)) {
                isOnlyPBaaS = true;
            }
        } else {
            if (this.#options.emitInvalidBlockHashes) {
                blockHashInvalid = util.reverseBuffer(util.sha256d(headerSolnBuffer)).toString('hex');
            }
            if (shareDiff / difficulty < 0.99) {
                if (previousDifficulty && shareDiff >= previousDifficulty) {
                    difficulty = previousDifficulty;
                } else {
                    if (!this.#options.acceptLowDiffShares) {
                        return shareError([23, `low difficulty share of ${shareDiff}`]);
                    }
                }
            }
        }
        this.emit('share', {
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
    }

    #bufferToBigIntLE(buf) {
        let res = 0n;
        for (let i = buf.length - 1; i >= 0; i--) {
            res = (res << 8n) + BigInt(buf[i]);
        }
        return res;
    }

    #bigIntToNumberSafe(big) {
        const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
        if (big <= maxSafe) {
            return Number(big);
        }
        const hexLen = big.toString(16).length;
        const nibbleShift = Math.max(0, hexLen - 12);
        const shiftBits = BigInt(nibbleShift) * 4n;
        const shifted = big >> shiftBits;
        return Number(shifted) * Math.pow(2, Number(shiftBits));
    }

    #anyToBigInt(v) {
        if (v === undefined || v === null) {
            return 0n;
        }
        if (typeof v === 'bigint') {
            return v;
        }
        if (typeof v === 'number') {
            return BigInt(v);
        }
        if (Buffer.isBuffer(v)) {
            return this.#bufferToBigIntLE(v);
        }
        if (typeof v === 'string') {
            const buf = Buffer.from(v, 'hex');
            return this.#bufferToBigIntLE(buf);
        }
        try {
            const s = v.toString();
            if (/^[0-9]+$/.test(s)) {
                return BigInt(s);
            }
            const buf = Buffer.from(s, 'hex');
            return this.#bufferToBigIntLE(buf);
        } catch (e) {
            return 0n;
        }
    }
}

module.exports = JobManager;
