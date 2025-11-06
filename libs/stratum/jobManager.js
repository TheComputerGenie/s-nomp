/**
 * @fileoverview Job Manager for Stratum Mining Pool
 * 
 * This module manages mining jobs for a stratum mining pool, handling:
 * - Job creation and distribution to miners
 * - Share validation and processing
 * - Block template management
 * - Duplicate submission detection
 * - Support for various mining algorithms (particularly VerusHash and Equihash)
 * 
 * The JobManager is responsible for:
 * 1. Creating unique jobs from blockchain templates
 * 2. Validating miner submissions
 * 3. Detecting valid blocks
 * 4. Managing job lifecycle and cleanup
 * 
 * @author Pool Development Team
 * @version 1.0.0
 */

const events = require('events');
const crypto = require('crypto');

// Use native BigInt instead of the old 'bignum' dependency

const util = require('./util.js');
const blockTemplate = require('./blockTemplate.js');
const algos = require('./algoProperties.js');

const vh = require('../verushash/build/Release/verushash.node');

/**
 * Equihash parameter mapping for different algorithm configurations.
 * Maps algorithm parameters (N_K format) to solution properties.
 * 
 * @constant {Object} EH_PARAMS_MAP
 * @property {Object} 144_5 - Parameters for N=144, K=5
 * @property {number} 144_5.SOLUTION_LENGTH - Expected solution length in bytes
 * @property {number} 144_5.SOLUTION_SLICE - Starting position for solution data
 * @property {Object} 192_7 - Parameters for N=192, K=7  
 * @property {Object} 200_9 - Parameters for N=200, K=9 (Zcash standard)
 */
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

/**
 * Generates unique extra nonce values for each mining subscriber.
 * 
 * The extra nonce is used to ensure each miner has a unique search space,
 * preventing duplicate work across miners. Uses instance ID and counter
 * to guarantee uniqueness across pool restarts.
 * 
 * @class ExtraNonceCounter
 * @param {number} [configInstanceId] - Optional instance ID for the pool
 */
const ExtraNonceCounter = function (configInstanceId) {
    /** @private {number} instanceId - Unique identifier for this pool instance */
    const instanceId = configInstanceId || crypto.randomBytes(4).readUInt32LE(0);

    /** @private {number} counter - Incrementing counter, shifted by instance ID */
    let counter = instanceId << 27;

    /**
     * Generates the next unique extra nonce value.
     * 
     * @method next
     * @returns {string} Hex-encoded extra nonce (8 characters)
     */
    this.next = function () {
        const extraNonce = util.packUInt32BE(Math.abs(counter++));
        return extraNonce.toString('hex');
    };

    /** @public {number} size - Size of extra nonce in bytes (always 4) */
    this.size = 4; //bytes
};

/**
 * Generates unique job identifiers for each block template.
 * 
 * Each mining job needs a unique identifier so miners can reference
 * their work when submitting shares. The counter wraps around to prevent
 * overflow and ensure continued operation.
 * 
 * @class JobCounter
 */
const JobCounter = function () {
    /** @private {number} counter - Current job counter value */
    let counter = 0x0000cccc;

    /**
     * Generates the next unique job ID and increments counter.
     * 
     * @method next
     * @returns {string} Hex-encoded job ID
     */
    this.next = function () {
        counter++;
        // Prevent overflow by wrapping counter
        if (counter % 0xffffffffff === 0) {
            counter = 1;
        }
        return this.cur();
    };

    /**
     * Returns the current job ID without incrementing.
     * 
     * @method cur
     * @returns {string} Current hex-encoded job ID
     */
    this.cur = function () {
        return counter.toString(16);
    };
};
/**
 * Validates if a string contains only valid hexadecimal characters.
 * 
 * @function isHexString
 * @param {string} s - String to validate
 * @returns {boolean} True if string is valid hex, false otherwise
 */
function isHexString(s) {
    const check = String(s).toLowerCase();

    // Hex strings must have even length (each byte = 2 hex chars)
    if (check.length % 2) {
        return false;
    }

    // Check each pair of characters
    for (i = 0; i < check.length; i = i + 2) {
        const c = check[i] + check[i + 1];
        if (!isHex(c)) {
            return false;
        }
    }
    return true;
}

/**
 * Validates if a 2-character string is valid hexadecimal.
 * 
 * @function isHex
 * @param {string} c - 2-character string to validate
 * @returns {boolean} True if valid hex pair, false otherwise
 */
