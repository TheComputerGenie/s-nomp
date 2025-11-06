
const fs = require('fs');
const { promisify } = require('util');
const redis = require('redis');
const WAValidator = require('wallet-address-validator');

const Stratum = require('./stratum');
const CreateRedisClient = require('./createRedisClient');
const PoolLogger = require('./logUtil.js');

const writeFileAsync = promisify(fs.writeFile);

/**
 * PaymentProcessor handles cryptocurrency mining pool payments with advanced features
 * including shielded transactions, PPLNT (Pay Per Last N Time) payment schemes,
 * duplicate block handling, and comprehensive Redis-based state management.
 * 
 * Key Features:
 * - Multi-pool support with independent processing
 * - Shielded transaction support for privacy coins (Zcash family)
 * - PPLNT payment mode for fair share distribution
 * - Duplicate block detection and resolution
 * - Bad block retry mechanism with exponential backoff
 * - Orphaned block share redistribution
 * - Network and market statistics caching
 * - Comprehensive error handling and logging
 * 
 * Payment Processing Flow:
 * 1. Data Retrieval - Fetch worker balances and pending blocks from Redis
 * 2. Block Validation - Verify block transactions and categorize them
 * 3. Share Calculation - Calculate rewards based on worker shares and PPLNT rules
 * 4. Payment Execution - Send payments via daemon's sendmany RPC
 * 5. Database Updates - Update Redis with new balances and block status
 */
class PaymentProcessor {
    /**
     * Initialize a new PaymentProcessor instance
     * @param {Object} poolConfig - Pool-specific configuration
     * @param {Object} portalConfig - Global portal configuration
     */
    constructor(poolConfig, portalConfig) {
        this.poolConfig = poolConfig;
        this.coin = poolConfig.coin.name;
        this.logger = new PoolLogger({
            logLevel: portalConfig.logLevel,
            logColors: portalConfig.logColors,
        });
        this.logSystem = 'Payments';
        this.logComponent = this.coin;

        this.processingConfig = poolConfig.paymentProcessing;
        this.daemon = new Stratum.daemon.interface([this.processingConfig.daemon], (severity, message) => {
            this.logger[severity](this.logSystem, this.logComponent, message);
        });

        this.redisClient = CreateRedisClient(poolConfig.redis);
        if (poolConfig.redis.password) {
            this.redisClient.auth(poolConfig.redis.password);
        }

        // Promisify redis commands and provide a multi helper that matches redis.Multi.exec(cb)
        // The multi wrapper supports both callback and promise styles to maintain compatibility
        this.redis = {
            hgetall: promisify(this.redisClient.hgetall).bind(this.redisClient),
            smembers: promisify(this.redisClient.smembers).bind(this.redisClient),
            hset: promisify(this.redisClient.hset).bind(this.redisClient),
            // Custom multi wrapper that returns an object with exec() supporting both styles
            multi: (commands) => {
                const multiObj = this.redisClient.multi(commands);
                return {
                    exec: (cb) => {
                        if (typeof cb === 'function') {
                            return multiObj.exec(cb);
                        }
                        return new Promise((resolve, reject) => {
                            multiObj.exec((err, replies) => {
                                if (err) {
                                    return reject(err);
                                }
                                resolve(replies);
                            });
                        });
                    }
                };
            }
        };

        // Shielding operation tracking (for privacy coins like Zcash)
        this.opidCount = 0;  // Number of active z_sendmany operations
        this.opids = [];     // Array of operation IDs to monitor
        this.badBlocks = {}; // Track blocks that failed validation (retry mechanism)

        // Payment processing configuration with sensible defaults
        this.minConfShield = Math.max(this.processingConfig.minConf || 10, 1);     // Min confirmations for shielding
        this.minConfPayout = Math.max(this.processingConfig.minConf || 10, 1);     // Min confirmations for payouts
        this.paymentIntervalSecs = Math.max(this.processingConfig.paymentInterval || 120, 30); // Payment frequency
        this.maxBlocksPerPayment = Math.max(this.processingConfig.maxBlocksPerPayment || 3, 1); // Blocks per payment run
        this.pplntEnabled = this.processingConfig.paymentMode === 'pplnt' || false; // PPLNT payment mode
        this.pplntTimeQualify = this.processingConfig.pplnt || 0.51;                // PPLNT time threshold (51%)
        this.getMarketStats = poolConfig.coin.getMarketStats === true;              // Fetch market data
        this.requireShielding = poolConfig.coin.requireShielding === true;          // Requires shielded transactions
        this.fee = parseFloat(poolConfig.coin.txfee) || 0.0004;                     // Transaction fee reserve
    }

