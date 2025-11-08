
const fs = require('fs');
const { promisify } = require('util');

const Stratum = require('./stratum');
const CreateRedisClient = require('./createRedisClient');
const PoolLogger = require('./PoolLogger.js');
const util = require('./utils/util.js');

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
 * - Network statistics caching
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

        // Shielding removed for Verus; only track bad blocks
        this.badBlocks = {}; // Track blocks that failed validation (retry mechanism)

        // Payment processing configuration with sensible defaults
        this.minConfPayout = Math.max(this.processingConfig.minConf || 10, 1);     // Min confirmations for payouts
        this.paymentIntervalSecs = Math.max(this.processingConfig.paymentInterval || 120, 30); // Payment frequency
        this.maxBlocksPerPayment = Math.max(this.processingConfig.maxBlocksPerPayment || 3, 1); // Blocks per payment run
        this.pplntEnabled = this.processingConfig.paymentMode === 'pplnt' || false; // PPLNT payment mode
        this.pplntTimeQualify = this.processingConfig.pplnt || 0.51;                // PPLNT time threshold (51%)
        // Verus-only: shielding/z-address support removed
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

        // No shielding in Verus build - removed z-address operations

        // Statistics caching intervals
        this.statsInterval = setInterval(() => this.cacheNetworkStats(), 58 * 1000);
    }

    /**
     * Validate that the daemon owns all configured addresses
     * This ensures the payment processor can manage funds properly
     */
    async validateDaemons() {
        const validations = [this.validateAddress(this.poolConfig.address)];
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
            Object.keys(balances).forEach(w => {
                workers[w] = { balance: util.coinsToSatoshis(parseFloat(balances[w]), this.magnitude) };
            });
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

        // Precompute counts of blocks per height for quick checks
        const heightCounts = {};
        for (let i = 0; i < rounds.length; i++) {
            heightCounts[rounds[i].height] = (heightCounts[rounds[i].height] || 0) + 1;
        }

        const validated = [];
        let payingBlocks = 0;

        for (let i = 0; i < rounds.length; i++) {
            const round = rounds[i];
            const tx = txDetails[i] || {};

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
                    continue; // Skip this round for now
                }
            } else if (tx && tx.result) {
                // Block is now valid - clear from bad blocks tracking
                if (this.badBlocks[round.txHash]) {
                    this.logger.info(this.logSystem, this.logComponent, `${round.txHash} is no longer bad!`);
                    delete this.badBlocks[round.txHash];
                }

                round.confirmations = tx.result.confirmations || 0;
                // Find transaction detail for pool address or use first available
                const detail = (tx.result.details || []).find(d => d.address === this.poolConfig.address) || (tx.result.details || [])[0];

                if (detail) {
                    round.category = detail.category;
                    if (round.category === 'generate' || round.category === 'immature') {
                        round.reward = util.coinsRound(parseFloat(detail.amount || detail.value), this.coinPrecision);
                    }
                } else {
                    this.logger.error(this.logSystem, this.logComponent, `ERROR: Missing output details to pool address for transaction ${round.txHash}`);
                    round.category = 'kicked'; // No details for pool address
                }
            } else {
                round.category = 'kicked'; // RPC error or no result
            }

            // Limit concurrent payments to prevent overwhelming the daemon
            if (round.category === 'generate') {
                if (round.confirmations >= this.minConfPayout) {
                    payingBlocks++;
                    if (payingBlocks > this.maxBlocksPerPayment) {
                        round.category = 'immature'; // Defer payment to next run
                    }
                } else {
                    round.category = 'immature'; // Not enough confirmations yet
                }
            }

            // Determine if shares can be safely deleted (no other blocks at same height)
            round.canDeleteShares = heightCounts[round.height] === 1;

            validated.push(round);
        }

        return validated;
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
            totalOwed += util.coinsToSatoshis(r.reward, this.magnitude) - util.coinsToSatoshis(this.fee, this.magnitude);
        });

        // Verify pool has sufficient balance for all payments
        // Verus: no shielded address exclusion
        const tBalance = await this.listUnspent(null, null, this.minConfPayout);
        if (tBalance < totalOwed) {
            this.logger.warn(this.logSystem, this.logComponent, `Insufficient funds for payment (${util.satoshisToCoins(tBalance, this.magnitude, this.coinPrecision)} < ${util.satoshisToCoins(totalOwed, this.magnitude, this.coinPrecision)}). Deferring payments.`);
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
            const reward = util.coinsToSatoshis(round.reward, this.magnitude) - util.coinsToSatoshis(this.fee, this.magnitude);

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
        Object.keys(workers).forEach(w => {
            const worker = workers[w];
            const address = this.getProperAddress(w.split('.')[0]);
            worker.address = address;
            const toSend = (worker.balance || 0) + (worker.reward || 0);

            // Only pay if amount meets minimum payment threshold
            if (toSend >= this.minPaymentSatoshis) {
                addressAmounts[address] = (addressAmounts[address] || 0) + toSend;
                totalSent += toSend;
            }
        });

        // Return early if no payments to process
        if (Object.keys(addressAmounts).length === 0) {
            return { workersWithPayments: workers, paymentsUpdate: [] };
        }

        // Convert satoshis to coin amounts for sendmany RPC
        const finalAddressAmounts = {};
        Object.keys(addressAmounts).forEach(addr => {
            finalAddressAmounts[addr] = util.satoshisToCoins(addressAmounts[addr], this.magnitude, this.coinPrecision);
        });

        try {
            // Execute sendmany RPC call to send all payments in single transaction
            const txid = await this.cmd('sendmany', ['', finalAddressAmounts]);
            this.logger.info(this.logSystem, this.logComponent, `Payments sent in transaction: ${txid}`);

            // Update worker records with sent amounts and balance changes
            Object.keys(workers).forEach(w => {
                const worker = workers[w];
                const toSend = (worker.balance || 0) + (worker.reward || 0);
                if (toSend >= this.minPaymentSatoshis) {
                    worker.sent = util.satoshisToCoins(toSend, this.magnitude, this.coinPrecision);
                    worker.balanceChange = -worker.balance; // Deduct old balance
                } else {
                    worker.sent = 0;
                    worker.balanceChange = worker.reward || 0; // Add to balance for next time
                }
            });

            // Create payment record for pool history
            const paymentRecord = {
                time: Date.now(),
                txid: txid,
                amount: util.satoshisToCoins(totalSent, this.magnitude, this.coinPrecision),
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
        Object.keys(workers).forEach(w => {
            const worker = workers[w];
            if (worker.balanceChange) {
                finalRedisCommands.push(['hincrbyfloat', `${this.coin}:balances`, w, util.satoshisToCoins(worker.balanceChange, this.magnitude, this.coinPrecision)]);
            }
            if (worker.sent) {
                finalRedisCommands.push(['hincrbyfloat', `${this.coin}:payouts`, w, worker.sent]);
            }
        });

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
                        Object.keys(r.workerShares).forEach(worker => {
                            finalRedisCommands.push(['hincrby', `${this.coin}:shares:roundCurrent`, worker, r.workerShares[worker]]);
                        });
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
        return util.coinsToSatoshis(balance, this.magnitude);
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
        const isValid = Stratum.util.validateVerusAddress(String(address).split('.')[0]);
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
