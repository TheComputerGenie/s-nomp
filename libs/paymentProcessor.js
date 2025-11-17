
/**
 * @fileoverview Payment Processor - handles block validation and payouts
 *
 * This module implements the PaymentProcessor class which coordinates reading
 * pending mined blocks and balances from Redis, validating transactions with
 * the coin daemon, computing rewards, executing payments via RPC, and
 * updating Redis state. It is intended to run as a long-lived background
 * worker per configured pool.
 *
 * @author ComputerGenieCo
 * @version 21.7.3
 * @copyright 2025
 */

const fs = require('fs');
const { promisify } = require('util');

// Local modules (alphabetized by module specifier)
const CreateRedisClient = require('./createRedisClient');
const PoolLogger = require('./PoolLogger.js');
const Stratum = require('./stratum');
const util = require('./utils/util.js');

const writeFileAsync = promisify(fs.writeFile);

class PaymentProcessor {
    /**
     * PaymentProcessor
     *
     * Coordinates payment processing for a single pool configuration.
     *
     * @class PaymentProcessor
     * @param {Object} poolConfig - Pool-specific configuration loaded from env
     * @param {Object} portalConfig - Optional portal configuration (logging etc.)
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
        // runtime state
        this.badBlocks = {};

        this.processingConfig = poolConfig.paymentProcessing;
        this.daemon = new Stratum.daemon.interface([this.processingConfig.daemon], (severity, message) => {
            this.logger[severity](this.logSystem, this.logComponent, message);
        });

        this.redisClient = CreateRedisClient(poolConfig.redis);
        if (poolConfig.redis.password) {
            this.redisClient.auth(poolConfig.redis.password);
        }

        this.redis = {
            hgetall: promisify(this.redisClient.hgetall).bind(this.redisClient),
            smembers: promisify(this.redisClient.smembers).bind(this.redisClient),
            hset: promisify(this.redisClient.hset).bind(this.redisClient),
            multi: (commands) => {
                const multiObj = this.redisClient.multi(commands);
                return {
                    exec: (cb) => {
                        if (typeof cb === 'function') {
                            return multiObj.exec(cb);
                        }
                        // Return a promise if callback not supplied
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

        this.minConfPayout = Math.max(this.processingConfig.minConf || 10, 1);
        this.paymentIntervalSecs = Math.max(this.processingConfig.paymentInterval || 120, 30);
        this.maxBlocksPerPayment = Math.max(this.processingConfig.maxBlocksPerPayment || 3, 1);
        this.pplntEnabled = (this.processingConfig.paymentMode === 'pplnt') || false;
        this.pplntTimeQualify = typeof this.processingConfig.pplnt === 'number' ? this.processingConfig.pplnt : 0.51;
        this.fee = (typeof poolConfig.coin.txfee !== 'undefined') ? parseFloat(poolConfig.coin.txfee) : 0.0004;
        if (Number.isNaN(this.fee)) {
            this.fee = 0.0004;
        }
    }

    /**
     * Start the payment processor.
     *
     * Initializes connections to the daemon and Redis, determines coin
     * precision, and schedules periodic payment and stats tasks.
     * @returns {Promise<void>}
     */
    async start() {
        this.logger.info(this.logSystem, this.logComponent, 'Starting payment processor...');

        try {
            await this.validateDaemons();
            await this.determineCoinPrecision();
        } catch (error) {
            this.logger.error(this.logSystem, this.logComponent, `Failed to initialize: ${error.message}`);
            return;
        }

        this.logger.debug(this.logSystem, this.logComponent, `Payment processing setup with daemon and redis.`);

        this.paymentInterval = setInterval(() => this.processPayments(), this.paymentIntervalSecs * 1000);

        this.statsInterval = setInterval(() => this.cacheNetworkStats(), 58 * 1000);
    }

    async validateDaemons() {
        const validations = [this.validateAddress(this.poolConfig.address)];
        await Promise.all(validations);
    }

    /**
     * validateAddress
     *
     * Ensure the daemon reports ownership of the configured pool address.
     * @param {string} address - Pool address to validate
     * @returns {Promise<void>}
     * @throws {Error} If the daemon does not own the address
     */

    async validateAddress(address) {
        const result = await this.cmd('validateaddress', [address]);
        if (!result.ismine) {
            throw new Error(`Daemon does not own pool address: ${address}`);
        }
    }