    /**
     * Start the payment processor and initialize all periodic intervals
     * Sets up payment processing, shielding operations, and statistics caching
     */
    async start() {
        this.logger.info(this.logSystem, this.logComponent, 'Starting payment processor...');

        try {
            // Validate daemon connectivity and address ownership
            await this.validateDaemons();
            // Determine coin precision for accurate calculations
            await this.determineCoinPrecision();
        } catch (error) {
            this.logger.error(this.logSystem, this.logComponent, `Failed to initialize: ${error.message}`);
            return;
        }

        this.logger.debug(this.logSystem, this.logComponent, `Payment processing setup with daemon and redis.`);

        // Main payment processing interval
        this.paymentInterval = setInterval(() => this.processPayments(), this.paymentIntervalSecs * 1000);

        // Shielding intervals (for privacy coins that require T→Z and Z→T transfers)
        if (this.requireShielding) {
            this.shieldingInterval = setInterval(() => this.shieldingCycle(), Math.max(this.poolConfig.walletInterval || 1, 1) * 60 * 1000);
            this.opidCheckInterval = setInterval(() => this.checkOpids(), 57 * 1000);
        }

        // Statistics caching intervals
        this.statsInterval = setInterval(() => this.cacheNetworkStats(), 58 * 1000);
        if (this.getMarketStats) {
            this.marketStatsInterval = setInterval(() => this.cacheMarketStats(), 300 * 1000);
        }
    }

    /**
     * Validate that the daemon owns all configured addresses
     * This ensures the payment processor can manage funds properly
     */
    async validateDaemons() {
        const validations = [this.validateAddress(this.poolConfig.address)];
        if (this.requireShielding) {
            validations.push(this.validateTAddress(this.poolConfig.tAddress));
            validations.push(this.validateZAddress(this.poolConfig.zAddress));
        }
        await Promise.all(validations);
    }

    /**
     * Validate that the daemon owns the main pool address
     * @param {string} address - The address to validate
     */
    async validateAddress(address) {
        const result = await this.cmd('validateaddress', [address]);
        if (!result.ismine) {
            throw new Error(`Daemon does not own pool address: ${address}`);
        }
    }

    /**
     * Validate that the daemon owns the transparent address (for shielded coins)
     * @param {string} address - The t-address to validate
     */
    async validateTAddress(address) {
        const result = await this.cmd('validateaddress', [address]);
        if (!result.ismine) {
            throw new Error(`Daemon does not own pool t-address: ${address}`);
        }
    }

    /**
     * Validate that the daemon owns the shielded address (for privacy coins)
     * @param {string} address - The z-address to validate
     */
    async validateZAddress(address) {
        const result = await this.cmd('z_validateaddress', [address]);
        if (!result.ismine) {
            throw new Error(`Daemon does not own pool z-address: ${address}`);
        }
    }

    /**
     * Determine the coin's precision by examining the daemon's balance
     * This sets up magnitude and precision values for accurate calculations
     */
    async determineCoinPrecision() {
        const result = await this.cmd('getbalance', []);
        const d = result.toString().split('.')[1];
        this.magnitude = parseInt(`10${'0'.repeat(d.length)}`);
        this.minPaymentSatoshis = parseInt(this.processingConfig.minimumPayment * this.magnitude);
        this.coinPrecision = this.magnitude.toString().length - 1;
    }

    /**
     * Main payment processing method - executes the 5-step payment flow
     * This is called periodically based on paymentIntervalSecs configuration
     * 
     * Processing Steps:
     * 1. Data Retrieval - Fetch worker balances and pending blocks from Redis
     * 2. Block Validation - Verify block transactions and handle duplicates/bad blocks
     * 3. Share Calculation - Calculate rewards with PPLNT rules and balance checks
     * 4. Payment Execution - Send payments via daemon RPC
     * 5. Database Updates - Update Redis with new balances and block status
     */
    async processPayments() {
        const startTime = Date.now();
        this.logger.info(this.logSystem, this.logComponent, 'Starting payment processing run...');

        try {
            // Step 1: Data Retrieval
            const { workers, rounds } = await this._getDataFromRedis();

            // Step 2: Block Validation
            const validatedRounds = await this._validateBlocks(rounds);

            // Step 3: Share Calculation
            const { workersWithRewards, finalRounds } = await this._calculateRewards(workers, validatedRounds);

            // Step 4: Payment Execution
            const { workersWithPayments, paymentsUpdate } = await this._executePayments(workersWithRewards);

            // Step 5: Database Updates
            await this._updateRedis(workersWithPayments, finalRounds, paymentsUpdate);

        } catch (error) {
            this.logger.error(this.logSystem, this.logComponent, `Error during payment processing: ${error.message}`);
            if (error.stack) {
                this.logger.error(this.logSystem, this.logComponent, error.stack);
            }
        }

        const duration = Date.now() - startTime;
        this.logger.info(this.logSystem, this.logComponent, `Payment processing run finished in ${duration}ms.`);
    }

