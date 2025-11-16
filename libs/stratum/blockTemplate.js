
/**
 * @fileoverview Block Template - Bitcoin block template generator
 *
 * Generates block templates for mining pools, handling transaction merkle trees,
 * coinbase generation, and block serialization for various cryptocurrencies.
 *
 * @author ComputerGenieCo
 * @version 21.7.3
 * @copyright 2025
 */
'use strict';

const PoolLogger = require('../PoolLogger.js');
const MerkleTree = require('./merkleTree.js');
const transactions = require('./transactions.js');
const util = require('../utils/util.js');

const bignum = util.bignum;

/**
 * Block Template
 *
 * Generates and manages block templates for mining pools, including merkle tree
 * construction, coinbase transaction creation, and block header serialization.
 *
 * @class BlockTemplate
 * @param {string} jobId - Unique identifier for the mining job
 * @param {Object} rpcData - RPC response data from the coin daemon
 * @param {string} extraNoncePlaceholder - Placeholder string for extra nonce insertion
 * @param {Object} options - Configuration options including recipients, address, etc.
 */
class BlockTemplate {

    #submits;
    #jobParams;
    #prevHashReversed;
    #merkleRootReversed;
    #finalSaplingRootHashReversed;
    #merkleRoot;
    #genTx;
    #genTxHash;
    #rewardFees;
    #txCount;
    #blockReward;

    constructor(jobId, rpcData, extraNoncePlaceholder, options) {

        const recipients = options.recipients;
        const poolAddress = options.address;
        const poolHex = options.poolHex;
        const coin = options.coin;

        this.options = options;
        const poolConfig = JSON.parse(process.env.pools);
        const portalConfig = JSON.parse(process.env.portalConfig);

        const logger = new PoolLogger({
            logLevel: portalConfig.logLevel,
            logColors: portalConfig.logColors
        });

        const logSystem = ' Blocks';
        const logComponent = options.coin.name;
        const forkId = process.env.forkId || '0';
        const logThread = forkId;

        this.#submits = [];
        this.rpcData = rpcData;
        this.jobId = jobId;
        this.target = bignum(rpcData.target, 16);
        this.difficulty = parseFloat((global.diff1 / this.target.toNumber()).toFixed(9));
        this.merged_target = this.target;

        if (this.rpcData.merged_bits) {
            this.merged_target = util.bignumFromBitsHex(this.rpcData.merged_bits);
        } else if (this.rpcData.mergeminebits) {
            this.merged_target = util.bignumFromBitsHex(this.rpcData.mergeminebits);
        }

        const blockReward = (this.rpcData.miner) * 100000000;

        const fees = [];
        rpcData.transactions.forEach((value) => {
            fees.push(value);
        });

        this.#rewardFees = transactions.getFees(fees);
        rpcData.rewardFees = this.#rewardFees;

        this.#txCount = this.rpcData.transactions.length + 1;

        const solver = parseInt(this.rpcData.solution.substr(0, 2), 16);

        if (coin.algorithm && coin.algorithm == 'verushash' && solver > 6 && this.rpcData.coinbasetxn) {
            this.#blockReward = this.rpcData.coinbasetxn.coinbasevalue;
            this.#genTx = this.rpcData.coinbasetxn.data;
            this.#genTxHash = util.reverseBuffer(Buffer.from(this.rpcData.coinbasetxn.hash, 'hex')).toString('hex');
        } else if (typeof this.genTx === 'undefined') {
            this.#genTx = transactions.createGeneration(
                rpcData.height,
                blockReward,
                this.#rewardFees,
                recipients,
                poolAddress,
                poolHex,
                coin
            ).toString('hex');

            this.#genTxHash = transactions.getTxHash();
        }

        this.#merkleRoot = MerkleTree.getRoot(this.rpcData, this.#genTxHash);
        this.#prevHashReversed = util.reverseBuffer(Buffer.from(rpcData.previousblockhash, 'hex')).toString('hex');

        if (rpcData.finalsaplingroothash) {
            this.#finalSaplingRootHashReversed = util.reverseBuffer(Buffer.from(rpcData.finalsaplingroothash, 'hex')).toString('hex');
        } else {
            this.#finalSaplingRootHashReversed = '0000000000000000000000000000000000000000000000000000000000000000';
        }