function isHex(c) {
    const a = parseInt(c, 16);
    let b = a.toString(16).toLowerCase();

    // Ensure even length with leading zero if needed
    if (b.length % 2) {
        b = `0${b}`;
    }

    // Verify round-trip conversion matches original
    if (b !== c) {
        return false;
    }
    return true;
}

/**
 * Main JobManager class that handles mining job creation, distribution, and share validation.
 * 
 * The JobManager is the core component responsible for:
 * - Creating mining jobs from blockchain templates
 * - Distributing jobs to connected miners
 * - Validating submitted shares
 * - Detecting and processing found blocks
 * - Managing job lifecycle and cleanup
 * 
 * @class JobManager
 * @extends EventEmitter
 * 
 * @param {Object} options - Configuration options for the job manager
 * @param {Object} options.coin - Coin configuration including algorithm settings
 * @param {string} options.coin.algorithm - Mining algorithm (e.g., 'verushash', 'equihash')
 * @param {Object} options.coin.parameters - Algorithm-specific parameters (N, K, personalization)
 * @param {Array} options.recipients - List of reward recipients and percentages
 * @param {string} options.address - Pool's payout address
 * @param {string} options.poolHex - Pool identifier in hex format
 * @param {number} [options.instanceId] - Unique instance ID for this pool process
 * @param {boolean} [options.acceptOldJobShares=false] - Whether to accept shares for expired jobs
 * @param {boolean} [options.acceptLowDiffShares=false] - Whether to accept low-difficulty shares
 * @param {boolean} [options.emitInvalidBlockHashes=false] - Whether to emit hashes for invalid blocks
 * 
 * @fires JobManager#newBlock - Emitted when a new block template is received
 * @fires JobManager#updatedBlock - Emitted when an existing block template is updated  
 * @fires JobManager#share - Emitted when a worker submits a share (valid or invalid)
 * 
 * @example
 * const jobManager = new JobManager({
 *   coin: { algorithm: 'verushash', parameters: { N: 200, K: 9 } },
 *   recipients: [{ address: 'pool_address', percent: 0.02 }],
 *   address: 'pool_payout_address',
 *   poolHex: '4e4f4d50',
 *   instanceId: 12345
 * });
 */