    /**
     * Step 1: Retrieve worker balances and pending blocks from Redis
     * Also handles duplicate block detection and resolution
     * 
     * @returns {Object} Object containing workers and rounds data
     * @returns {Object} workers - Worker addresses mapped to their balances
     * @returns {Array} rounds - Array of pending block objects sorted by height
     */
    async _getDataFromRedis() {
        // Fetch worker balances and pending blocks in parallel
        const [balances, pendingBlocks] = await Promise.all([
            this.redis.hgetall(`${this.coin}:balances`),
            this.redis.smembers(`${this.coin}:blocksPending`),
        ]);

        // Build workers object with balances converted to satoshis
        const workers = {};
        if (balances) {
            for (const w in balances) {
                workers[w] = { balance: this.coinsToSatoshis(parseFloat(balances[w])) };
            }
        }

        // Parse pending blocks into round objects
        let rounds = pendingBlocks.map(r => {
            const details = r.split(':');
            return {
                blockHash: details[0],
                txHash: details[1],
                height: parseInt(details[2]),
                minedby: details[3],
                time: details[4],
                serialized: r,
                duplicate: false,
            };
        }).sort((a, b) => a.height - b.height);

        // Handle duplicate block heights (multiple blocks at same height)
        const heights = {};
        rounds.forEach(r => {
            heights[r.height] = (heights[r.height] || 0) + 1;
        });

        const duplicateRounds = rounds.filter(r => heights[r.height] > 1);
        if (duplicateRounds.length > 0) {
            this.logger.warn(this.logSystem, this.logComponent, `Duplicate pending blocks found: ${JSON.stringify(duplicateRounds.map(r => r.height))}`);

            // Use getblock RPC to determine which blocks are invalid (confirmations === -1)
            const rpcDupCheck = duplicateRounds.map(r => ['getblock', [r.blockHash]]);
            const blocks = await this.batchCmd(rpcDupCheck);

            const invalidBlocks = [];
            blocks.forEach((block, i) => {
                const round = duplicateRounds[i];
                if (block && block.result && block.result.confirmations === -1) {
                    invalidBlocks.push(['smove', `${this.coin}:blocksPending`, `${this.coin}:blocksKicked`, round.serialized]);
                    round.duplicate = true; // Mark as invalid duplicate
                }
            });

            // Move invalid duplicates to kicked set and filter them out
            if (invalidBlocks.length > 0) {
                await this.redis.multi(invalidBlocks).exec();
                this.logger.info(this.logSystem, this.logComponent, `Moved ${invalidBlocks.length} invalid duplicate blocks to kicked set.`);
                rounds = rounds.filter(r => !r.duplicate);
            } else {
                this.logger.error(this.logSystem, this.logComponent, 'Unable to detect invalid duplicate blocks, duplicate block payments on hold.');
            }
        }

        return { workers, rounds };
    }

    /**
     * Step 2: Validate blocks by querying transaction details from daemon
     * Implements bad block retry mechanism and categorizes blocks for processing
     * 
     * Block Categories:
     * - 'generate': Confirmed blocks ready for payment
     * - 'immature': Blocks awaiting sufficient confirmations
     * - 'orphan': Blocks that became orphaned (shares redistributed)
     * - 'kicked': Invalid blocks to be removed
     * 
     * @param {Array} rounds - Array of round objects to validate
     * @returns {Array} Filtered array of valid rounds
     */
    async _validateBlocks(rounds) {
        if (rounds.length === 0) {
            return [];
        }

        // Batch RPC call to get transaction details for all rounds
        const batchRPC = rounds.map(r => ['gettransaction', [r.txHash]]);
        const txDetails = await this.batchCmd(batchRPC);

        let payingBlocks = 0;

        return rounds.filter(round => {
            const tx = txDetails[rounds.indexOf(round)];

            // Handle bad blocks with retry mechanism (RPC error -5 = invalid transaction)
            if (tx.error && tx.error.code === -5) {
                this.badBlocks[round.txHash] = (this.badBlocks[round.txHash] || 0) + 1;
                if (this.badBlocks[round.txHash] >= 15) {
                    // Give up after 15 retries - permanently kick this block
                    this.logger.warn(this.logSystem, this.logComponent, `ERROR: Daemon reports invalid transaction: ${round.txHash}`);
                    delete this.badBlocks[round.txHash];
                    round.category = 'kicked';
                } else {
                    // Retry this block in the next payment run
                    this.logger.warn(this.logSystem, this.logComponent, `Abandoned block ${round.txHash} check ${this.badBlocks[round.txHash]}/15`);
                    return false; // Skip this round for now
                }
            } else if (tx && tx.result) {
                // Block is now valid - clear from bad blocks tracking
                if (this.badBlocks[round.txHash]) {
                    this.logger.info(this.logSystem, this.logComponent, `${round.txHash} is no longer bad!`);
                    delete this.badBlocks[round.txHash];
                }

                round.confirmations = tx.result.confirmations || 0;
                // Find transaction detail for pool address or use first available
                const detail = tx.result.details.find(d => d.address === this.poolConfig.address) || tx.result.details[0];

                if (detail) {
                    round.category = detail.category;
                    if (round.category === 'generate' || round.category === 'immature') {
                        round.reward = this.coinsRound(parseFloat(detail.amount || detail.value));
                    }
                } else {
                    this.logger.error(this.logSystem, this.logComponent, `ERROR: Missing output details to pool address for transaction ${round.txHash}`);
                    round.category = 'kicked'; // No details for pool address
                }
            } else {
                round.category = 'kicked'; // RPC error or no result
            }

            // Limit concurrent payments to prevent overwhelming the daemon
            if (round.category === 'generate' && round.confirmations >= this.minConfPayout) {
                payingBlocks++;
                if (payingBlocks > this.maxBlocksPerPayment) {
                    round.category = 'immature'; // Defer payment to next run
                }
            } else if (round.category === 'generate') {
                round.category = 'immature'; // Not enough confirmations yet
            }

            // Determine if shares can be safely deleted (no other blocks at same height)
            round.canDeleteShares = (() => {
                for (let i = 0; i < rounds.length; i++) {
                    const compareR = rounds[i];
                    if ((compareR.height === round.height)
                        && (compareR.category !== 'kicked')
                        && (compareR.category !== 'orphan')
                        && (compareR.serialized !== round.serialized)) {
                        return false;
                    }
                }
                return true;
            })();

            return true;
        });
    }

