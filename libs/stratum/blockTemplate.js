/**
 * @fileoverview Block Template - Mining job and block serialization utilities
 *
 * Provides the BlockTemplate class for handling cryptocurrency mining jobs,
 * block header serialization, and submission validation for stratum mining protocols.
 *
 * @author ComputerGenieCo
 * @version 21.7.3
 * @copyright 2025
 */

'use strict';

// Core requires
const PoolLogger = require('../PoolLogger.js');
const merkle = require('./merkleTree.js');
const transactions = require('./transactions.js');
const util = require('../utils/util.js');

// Use shared lightweight BigNum factory from utils
const bignum = util.bignum;

/**
 * BlockTemplate class for cryptocurrency mining jobs
 *
 * Represents a single mining job with methods to validate and submit blocks
 * to the cryptocurrency daemon. Handles block header serialization, coinbase
 * transaction generation, and mining job parameter creation.
 *
 * @class BlockTemplate
 * @param {string} jobId - Unique identifier for this mining job
 * @param {Object} rpcData - Block template data from cryptocurrency daemon
 * @param {string} extraNoncePlaceholder - Placeholder for extra nonce (unused)
 * @param {Object} options - Configuration options
 */
class BlockTemplate {
    constructor(jobId, rpcData, extraNoncePlaceholder, options) {

        // Extract configuration options
        const recipients = options.recipients;
        const poolAddress = options.address;
        const poolHex = options.poolHex;
        const coin = options.coin;

        /** @type {Object} Pool configuration options */
        this.options = options;
        const poolConfig = JSON.parse(process.env.pools);
        const portalConfig = JSON.parse(process.env.portalConfig);

        /** @type {PoolLogger} Logger instance for pool operations */
        const logger = new PoolLogger({
            logLevel: portalConfig.logLevel,
            logColors: portalConfig.logColors
        });

        /** @type {string} Log system identifier */
        const logSystem = ' Blocks';

        /** @type {string} Log component (coin name) */
        const logComponent = options.coin.name;

        /** @type {string} Fork identifier for multi-process setups */
        const forkId = process.env.forkId || '0';

        /** @type {string} Log subcategory with thread number */
        const logSubCat = `Thread ${parseInt(forkId) + 1}`;

        /**
         * Array to track submitted block headers to prevent duplicate submissions
         * @private
         * @type {Array<string>}
         */
        this.submits = [];

        // === Public Properties ===

        /**
         * Raw RPC data received from the cryptocurrency daemon
         * @type {Object}
         */
        this.rpcData = rpcData;

        /**
         * Unique identifier for this mining job
         * @type {string}
         */
        this.jobId = jobId;

        // === Target and Difficulty Calculation ===

        /**
         * Mining target as a big number (converted from hex string)
         * Represents the maximum hash value that constitutes a valid block
         * @type {bignum}
         */
        this.target = bignum(rpcData.target, 16);

        /**
         * Block difficulty calculated from the target
         * Higher difficulty means lower target value (harder to mine)
         * @type {number}
         */
        this.difficulty = parseFloat((diff1 / this.target.toNumber()).toFixed(9));

        /**
         * Target for merged mining operations (defaults to main target)
         * Used for auxiliary chain mining in merged mining scenarios
         * @type {bignum}
         */
        this.merged_target = this.target;

        // Handle PBaaS minimal merged mining target configuration
        // PBaaS (Public Blockchains as a Service) may specify different targets for merged mining
        if (this.rpcData.merged_bits) {
            // Use merged_bits if provided by daemon
            this.merged_target = util.bignumFromBitsHex(this.rpcData.merged_bits);
        } else if (this.rpcData.mergeminebits) {
            // Fallback to mergeminebits for compatibility
            this.merged_target = util.bignumFromBitsHex(this.rpcData.mergeminebits);
        }

        // === Block Reward and Payment Calculation ===

        /**
         * Base block reward in satoshis (miner reward * 100000000)
         * @type {number}
         */
        const blockReward = (this.rpcData.miner) * 100000000;

        // === Transaction Fee Processing ===

        /**
         * Array of transaction objects for fee calculation
         * @type {Array}
         */
        const fees = [];
        rpcData.transactions.forEach((value) => {
            fees.push(value);
        });

        /**
         * Total transaction fees collected from all transactions in the block
         * @type {number}
         */
        this.rewardFees = transactions.getFees(fees);
        rpcData.rewardFees = this.rewardFees;

        /**
         * Total transaction count including the coinbase transaction
         * Used for block serialization and validation
         * @type {number}
         */
        this.txCount = this.rpcData.transactions.length + 1; // add total txs and new coinbase

        // === Coinbase Transaction Generation ===

        /**
         * Extract solver version from solution space (first 2 hex characters)
         * Used to determine PBaaS activation and coinbase handling method
         * @type {number}
         */
        const solver = parseInt(this.rpcData.solution.substr(0, 2), 16);

        // When PBaaS (Public Blockchains as a Service) activates (solver > 6), we must use
        // the pre-built coinbase transaction from daemon to get proper fee pool calculations
        if (coin.algorithm && coin.algorithm == 'verushash' && solver > 6 && this.rpcData.coinbasetxn) {
            /**
             * Block reward amount from daemon's coinbase transaction (PBaaS mode)
             * @type {number}
             */
            this.blockReward = this.rpcData.coinbasetxn.coinbasevalue;

            /**
             * Pre-built coinbase transaction data from daemon (hex string)
             * @type {string}
             */
            this.genTx = this.rpcData.coinbasetxn.data;

            /**
             * Coinbase transaction hash (reversed for little-endian format)
             * @type {string}
             */
            this.genTxHash = util.reverseBuffer(Buffer.from(this.rpcData.coinbasetxn.hash, 'hex')).toString('hex');

        } else if (typeof this.genTx === 'undefined') {
            // Generate coinbase transaction manually for non-PBaaS scenarios
            /**
             * Generated coinbase transaction in hexadecimal format
             * @type {string}
             */
            this.genTx = transactions.createGeneration(
                rpcData.height,
                blockReward,
                this.rewardFees,
                recipients,
                poolAddress,
                poolHex,
                coin
            ).toString('hex');

            /**
             * Hash of the generated coinbase transaction
             * @type {string}
             */
            this.genTxHash = transactions.getTxHash();
        }

        // === Merkle Root and Block Header Preparation ===

        /**
         * Merkle root calculated from all transactions (including coinbase)
         * @type {string}
         */
        this.merkleRoot = merkle.getRoot(this.rpcData, this.genTxHash);

        /**
         * Previous block hash in little-endian format (reversed for block header)
         * @type {string}
         */
        this.prevHashReversed = util.reverseBuffer(Buffer.from(rpcData.previousblockhash, 'hex')).toString('hex');

        /**
         * Final Sapling root hash in little-endian format
         * Defaults to zero hash if not provided
         * @type {string}
         */
        if (rpcData.finalsaplingroothash) {
            this.finalSaplingRootHashReversed = util.reverseBuffer(Buffer.from(rpcData.finalsaplingroothash, 'hex')).toString('hex');
        } else {
            this.finalSaplingRootHashReversed = '0000000000000000000000000000000000000000000000000000000000000000'; //hashReserved
        }

        /**
         * Merkle root in little-endian format (reversed for block header)
         * @type {string}
         */
        this.merkleRootReversed = util.reverseBuffer(Buffer.from(this.merkleRoot, 'hex')).toString('hex');

        // Block template is now ready for mining operations

        // === Final Difficulty Calculation and Logging ===

        /**
         * Final difficulty calculation using utility function
         * This may differ from the initial calculation and provides the authoritative difficulty
         * @type {number}
         */
        this.difficulty = util.calculateDifficulty(this.rpcData.target);

        // Log block template creation
        if (forkId == '0') {
            logger.trace(logSystem, logComponent, logSubCat, `block ${this.rpcData.height} diff is: ${this.difficulty}`);
        }
    }