    async determineCoinPrecision() {
        const result = await this.cmd('getbalance', []);
        const str = (typeof result === 'number' || typeof result === 'string') ? result.toString() : '0';
        const parts = str.split('.');
        const decimals = (parts[1] || '').length;
        // magnitude = 10^decimals
        this.magnitude = Number(`1${'0'.repeat(Math.max(decimals, 0))}`);
        if (!Number.isFinite(this.magnitude) || this.magnitude <= 0) {
            this.magnitude = 100000000; // default to 1e8
        }
        // ensure minimumPayment exists and is numeric
        const minPayment = parseFloat(this.processingConfig.minimumPayment || 0);
        this.minPayment = minPayment;
        this.minPaymentSatoshis = Math.round(minPayment * this.magnitude);
        this.coinPrecision = Math.max(decimals, 0);
    }

    /**
     * processPayments
     *
     * Top-level payment processing run. This coordinates reading data from
     * Redis, validating blocks, calculating rewards, executing payments, and
     * updating Redis state. Errors during processing are logged and do not
     * stop the periodic scheduler.
     * @returns {Promise<void>}
     */

    async processPayments() {
        const startTime = Date.now();
        this.logger.info(this.logSystem, this.logComponent, 'Starting payment processing run...');

        try {
            const { workers, rounds } = await this._getDataFromRedis();

            const validatedRounds = await this._validateBlocks(rounds);

            const { workersWithRewards, finalRounds } = await this._calculateRewards(workers, validatedRounds);

            // Compute total net rewards (satoshis) available from the rounds
            const feeSatoshis = util.coinsToSatoshis(this.fee, this.magnitude);
            let sumNetRewardsSats = 0;
            finalRounds.forEach(r => {
                if (r.category === 'generate') {
                    const blockRewardSatoshis = util.coinsToSatoshis(r.reward, this.magnitude);
                    const net = Math.max(0, blockRewardSatoshis - feeSatoshis);
                    sumNetRewardsSats += net;
                }
            });

            const { workersWithPayments, paymentsUpdate } = await this._executePayments(workersWithRewards, sumNetRewardsSats);

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
     * _getDataFromRedis
     *
     * Fetch balances and pending block list from Redis and normalize the
     * results into in-memory structures used during processing.
     * @returns {Promise<{workers: Object, rounds: Array}>}
     */

    async _getDataFromRedis() {
        const [balances, pendingBlocks] = await Promise.all([
            this.redis.hgetall(`${this.coin}:balances`),
            this.redis.smembers(`${this.coin}:blocksPending`),
        ]);

        const workers = {};
        if (balances) {
            Object.keys(balances).forEach(w => {
                // Ensure malformed or missing balances default to 0
                const balFloat = parseFloat(balances[w]);
                const balCoins = Number.isFinite(balFloat) ? balFloat : 0;
                workers[w] = { balance: util.coinsToSatoshis(balCoins, this.magnitude) };
            });
        }

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

        const heights = {};
        rounds.forEach(r => {
            heights[r.height] = (heights[r.height] || 0) + 1;
        });

        const duplicateRounds = rounds.filter(r => heights[r.height] > 1);
        if (duplicateRounds.length > 0) {
            this.logger.warn(this.logSystem, this.logComponent, `Duplicate pending blocks found: ${JSON.stringify(duplicateRounds.map(r => r.height))}`);

            const rpcDupCheck = duplicateRounds.map(r => ['getblock', [r.blockHash]]);
            const blocks = await this.batchCmd(rpcDupCheck);

            const invalidBlocks = [];
            blocks.forEach((block, i) => {
                const round = duplicateRounds[i];
                if (block && block.result && block.result.confirmations === -1) {
                    invalidBlocks.push(['smove', `${this.coin}:blocksPending`, `${this.coin}:blocksKicked`, round.serialized]);
                    round.duplicate = true;
                }
            });

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
     * _validateBlocks
     *
     * Given an array of pending rounds, query the daemon for transaction
     * details and classify each round as 'generate', 'immature', 'kicked', or
     * 'orphan'. Also annotate confirmation counts and reward values.
     * @param {Array} rounds - Array of pending round objects from Redis
     * @returns {Promise<Array>} Array of validated round objects
     */

    async _validateBlocks(rounds) {
        if (rounds.length === 0) {
            return [];
        }

        const batchRPC = rounds.map(r => ['gettransaction', [r.txHash]]);
        const txDetails = await this.batchCmd(batchRPC);

        const heightCounts = {};
        for (let i = 0; i < rounds.length; i++) {
            heightCounts[rounds[i].height] = (heightCounts[rounds[i].height] || 0) + 1;
        }

        const validated = [];
        let payingBlocks = 0;

        for (let i = 0; i < rounds.length; i++) {
            const round = rounds[i];
            const tx = txDetails[i] || {};

            if (tx.error && tx.error.code === -5) {
                this.badBlocks[round.txHash] = (this.badBlocks[round.txHash] || 0) + 1;
                if (this.badBlocks[round.txHash] >= 15) {
                    this.logger.warn(this.logSystem, this.logComponent, `ERROR: Daemon reports invalid transaction: ${round.txHash}`);
                    delete this.badBlocks[round.txHash];
                    round.category = 'kicked';
                } else {
                    this.logger.warn(this.logSystem, this.logComponent, `Abandoned block ${round.txHash} check ${this.badBlocks[round.txHash]}/15`);
                    continue;
                }
            } else if (tx && tx.result) {
                if (this.badBlocks[round.txHash]) {
                    this.logger.info(this.logSystem, this.logComponent, `${round.txHash} is no longer bad!`);
                    delete this.badBlocks[round.txHash];
                }

                round.confirmations = tx.result.confirmations || 0;
                const detail = (tx.result.details || []).find(d => d.address === this.poolConfig.address) || (tx.result.details || [])[0];

                if (detail) {
                    round.category = detail.category;
                    if (round.category === 'generate' || round.category === 'immature') {
                        round.reward = util.coinsRound(parseFloat(detail.amount || detail.value), this.coinPrecision);
                    }
                } else {
                    this.logger.error(this.logSystem, this.logComponent, `ERROR: Missing output details to pool address for transaction ${round.txHash}`);
                    round.category = 'kicked';
                }
            } else {
                round.category = 'kicked';
            }

            // If the daemon reports the output category as 'generate' or
            // 'immature', treat the round as potentially payable once it has
            // reached the required confirmation count. Some daemons report
            // coinbase outputs as 'immature' even when confirmations have
            // passed the pool's minConf, so we explicitly promote those.
            if (round.category === 'generate' || round.category === 'immature') {
                if (round.confirmations >= this.minConfPayout) {
                    // mark as payable
                    round.category = 'generate';
                    payingBlocks++;
                    if (payingBlocks > this.maxBlocksPerPayment) {
                        // defer excess blocks to future runs
                        round.category = 'immature';
                    }
                } else {
                    // still immature
                    round.category = 'immature';
                }
            }

            round.canDeleteShares = heightCounts[round.height] === 1;

            validated.push(round);
        }

        return validated;
    }

    /**
     * _calculateRewards
     *
     * For confirmed (paying) rounds, load per-worker share counts from Redis,
     * apply PPLNT disqualification as configured, and compute per-worker
     * reward satoshi amounts. Updates the workers map with a 'reward' field.
     * @param {Object} workers - Map of worker => { balance }
     * @param {Array} rounds - Validated rounds array
     * @returns {Promise<{workersWithRewards: Object, finalRounds: Array}>}
     */

    async _calculateRewards(workers, rounds) {
        const payingRounds = rounds.filter(r => r.category === 'generate');
        if (payingRounds.length === 0) {
            return { workersWithRewards: workers, finalRounds: rounds };
        }

        const shareLookups = payingRounds.map(r => ['hgetall', `${this.coin}:shares:round${r.height}`]);
        const timeLookups = this.pplntEnabled ? payingRounds.map(r => ['hgetall', `${this.coin}:shares:times${r.height}`]) : [];

        const [allWorkerShares, allWorkerTimes] = await Promise.all([
            this.redis.multi(shareLookups).exec(),
            this.pplntEnabled ? this.redis.multi(timeLookups).exec() : Promise.resolve([])
        ]);

        let totalOwed = Object.values(workers).reduce((sum, worker) => sum + (worker.balance || 0), 0);
        // Precompute fee in satoshis once and use consistently per round
        const feeSatoshis = util.coinsToSatoshis(this.fee, this.magnitude);
        payingRounds.forEach(r => {
            const blockRewardSatoshis = util.coinsToSatoshis(r.reward, this.magnitude);
            const netReward = Math.max(0, blockRewardSatoshis - feeSatoshis);
            totalOwed += netReward;
        });

        const tBalance = await this.listUnspent(null, null, this.minConfPayout);
        if (tBalance < totalOwed) {
            this.logger.warn(this.logSystem, this.logComponent, `Insufficient funds for payment (${util.satoshisToCoins(tBalance, this.magnitude, this.coinPrecision)} < ${util.satoshisToCoins(totalOwed, this.magnitude, this.coinPrecision)}). Deferring payments.`);
            rounds.forEach(r => {
                if (r.category === 'generate') {
                    r.category = 'immature';
                }
            });
            return { workersWithRewards: workers, finalRounds: rounds };
        }

        payingRounds.forEach((round, i) => {
            const workerShares = allWorkerShares[i];
            if (!workerShares) {
                return;
            }

            let totalShares = Object.values(workerShares).reduce((sum, s) => sum + parseFloat(s), 0);
            if (totalShares === 0) {
                return;
            }

            if (this.pplntEnabled) {
                const workerTimes = allWorkerTimes[i];
                const maxTime = round.time * this.pplntTimeQualify;
                let totalSharesRemoved = 0;

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

            round.workerShares = workerShares;

            const blockRewardSatoshis = util.coinsToSatoshis(round.reward, this.magnitude);
            let netReward = blockRewardSatoshis - feeSatoshis;
            if (netReward <= 0) {
                this.logger.warn(this.logSystem, this.logComponent, `Block reward (${blockRewardSatoshis}) <= fee (${feeSatoshis}) for round ${round.height}; skipping reward distribution.`);
                netReward = 0;
            }

            // Distribute netReward proportionally to workerShares. Use rounding
            // and assign any small remainder to the worker with the largest share
            // to ensure total distributed equals netReward.
            const workerRewards = {};
            let distributed = 0;
            let largestWorker = null;
            let largestShares = 0;

            for (const workerAddress in workerShares) {
                const shares = parseFloat(workerShares[workerAddress]);
                const percent = shares / totalShares;
                const workerReward = Math.round(netReward * percent);
                workerRewards[workerAddress] = workerReward;
                distributed += workerReward;
                if (shares > largestShares) {
                    largestShares = shares;
                    largestWorker = workerAddress;
                }
            }

            // Adjust for rounding remainder
            const remainder = netReward - distributed;
            if (remainder !== 0 && largestWorker) {
                workerRewards[largestWorker] = (workerRewards[largestWorker] || 0) + remainder;
                distributed += remainder;
            }

            for (const workerAddress in workerRewards) {
                if (!workers[workerAddress]) {
                    workers[workerAddress] = { balance: 0 };
                }
                workers[workerAddress].reward = (workers[workerAddress].reward || 0) + workerRewards[workerAddress];
            }
        });

        return { workersWithRewards: workers, finalRounds: rounds };
    }

    /**
     * _executePayments
     *
     * Build an aggregated send list for addresses that meet the minimum
     * payment, call the daemon's sendmany RPC, and annotate worker objects
     * with sent amounts and balance changes.
     * @param {Object} workers - Map of workers with balances and rewards
     * @returns {Promise<{workersWithPayments: Object, paymentsUpdate: Array}>}
     */

    async _executePayments(workers, sumNetRewardsSats = 0) {
        // Aggregate amounts by miner address (root address portion before any worker suffix)
        const addressAmounts = {};
        const addressWorkers = {}; // map address -> array of worker keys

        Object.keys(workers).forEach(w => {
            const worker = workers[w];
            const addressRoot = String(w).split('.')[0];
            const address = this.getProperAddress(addressRoot);
            worker.address = address;
            const toSend = (worker.balance || 0) + (worker.reward || 0);

            addressAmounts[address] = (addressAmounts[address] || 0) + toSend;
            addressWorkers[address] = addressWorkers[address] || [];
            addressWorkers[address].push({ key: w, toSend });
        });

        // Determine which addresses meet the minimum payment threshold
        const payableAddresses = Object.keys(addressAmounts).filter(addr => {
            const coinAmount = util.satoshisToCoins(addressAmounts[addr], this.magnitude, this.coinPrecision);
            return coinAmount >= this.minPayment;
        });

        if (payableAddresses.length === 0) {
            // No payments to send this run. Only record earned rewards
            // as balance changes if there are actual rewards to defer.
            let deferredCount = 0;
            Object.keys(workers).forEach(w => {
                const worker = workers[w];
                worker.sent = 0;
                // reward is stored in satoshis; balanceChange expects satoshis
                const change = worker.reward || 0;
                worker.balanceChange = change;
                if (change > 0) {
                    deferredCount++;
                }
            });

            if (deferredCount > 0) {
                this.logger.info(this.logSystem, this.logComponent, `Deferred payments recorded to balances for ${deferredCount} workers.`);
            }

            return { workersWithPayments: workers, paymentsUpdate: [] };
        }

        // Build final amounts for sendmany only for payable addresses
        const finalAddressAmounts = {};
        let totalSent = 0;
        payableAddresses.forEach(addr => {
            finalAddressAmounts[addr] = util.satoshisToCoins(addressAmounts[addr], this.magnitude, this.coinPrecision);
            totalSent += addressAmounts[addr];
        });

        // Compute sum of worker balances (satoshis) to determine total available
        let sumWorkerBalancesSats = 0;
        Object.keys(workers).forEach(w => {
            const worker = workers[w];
            sumWorkerBalancesSats += (worker.balance || 0);
        });

        const totalAvailable = (sumNetRewardsSats || 0) + sumWorkerBalancesSats;

        // Safety: if computed total to send exceeds total available (shouldn't happen)
        if (totalSent > (totalAvailable + 1)) { // 1 sat tolerance
            this.logger.error(this.logSystem, this.logComponent, `CRITICAL: Computed totalSent (${totalSent} sat) > totalAvailable (${totalAvailable} sat). Aborting send to avoid overpayment.`);
            // Defer payments: record rewards back to balances
            Object.keys(workers).forEach(w => {
                const worker = workers[w];
                worker.sent = 0;
                worker.balanceChange = worker.reward || 0;
            });
            return { workersWithPayments: workers, paymentsUpdate: [] };
        }

        try {
            const txid = await this.cmd('sendmany', ['', finalAddressAmounts]);
            this.logger.info(this.logSystem, this.logComponent, `Payments sent in transaction: ${txid}`);

            // Mark workers as paid or deferred based on whether their miner
            // (address) was included in this payment run.
            Object.keys(workers).forEach(w => {
                const worker = workers[w];
                const addr = worker.address;
                const toSend = (worker.balance || 0) + (worker.reward || 0);
                if (payableAddresses.indexOf(addr) !== -1) {
                    // This worker's miner was paid; mark worker as sent and
                    // clear their balance (balanceChange is negative of prior balance)
                    worker.sent = util.satoshisToCoins(toSend, this.magnitude, this.coinPrecision);
                    worker.balanceChange = -worker.balance;
                } else {
                    worker.sent = 0;
                    worker.balanceChange = worker.reward || 0;
                }
            });

            const paymentRecord = {
                time: Date.now(),
                txid: txid,
                amount: util.satoshisToCoins(totalSent, this.magnitude, this.coinPrecision),
                fee: this.fee,
                workers: payableAddresses.length,
                paid: finalAddressAmounts
            };

            const paymentsUpdate = [
                ['zadd', `${this.coin}:payments`, Date.now(), JSON.stringify(paymentRecord)]
            ];

            return { workersWithPayments: workers, paymentsUpdate };

        } catch (error) {
            this.logger.error(this.logSystem, this.logComponent, `Sendmany failed: ${error.message}. Deferring payments.`);
            for (const w in workers) {
                workers[w].sent = 0;
                workers[w].balanceChange = workers[w].reward || 0;
            }
            return { workersWithPayments: workers, paymentsUpdate: [] };
        }
    }

    /**
     * _updateRedis
     *
     * Apply the calculated Redis updates for balances, payouts, moved blocks
     * and any payment history zadd. If Redis update fails after a successful
     * send, the final commands are written to disk for manual recovery and
     * the payment interval is stopped.
     * @param {Object} workers - Map of worker objects
     * @param {Array} rounds - Final rounds array
     * @param {Array} paymentsUpdate - Redis commands to record the payment
     * @returns {Promise<void>}
     */

    async _updateRedis(workers, rounds, paymentsUpdate) {
        const finalRedisCommands = [];

        Object.keys(workers).forEach(w => {
            const worker = workers[w];
            if (worker.balanceChange) {
                finalRedisCommands.push(['hincrbyfloat', `${this.coin}:balances`, w, util.satoshisToCoins(worker.balanceChange, this.magnitude, this.coinPrecision)]);
            }
            if (worker.sent) {
                finalRedisCommands.push(['hincrbyfloat', `${this.coin}:payouts`, w, worker.sent]);
            }
        });

        const roundsToDelete = [];
        rounds.forEach(r => {
            switch (r.category) {
                case 'kicked':
                case 'orphan':
                    finalRedisCommands.push(['smove', `${this.coin}:blocksPending`, `${this.coin}:blocksKicked`, r.serialized]);

                    if (r.category === 'orphan' && r.workerShares) {
                        this.logger.warn(this.logSystem, this.logComponent, `Moving shares from orphaned block ${r.height} to current round.`);
                        Object.keys(r.workerShares).forEach(worker => {
                            finalRedisCommands.push(['hincrby', `${this.coin}:shares:roundCurrent`, worker, r.workerShares[worker]]);
                        });
                    }
                    break;

                case 'generate':
                    finalRedisCommands.push(['smove', `${this.coin}:blocksPending`, `${this.coin}:blocksConfirmed`, r.serialized]);
                    roundsToDelete.push(`${this.coin}:shares:round${r.height}`);
                    roundsToDelete.push(`${this.coin}:shares:times${r.height}`);
                    break;

                case 'immature':
                    // Store the real confirmation count so future payment runs can
                    // re-evaluate the round's status. The UI will cap the displayed
                    // value to the configured minConf to avoid showing numbers
                    // greater than the threshold.
                    finalRedisCommands.push(['hset', `${this.coin}:blocksPendingConfirms`, r.blockHash, r.confirmations]);
                    break;
            }
        });

        if (roundsToDelete.length > 0) {
            finalRedisCommands.push(['del', ...roundsToDelete]);
        }

        if (paymentsUpdate.length > 0) {
            finalRedisCommands.push(...paymentsUpdate);
        }

        const totalPaid = Object.values(workers).reduce((sum, w) => sum + (w.sent || 0), 0);
        if (totalPaid > 0) {
            finalRedisCommands.push(['hincrbyfloat', `${this.coin}:stats`, 'totalPaid', totalPaid]);
        }

        if (finalRedisCommands.length > 0) {
            try {
                await this.redis.multi(finalRedisCommands).exec();
            } catch (error) {
                this.logger.error(this.logSystem, this.logComponent, `CRITICAL: Payments sent but failed to update Redis. Manual intervention required. ${error.message}`);
                clearInterval(this.paymentInterval);
                await writeFileAsync(`${this.coin}_finalRedisCommands.txt`, JSON.stringify(finalRedisCommands));
            }
        }
    }

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
     * listUnspent
     *
     * Wrapper around the daemon 'listunspent' RPC that returns the available
     * balance in satoshis, optionally excluding a specific address.
     * @param {string|null} address - Optional address to include
     * @param {string|null} notAddress - Optional address to exclude from sum
     * @param {number} minConf - Minimum confirmations to count
     * @returns {Promise<number>} balance in satoshis
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
     * getProperAddress
     *
     * Resolve a worker-provided address to either the pool address or the
     * provided address if it validates. Falls back to the invalidAddress
     * configured value when available.
     * @param {string} address - Raw address string (may include worker suffix)
     * @returns {string} Validated address to use for payouts
     */

    getProperAddress(address) {
        if (!address) {
            return this.poolConfig.address;
        }
        const addrRoot = String(address).split('.')[0];
        const isValid = Stratum.util && Stratum.util.validateVerusAddress ? Stratum.util.validateVerusAddress(addrRoot) : false;
        if (!isValid) {
            this.logger.warn(this.logSystem, this.logComponent, `Invalid address ${address}, converting to pool address.`);
            return this.poolConfig.invalidAddress || this.poolConfig.address;
        }
        return address;
    }

    /**
     * cmd
     *
     * Promise wrapper for a single RPC call to the daemon interface.
     * @param {string} command - RPC command name
     * @param {Array} params - RPC parameters
     * @returns {Promise<any>} RPC response payload
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
     * batchCmd
     *
     * Promise wrapper for batching multiple RPC calls to the daemon.
     * @param {Array} batch - Array of RPC commands for batch execution
     * @returns {Promise<Array>} Batch results from the daemon
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