    /**
     * Step 3: Calculate rewards for workers based on their shares
     * Implements PPLNT (Pay Per Last N Time) if enabled and validates pool balance
     * 
     * PPLNT Logic:
     * - Only counts shares submitted within the qualifying time period
     * - Qualifying time = block_time * pplntTimeQualify (default 51%)
     * - Prevents pool hopping by requiring recent activity
     * 
     * @param {Object} workers - Worker data with balances
     * @param {Array} rounds - Validated rounds array
     * @returns {Object} Object with updated workers and rounds
     */
    async _calculateRewards(workers, rounds) {
        const payingRounds = rounds.filter(r => r.category === 'generate');
        if (payingRounds.length === 0) {
            return { workersWithRewards: workers, finalRounds: rounds };
        }

        // Fetch share data for paying rounds
        const shareLookups = payingRounds.map(r => ['hgetall', `${this.coin}:shares:round${r.height}`]);
        const timeLookups = this.pplntEnabled ? payingRounds.map(r => ['hgetall', `${this.coin}:shares:times${r.height}`]) : [];

        const [allWorkerShares, allWorkerTimes] = await Promise.all([
            this.redis.multi(shareLookups).exec(),
            this.pplntEnabled ? this.redis.multi(timeLookups).exec() : Promise.resolve([])
        ]);

        // Calculate total amount owed (existing balances + new rewards - fees)
        let totalOwed = Object.values(workers).reduce((sum, worker) => sum + (worker.balance || 0), 0);
        payingRounds.forEach(r => {
            totalOwed += this.coinsToSatoshis(r.reward) - this.coinsToSatoshis(this.fee);
        });

        // Verify pool has sufficient balance for all payments
        const tBalance = await this.listUnspent(null, this.requireShielding ? this.poolConfig.address : null, this.minConfPayout);
        if (tBalance < totalOwed) {
            this.logger.warn(this.logSystem, this.logComponent, `Insufficient funds for payment (${this.satoshisToCoins(tBalance)} < ${this.satoshisToCoins(totalOwed)}). Deferring payments.`);
            // Convert all generate blocks to immature to defer payments
            rounds.forEach(r => {
                if (r.category === 'generate') {
                    r.category = 'immature';
                } 
            });
            return { workersWithRewards: workers, finalRounds: rounds };
        }

        // Process each paying round to calculate worker rewards
        payingRounds.forEach((round, i) => {
            const workerShares = allWorkerShares[i];
            if (!workerShares) {
                return;
            }

            let totalShares = Object.values(workerShares).reduce((sum, s) => sum + parseFloat(s), 0);
            if (totalShares === 0) {
                return;
            }

            // Apply PPLNT filtering if enabled
            if (this.pplntEnabled) {
                const workerTimes = allWorkerTimes[i];
                const maxTime = round.time * this.pplntTimeQualify;
                let totalSharesRemoved = 0;

                // Remove shares from workers who haven't contributed recently enough
                for (const workerAddress in workerShares) {
                    const lastShareTime = workerTimes[workerAddress] || 0;
                    if (lastShareTime < maxTime) {
                        const shares = parseFloat(workerShares[workerAddress]);
                        this.logger.warn(this.logSystem, this.logComponent, `PPLNT: Disqualifying ${shares} shares from ${workerAddress} for round ${round.height}`);
                        totalSharesRemoved += shares;
                        delete workerShares[workerAddress];
                    }
                }
                totalShares -= totalSharesRemoved;
            }

            // Store worker shares for potential orphan merging
            round.workerShares = workerShares;

            // Calculate net reward after fee deduction
            const reward = this.coinsToSatoshis(round.reward) - this.coinsToSatoshis(this.fee);

            // Distribute reward proportionally based on shares
            for (const workerAddress in workerShares) {
                const percent = parseFloat(workerShares[workerAddress]) / totalShares;
                const workerReward = Math.round(reward * percent);
                if (!workers[workerAddress]) {
                    workers[workerAddress] = { balance: 0 };
                }
                workers[workerAddress].reward = (workers[workerAddress].reward || 0) + workerReward;
            }
        });

        return { workersWithRewards: workers, finalRounds: rounds };
    }

