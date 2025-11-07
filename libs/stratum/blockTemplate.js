/**
 * @fileoverview BlockTemplate module for managing cryptocurrency mining block templates.
 * This module handles the creation, validation, and serialization of block templates
 * for stratum mining operations, with special support for Verus and PBaaS protocols.
 * 
 * @module blockTemplate
 * @requires bignum - For handling large number operations
 * @requires ./merkleTree - For merkle root calculations
 * @requires ./transactions - For transaction generation and fee calculation
 * @requires ./util - For various utility functions
 * @requires ../PoolLogger - For logging operations
 * 
 * @author s-nomp contributors
 * @since 1.0.0
 */

'use strict';

// Core requires
const merkle = require('./merkleTree.js');
const transactions = require('./transactions.js');
const util = require('../utils/util.js');
const PoolLogger = require('../PoolLogger.js');

// Lightweight replacement for the `bignum` package using native BigInt (Node.js v21+).
// We provide a minimal wrapper that matches the small API surface used in this file
// (construction from hex, toNumber, toString, valueOf). This lets other code that
// expects a "bignum-like" object continue to work without pulling the external
// dependency.
// Use shared lightweight BigNum factory from utils
const bignum = util.bignum;


/**
 * BlockTemplate class represents a single mining job and provides methods to validate
 * and submit blocks to the cryptocurrency daemon. It handles block header serialization,
 * coinbase transaction generation, and mining job parameter creation.
 * 
 * This class is specifically designed to work with stratum mining protocols and supports
 * various cryptocurrency features including:
 * - Standard block templates
 * - Merged mining (auxiliary chains)
 * - PBaaS (Public Blockchains as a Service) protocol
 * - VerusHash algorithm with solution spaces
 * - Masternode payments
 * - Founder rewards
 * 
 * @class BlockTemplate
 * @param {string} jobId - Unique identifier for this mining job
 * @param {Object} rpcData - Block template data received from the cryptocurrency daemon
 * @param {string} rpcData.target - Mining target in hexadecimal format
 * @param {number} rpcData.height - Block height
 * @param {number} rpcData.version - Block version
 * @param {string} rpcData.previousblockhash - Previous block hash
 * @param {string} rpcData.bits - Difficulty bits in compact format
 * @param {number} rpcData.curtime - Current timestamp
 * @param {Array} rpcData.transactions - Array of transactions to include in block
 * @param {number} rpcData.miner - Miner reward amount
 * @param {string} [rpcData.finalsaplingroothash] - Sapling root hash for privacy coins
 * @param {string} [rpcData.solution] - Solution space for VerusHash (contains reserved space)
 * @param {Object} [rpcData.coinbasetxn] - Pre-built coinbase transaction from daemon (PBaaS)
 * @param {string} extraNoncePlaceholder - Placeholder for extra nonce in coinbase (unused)
 * @param {Array} recipients - Array of mining pool fee recipients
 * @param {string} poolAddress - Mining pool's primary address
 * @param {string} poolHex - Pool address in hexadecimal format
 * @param {Object} coin - Coin configuration object
 * @param {string} [coin.algorithm] - Mining algorithm (e.g., 'verushash')
 * @param {boolean} [coin.payFoundersReward] - Whether to pay founder rewards
 * 
 * @example
 * const blockTemplate = new BlockTemplate(
 *   'job123',
 *   rpcBlockData,
 *   null,
 *   poolRecipients,
 *   'RPoolAddress123...',
 *   '76a914...88ac',
 *   { algorithm: 'verushash', payFoundersReward: true }
 * );
 */
