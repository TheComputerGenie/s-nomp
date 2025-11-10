/**
 * @fileoverview Transaction generation utilities for cryptocurrency mining pools.
 * This module handles the creation of coinbase transactions for various cryptocurrencies,
 * including support for founders rewards, treasury rewards, masternode payments,
 * and pool fee distributions. It supports multiple coin types including Zcash-based
 * coins with Overwinter and Sapling protocol upgrades.
 *
 * @author v-nomp Pool Software
 * @version 1.0.0
 */

const bitcoin = require('../utxo');
const util = require('../utils/util.js');

/**
 * Stores the hash of the last generated transaction.
 * This is used to track the transaction ID for block template generation.
 * @type {string}
 */
let txHash;

/**
 * Gets the hash of the last generated coinbase transaction.
 *
 * @returns {string} The hexadecimal string representation of the transaction hash
 * @example
 * const hash = txHash();
 * console.log('Last transaction hash:', hash);
 */
exports.txHash = () => txHash;

/**
 * Creates a coinbase transaction for a new block in a cryptocurrency mining pool.
 * This is the primary function that handles reward distribution including:
 * - Pool rewards
 * - Founders/Treasury rewards (for applicable coins)
 * - Masternode payments (for applicable coins)
 * - Fee recipient distributions
 *
 * @param {number} blockHeight - The height of the block being mined
 * @param {number} blockReward - The base block reward in satoshis
 * @param {number} feeReward - Total transaction fees collected in satoshis
 * @param {Array<Object>} recipients - Array of fee recipients with address and percent
 * @param {string} poolAddress - The pool's payout address
 * @param {string} [poolHex] - Custom hex string for coinbase (defaults to 'VRSC')
 * @param {Object} coin - Coin configuration object with network and reward parameters
 * @param {number} [masternodeReward] - Masternode reward amount in satoshis
 * @param {string} [masternodePayee] - Masternode payout address
 * @param {boolean} [masternodePayment] - Whether masternode payment is enabled
 * @returns {string} The hexadecimal representation of the coinbase transaction
 * @throws {Error} When invalid addresses or coin parameters are provided
 *
 * @example
 * const recipients = [
 *   { address: '1PoolFeeAddr...', percent: 1.0 },
 *   { address: '1DevFeeAddr...', percent: 0.5 }
 * ];
 * const coinConfig = {
 *   symbol: 'VRSC',
 *   payFoundersReward: true,
 *   percentFoundersReward: 2.5
 * };
 * const txHex = createGeneration(
 *   100000, 1250000000, 50000, recipients,
 *   '1PoolAddress...', null, coinConfig
 * );
 */
