/**
 * @fileoverview Transactions - handles coinbase transaction creation
 *
 * Creates coinbase transactions for new blocks in cryptocurrency mining pools,
 * handling reward distribution including pool rewards and fee recipients.
 *
 * @author ComputerGenieCo
 * @version 21.7.3
 * @copyright 2025
 */
const bitcoin = require('../utxo');
const util = require('../utils/util.js');

/**
 * Transactions
 *
 * Handles creation of coinbase transactions for mining pools, including reward
 * distribution to pool and fee recipients.
 *
 * @class Transactions
 */
class Transactions {
    // Private storage for the last generated coinbase transaction hash (hex string)
    static #txHash;

    /**
     * Gets the hash of the last generated coinbase transaction.
     *
     * @static
     * @returns {string} The hexadecimal string representation of the transaction hash
     * @example
     * const hash = Transactions.getTxHash();
     * console.log('Last transaction hash:', hash);
     */
    static getTxHash() {
        return this.#txHash;
    }

    /**
     * Creates a coinbase transaction for a new block in a cryptocurrency mining pool.
     * This handles reward distribution including pool rewards and fee recipient distributions.
     *
     * @static
     * @param {number} blockHeight - The height of the block being mined
     * @param {number} blockReward - The base block reward in satoshis
     * @param {number} feeReward - Total transaction fees collected in satoshis
     * @param {Array<Object>} recipients - Array of fee recipients with address and percent
     * @param {string} poolAddress - The pool's payout address
     * @param {string} [poolHex] - Custom hex string for coinbase (defaults to 'VRSC')
     * @param {Object} coin - Coin configuration object with network and reward parameters
     * @returns {string} The hexadecimal representation of the coinbase transaction
     * @throws {Error} When invalid addresses or coin parameters are provided
     *
     * @example
     * const recipients = [
     *   { address: '1PoolFeeAddr...', percent: 1.0 },
     *   { address: '1DevFeeAddr...', percent: 0.5 }
     * ];
     * const coinConfig = {
     *   symbol: 'VRSC'
     * };
     * const txHex = Transactions.createGeneration(
     *   100000, 1250000000, 50000, recipients,
     *   '1PoolAddress...', null, coinConfig
     * );
     */
    static createGeneration(blockHeight, blockReward, feeReward, recipients, poolAddress, poolHex, coin) {
        // Extract the hash160 from the pool's Base58Check encoded address for the P2PKH output
        const poolAddrHash = bitcoin.address.fromBase58Check(poolAddress).hash;

        // Get the network parameters for the specific coin (mainnet, testnet, etc.)
        const network = bitcoin.networks[coin.symbol];

        // Create a new transaction builder with the appropriate network settings
        const txb = new bitcoin.TransactionBuilder(network);

        // Use the project's constant for transaction version where applicable
        txb.setVersion(bitcoin.Transaction.ZCASH_SAPLING_VERSION);

        // Build the coinbase input per BIP34: contains serialized block height
        let blockHeightSerial = (blockHeight.toString(16).length % 2 === 0 ? '' : '0') + blockHeight.toString(16);

        // Determine minimum byte length for the serialized height
        const height = Math.ceil((blockHeight << 1).toString(2).length / 8);

        // Pad serialized height with zero bytes if needed
        const lengthDiff = blockHeightSerial.length / 2 - height;
        for (let i = 0; i < lengthDiff; i++) {
            blockHeightSerial = `${blockHeightSerial}00`;
        }

        // Length prefix for the height (single byte)
        const length = `0${height}`;

        // Serialized BIP34 block height: [length][height_little_endian][OP_0]
        const serializedBlockHeight = Buffer.concat([
            Buffer.from(length, 'hex'),                              // Length of height data
            util.reverseBuffer(Buffer.from(blockHeightSerial, 'hex')), // Height in little-endian
            Buffer.from('00', 'hex')                                 // OP_0 terminator
        ]);

        // Add the coinbase input (null previous hash, max index and sequence). The scriptSig is the serialized height
        txb.addInput(
            Buffer.from('0000000000000000000000000000000000000000000000000000000000000000', 'hex'),
            4294967295,
            4294967295,
            Buffer.concat([
                serializedBlockHeight,
                Buffer.from(poolHex ? poolHex : '56525343', 'hex')
            ])
        );

        // Sum total percent allocated to recipients
        let feePercent = 0;
        recipients.forEach(recipient => feePercent += recipient.percent);

        // Pool's main output: remaining reward after recipient percentages, plus all transaction fees
        txb.addOutput(
            util.scriptCompile(poolAddrHash),
            Math.round((blockReward + feeReward) * (1 - (feePercent / 100)))
        );

        // Add outputs for each fee recipient (percentages are relative to the total reward+fees)
        recipients.forEach(recipient => {
            const recipientAmount = Math.round((blockReward + feeReward) * (recipient.percent / 100));

            txb.addOutput(
                util.scriptCompile(bitcoin.address.fromBase58Check(recipient.address).hash),
                recipientAmount
            );
        });

        // Build and finalize the transaction, store its hash (hex string), and return hex
        const tx = txb.build();
        const txHex = tx.toHex();

        this.#txHash = tx.getHash().toString('hex');

        return txHex;
    }

    /**
     * Calculates the total transaction fees from an array of fee objects.
     * This utility function sums up all individual transaction fees to determine
     * the total fee reward that should be included in the coinbase transaction.
     *
     * @static
     * @param {Array<Object>} feeArray - Array of transaction objects containing fee information
     * @param {number} feeArray[].fee - The fee amount for each transaction in satoshis
     * @returns {number} The total sum of all transaction fees in satoshis
     *
     * @example
     * const transactions = [
     *   { fee: 1000 },
     *   { fee: 500 },
     *   { fee: 750 }
     * ];
     * const totalFees = Transactions.getFees(transactions); // Returns 2250
     */
    static getFees(feeArray) {
        // Sum all transaction fees (ensure numeric conversion)
        let fee = 0;
        feeArray.forEach(value => {
            fee += Number(value.fee);
        });
        return fee;
    }
}

module.exports = Transactions;