    /**
     * Generates parameters for the mining.notify stratum message.
     * This method creates the parameter array that gets sent to miners
     * to inform them about new mining jobs.
     *
     * @returns {Array} Array of parameters for stratum mining.notify message
     */
    getJobParams() {
        // Convert difficulty bits to little-endian format
        const nbits = util.reverseBuffer(Buffer.from(this.rpcData.bits, 'hex'));

        // Build job parameters array (cached after first call)
        if (!this.jobParams) {
            this.jobParams = [
                this.jobId,                                                           // 0: Job identifier
                util.packUInt32LE(this.rpcData.version).toString('hex'),             // 1: Block version
                this.prevHashReversed,                                               // 2: Previous block hash
                this.merkleRootReversed,                                             // 3: Merkle root
                this.finalSaplingRootHashReversed,                                   // 4: Final sapling root
                util.packUInt32LE(this.rpcData.curtime).toString('hex'),            // 5: Timestamp
                nbits.toString('hex'),                                               // 6: Difficulty bits
                true                                                                 // 7: Clean jobs flag
            ];

            // VerusHash V2.1 activation - add solution space if available
            if (this.rpcData.solution !== undefined && typeof this.rpcData.solution === 'string') {
                /**
                 * Reserved solution space for VerusHash mining algorithm
                 * Contains space that miners can use for additional nonce values
                 * @type {string}
                 */
                let reservedSolutionSpace = this.rpcData.solution.replace(/[0]+$/, ''); // Trim trailing zeros

                // Ensure even number of hex characters
                if ((reservedSolutionSpace.length % 2) == 1) {
                    reservedSolutionSpace += '0';
                }
                this.jobParams.push(reservedSolutionSpace);                          // 8: Solution space
            }
        }
        return this.jobParams;
    }