exports.createGeneration = (blockHeight, blockReward, feeReward, recipients, poolAddress, poolHex, coin, masternodeReward, masternodePayee, masternodePayment) => {
    // Extract the hash160 from the pool's Base58Check encoded address
    // This hash will be used in the P2PKH script for the pool's reward output
    const poolAddrHash = bitcoin.address.fromBase58Check(poolAddress).hash;

    // Get the network parameters for the specific coin (mainnet, testnet, etc.)
    // This determines address formats, magic bytes, and other network-specific settings
    const network = bitcoin.networks[coin.symbol];

    // Create a new transaction builder with the appropriate network settings
    const txb = new bitcoin.TransactionBuilder(network);

    // Handle Zcash protocol upgrades: Sapling and Overwinter
    // These upgrades introduced new transaction versions with enhanced privacy features
    if (coin.sapling) {
        // Sapling upgrade: Advanced zero-knowledge proofs for better privacy
        // Can be enabled globally (true) or at a specific block height (number)
        if (coin.sapling === true || (typeof coin.sapling === 'number' && coin.sapling <= blockHeight)) {
            txb.setVersion(bitcoin.Transaction.ZCASH_SAPLING_VERSION);
        }
    } else if (coin.overwinter) {
        // Overwinter upgrade: Network upgrade preparation for Sapling
        // Introduces versioned transaction format and replay protection
        if (coin.overwinter === true || (typeof coin.overwinter === 'number' && coin.overwinter <= blockHeight)) {
            txb.setVersion(bitcoin.Transaction.ZCASH_OVERWINTER_VERSION);
        }
    }

    // Create the coinbase input - this is where new coins are generated
    // The coinbase input must include the block height as per BIP 34

    // Convert block height to hexadecimal and ensure even length (pad with leading zero if needed)
    let blockHeightSerial = (blockHeight.toString(16).length % 2 === 0 ? '' : '0') + blockHeight.toString(16);

    // Calculate the minimum number of bytes needed to represent the block height
    // This is done by left-shifting the height and converting to binary to find bit length
    const height = Math.ceil((blockHeight << 1).toString(2).length / 8);

    // Pad the serialized height with zero bytes if it's shorter than the calculated minimum
    const lengthDiff = blockHeightSerial.length / 2 - height;
    for (let i = 0; i < lengthDiff; i++) {
        blockHeightSerial = `${blockHeightSerial}00`;
    }

    // Create the length prefix (number of bytes in the height)
    const length = `0${height}`;

    // Construct the serialized block height according to Bitcoin protocol:
    // [length][height_bytes_little_endian][OP_0]
    const serializedBlockHeight = Buffer.concat([
        Buffer.from(length, 'hex'),                              // Length of height data
        util.reverseBuffer(Buffer.from(blockHeightSerial, 'hex')), // Height in little-endian
        Buffer.from('00', 'hex')                                 // OP_0 terminator
    ]);

    // Add the coinbase input to the transaction
    // Coinbase inputs have a special format with null hash (all zeros) and max sequence
    txb.addInput(
        Buffer.from('0000000000000000000000000000000000000000000000000000000000000000', 'hex'), // Null hash (coinbase marker)
        4294967295,                                                                                // Output index (0xFFFFFFFF for coinbase)
        4294967295,                                                                                // Sequence number (0xFFFFFFFF)
        Buffer.concat([
            serializedBlockHeight,                                    // BIP 34 block height
            Buffer.from(poolHex ? poolHex : '56525343', 'hex')       // Pool signature (default: 'VRSC' in hex)
        ])
    );

    // Calculate the total percentage of fees that will be distributed to recipients
    // This is used to determine how much of the block reward goes to the pool vs. recipients
    let feePercent = 0;
    recipients.forEach(recipient => feePercent += recipient.percent);

    // Flag to track whether transaction fees have been included in pool reward calculation
    // This prevents double-counting fees in certain reward distribution scenarios
    let feesDivided = false;

    // Handle reward distribution based on whether masternode payments are enabled
    // The logic branches into two main paths: with and without masternode support
    if (masternodePayment === false || masternodePayment === undefined) {
        // Handle coins WITHOUT masternode payments (e.g., ZEN, Zcash-based coins)
        // This section manages founders/treasury rewards for various coin types

        // Check if this coin has founders/treasury rewards and if we're within the reward period
        if (coin.payFoundersReward === true && (coin.maxFoundersRewardBlockHeight >= blockHeight || coin.treasuryRewardStartBlockHeight || coin.treasuryRewardUpdateStartBlockHeight)) {
            // Determine which type of reward system is active based on block height
            // Priority: Treasury Update > Treasury > Founders (in chronological order)

            if (coin.treasuryRewardUpdateStartBlockHeight && blockHeight >= coin.treasuryRewardUpdateStartBlockHeight) {
                // Treasury Update System: Advanced reward distribution with multiple node types
                // This system rotates through different addresses at regular intervals

                // Calculate treasury reward address index based on block height and change interval
                // Uses modulo to cycle through the available addresses in the array
                const indexCF = parseInt(Math.floor(((blockHeight - coin.treasuryRewardUpdateStartBlockHeight) / coin.treasuryRewardUpdateAddressChangeInterval) % coin.vTreasuryRewardUpdateAddress.length));
                const foundersAddrHash = bitcoin.address.fromBase58Check(coin.vTreasuryRewardUpdateAddress[indexCF]).hash;

                // Calculate Secure Nodes reward address index
                // Secure Nodes provide network security services and receive ongoing rewards
                const indexSN = parseInt(Math.floor(((blockHeight - coin.treasuryRewardUpdateStartBlockHeight) / coin.treasuryRewardUpdateAddressChangeInterval) % coin.vSecureNodesRewardAddress.length));
                const secureNodesAddrHash = bitcoin.address.fromBase58Check(coin.vSecureNodesRewardAddress[indexSN]).hash;

                // Calculate Super Nodes reward address index
                // Super Nodes typically provide enhanced network services (masternodes, validators, etc.)
                const indexXN = parseInt(Math.floor(((blockHeight - coin.treasuryRewardUpdateStartBlockHeight) / coin.treasuryRewardUpdateAddressChangeInterval) % coin.vSuperNodesRewardAddress.length));
                const superNodesAddrHash = bitcoin.address.fromBase58Check(coin.vSuperNodesRewardAddress[indexXN]).hash;

                // Debug logging (commented out for production)
                // These logs help verify correct address rotation during development
                // console.log(`treasuryIndex: ${indexCF}`)
                // console.log(`treasuryAddr:  ${coin.vTreasuryRewardUpdateAddress[indexCF]}`)
                // console.log(`secureNodesIndex: ${indexSN}`)
                // console.log(`secureNodesAddr:  ${coin.vSecureNodesRewardAddress[indexSN]}`)
                // console.log(`superNodesIndex: ${indexXN}`)
                // console.log(`superNodesAddr:  ${coin.vSuperNodesRewardAddress[indexXN]}`)

                // Add pool reward output (remaining amount after all other rewards)
                // Pool gets: (100% - treasury% - secureNodes% - superNodes% - fees%) + transaction fees
                txb.addOutput(
                    util.scriptCompile(poolAddrHash),
                    Math.round(blockReward * (1 - (coin.percentTreasuryUpdateReward + coin.percentSecureNodesReward + coin.percentSuperNodesReward + feePercent) / 100)) + feeReward
                );

                // Add treasury reward output (uses P2SH script for enhanced security)
                txb.addOutput(
                    util.scriptFoundersCompile(foundersAddrHash),
                    Math.round(blockReward * (coin.percentTreasuryUpdateReward / 100))
                );

                // Add Secure Nodes reward output
                txb.addOutput(
                    util.scriptFoundersCompile(secureNodesAddrHash),
                    Math.round(blockReward * (coin.percentSecureNodesReward / 100))
                );

                // Add Super Nodes reward output
                txb.addOutput(
                    util.scriptFoundersCompile(superNodesAddrHash),
                    Math.round(blockReward * (coin.percentSuperNodesReward / 100))
                );

                // Treasury reward system (simpler than Treasury Update)
            } else if (coin.treasuryRewardStartBlockHeight && blockHeight >= coin.treasuryRewardStartBlockHeight) {
                // Standard Treasury System: Single treasury with rotating addresses
                // Used by coins that have graduated from founders rewards to treasury system

                // Calculate which treasury address to use based on block height
                // Addresses rotate at regular intervals to distribute control
                const index = parseInt(Math.floor(((blockHeight - coin.treasuryRewardStartBlockHeight) / coin.treasuryRewardAddressChangeInterval) % coin.vTreasuryRewardAddress.length));
                const foundersAddrHash = bitcoin.address.fromBase58Check(coin.vTreasuryRewardAddress[index]).hash;

                // Debug logging for treasury address rotation
                // console.log(`treasuryIndex: ${index}`)
                // console.log(`treasuryAddr:  ${coin.vTreasuryRewardAddress[index]}`)

                // Add pool reward output (remaining after treasury and fees)
                txb.addOutput(
                    util.scriptCompile(poolAddrHash),
                    Math.round(blockReward * (1 - (coin.percentTreasuryReward + feePercent) / 100)) + feeReward
                );

                // Add treasury reward output
                txb.addOutput(
                    util.scriptFoundersCompile(foundersAddrHash),
                    Math.round(blockReward * (coin.percentTreasuryReward / 100))
                );
            } else {
                // Original Founders Reward System
                // Used in early stages of coin development to fund initial development
                // Typically phases out after a certain block height

                // Calculate founders address index - simpler rotation based on block height
                // No start block offset, just divide by interval
                const index = parseInt(Math.floor(blockHeight / coin.foundersRewardAddressChangeInterval));
                const foundersAddrHash = bitcoin.address.fromBase58Check(coin.vFoundersRewardAddress[index]).hash;

                // Debug logging for founders address rotation
                // console.log(`foundersIndex: ${index}`)
                // console.log(`foundersAddr:  ${coin.vFoundersRewardAddress[index]}`)

                // Add pool reward output (remaining after founders reward and fees)
                txb.addOutput(
                    util.scriptCompile(poolAddrHash),
                    Math.round(blockReward * (1 - (coin.percentFoundersReward + feePercent) / 100)) + feeReward
                );

                // Add founders reward output
                txb.addOutput(
                    util.scriptFoundersCompile(foundersAddrHash),
                    Math.round(blockReward * (coin.percentFoundersReward / 100))
                );
            }
        } else {
            // No special rewards system - standard mining pool operation
            // Pool receives full block reward minus fee recipients, plus all transaction fees
            feesDivided = true; // Mark that fees are included in pool calculation
            txb.addOutput(
                util.scriptCompile(poolAddrHash),
                Math.round((blockReward + feeReward) * (1 - (feePercent / 100)))
            );
        }
    } else {
        // Handle coins WITH masternode payments (e.g., SnowGem, Dash-based coins)
        // Masternodes provide additional network services and receive regular payments

        // Extract masternode address hash if payee is specified
        // Masternode payments are mandatory when enabled, so this should always be present
        const masternodeAddrHash = masternodePayee ? bitcoin.address.fromBase58Check(masternodePayee).hash : null;

        // Check if this masternode-enabled coin also has founders/treasury rewards
        if (coin.payFoundersReward === true && (coin.maxFoundersRewardBlockHeight >= blockHeight || coin.treasuryRewardStartBlockHeight)) {
            // Masternode coins with treasury/founders rewards (complex reward distribution)

            if (coin.treasuryRewardStartBlockHeight && blockHeight >= coin.treasuryRewardStartBlockHeight) {
                // Treasury + Masternode reward system
                // Pool reward is reduced by both treasury and masternode payments

                const index = parseInt(Math.floor(((blockHeight - coin.treasuryRewardStartBlockHeight) / coin.treasuryRewardAddressChangeInterval) % coin.vTreasuryRewardAddress.length));
                const foundersAddrHash = bitcoin.address.fromBase58Check(coin.vTreasuryRewardAddress[index]).hash;

                // Debug logging for treasury rotation
                // console.log(`treasuryIndex: ${index}`)
                // console.log(`treasuryAddr:  ${coin.vTreasuryRewardAddress[index]}`)

                // Add pool reward output (reduced by treasury percentage, fees, and masternode payment)
                txb.addOutput(
                    util.scriptCompile(poolAddrHash),
                    Math.round(blockReward * (1 - (coin.percentTreasuryReward + feePercent) / 100)) + feeReward - masternodeReward
                );

                // Add treasury reward output
                txb.addOutput(
                    util.scriptFoundersCompile(foundersAddrHash),
                    Math.round(blockReward * (coin.percentTreasuryReward / 100))
                );

                // Add masternode reward output (uses regular P2PKH script)
                txb.addOutput(
                    util.scriptCompile(masternodeAddrHash),
                    Math.round(masternodeReward)
                );
            } else {
                // Founders + Masternode reward system
                // Used in early development phases of masternode-enabled coins

                const index = parseInt(Math.floor(blockHeight / coin.foundersRewardAddressChangeInterval));
                const foundersAddrHash = bitcoin.address.fromBase58Check(coin.vFoundersRewardAddress[index]).hash;

                // Debug logging for founders rotation
                // console.log(`foundersIndex: ${index}`)
                // console.log(`foundersAddr:  ${coin.vFoundersRewardAddress[index]}`)

                // Add pool reward output (reduced by founders percentage, fees, and masternode payment)
                txb.addOutput(
                    util.scriptCompile(poolAddrHash),
                    Math.round(blockReward * (1 - (coin.percentFoundersReward + feePercent) / 100)) + feeReward - masternodeReward
                );

                // Add founders reward output
                txb.addOutput(
                    util.scriptFoundersCompile(foundersAddrHash),
                    Math.round(blockReward * (coin.percentFoundersReward / 100))
                );

                // Add masternode reward output
                txb.addOutput(
                    util.scriptCompile(masternodeAddrHash),
                    Math.round(masternodeReward)
                );
            }
        } else {
            // Simple masternode system without founders/treasury rewards
            // Pool gets remaining block reward after masternode payment and fee deductions

            // Add pool reward output (reduced by fees and masternode payment)
            txb.addOutput(
                util.scriptCompile(poolAddrHash),
                Math.round(blockReward * (1 - (feePercent / 100))) + feeReward - masternodeReward
            );

            // Add masternode reward output
            txb.addOutput(
                util.scriptCompile(masternodeAddrHash),
                Math.round(masternodeReward)
            );
        }
    }

    // Add outputs for pool fee recipients (development, maintenance, etc.)
    // These recipients receive a percentage of the total reward based on their configured share
    recipients.forEach(recipient => {
        // Calculate recipient reward based on total available reward
        // Include transaction fees only if they weren't already distributed to the pool
        const recipientAmount = Math.round((blockReward + (feesDivided ? feeReward : 0)) * (recipient.percent / 100));

        txb.addOutput(
            util.scriptCompile(bitcoin.address.fromBase58Check(recipient.address).hash),
            recipientAmount
        );
    });

    // Build and finalize the transaction
    const tx = txb.build();

    // Convert transaction to hexadecimal format for network transmission
    txHex = tx.toHex();
    // Debug: Log the complete transaction hex
    // console.log('hex coinbase transaction: ' + txHex)

    // Store the transaction hash for reference (used in block template)
    // The hash is calculated from the serialized transaction data
    txHash = tx.getHash().toString('hex');

    // Debug: Log transaction details
    // console.log(`txHex: ${txHex.toString('hex')}`)
    // console.log(`txHash: ${txHash}`)

    return txHex;
};

/**
 * Calculates the total transaction fees from an array of fee objects.
 * This utility function sums up all individual transaction fees to determine
 * the total fee reward that should be included in the coinbase transaction.
 *
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
 * const totalFees = getFees(transactions); // Returns 2250
 */
module.exports.getFees = feeArray => {
    // Initialize fee accumulator
    let fee = Number();

    // Sum all individual transaction fees
    feeArray.forEach(value => fee += Number(value.fee));

    return fee;
};