const JobManager = module.exports = function JobManager(options) {

    // Private members

    /** @private {JobManager} _this - Reference to this instance for closures */
    const _this = this;

    /** @private {JobCounter} jobCounter - Generates unique job IDs */
    const jobCounter = new JobCounter();

    /** @private {number} shareMultiplier - Algorithm-specific difficulty multiplier */
    const shareMultiplier = algos[options.coin.algorithm].multiplier;

    // Public members

    /** 
     * @public {ExtraNonceCounter} extraNonceCounter - Generates unique extra nonces for miners
     */
    this.extraNonceCounter = new ExtraNonceCounter(options.instanceId);

    /** 
     * @public {Object} currentJob - Currently active block template job
     * @property {string} jobId - Unique identifier for this job
     * @property {Object} rpcData - Raw data from blockchain RPC
     * @property {Buffer} target - Difficulty target for this block
     */
    this.currentJob;

    /** 
     * @public {Object.<string, Object>} validJobs - Map of active job IDs to job objects
     */
    this.validJobs = {};

    /** 
     * @public {number} lastCleanJob - Timestamp of last clean job sent to miners
     */
    this.lastCleanJob = Date.now();

    /**
     * @public {Buffer} extraNoncePlaceholder - Placeholder for extra nonce in coinbase
     */
    this.extraNoncePlaceholder = Buffer.alloc(this.extraNonceCounter.size);

    /**
     * Cache for recently processed getblocktemplate keys to dedupe RPC responses.
     * Maps "previousblockhash_curtime" -> timestamp to avoid processing identical templates.
     * 
     * @private {Map<string, number>} processedGbtKeys
     */
    const processedGbtKeys = new Map();

    /** @private {number} PROCESSED_GBT_TTL - Time-to-live for processed GBT cache entries (15 seconds) */
    const PROCESSED_GBT_TTL = 15000; // ms

    /**
     * Checks if RPC data has already been processed recently.
     * 
     * This prevents duplicate processing of identical block templates
     * that may be received from multiple RPC calls or daemon notifications.
     * 
     * @method isRpcDataProcessed
     * @param {Object} rpcData - Block template data from RPC call
     * @param {string} rpcData.previousblockhash - Hash of previous block
     * @param {number} rpcData.curtime - Current blockchain time
     * @returns {boolean} True if this template was processed recently
     */
    this.isRpcDataProcessed = function (rpcData) {
        if (!rpcData || !rpcData.previousblockhash) {
            return false;
        }

        // Create unique key from block hash and time
        const key = `${rpcData.previousblockhash}_${rpcData.curtime}`;
        const ts = processedGbtKeys.get(key);

        if (!ts) {
            return false;
        }

        // Check if entry has expired
        if ((Date.now() - ts) > PROCESSED_GBT_TTL) {
            processedGbtKeys.delete(key);
            return false;
        }

        return true;
    };

    /**
     * Marks RPC data as processed to prevent duplicate handling.
     * 
     * @method markRpcDataProcessed  
     * @param {Object} rpcData - Block template data from RPC call
     * @param {string} rpcData.previousblockhash - Hash of previous block
     * @param {number} rpcData.curtime - Current blockchain time
     */
    this.markRpcDataProcessed = function (rpcData) {
        if (!rpcData || !rpcData.previousblockhash) {
            return;
        }

        const key = `${rpcData.previousblockhash}_${rpcData.curtime}`;
        processedGbtKeys.set(key, Date.now());
    };

    /** 
     * @private {Function} hashDigest - Algorithm-specific hash validation function
     */
    const hashDigest = algos[options.coin.algorithm].hash(options.coin);

    /**
     * Algorithm-specific coinbase transaction hasher.
     * Most algorithms use double SHA256 for coinbase hashing.
     * 
     * @private {Function} coinbaseHasher - Function to hash coinbase transactions
     */
    const coinbaseHasher = (function () {
        switch (options.coin.algorithm) {
            default:
                return util.sha256d; // Double SHA256 is the standard
        }
    })();

    /**
     * Algorithm-specific block header hasher.
     * Different algorithms may require different hashing approaches.
     * 
     * @private {Function} blockHasher - Function to hash block headers
     */
    const blockHasher = (function () {
        switch (options.coin.algorithm) {
            case 'sha1':
                return function (d) {
                    // SHA1 coins use double SHA256 then reverse
                    return util.reverseBuffer(util.sha256d(d));
                };
            default:
                return function (d) {
                    // Standard coins use single SHA256 then reverse
                    return util.reverseBuffer(util.sha256(d));
                };
        }
    })();

    /**
     * Updates the current job with new RPC data without full reprocessing.
     * 
     * This method creates a new block template and applies it as an update,
     * which is more efficient than full template processing when only
     * minor changes have occurred.
     * 
     * @method updateCurrentJob
     * @param {Object} rpcData - New block template data from blockchain RPC
     * @param {string} rpcData.previousblockhash - Hash of previous block
     * @param {number} rpcData.height - Block height
     * @param {number} rpcData.curtime - Current blockchain time
     * @param {string} rpcData.bits - Difficulty target in compact format
     */
    this.updateCurrentJob = function (rpcData) {
        // Create new template with updated data
        const tmpBlockTemplate = new blockTemplate(
            jobCounter.next(),
            rpcData,
            _this.extraNoncePlaceholder,
            options.recipients,
            options.address,
            options.poolHex,
            options.coin
        );

        // Apply the template as an update to current job
        applyUpdateFromTemplate(tmpBlockTemplate);
    };

    /**
     * Helper function to apply an update using a prepared BlockTemplate instance.
     * 
     * This function determines whether a clean job is needed based on changes
     * in critical block template data. Clean jobs force miners to restart their
     * work, so they should only be sent when necessary.
     * 
     * A clean job is required when:
     * - Previous block hash changes (new block found)
     * - Merkle root changes (transactions updated)
     * - Sapling root hash changes (shielded transactions)
     * - Difficulty target changes
     * - Solution version changes (protocol updates)
     * 
     * @private
     * @function applyUpdateFromTemplate
     * @param {Object} tmpBlockTemplate - Prepared block template to apply
     */
    function applyUpdateFromTemplate(tmpBlockTemplate) {
        // Assume clean job if no current job exists
        let cleanJob = typeof (_this.currentJob) === 'undefined';

        if (!cleanJob) {
            // Check critical fields that require clean job when changed
            if (_this.currentJob.prevHashReversed != tmpBlockTemplate.prevHashReversed) {
                cleanJob = true; // New block found
            }
            if (_this.currentJob.merkleRootReversed != tmpBlockTemplate.merkleRootReversed) {
                cleanJob = true; // Transaction set changed
            }
            if (_this.currentJob.finalSaplingRootHashReversed != tmpBlockTemplate.finalSaplingRootHashReversed) {
                cleanJob = true; // Shielded transaction changes
            }
            if (_this.currentJob.rpcData.bits != tmpBlockTemplate.rpcData.bits) {
                cleanJob = true; // Difficulty retarget
            }
            if (_this.currentJob.rpcData.solution != tmpBlockTemplate.rpcData.solution) {
                cleanJob = true; // Solution format/version change
            }
        }

        // Rate limit clean jobs to prevent spam (max one per 15 seconds)
        if ((Date.now() - _this.lastCleanJob) < 15000) {
            cleanJob = false;
        }

        if (cleanJob) {
            _this.lastCleanJob = Date.now();
        }

        // Update current job and notify listeners
        _this.currentJob = tmpBlockTemplate;
        _this.emit('updatedBlock', tmpBlockTemplate, cleanJob);

        // Add to valid jobs list for share validation
        _this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;
    }

    /**
     * Processes a new block template from the blockchain daemon.
     * 
     * This is the main entry point for handling new block templates. It determines
     * whether the template represents a new block, an update to existing block,
     * or should be ignored. The function handles deduplication and manages the
     * job lifecycle appropriately.
     * 
     * @method processTemplate
     * @param {Object} rpcData - Block template data from getblocktemplate RPC call
     * @param {number} rpcData.height - Block height
     * @param {string} rpcData.previousblockhash - Hash of previous block
     * @param {number} rpcData.curtime - Current blockchain time  
     * @param {string} rpcData.bits - Difficulty target in compact format
     * @param {Array} rpcData.transactions - List of transactions to include
     * @param {string} [rpcData.solution] - Solution format version for Zcash-based coins
     * @returns {boolean} True if a new block was processed, false otherwise
     */
    this.processTemplate = function (rpcData) {
        // Create new block template for processing
        const tmpBlockTemplate = new blockTemplate(
            jobCounter.next(),
            rpcData,
            _this.extraNoncePlaceholder,
            options.recipients,
            options.address,
            options.poolHex,
            options.coin
        );

        // Determine if this requires a clean job (forces miner restart)
        let cleanJob = typeof (_this.currentJob) === 'undefined';

        if (!cleanJob) {
            // Ignore outdated blocks (blockchain reorganization protection)
            if (rpcData.height < _this.currentJob.rpcData.height) {
                return false;
            }

            // Check critical fields for changes requiring clean job
            if (_this.currentJob.prevHashReversed != tmpBlockTemplate.prevHashReversed) {
                cleanJob = true; // Previous block changed
            }
            if (_this.currentJob.merkleRootReversed != tmpBlockTemplate.merkleRootReversed) {
                cleanJob = true; // Transaction set changed
            }
            if (_this.currentJob.finalSaplingRootHashReversed != tmpBlockTemplate.finalSaplingRootHashReversed) {
                cleanJob = true; // Sapling transactions changed
            }
            if (_this.currentJob.rpcData.bits != tmpBlockTemplate.rpcData.bits) {
                cleanJob = true; // Difficulty changed
            }
            if (_this.currentJob.rpcData.solution != tmpBlockTemplate.rpcData.solution) {
                cleanJob = true; // Solution version changed
            }
        }

        // If no clean job needed, this is likely a duplicate or minor update
        if (!cleanJob) {
            return false;
        }

        // Check if this is truly a new block (height change) or just an update
        const newBlock = !this.currentJob || (rpcData.height !== _this.currentJob.rpcData.height);

        if (!newBlock) {
            // Same block height - apply as update rather than new block
            applyUpdateFromTemplate(tmpBlockTemplate);
            _this.markRpcDataProcessed(tmpBlockTemplate.rpcData);
            return false;
        }

        // This is a genuinely new block - full reset required
        this.currentJob = tmpBlockTemplate;
        this.lastCleanJob = Date.now();

        // Clear all old jobs since they're now invalid
        this.validJobs = {};

        // Notify listeners of new block
        _this.emit('newBlock', tmpBlockTemplate);

        // Add new job to valid jobs list
        this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;

        // Mark this template as processed to prevent duplicate handling
        _this.markRpcDataProcessed(tmpBlockTemplate.rpcData);

        return true;
    };

    /**
     * Processes and validates a submitted share from a miner.
     * 
     * This is the core share validation function that:
     * 1. Validates the submission format and parameters
     * 2. Checks for duplicate submissions
     * 3. Verifies the proof-of-work solution
     * 4. Determines if the share qualifies as a block
     * 5. Calculates share difficulty and rewards
     * 6. Emits appropriate events for logging and processing
     * 
     * @method processShare
     * @param {string} jobId - Unique identifier for the mining job
     * @param {number} previousDifficulty - Previous difficulty (for vardiff transitions)
     * @param {number} difficulty - Current target difficulty for this miner
     * @param {string} extraNonce1 - Pool-assigned extra nonce (unique per miner)
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
    this.processShare = function (jobId, previousDifficulty, difficulty, extraNonce1, extraNonce2, nTime, nonce, ipAddress, port, workerName, soln) {
        /**
         * Helper function to handle share errors consistently.
         * Emits share event with error details and returns standardized error response.
         * 
         * @private
         * @function shareError
         * @param {Array} error - Error array containing [code, message]
         * @returns {Object} Standardized error response
         */
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

        // Record submission timestamp for logging and validation
        const submitTime = Date.now() / 1000 | 0;

        // Look up the job this share corresponds to
        const job = this.validJobs[jobId];

        // Validate job exists and is still valid
        if (typeof job === 'undefined' || job.jobId != jobId) {
            if (options.acceptOldJobShares) {
                // Accept expired job shares for hashrate accuracy in solo mining
                // This helps maintain accurate hashrate statistics even when jobs expire quickly
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

        // Validate nTime format (must be exactly 8 hex characters)
        if (nTime.length !== 8) {
            console.log('incorrect size of ntime');
            return shareError([20, 'incorrect size of ntime']);
        }

        // Convert little-endian hex string to integer
        // nTime format: bytes are reversed, so we rebuild in correct order
        const nTimeInt = parseInt(nTime.substr(6, 2) + nTime.substr(4, 2) + nTime.substr(2, 2) + nTime.substr(0, 2), 16);

        // Validate nTime conversion was successful
        if (Number.isNaN(nTimeInt)) {
            return shareError([20, 'invalid ntime']);
        }

        // Validate nTime matches the job's expected time
        // This prevents miners from manipulating timestamps
        if (nTimeInt != job.rpcData.curtime) {
            return shareError([20, 'ntime out of range']);
        }

        // Validate nonce format (must be exactly 64 hex characters = 32 bytes)
        if (nonce.length !== 64) {
            console.log('incorrect size of nonce');
            return shareError([20, 'incorrect size of nonce']);
        }

        // Get algorithm parameters for solution validation
        // Default to Zcash Equihash parameters if not specified
        let parameters = options.coin.parameters;
        if (!parameters) {
            parameters = {
                N: 200,    // Memory parameter
                K: 9,      // Time parameter  
                personalization: 'ZcashPoW'
            };
        }

        const N = parameters.N || 200;
        const K = parameters.K || 9;

        // Look up expected solution format based on N,K parameters
        const expectedLength = EH_PARAMS_MAP[`${N}_${K}`].SOLUTION_LENGTH || 2694;
        const solutionSlice = EH_PARAMS_MAP[`${N}_${K}`].SOLUTION_SLICE || 0;

        // Validate solution length matches algorithm requirements
        if (soln.length !== expectedLength) {
            console.log(`Error: Incorrect size of solution (${soln.length}), expected ${expectedLength}`);
            return shareError([20, `Error: Incorrect size of solution (${soln.length}), expected ${expectedLength}`]);
        }

        // Validate solution version matches job requirements
        // This ensures compatibility with protocol upgrades
        if (soln.substr(6, 8) !== job.rpcData.solution.substr(0, 8)) {
            console.log(`Error: Incorrect solution version (${soln.substr(6, 8)}), expected ${job.rpcData.solution.substr(0, 8)}`);
            return shareError([20, `invalid solution version (${soln.substr(6, 8)}), expected ${job.rpcData.solution.substr(0, 8)}`]);
        }

        // Validate extraNonce2 is proper hex format
        if (!isHexString(extraNonce2)) {
            console.log('invalid hex in extraNonce2');
            return shareError([20, 'invalid hex in extraNonce2']);
        }

        // Check for duplicate submissions (same nonce + solution combination)
        // This prevents miners from submitting the same work multiple times
        if (!job.registerSubmit(nonce, soln)) {
            return shareError([22, 'duplicate share']);
        }

        // Handle PBaaS (Public Blockchains as a Service) protocol changes
        // In PBaaS v7+, the daemon controls the block header nonce, not the pool/miner
        const solution_ver = parseInt(util.reverseBuffer(Buffer.from(job.rpcData.solution.substr(0, 8), 'hex')).toString('hex'), 16);

        if (solution_ver > 6) {
            // PBaaS v7+ uses daemon-controlled nonce, ignore miner nonce
            nonce = undefined;

            // Verify the pool's extra nonce is embedded in the solution
            // This ensures the pool gets credit for work done by its miners
            const solExtraData = soln.substr(-30);
            if (solExtraData.indexOf(extraNonce1) < 0) {
                return shareError([20, 'invalid solution, pool nonce missing']);
            }
        }

        // Serialize block header and create complete block data
        const headerBuffer = job.serializeHeader(nTime, nonce); // 144 bytes (header only)
        const headerSolnBuffer = Buffer.concat([headerBuffer, Buffer.from(soln, 'hex')]);
        let headerHash;

        // Apply algorithm-specific hashing to validate the proof-of-work
        switch (options.coin.algorithm) {
            case 'verushash':
                // VerusHash has multiple variants based on solution version and block version
                if (job.rpcData.version > 4 && job.rpcData.solution !== undefined) {
                    // Verify VerusHash solution version matches job requirements
                    if (soln.substr(solutionSlice, 2) !== job.rpcData.solution.substr(0, 2)) {
                        return shareError([22, 'invalid solution version']);
                    }

                    // Use appropriate VerusHash variant based on solution version
                    if (soln.substr(solutionSlice, 2) == '03') {
                        headerHash = vh.hash2b1(headerSolnBuffer); // VerusHash 2.0b1
                    } else {
                        headerHash = vh.hash2b2(headerSolnBuffer); // VerusHash 2.0b2+
                    }
                } else if (job.rpcData.version > 4) {
                    headerHash = vh.hash2b(headerSolnBuffer); // VerusHash 2.0b
                } else {
                    headerHash = vh.hash(headerSolnBuffer); // Original VerusHash
                }
                break;
            default:
                // Default to double SHA256 for other algorithms
                headerHash = util.sha256d(headerSolnBuffer);
                break;
        };

        // Convert hash to big number for difficulty calculations
        // Convert hash to native BigInt (little-endian) for difficulty calculations
        // This preserves behavior of previous bignum.fromBuffer(headerHash, { endian: 'little', size: 32 })
        function bufferToBigIntLE(buf) {
            // Read buffer as little-endian and convert to BigInt
            let res = 0n;
            for (let i = buf.length - 1; i >= 0; i--) {
                res = (res << 8n) + BigInt(buf[i]);
            }
            return res;
        }

        const headerBigInt = bufferToBigIntLE(headerHash);

        let blockHashInvalid;
        let blockHash;
        let blockHex;

        // Calculate share difficulty using the standard formula
        // diff1 is the base difficulty (defined globally in algoProperties.js)
        // Lower hash values = higher difficulty shares
        // diff1 is a Number; headerBigInt is BigInt. To compute share difficulty as a Number,
        // convert headerBigInt to a Number when safe. If headerBigInt exceeds Number.MAX_SAFE_INTEGER,
        // use a floating-point division on approximated values by using hex string slices.
        function bigIntToNumberSafe(big) {
            const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
            if (big <= maxSafe) return Number(big);
            // Approximate by shifting down to fit in safe range while preserving ratio
            const hexLen = big.toString(16).length;
            const nibbleShift = Math.max(0, hexLen - 12); // number of hex nibbles to shift down
            const shiftBits = BigInt(nibbleShift) * 4n;
            const shifted = big >> shiftBits;
            return Number(shifted) * Math.pow(2, Number(shiftBits));
        }

        const headerNumApprox = bigIntToNumberSafe(headerBigInt);
        const shareDiff = diff1 / headerNumApprox * shareMultiplier;
        const blockDiffAdjusted = job.difficulty * shareMultiplier;

        // Validate the proof-of-work solution using algorithm-specific verification
        // This ensures the solution actually satisfies the cryptographic requirements
        if (hashDigest(headerBuffer, Buffer.from(soln.slice(solutionSlice), 'hex')) !== true) {
            return shareError([20, 'invalid solution']);
        }

        // Handle PBaaS merged mining - allows lower difficulty submissions for auxilliary chains
        let isOnlyPBaaS = false;
        let target = job.target;

        // Use merged mining target if available (less restrictive than main target)
        if (job.merged_target) {
            target = job.merged_target;
        }

        // Helper to coerce various target formats to BigInt (Buffer, hex string, number, bignum-like)
        function anyToBigInt(v) {
            if (v === undefined || v === null) return 0n;
            if (typeof v === 'bigint') return v;
            if (typeof v === 'number') return BigInt(v);
            if (Buffer.isBuffer(v)) return bufferToBigIntLE(v);
            if (typeof v === 'string') {
                // assume hex string
                const buf = Buffer.from(v, 'hex');
                return bufferToBigIntLE(buf);
            }
            // Try to use object's toString representation (e.g., previous bignum objects)
            try {
                const s = v.toString();
                if (/^[0-9]+$/.test(s)) return BigInt(s);
                const buf = Buffer.from(s, 'hex');
                return bufferToBigIntLE(buf);
            } catch (e) {
                return 0n;
            }
        }

        // Check if this share qualifies as a block candidate
        const targetBigInt = anyToBigInt(target);
        const jobTargetBigInt = anyToBigInt(job.target);

        if (headerBigInt <= targetBigInt) {
            // Hash meets target difficulty - this is a potential block!
            blockHex = job.serializeBlock(headerBuffer, Buffer.from(soln, 'hex')).toString('hex');
            blockHash = util.reverseBuffer(headerHash).toString('hex');

            // Check if this only meets PBaaS target but not main chain target
            if (!(headerBigInt <= jobTargetBigInt)) {
                isOnlyPBaaS = true;
            }
        } else {
            // Share doesn't meet block target - validate against miner difficulty

            // Optionally emit invalid block hashes for debugging
            if (options.emitInvalidBlockHashes) {
                blockHashInvalid = util.reverseBuffer(util.sha256d(headerSolnBuffer)).toString('hex');
            }

            // Validate share meets minimum difficulty requirement
            // Allow 1% tolerance for floating point precision issues
            if (shareDiff / difficulty < 0.99) {
                // Check if share matches previous difficulty (vardiff retarget scenario)
                if (previousDifficulty && shareDiff >= previousDifficulty) {
                    difficulty = previousDifficulty;
                } else {
                    // Reject low difficulty shares unless configured to accept them
                    if (!options.acceptLowDiffShares) {
                        return shareError([23, `low difficulty share of ${shareDiff}`]);
                    }
                }
            }
        }

        // Emit share event with all relevant data for logging and processing
        // This event is consumed by statistics, payment processors, and logging systems
        _this.emit('share', {
            job: jobId,                                    // Job identifier
            ip: ipAddress,                                 // Miner IP address  
            port: port,                                    // Connection port
            worker: workerName,                            // Worker/miner name
            height: job.rpcData.height,                    // Block height
            blockReward: job.rpcData.reward,               // Block reward amount
            difficulty: difficulty,                        // Target difficulty for miner
            shareDiff: shareDiff.toFixed(8),              // Actual difficulty of submitted share
            blockDiff: blockDiffAdjusted,                 // Network difficulty (adjusted)
            blockDiffActual: job.difficulty,              // Raw network difficulty
            blockHash: blockHash,                         // Block hash if block found (null otherwise)
            blockHashInvalid: blockHashInvalid,           // Invalid block hash for debugging
            blockOnlyPBaaS: isOnlyPBaaS                   // True if only meets PBaaS target
        }, blockHex);                                     // Serialized block data (if block found)

        // Return success response with block hash if applicable
        return { result: true, error: null, blockHash: blockHash };
    };
};

/**
 * Set up JobManager to inherit from EventEmitter.
 * This allows the JobManager to emit events that other components can listen to.
 * 
 * Events emitted:
 * - 'newBlock': When a completely new block template is received
 * - 'updatedBlock': When an existing block template is updated
 * - 'share': When a miner submits a share (valid or invalid)
 */
JobManager.prototype.__proto__ = events.EventEmitter.prototype;
