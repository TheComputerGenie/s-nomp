const bignum = require('bignum');

const merkle = require('./merkleTree.js');
const transactions = require('./transactions.js');
const util = require('./util.js');
const PoolLogger = require('../logUtil.js');


/**
 * The BlockTemplate class holds a single job.
 * and provides several methods to validate and submit it to the daemon coin
**/
const BlockTemplate = module.exports = function BlockTemplate(
    jobId,
    rpcData,
    extraNoncePlaceholder,
    recipients,
    poolAddress,
    poolHex,
    coin
) {

    const logger = new PoolLogger({
        logLevel: `debug`,
        logColors: `true`
    });

    //private members
    const submits = [];

    //public members
    this.rpcData = rpcData;
    this.jobId = jobId;

    // get target info
    this.target = bignum(rpcData.target, 16);
    this.difficulty = parseFloat((diff1 / this.target.toNumber()).toFixed(9));
    this.merged_target = this.target;
    // pbaas minimal merged mining target
    if (this.rpcData.merged_bits) {
        this.merged_target = util.bignumFromBitsHex(this.rpcData.merged_bits);
    } else if (this.rpcData.mergeminebits) {
        this.merged_target = util.bignumFromBitsHex(this.rpcData.mergeminebits);
    }


    // generate the fees and coinbase tx
    let blockReward = (this.rpcData.miner) * 100000000;


    if (coin.payFoundersReward === true) {
        if (!this.rpcData.founders || this.rpcData.founders.length <= 0) {
            console.log('Error, founders reward missing for block template!');
        } else {
            blockReward = (this.rpcData.miner + this.rpcData.founders + this.rpcData.securenodes + this.rpcData.supernodes) * 100000000;
        }
    }

    const masternodeReward = rpcData.payee_amount;
    const masternodePayee = rpcData.payee;
    const masternodePayment = rpcData.masternode_payments;

    const fees = [];
    rpcData.transactions.forEach((value) => {
        fees.push(value);
    });
    this.rewardFees = transactions.getFees(fees);
    rpcData.rewardFees = this.rewardFees;

    this.txCount = this.rpcData.transactions.length + 1; // add total txs and new coinbase

    // veruscoin daemon performs all coinbase transaction calculations to included any fee's from the fee pool
    // *Note, verus daemon must be setup with -minerdistribution '{"address": 0.9, "address2":0.1}' option
    //        or setup with -pubkey, -mineraddres, etc.

    const solver = parseInt(this.rpcData.solution.substr(0, 2), 16);
    // when PBaaS activates we must use the coinbasetxn from daemon to get proper fee pool calculations in coinbase
    if (coin.algorithm && coin.algorithm == 'verushash' && solver > 6 && this.rpcData.coinbasetxn) {
        this.blockReward = this.rpcData.coinbasetxn.coinbasevalue;
        this.genTx = this.rpcData.coinbasetxn.data;
        this.genTxHash = util.reverseBuffer(Buffer.from(this.rpcData.coinbasetxn.hash, 'hex')).toString('hex');

    } else if (typeof this.genTx === 'undefined') {
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
        this.genTxHash = transactions.txHash();
    }

    this.merkleRoot = merkle.getRoot(this.rpcData, this.genTxHash);

    /*
    console.log('this.genTxHash: ' + transactions.txHash());
    console.log('this.merkleRoot: ' + merkle.getRoot(rpcData, this.genTxHash));
    */

    // generate the merkle root
    this.prevHashReversed = util.reverseBuffer(Buffer.from(rpcData.previousblockhash, 'hex')).toString('hex');
    if (rpcData.finalsaplingroothash) {
        this.finalSaplingRootHashReversed = util.reverseBuffer(Buffer.from(rpcData.finalsaplingroothash, 'hex')).toString('hex');
    } else {
        this.finalSaplingRootHashReversed = '0000000000000000000000000000000000000000000000000000000000000000'; //hashReserved
    }

    this.merkleRootReversed = util.reverseBuffer(Buffer.from(this.merkleRoot, 'hex')).toString('hex');
    // we can't do anything else until we have a submission

    //block header per https://github.com/zcash/zips/blob/master/protocol/protocol.pdf
    this.serializeHeader = function (nTime, nonce) {
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

        header.writeUInt32LE(this.rpcData.version, position += 0, 4, 'hex');
        header.write(this.prevHashReversed, position += 4, 32, 'hex');
        header.write(this.merkleRootReversed, position += 32, 32, 'hex');
        header.write(this.finalSaplingRootHashReversed, position += 32, 32, 'hex');
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
    };

    // join the header and txs together
    this.serializeBlock = function (header, soln) {

        let txCount = this.txCount.toString(16);
        if (Math.abs(txCount.length % 2) == 1) {
            txCount = `0${txCount}`;
        }

        let varInt;
        if (this.txCount <= 0x7f) {
            varInt = Buffer.from(txCount, 'hex');
        } else if (this.txCount <= 0x7fff) {
            if (txCount.length == 2) {
                txCount = `00${txCount}`;
            }
            varInt = Buffer.concat([Buffer.from('FD', 'hex'), util.reverseBuffer(Buffer.from(txCount, 'hex'))]);
        }

        let buf = Buffer.concat([
            header,
            soln,
            varInt,
            Buffer.from(this.genTx, 'hex')
        ]);

        if (this.rpcData.transactions.length > 0) {
            this.rpcData.transactions.forEach((value) => {
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

    // submit the block header
    this.registerSubmit = function (header, soln) {
        const submission = (header + soln).toLowerCase();
        if (submits.indexOf(submission) === -1) {

            submits.push(submission);
            return true;
        }
        return false;
    };

    // used for mining.notify
    this.getJobParams = function () {
        const nbits = util.reverseBuffer(Buffer.from(this.rpcData.bits, 'hex'));
        if (!this.jobParams) {
            this.jobParams = [
                this.jobId,
                util.packUInt32LE(this.rpcData.version).toString('hex'),
                this.prevHashReversed,
                this.merkleRootReversed,
                this.finalSaplingRootHashReversed,
                util.packUInt32LE(this.rpcData.curtime).toString('hex'),
                nbits.toString('hex'),
                true
            ];
            // VerusHash V2.1 activation
            if (this.rpcData.solution !== undefined && typeof this.rpcData.solution === 'string') {
                // trim trailing 0's
                let reservedSolutionSpace = this.rpcData.solution.replace(/[0]+$/, '');
                if ((reservedSolutionSpace.length % 2) == 1) {
                    reservedSolutionSpace += '0';
                }
                this.jobParams.push(reservedSolutionSpace);
            }
            // PBaaS requires block header nonce to be sent to miners
            //if (this.rpcData.nonce) {
            //this.jobParams.push(this.rpcData.nonce);
            //}
        }
        return this.jobParams;
    };

    this.difficulty = util.calculateDifficulty(this.rpcData.target);

    if (!process.env.forkId || process.env.forkId === '0') {
        logger.warn('Blocks', coin.name, `Thread ${parseInt(process.env.forkId) + 1}`, `${this.rpcData.height} block diff is: ${this.difficulty}`);
    }
};