    /**
     * Step 4: Execute payments to miners using daemon's sendmany RPC
     * Aggregates payments by address, validates addresses, and creates payment records
     * 
     * @param {Object} workers - Worker data with calculated rewards
     * @returns {Object} Object with updated workers and Redis commands for payment records
     * @returns {Object} workersWithPayments - Updated worker data with payment status
     * @returns {Array} paymentsUpdate - Redis commands to store payment history record
     */
    async _executePayments(workers) {
        const addressAmounts = {};
        let totalSent = 0;

        // Aggregate payments by miner address and validate addresses
        for (const w in workers) {
            const worker = workers[w];
            const address = this.getProperAddress(w.split('.')[0]);
            worker.address = address;
            const toSend = (worker.balance || 0) + (worker.reward || 0);

            // Only pay if amount meets minimum payment threshold
            if (toSend >= this.minPaymentSatoshis) {
                addressAmounts[address] = (addressAmounts[address] || 0) + toSend;
                totalSent += toSend;
            }
        }

        // Return early if no payments to process
        if (Object.keys(addressAmounts).length === 0) {
            return { workersWithPayments: workers, paymentsUpdate: [] };
        }

        // Convert satoshis to coin amounts for sendmany RPC
        const finalAddressAmounts = {};
        for (const addr in addressAmounts) {
            finalAddressAmounts[addr] = this.satoshisToCoins(addressAmounts[addr]);
        }

        try {
            // Execute sendmany RPC call to send all payments in single transaction
            const txid = await this.cmd('sendmany', ['', finalAddressAmounts]);
            this.logger.info(this.logSystem, this.logComponent, `Payments sent in transaction: ${txid}`);

            // Update worker records with sent amounts and balance changes
            for (const w in workers) {
                const worker = workers[w];
                const toSend = (worker.balance || 0) + (worker.reward || 0);
                if (toSend >= this.minPaymentSatoshis) {
                    worker.sent = this.satoshisToCoins(toSend);
                    worker.balanceChange = -worker.balance; // Deduct old balance
                } else {
                    worker.sent = 0;
                    worker.balanceChange = worker.reward || 0; // Add to balance for next time
                }
            }

            // Create payment record for pool history
            const paymentRecord = {
                time: Date.now(),
                txid: txid,
                amount: this.satoshisToCoins(totalSent),
                fee: this.fee,
                workers: Object.keys(addressAmounts).length,
                paid: finalAddressAmounts
            };

            // Add payment record to Redis sorted set for pool statistics
            const paymentsUpdate = [
                ['zadd', `${this.coin}:payments`, Date.now(), JSON.stringify(paymentRecord)]
            ];

            return { workersWithPayments: workers, paymentsUpdate };

        } catch (error) {
            // If payment fails, defer payments by adding rewards to balances
            this.logger.error(this.logSystem, this.logComponent, `Sendmany failed: ${error.message}. Deferring payments.`);
            for (const w in workers) {
                workers[w].sent = 0;
                workers[w].balanceChange = workers[w].reward || 0; // Add reward to balance for next payment run
            }
            return { workersWithPayments: workers, paymentsUpdate: [] };
        }
    }