        this.#merkleRootReversed = util.reverseBuffer(Buffer.from(this.#merkleRoot, 'hex')).toString('hex');
        this.difficulty = util.calculateDifficulty(this.rpcData.target);

        logger.trace(logSystem, logComponent, logThread, `block ${this.rpcData.height} diff is: ${this.difficulty}`, true);

    }

    /**
     * Get the job parameters array for stratum mining protocol.
     * @returns {Array} The job parameters for the mining job
     */
    getJobParams() {

        const nbits = util.reverseBuffer(Buffer.from(this.rpcData.bits, 'hex'));

        if (!this.#jobParams) {
            this.#jobParams = [
                this.jobId,
                util.packUInt32LE(this.rpcData.version).toString('hex'),
                this.#prevHashReversed,
                this.#merkleRootReversed,
                this.#finalSaplingRootHashReversed,
                util.packUInt32LE(this.rpcData.curtime).toString('hex'),
                nbits.toString('hex'),
                true
            ];

            if (this.rpcData.solution !== undefined && typeof this.rpcData.solution === 'string') {

                let reservedSolutionSpace = this.rpcData.solution.replace(/[0]+$/, '');

                if ((reservedSolutionSpace.length % 2) == 1) {
                    reservedSolutionSpace += '0';
                }
                this.#jobParams.push(reservedSolutionSpace);
            }
        }
        return this.#jobParams;
    }

    /**
     * Serialize the block header into a buffer.
     * @param {string} nTime - The timestamp as hex string
     * @param {string} nonce - The nonce as hex string
     * @returns {Buffer} The serialized block header
     */
    serializeHeader(nTime, nonce) {

        const header = Buffer.alloc(140);
        let position = 0;

        header.writeUInt32LE(this.rpcData.version, position += 0, 4, 'hex');
        header.write(this.#prevHashReversed, position += 4, 32, 'hex');
        header.write(this.#merkleRootReversed, position += 32, 32, 'hex');
        header.write(this.#finalSaplingRootHashReversed, position += 32, 32, 'hex');
        header.write(nTime, position += 32, 4, 'hex');
        header.write(util.reverseBuffer(Buffer.from(this.rpcData.bits, 'hex')).toString('hex'), position += 4, 4, 'hex');

        if (!nonce && this.rpcData.nonce) {

            header.write(util.reverseBuffer(Buffer.from(this.rpcData.nonce, 'hex')).toString('hex'), position += 4, 32, 'hex');
        } else if (nonce) {

            header.write(nonce, position += 4, 32, 'hex');
        } else {
            console.log('ERROR, block header nonce not provided by daemon!');
        }
        return header;
    }

    /**
     * Serialize the complete block including header, solution, and transactions.
     * @param {Buffer} header - The block header buffer
     * @param {Buffer} soln - The solution buffer
     * @returns {Buffer} The complete serialized block
     */
    serializeBlock(header, soln) {

        let txCount = this.#txCount.toString(16);

        if (Math.abs(txCount.length % 2) == 1) {
            txCount = `0${txCount}`;
        }

        let varInt;
        if (this.#txCount <= 0x7f) {

            varInt = Buffer.from(txCount, 'hex');
        } else if (this.#txCount <= 0x7fff) {

            if (txCount.length == 2) {
                txCount = `00${txCount}`;
            }
            varInt = Buffer.concat([Buffer.from('FD', 'hex'), util.reverseBuffer(Buffer.from(txCount, 'hex'))]);
        }

        let buf = Buffer.concat([
            header,
            soln,
            varInt,
            Buffer.from(this.#genTx, 'hex')
        ]);

        if (this.rpcData.transactions.length > 0) {
            this.rpcData.transactions.forEach((value) => {
                const tmpBuf = Buffer.concat([buf, Buffer.from(value.data, 'hex')]);
                buf = tmpBuf;
            });
        }

        return buf;
    }

    /**
     * Register a mining submission to prevent duplicates.
     * @param {string} header - The block header hex
     * @param {string} soln - The solution hex
     * @returns {boolean} True if the submission was registered, false if duplicate
     */
    registerSubmit(header, soln) {
        const submission = (header + soln).toLowerCase();

        if (this.#submits.indexOf(submission) === -1) {
            this.#submits.push(submission);
            return true;
        }
        return false;
    }

}

module.exports = BlockTemplate;