    /**
     * Serializes the block header according to the blockchain protocol specification.
     *
     * @param {string} nTime - Block timestamp in hexadecimal format
     * @param {string} nonce - Mining nonce in hexadecimal format (32 bytes)
     * @returns {Buffer} Serialized block header as a 140-byte buffer
     */
    serializeHeader(nTime, nonce) {
        // Allocate 140 bytes for the complete block header
        const header = Buffer.alloc(140);
        let position = 0;

        // Write block version (4 bytes, little-endian)
        header.writeUInt32LE(this.rpcData.version, position += 0, 4, 'hex');

        // Write previous block hash (32 bytes, already reversed)
        header.write(this.prevHashReversed, position += 4, 32, 'hex');

        // Write merkle root (32 bytes, already reversed)
        header.write(this.merkleRootReversed, position += 32, 32, 'hex');

        // Write final sapling root hash (32 bytes, already reversed)
        header.write(this.finalSaplingRootHashReversed, position += 32, 32, 'hex');

        // Write timestamp (4 bytes)
        header.write(nTime, position += 32, 4, 'hex');

        // Write difficulty bits (4 bytes, reversed to little-endian)
        header.write(util.reverseBuffer(Buffer.from(this.rpcData.bits, 'hex')).toString('hex'), position += 4, 4, 'hex');

        // Write nonce (32 bytes) - prioritize provided nonce over daemon nonce
        if (!nonce && this.rpcData.nonce) {
            // Use daemon-provided nonce (reversed to little-endian)
            header.write(util.reverseBuffer(Buffer.from(this.rpcData.nonce, 'hex')).toString('hex'), position += 4, 32, 'hex');
        } else if (nonce) {
            // Use provided nonce (typically from miner)
            header.write(nonce, position += 4, 32, 'hex');
        } else {
            console.log('ERROR, block header nonce not provided by daemon!');
        }
        return header;
    }

    /**
     * Serializes the complete block by combining the header, solution, and all transactions.
     *
     * @param {Buffer} header - Serialized block header (from serializeHeader)
     * @param {Buffer} soln - Proof-of-work solution (VerusHash solution)
     * @returns {Buffer} Complete serialized block ready for network submission
     */
    serializeBlock(header, soln) {

        // Convert transaction count to hexadecimal
        let txCount = this.txCount.toString(16);
        // Ensure even number of hex characters (pad with leading zero if needed)
        if (Math.abs(txCount.length % 2) == 1) {
            txCount = `0${txCount}`;
        }

        /**
         * Variable integer encoding for transaction count
         * Bitcoin protocol uses variable-length integers (varints) to efficiently encode counts
         * @type {Buffer}
         */
        let varInt;
        if (this.txCount <= 0x7f) {
            // Single byte for counts <= 127
            varInt = Buffer.from(txCount, 'hex');
        } else if (this.txCount <= 0x7fff) {
            // Two bytes with 0xFD prefix for counts <= 32767
            if (txCount.length == 2) {
                txCount = `00${txCount}`;
            }
            varInt = Buffer.concat([Buffer.from('FD', 'hex'), util.reverseBuffer(Buffer.from(txCount, 'hex'))]);
        }

        // Start building the complete block by concatenating components
        let buf = Buffer.concat([
            header,                              // Block header (140 bytes)
            soln,                               // VerusHash solution (variable length)
            varInt,                             // Transaction count (variable integer)
            Buffer.from(this.genTx, 'hex')      // Coinbase transaction
        ]);

        // Append all additional transactions to the block
        if (this.rpcData.transactions.length > 0) {
            this.rpcData.transactions.forEach((value) => {
                // Concatenate each transaction's raw data
                const tmpBuf = Buffer.concat([buf, Buffer.from(value.data, 'hex')]);
                buf = tmpBuf;
            });
        }

        return buf;
    }

    /**
     * Registers a block submission to prevent duplicate submissions.
     *
     * @param {string} header - Block header as hexadecimal string
     * @param {string} soln - Proof-of-work solution as hexadecimal string
     * @returns {boolean} true if this is a new submission, false if duplicate
     */
    registerSubmit(header, soln) {
        // Create unique submission identifier by combining header and solution
        const submission = (header + soln).toLowerCase();

        // Check if this submission has been seen before
        if (this.submits.indexOf(submission) === -1) {
            // New submission - add to tracking array
            this.submits.push(submission);
            return true;
        }
        // Duplicate submission detected
        return false;
    }

    // BlockTemplate instance is now fully initialized and ready for mining operations
}

module.exports = BlockTemplate;