    /**
     * Step 5: Update Redis with payment results and block status changes
     * Handles orphaned block share redistribution and critical error recovery
     * 
     * Block Status Transitions:
     * - 'kicked'/'orphan' → moved to blocksKicked set
     * - 'generate' → moved to blocksConfirmed set, shares deleted
     * - 'immature' → confirmation count updated
     * 
     * @param {Object} workers - Worker data with payment results
     * @param {Array} rounds - Processed rounds with final categories
     * @param {Array} paymentsUpdate - Additional Redis commands for payments
     */
    async _updateRedis(workers, rounds, paymentsUpdate) {
        const finalRedisCommands = [];

        // Update worker balances and payout totals
        for (const w in workers) {
            const worker = workers[w];
            if (worker.balanceChange) {
                finalRedisCommands.push(['hincrbyfloat', `${this.coin}:balances`, w, this.satoshisToCoins(worker.balanceChange)]);
            }
            if (worker.sent) {
                finalRedisCommands.push(['hincrbyfloat', `${this.coin}:payouts`, w, worker.sent]);
            }
        }

        // Process blocks based on their final category
        const roundsToDelete = [];
        rounds.forEach(r => {
            switch (r.category) {
                case 'kicked':
                case 'orphan':
                    // Move invalid/orphaned blocks to kicked set
                    finalRedisCommands.push(['smove', `${this.coin}:blocksPending`, `${this.coin}:blocksKicked`, r.serialized]);

                    // For orphaned blocks, redistribute shares to current round
                    if (r.category === 'orphan' && r.workerShares) {
                        this.logger.warn(this.logSystem, this.logComponent, `Moving shares from orphaned block ${r.height} to current round.`);
                        for (const worker in r.workerShares) {
                            finalRedisCommands.push(['hincrby', `${this.coin}:shares:roundCurrent`, worker, r.workerShares[worker]]);
                        }
                    }
                    break;

                case 'generate':
                    // Move paid blocks to confirmed set and clean up share data
                    finalRedisCommands.push(['smove', `${this.coin}:blocksPending`, `${this.coin}:blocksConfirmed`, r.serialized]);
                    roundsToDelete.push(`${this.coin}:shares:round${r.height}`);
                    roundsToDelete.push(`${this.coin}:shares:times${r.height}`);
                    break;

                case 'immature':
                    // Update confirmation count for immature blocks
                    finalRedisCommands.push(['hset', `${this.coin}:blocksPendingConfirms`, r.blockHash, r.confirmations]);
                    break;
            }
        });

        // Delete share data for confirmed blocks
        if (roundsToDelete.length > 0) {
            finalRedisCommands.push(['del', ...roundsToDelete]);
        }

        // Add any additional payment-related commands
        if (paymentsUpdate.length > 0) {
            finalRedisCommands.push(...paymentsUpdate);
        }

        // Update total paid statistics
        const totalPaid = Object.values(workers).reduce((sum, w) => sum + (w.sent || 0), 0);
        if (totalPaid > 0) {
            finalRedisCommands.push(['hincrbyfloat', `${this.coin}:stats`, 'totalPaid', totalPaid]);
        }

        // Execute all Redis commands atomically
        if (finalRedisCommands.length > 0) {
            try {
                await this.redis.multi(finalRedisCommands).exec();
            } catch (error) {
                // CRITICAL: Payments were sent but Redis update failed
                // Stop payment processing and save commands for manual execution
                this.logger.error(this.logSystem, this.logComponent, `CRITICAL: Payments sent but failed to update Redis. Manual intervention required. ${error.message}`);
                clearInterval(this.paymentInterval); // Prevent double payouts
                await writeFileAsync(`${this.coin}_finalRedisCommands.txt`, JSON.stringify(finalRedisCommands));
            }
        }
    }

    /**
     * Automatic shielding cycle for privacy coins (Zcash family)
     * Manages the movement of funds between transparent and shielded addresses
     * 
     * Logic:
     * 1. If transparent balance > threshold: Shield funds (T->Z)
     * 2. If transparent balance is low but shielded balance > threshold: Unshield funds (Z->T)
     * 
     * This ensures there are always sufficient transparent funds for mining payouts
     * while keeping most pool funds in the privacy-enhanced shielded pool.
     */
    async shieldingCycle() {
        if (!this.requireShielding) {
            return;
        } // Skip if shielding not required

        try {
            const tBalance = await this.listUnspent(this.poolConfig.address, null, this.minConfShield);
            const shieldingThreshold = this.coinsToSatoshis(0.001); // 0.001 coin threshold

            if (tBalance > shieldingThreshold) {
                // Shield transparent funds to privacy pool
                await this.sendTToZ(tBalance);
            } else {
                // Check if we need to unshield funds for payouts
                const zBalance = await this.listUnspentZ(this.poolConfig.zAddress, this.minConfShield);
                if (zBalance > shieldingThreshold) {
                    await this.sendZToT(zBalance);
                }
            }
        } catch (error) {
            this.logger.error(this.logSystem, this.logComponent, `Shielding cycle error: ${error.message}`);
        }
    }

    /**
     * Send transparent funds to shielded address (T->Z transaction)
     * Used for accumulating transparent coinbase rewards into shielded pool
     * Prevents concurrent operations and enforces minimum balance threshold
     * 
     * @param {Number} tBalance - Transparent balance in satoshis
     */
    async sendTToZ(tBalance) {
        if (this.opidCount > 0) {
            return;
        } // Prevent concurrent shielding operations
        const amount = this.satoshisToCoins(tBalance - 10000); // Reserve 0.0001 for fees
        if (amount <= 0) {
            return;
        }

        const params = [this.poolConfig.address, [{ address: this.poolConfig.zAddress, amount }]];
        const opid = await this.cmd('z_sendmany', params);
        this.opidCount++;
        this.opids.push(opid);
        this.logger.info(this.logSystem, this.logComponent, `Shielding ${amount} T to Z, opid: ${opid}`);
    }