const BlockTemplate = module.exports = function BlockTemplate(
    jobId,
    rpcData,
    extraNoncePlaceholder,
    recipients,
    poolAddress,
    poolHex,
    coin
) {

    /**
     * Logger instance for debugging and tracing block template operations
     * @private
     * @type {PoolLogger}
     */
    const logger = new PoolLogger({
        logLevel: `debug`,
        logColors: `true`
    });

    /**
     * Array to track submitted block headers to prevent duplicate submissions
     * @private
     * @type {Array<string>}
     */
    const submits = [];

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
    let blockReward = (this.rpcData.miner) * 100000000;

    // Handle founder rewards for coins that support them (like Zcash forks)
    if (coin.payFoundersReward === true) {
        if (!this.rpcData.founders || this.rpcData.founders.length <= 0) {
            console.log('Error, founders reward missing for block template!');
        } else {
            // Calculate total block reward including all network participants
            // founders: Development team rewards
            // securenodes: Secure node operator rewards  
            // supernodes: Super node operator rewards
            blockReward = (this.rpcData.miner + this.rpcData.founders + this.rpcData.securenodes + this.rpcData.supernodes) * 100000000;
        }
    }

    /**
     * Masternode reward amount (if applicable)
     * @type {number}
     */
    const masternodeReward = rpcData.payee_amount;

    /**
     * Masternode payee address
     * @type {string}
     */
    const masternodePayee = rpcData.payee;

    /**
     * Whether masternode payments are enabled
     * @type {boolean}
     */
    const masternodePayment = rpcData.masternode_payments;

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

    // VerusCoin daemon performs all coinbase transaction calculations to include fees from the fee pool
    // *Note: Verus daemon must be setup with -minerdistribution '{"address": 0.9, "address2":0.1}' option
    //        or setup with -pubkey, -mineraddress, etc. for proper reward distribution

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
            coin,
            masternodeReward,
            masternodePayee,
            masternodePayment
        ).toString('hex');

        /**
         * Hash of the generated coinbase transaction
         * @type {string}
         */
        this.genTxHash = transactions.txHash();
    }

    // === Merkle Root and Block Header Preparation ===

    /**
     * Merkle root calculated from all transactions (including coinbase)
     * @type {string}
     */
    this.merkleRoot = merkle.getRoot(this.rpcData, this.genTxHash);

    /*
    console.log('this.genTxHash: ' + transactions.txHash());
    console.log('this.merkleRoot: ' + merkle.getRoot(rpcData, this.genTxHash));
    */

    /**
     * Previous block hash in little-endian format (reversed for block header)
     * @type {string}
     */
    this.prevHashReversed = util.reverseBuffer(Buffer.from(rpcData.previousblockhash, 'hex')).toString('hex');

    /**
     * Final Sapling root hash in little-endian format
     * Used by privacy coins (Zcash forks) for shielded transactions
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

    // Log block template creation (only from main thread to avoid spam)
    if (!process.env.forkId || process.env.forkId === '0') {
        logger.trace('Blocks', coin.name, `Thread ${parseInt(process.env.forkId) + 1}`, `${this.rpcData.height} block diff is: ${this.difficulty}`);
    }

    // === Mining Job Parameters Method ===

    /**
     * Generates parameters for the mining.notify stratum message.
     * This method creates the parameter array that gets sent to miners
     * to inform them about new mining jobs.
     * 
     * Standard stratum mining.notify parameters:
     * 0. Job ID - Unique identifier for this mining job
     * 1. Version - Block version (4 bytes, little-endian)
     * 2. Previous Hash - Hash of previous block (32 bytes, little-endian) 
     * 3. Merkle Root - Transaction merkle root (32 bytes, little-endian)
     * 4. Final Sapling Root - Privacy coin root hash (32 bytes, little-endian)
     * 5. Timestamp - Current time (4 bytes, little-endian)
     * 6. Bits - Difficulty target (4 bytes, little-endian)
     * 7. Clean Jobs - Boolean indicating if previous jobs should be discarded
     * 8. Solution Space - VerusHash reserved solution space (optional)
     * 
     * @method getJobParams
     * @returns {Array} Array of parameters for stratum mining.notify message
     * 
     * @example
     * const jobParams = blockTemplate.getJobParams();
     * // Send to miner: ["mining.notify", jobParams]
     */
    this.getJobParams = function () {
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

            // PBaaS may require block header nonce to be sent to miners
            // Currently commented out but available for future use
            //if (this.rpcData.nonce) {
            //    this.jobParams.push(this.rpcData.nonce);                           // 9: Header nonce
            //}
        }
        return this.jobParams;
    };

    // === Block Header Serialization Method ===

    /**
     * Serializes the block header according to the blockchain protocol specification.
     * Block header format follows Zcash protocol: https://github.com/zcash/zips/blob/master/protocol/protocol.pdf
     * 
     * Block header structure (140 bytes total):
     * - Version (4 bytes): Block version number
     * - Previous Hash (32 bytes): Hash of previous block
     * - Merkle Root (32 bytes): Root of transaction merkle tree
     * - Final Sapling Root (32 bytes): Root for shielded transactions (privacy coins)
     * - Timestamp (4 bytes): Block creation time
     * - Bits (4 bytes): Difficulty target in compact format
     * - Nonce (32 bytes): Mining nonce value
     * 
     * @method serializeHeader
     * @param {string} nTime - Block timestamp in hexadecimal format
     * @param {string} nonce - Mining nonce in hexadecimal format (32 bytes)
     * @returns {Buffer} Serialized block header as a 140-byte buffer
     * 
     * @example
     * const header = blockTemplate.serializeHeader('5f8a7b2c', '0000000000000000000000000000000000000000000000000000000012345678');
     */
    this.serializeHeader = function (nTime, nonce) {
        // Allocate 140 bytes for the complete block header
        const header = Buffer.alloc(140);
        let position = 0;

        /*
        console.log('nonce:' + nonce);
        console.log('this.rpcData.bits: ' + this.rpcData.bits);
        console.log('nTime: ' + nTime);
        console.log('this.merkleRootReversed: ' + this.merkleRootReversed);
        console.log('this.prevHashReversed: ' + this.prevHashReversed);
        console.log('this.finalSaplingRootHashReversed: ' + this.finalSaplingRootHashReversed);
        console.log('this.rpcData.version: ' + this.rpcData.version);
        */

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
    };

    // === Complete Block Serialization Method ===

    /**
     * Serializes the complete block by combining the header, solution, and all transactions.
     * This creates the final block data that can be submitted to the cryptocurrency network.
     * 
     * Block structure:
     * - Block header (140 bytes)
     * - Solution (variable length, VerusHash specific)
     * - Transaction count (variable integer)
     * - Coinbase transaction (variable length)
     * - Additional transactions (variable length each)
     * 
     * @method serializeBlock
     * @param {Buffer} header - Serialized block header (from serializeHeader)
     * @param {Buffer} soln - Proof-of-work solution (VerusHash solution)
     * @returns {Buffer} Complete serialized block ready for network submission
     * 
     * @example
     * const header = blockTemplate.serializeHeader(timestamp, nonce);
     * const solution = Buffer.from(proofOfWorkSolution, 'hex');
     * const block = blockTemplate.serializeBlock(header, solution);
     */
    this.serializeBlock = function (header, soln) {

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

        /*
        console.log('header: ' + header.toString('hex'));
        console.log('soln: ' + soln.toString('hex'));
        console.log('varInt: ' + varInt.toString('hex'));
        console.log('this.genTx: ' + this.genTx);
        console.log('data: ' + value.data);
        console.log('buf_block: ' + buf.toString('hex'));
        */
        return buf;
    };

    // === Submission Tracking Method ===

    /**
     * Registers a block submission to prevent duplicate submissions.
     * This helps avoid wasted work and potential network spam by tracking
     * which header+solution combinations have already been submitted.
     * 
     * @method registerSubmit
     * @param {string} header - Block header as hexadecimal string
     * @param {string} soln - Proof-of-work solution as hexadecimal string
     * @returns {boolean} true if this is a new submission, false if duplicate
     * 
     * @example
     * const isNewSubmission = blockTemplate.registerSubmit(headerHex, solutionHex);
     * if (isNewSubmission) {
     *     // Process the new submission
     * } else {
     *     // Reject duplicate submission
     * }
     */
    this.registerSubmit = function (header, soln) {
        // Create unique submission identifier by combining header and solution
        const submission = (header + soln).toLowerCase();

        // Check if this submission has been seen before
        if (submits.indexOf(submission) === -1) {
            // New submission - add to tracking array
            submits.push(submission);
            return true;
        }
        // Duplicate submission detected
        return false;
    };

    // BlockTemplate instance is now fully initialized and ready for mining operations
};