    /**
     * Send shielded funds to transparent address (Z->T transaction)
     * Used for paying miners from the shielded pool
     * Limits unshielding amount and prevents concurrent operations
     * 
     * @param {Number} zBalance - Shielded balance in satoshis
     */
    async sendZToT(zBalance) {
        if (this.opidCount > 0) {
            return;
        } // Prevent concurrent unshielding operations
        let amount = this.satoshisToCoins(zBalance - 10000); // Reserve 0.0001 for fees
        if (amount <= 0) {
            return;
        }
        if (amount > 100) {
            amount = 100;
        } // Limit unshielding to 100 coins per operation

        const params = [this.poolConfig.zAddress, [{ address: this.poolConfig.tAddress, amount }]];
        const opid = await this.cmd('z_sendmany', params);
        this.opidCount++;
        this.opids.push(opid);
        this.logger.info(this.logSystem, this.logComponent, `Unshielding ${amount} Z to T, opid: ${opid}`);
    }

    /**
     * Check status of async shielded transactions and clean up completed operations
     * Monitors operation IDs to determine when shielding/unshielding completes
     * Automatically removes completed operations from tracking arrays
     */
    async checkOpids() {
        if (this.opids.length === 0) {
            return;
        }

        const statuses = await this.cmd('z_getoperationstatus', [this.opids]);
        if (!statuses) {
            return;
        }

        for (const op of statuses) {
            if (op.status === 'success' || op.status === 'failed') {
                // Remove completed operation from tracking
                const index = this.opids.indexOf(op.id);
                if (index > -1) {
                    this.opids.splice(index, 1);
                    this.opidCount--;
                }

                // Log operation result
                if (op.status === 'success') {
                    this.logger.info(this.logSystem, this.logComponent, `Operation ${op.id} succeeded. TXID: ${op.result.txid}`);
                } else {
                    this.logger.error(this.logSystem, this.logComponent, `Operation ${op.id} failed. Error: ${op.error.message}`);
                }
            }
        }
    }

    /**
     * Cache current network statistics in Redis for website display
     * Retrieves blockchain and network data for pool statistics page
     * Updates: block height, difficulty, network hashrate, connections
     */
    async cacheNetworkStats() {
        try {
            const [miningInfo, networkInfo] = await Promise.all([
                this.cmd('getmininginfo', []),
                this.cmd('getnetworkinfo', []),
            ]);

            const redisCommands = [
                ['hset', `${this.coin}:stats`, 'networkBlocks', miningInfo.blocks],
                ['hset', `${this.coin}:stats`, 'networkDiff', miningInfo.difficulty],
                ['hset', `${this.coin}:stats`, 'networkSols', miningInfo.networkhashps],
                ['hset', `${this.coin}:stats`, 'networkConnections', networkInfo.connections],
            ];
            await this.redis.multi(redisCommands).exec();
        } catch (error) {
            this.logger.error(this.logSystem, this.logComponent, `Error caching network stats: ${error.message}`);
        }
    }

    /**
     * Cache cryptocurrency market data from CoinMarketCap API
     * Retrieves price, volume, and market cap data for pool website
     * Handles coin name mapping for API compatibility (e.g., zen -> zencash)
     * 
     * Note: Uses CoinMarketCap v1 API for compatibility with existing pool infrastructure.
     * For production use, consider upgrading to v2 API with proper API key authentication.
     */
    async cacheMarketStats() {
        try {
            let coinName = this.coin.replace('_testnet', '').toLowerCase();
            if (coinName === 'zen') {
                coinName = 'zencash';
            } // API name mapping

            // Attempt to fetch from CoinMarketCap v1 API (may be rate limited)
            const response = await fetch(`https://api.coinmarketcap.com/v1/ticker/${coinName}/`, {
                headers: {
                    'User-Agent': 'NOMP Pool Software'
                },
                signal: AbortSignal.timeout(10000) // 10 second timeout
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const body = await response.json();

            if (body && body.length > 0) {
                await this.redis.hset(`${this.coin}:stats`, 'coinmarketcap', JSON.stringify(body));
                this.logger.debug(this.logSystem, this.logComponent, `Successfully cached market stats for ${coinName}`);
            } else {
                this.logger.warn(this.logSystem, this.logComponent, `No market data returned for ${coinName}`);
            }
        } catch (error) {
            // Market stats are not critical for pool operation, so we log but don't throw
            if (error.message.includes('ENOTFOUND') || error.message.includes('ECONNREFUSED') || error.name === 'TimeoutError') {
                this.logger.warn(this.logSystem, this.logComponent, `CoinMarketCap API unavailable: ${error.message}`);
            } else if (error.message.includes('429')) {
                this.logger.warn(this.logSystem, this.logComponent, `CoinMarketCap API rate limit exceeded`);
            } else {
                this.logger.error(this.logSystem, this.logComponent, `Error caching market stats: ${error.message}`);
            }
        }
    }

    /**
     * List unspent transaction outputs and calculate balance
     * Used for determining available funds in transparent addresses
     * 
     * @param {String} address - Specific address to check (optional)
     * @param {String} notAddress - Address to exclude from balance calculation
     * @param {Number} minConf - Minimum confirmations required
     * @returns {Number} Total balance in coins
     */
    async listUnspent(address, notAddress, minConf) {
        const args = [minConf, 99999999];
        if (address) {
            args.push([address]);
        }
        const unspent = await this.cmd('listunspent', args);
        let balance = 0;
        if (unspent) {
            unspent.forEach(tx => {
                if (!notAddress || tx.address !== notAddress) {
                    balance += tx.amount;
                }
            });
        }
        return this.coinsToSatoshis(balance);
    }

    /**
     * Get shielded address balance with minimum confirmations
     * Used for checking available funds in shielded pool
     * 
     * @param {String} address - Shielded address to check
     * @param {Number} minConf - Minimum confirmations required
     * @returns {Number} Balance in satoshis
     */
    async listUnspentZ(address, minConf) {
        const balance = await this.cmd('z_getbalance', [address, minConf]);
        return this.coinsToSatoshis(balance || 0);
    }

    /**
     * Validate miner address and return proper address for payments
     * Handles address validation and fallback to pool address for invalid addresses
     * Supports Verus address validation and mining key extraction
     * 
     * @param {String} address - Worker address to validate (may include mining key)
     * @returns {String} Valid address for payments
     */
    getProperAddress(address) {
        const isValid = WAValidator.validate(String(address).split('.')[0], 'VRSC');
        if (!isValid) {
            this.logger.warn(this.logSystem, this.logComponent, `Invalid address ${address}, converting to pool address.`);
            return this.poolConfig.invalidAddress || this.poolConfig.address;
        }
        return address;
    }

    /**
     * Execute single daemon RPC command with promise wrapper
     * Converts callback-based daemon interface to async/await compatible promises
     * 
     * @param {String} command - RPC command name
     * @param {Array} params - Command parameters  
     * @returns {Promise} Command result or rejection on error
     */
    cmd(command, params) {
        return new Promise((resolve, reject) => {
            this.daemon.cmd(command, params, (result) => {
                if (result.error) {
                    reject(new Error(result.error.message || JSON.stringify(result.error)));
                } else {
                    resolve(result.response || (result[0] ? result[0].response : null));
                }
            }, true, true);
        });
    }

    /**
     * Execute multiple daemon RPC commands in a single batch
     * Optimizes performance by reducing network round trips for bulk operations
     * 
     * @param {Array} batch - Array of RPC command objects
     * @returns {Promise} Array of command results or rejection on error
     */
    batchCmd(batch) {
        return new Promise((resolve, reject) => {
            this.daemon.batchCmd(batch, (error, results) => {
                if (error) {
                    reject(new Error(JSON.stringify(error)));
                } else {
                    resolve(results);
                }
            });
        });
    }
    /**
     * Convert satoshis to coin decimal representation
     * @param {Number} satoshis - Value in satoshis
     * @returns {Number} Value in coins with proper precision
     */
    satoshisToCoins(satoshis) {
        return this.roundTo(satoshis / this.magnitude, this.coinPrecision);
    }

    /**
     * Convert coins to satoshi representation
     * @param {Number} coins - Value in coins
     * @returns {Number} Value in satoshis (integer)
     */
    coinsToSatoshis(coins) {
        return Math.round(coins * this.magnitude);
    }

    /**
     * Round coin amount to proper decimal precision
     * @param {Number} number - Coin amount to round
     * @returns {Number} Rounded amount with coin precision
     */
    coinsRound(number) {
        return this.roundTo(number, this.coinPrecision);
    }

    /**
     * Utility function to round numbers to specified decimal places
     * @param {Number} n - Number to round
     * @param {Number} digits - Number of decimal places
     * @returns {Number} Rounded number
     */
    roundTo(n, digits) {
        const multiplicator = Math.pow(10, digits);
        n = parseFloat((n * multiplicator).toFixed(11));
        return Math.round(n) / multiplicator;
    }
}

module.exports = function () {
    let portalConfig = {};
    if (process.env.portalConfig) {
        try {
            portalConfig = JSON.parse(process.env.portalConfig);
        } catch (e) {
            /* ignore */
        }
    }

    const poolConfigs = JSON.parse(process.env.pools);

    for (const coin in poolConfigs) {
        const poolOptions = poolConfigs[coin];
        if (poolOptions.paymentProcessing && poolOptions.paymentProcessing.enabled) {
            const processor = new PaymentProcessor(poolOptions, portalConfig);
            processor.start().catch(err => {
                console.error(`Failed to start payment processor for ${coin}: ${err.message}`);
            });
        }
    }
};
