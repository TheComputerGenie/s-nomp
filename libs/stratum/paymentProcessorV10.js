/*
 Minimal, Node.js v10 compatible reimplementation of PaymentProcessor.
 Preserves behavior of the original paymentProcessor.js but uses
 async/await, consistent error handling, and clearer structure.
*/

const fs = require('fs');
const { promisify } = require('util');
const request = promisify(require('request'));
const WAValidator = require('wallet-address-validator');

const Stratum = require('../stratum');
const CreateRedisClient = require('../createRedisClient');
const PoolLogger = require('../logUtil');

const writeFileAsync = promisify(fs.writeFile);

class PaymentProcessor {
    constructor(poolConfig, portalConfig) {
        this.poolConfig = poolConfig;
        this.coin = poolConfig.coin.name;
        this.logger = new PoolLogger({
            logLevel: portalConfig.logLevel,
            logColors: portalConfig.logColors,
        });
        this.logSystem = 'Payments';
        this.logComponent = this.coin;

        this.processingConfig = poolConfig.paymentProcessing || {};
        // daemon interface expects array of daemons and a callback
        this.daemon = new Stratum.daemon.interface([this.processingConfig.daemon], (sev, msg) => {
            if (this.logger && typeof this.logger[sev] === 'function') {
                this.logger[sev](this.logSystem, this.logComponent, msg);
            }
        });

        this.redisClient = CreateRedisClient(poolConfig.redis);
        if (poolConfig.redis && poolConfig.redis.password) {
            try {
                this.redisClient.auth(poolConfig.redis.password);
            } catch (e) { /* ignore */ }
        }

        // promisified redis helpers
        const bind = fn => promisify(fn).bind(this.redisClient);
        this.redis = {
            hgetall: bind(this.redisClient.hgetall),
            smembers: bind(this.redisClient.smembers),
            hset: bind(this.redisClient.hset),
            multi: (commands) => {
                const multiObj = this.redisClient.multi(commands);
                return {
                    exec: (cb) => {
                        if (typeof cb === 'function') {
                            return multiObj.exec(cb);
                        }
                        return new Promise((resolve, reject) => multiObj.exec((err, res) => err ? reject(err) : resolve(res)));
                    }
                };
            }
        };

        // internal state
        this.opidCount = 0;
        this.opids = [];
        this.badBlocks = {};

        this.minConfShield = Math.max(this.processingConfig.minConf || 10, 1);
        this.minConfPayout = Math.max(this.processingConfig.minConf || 10, 1);
        this.paymentIntervalSecs = Math.max(this.processingConfig.paymentInterval || 120, 30);
        this.maxBlocksPerPayment = Math.max(this.processingConfig.maxBlocksPerPayment || 3, 1);
        this.pplntEnabled = this.processingConfig.paymentMode === 'pplnt';
        this.pplntTimeQualify = this.processingConfig.pplnt || 0.51;
        this.getMarketStats = !!(poolConfig.coin && poolConfig.coin.getMarketStats);
        this.requireShielding = !!(poolConfig.coin && poolConfig.coin.requireShielding);
        this.fee = parseFloat((poolConfig.coin && poolConfig.coin.txfee) || 0.0004);
    }

    async start() {
        this.logger.info(this.logSystem, this.logComponent, 'Starting PaymentProcessor');
        try {
            await this.validateDaemons();
            await this.determineCoinPrecision();
        } catch (e) {
            this.logger.error(this.logSystem, this.logComponent, `Init failed: ${e.message}`);
            return;
        }

        this.paymentInterval = setInterval(() => this.processPayments(), this.paymentIntervalSecs * 1000);
        if (this.requireShielding) {
            this.shieldingInterval = setInterval(() => this.shieldingCycle(), Math.max(this.poolConfig.walletInterval || 1, 1) * 60 * 1000);
            this.opidCheckInterval = setInterval(() => this.checkOpids(), 57 * 1000);
        }

        this.statsInterval = setInterval(() => this.cacheNetworkStats(), 58 * 1000);
        if (this.getMarketStats) {
            this.marketStatsInterval = setInterval(() => this.cacheMarketStats(), 300 * 1000);
        }
    }

    async validateDaemons() {
        await this.validateAddress(this.poolConfig.address);
        if (this.requireShielding) {
            await this.validateTAddress(this.poolConfig.tAddress);
            await this.validateZAddress(this.poolConfig.zAddress);
        }
    }

    async validateAddress(address) {
        const res = await this.cmd('validateaddress', [address]);
        if (!res || !res.ismine) {
            throw new Error(`Daemon does not own pool address: ${address}`);
        }
    }

    async validateTAddress(address) {
        const res = await this.cmd('validateaddress', [address]);
        if (!res || !res.ismine) {
            throw new Error(`Daemon does not own pool t-address: ${address}`);
        }
    }

    async validateZAddress(address) {
        const res = await this.cmd('z_validateaddress', [address]);
        if (!res || !res.ismine) {
            throw new Error(`Daemon does not own pool z-address: ${address}`);
        }
    }

    async determineCoinPrecision() {
        const res = await this.cmd('getbalance', []);
        const parts = String(res).split('.');
        const d = parts[1] || '';
        this.magnitude = parseInt(`10${'0'.repeat(d.length)}`);
        this.minPaymentSatoshis = parseInt((this.processingConfig.minimumPayment || 0) * this.magnitude);
        this.coinPrecision = String(this.magnitude).length - 1;
    }

    async processPayments() {
        const start = Date.now();
        this.logger.info(this.logSystem, this.logComponent, 'Processing payments');
        try {
            const { workers, rounds } = await this._getDataFromRedis();
            const validated = await this._validateBlocks(rounds);
            const { workersWithRewards, finalRounds } = await this._calculateRewards(workers, validated);
            const { workersWithPayments, paymentsUpdate } = await this._executePayments(workersWithRewards);
            await this._updateRedis(workersWithPayments, finalRounds, paymentsUpdate);
        } catch (e) {
            this.logger.error(this.logSystem, this.logComponent, `Payment run error: ${e.message}`);
        }
        this.logger.info(this.logSystem, this.logComponent, `Payment run took ${Date.now() - start}ms`);
    }

    async _getDataFromRedis() {
        const [balances, pending] = await Promise.all([
            this.redis.hgetall(`${this.coin}:balances`).catch(() => null),
            this.redis.smembers(`${this.coin}:blocksPending`).catch(() => []),
        ]);

        const workers = {};
        if (balances) {
            Object.keys(balances).forEach(k => {
                try {
                    // store balances in satoshis (smallest unit) to match original implementation
                    workers[k] = { balance: this.coinsToSatoshis(parseFloat(balances[k])) };
                } catch (e) {
                    workers[k] = { balance: 0 };
                }
            });
        }

        const rounds = (pending || []).map(r => {
            const parts = r.split(':');
            return {
                blockHash: parts[0], txHash: parts[1], height: parseInt(parts[2]) || 0,
                minedby: parts[3], time: parts[4], serialized: r, duplicate: false
            };
        }).sort((a, b) => a.height - b.height);

        // detect duplicates
        const heights = {};
        rounds.forEach(r => {
            heights[r.height] = (heights[r.height] || 0) + 1;
        });
        const duplicates = rounds.filter(r => heights[r.height] > 1);
        if (duplicates.length) {
            this.logger.warn(this.logSystem, this.logComponent, `Duplicate pending blocks: ${JSON.stringify(duplicates.map(d => d.height))}`);
            const rpc = duplicates.map(d => ['getblock', [d.blockHash]]);
            const blocks = await this.batchCmd(rpc).catch(() => []);
            const invalid = [];
            blocks.forEach((b, i) => {
                try {
                    if (b && b.confirmations === -1) {
                        invalid.push(duplicates[i]);
                    }
                } catch (e) { }
            });
            if (invalid.length) {
                const cmds = invalid.map(i => ['srem', `${this.coin}:blocksPending`, i.serialized])
                    .concat(invalid.map(i => ['sadd', `${this.coin}:blocksKicked`, i.serialized]));
                await this.redis.multi(cmds).exec().catch(() => null);
                // filter them out locally
                const invalidSet = new Set(invalid.map(x => x.serialized));
                return { workers, rounds: rounds.filter(r => !invalidSet.has(r.serialized)) };
            }
        }

        return { workers, rounds };
    }

    async _validateBlocks(rounds) {
        if (!rounds || rounds.length === 0) {
            return [];
        }
        const batch = rounds.map(r => ['gettransaction', [r.txHash]]);
        const txs = await this.batchCmd(batch).catch(() => []);
        let payingBlocks = 0;
        rounds.forEach((round, idx) => {
            const tx = txs[idx] || {};
            if (tx.error && tx.error.code === -5) {
                // bad tx, mark and schedule retry
                this.badBlocks[round.height] = (this.badBlocks[round.height] || 0) + 1;
                if (this.badBlocks[round.height] > 5) {
                    round.category = 'kicked';
                } else {
                    round.category = 'immature';
                }
            } else if (tx && tx.result) {
                const details = tx.result;
                round.confirmations = details.confirmations || 0;
                round.reward = details.details && details.details[0] && details.details[0].amount ? details.details[0].amount : 0;
                if (details.confirmations >= this.minConfPayout && payingBlocks < this.maxBlocksPerPayment) {
                    round.category = 'generate';
                    payingBlocks++;
                } else if (details.confirmations < this.minConfPayout) {
                    round.category = 'immature';
                } else {
                    round.category = 'immature';
                }
            } else {
                round.category = 'immature';
            }

            // determine if shares can be safely deleted (no other blocks at same height)
            round.canDeleteShares = rounds.filter(r => r.height === round.height).length === 1;
        });

        return rounds;
    }

    async _calculateRewards(workers, rounds) {
        const paying = rounds.filter(r => r.category === 'generate');
        if (!paying.length) {
            return { workersWithRewards: workers, finalRounds: rounds };
        }

        const shareLookups = paying.map(r => ['hgetall', `${this.coin}:shares:round${r.height}`]);
        const timeLookups = this.pplntEnabled ? paying.map(r => ['hgetall', `${this.coin}:shares:times${r.height}`]) : [];

        const [allWorkerShares, allWorkerTimes] = await Promise.all([
            this.redis.multi(shareLookups).exec().catch(() => []),
            this.pplntEnabled ? this.redis.multi(timeLookups).exec().catch(() => []) : Promise.resolve([])
        ]);

        let totalOwed = Object.values(workers).reduce((s, w) => s + (w.balance || 0), 0);
        paying.forEach(r => {
            totalOwed += this.coinsToSatoshis(r.reward) - this.coinsToSatoshis(this.fee);
        });

        const tBalance = await this.listUnspent(null, this.requireShielding ? this.poolConfig.address : null, this.minConfPayout).catch(() => 0);
        if (tBalance < totalOwed) {
            this.logger.warn(this.logSystem, this.logComponent, `Insufficient funds (${this.satoshisToCoins(tBalance)} < ${this.satoshisToCoins(totalOwed)})`);
            rounds.forEach(r => {
                if (r.category === 'generate') {
                    r.category = 'immature';
                }
            });
            return { workersWithRewards: workers, finalRounds: rounds };
        }

        paying.forEach((round, i) => {
            const workerShares = allWorkerShares[i] || {};
            let totalShares = Object.values(workerShares).reduce((s, v) => s + Number(v || 0), 0);
            if (totalShares === 0) {
                return;
            }

            // PPLNT filtering
            if (this.pplntEnabled) {
                const times = allWorkerTimes[i] || {};
                const blockTime = Number(round.time) || 0;
                const qualify = blockTime * this.pplntTimeQualify;
                Object.keys(workerShares).forEach(addr => {
                    const t = Number(times[addr] || 0);
                    if (t < qualify) {
                        totalShares -= Number(workerShares[addr] || 0);
                        delete workerShares[addr];
                    }
                });
                if (totalShares <= 0) {
                    return;
                }
            }

            round.workerShares = workerShares;
            const reward = this.coinsToSatoshis(round.reward) - this.coinsToSatoshis(this.fee);

            Object.keys(workerShares).forEach(addr => {
                const share = Number(workerShares[addr] || 0);
                const amt = Math.floor((share / totalShares) * reward);
                if (!workers[addr]) {
                    workers[addr] = { balance: 0 };
                }
                workers[addr].reward = (workers[addr].reward || 0) + amt;
            });
        });

        return { workersWithRewards: workers, finalRounds: rounds };
    }

    async _executePayments(workers) {
        const addressAmounts = {};
        let totalSent = 0;
        Object.keys(workers).forEach(k => {
            const worker = workers[k];
            const address = this.getProperAddress(k.split('.')[0]);
            worker.address = address;
            const toSend = (worker.balance || 0) + (worker.reward || 0);
            if (toSend >= this.minPaymentSatoshis) {
                addressAmounts[address] = (addressAmounts[address] || 0) + toSend;
                totalSent += toSend;
            } else {
                // add reward to balance (defer)
                worker.balance = (worker.balance || 0) + (worker.reward || 0);
                worker.reward = 0;
            }
        });

        if (Object.keys(addressAmounts).length === 0) {
            return { workersWithPayments: workers, paymentsUpdate: [] };
        }

        const finalAddressAmounts = {};
        Object.keys(addressAmounts).forEach(addr => {
            finalAddressAmounts[addr] = this.satoshisToCoins(addressAmounts[addr]);
        });

        try {
            const txid = await this.cmd('sendmany', ['', finalAddressAmounts]);
            this.logger.info(this.logSystem, this.logComponent, `Payments TX: ${txid}`);
            Object.keys(workers).forEach(k => {
                const worker = workers[k];
                if (worker.address && finalAddressAmounts[worker.address]) {
                    worker.sent = (worker.sent || 0) + addressAmounts[worker.address];
                    worker.balanceChange = -(addressAmounts[worker.address] - (worker.balance || 0));
                    worker.balance = 0;
                    worker.reward = 0;
                }
            });

            const paymentRecord = {
                time: Date.now(), txid, amount: this.satoshisToCoins(totalSent), fee: this.fee,
                workers: Object.keys(addressAmounts).length, paid: finalAddressAmounts
            };
            const paymentsUpdate = [['zadd', `${this.coin}:payments`, Date.now(), JSON.stringify(paymentRecord)]];
            return { workersWithPayments: workers, paymentsUpdate };
        } catch (e) {
            this.logger.error(this.logSystem, this.logComponent, `Sendmany failed: ${e.message}`);
            // defer payments
            Object.keys(workers).forEach(k => {
                workers[k].balance = (workers[k].balance || 0) + (workers[k].reward || 0); workers[k].reward = 0;
            });
            return { workersWithPayments: workers, paymentsUpdate: [] };
        }
    }

    async _updateRedis(workers, rounds, paymentsUpdate) {
        const cmds = [];
        Object.keys(workers).forEach(k => {
            const w = workers[k];
            if (w.balanceChange) {
                cmds.push(['hincrbyfloat', `${this.coin}:balances`, k, this.satoshisToCoins(w.balanceChange)]);
            }
            if (w.sent) {
                // record individual worker total payouts in satoshis (match original which stored raw satoshis)
                cmds.push(['hincrbyfloat', `${this.coin}:payouts`, k, w.sent]);
            }
            if (w.sent) {
                cmds.push(['hset', `${this.coin}:workers:${k}`, 'lastPaid', Date.now()]);
            }
        });

        const roundsToDelete = [];
        rounds.forEach(r => {
            if (r.category === 'kicked' || r.category === 'orphan') {
                // move from pending to kicked set atomically
                cmds.push(['smove', `${this.coin}:blocksPending`, `${this.coin}:blocksKicked`, r.serialized]);
            }
            if (r.category === 'generate' && r.canDeleteShares) {
                roundsToDelete.push(`${this.coin}:shares:round${r.height}`);
                roundsToDelete.push(`${this.coin}:shares:times${r.height}`);
                // move from pending to confirmed atomically
                cmds.push(['smove', `${this.coin}:blocksPending`, `${this.coin}:blocksConfirmed`, r.serialized]);
            }
            if (r.category === 'immature') {
                // update confirmations if present
                if (r.confirmations !== undefined) {
                    cmds.push(['hset', `${this.coin}:blocks:${r.height}`, 'confirmations', r.confirmations]);
                }
            }
        });

        if (roundsToDelete.length) {
            cmds.push(['del', ...roundsToDelete]);
        }
        if (paymentsUpdate && paymentsUpdate.length) {
            cmds.push(...paymentsUpdate);
        }

        const totalPaid = Object.keys(workers).reduce((s, k) => s + (workers[k].sent || 0), 0);
        if (totalPaid > 0) {
            cmds.push(['hincrbyfloat', `${this.coin}:stats`, 'totalPaid', this.satoshisToCoins(totalPaid)]);
        }

        if (cmds.length) {
            try {
                await this.redis.multi(cmds).exec();
            } catch (e) {
                // CRITICAL: Payments may have been sent but Redis update failed.
                // Stop payment processing and persist commands for manual recovery.
                this.logger.error(this.logSystem, this.logComponent, `CRITICAL: Payments sent but failed to update Redis. Manual intervention required. ${e.message}`);
                if (this.paymentInterval) {
                    clearInterval(this.paymentInterval);
                }
                try {
                    await writeFileAsync(`${this.coin}_finalRedisCommands.txt`, JSON.stringify(cmds));
                } catch (wfErr) {
                    this.logger.error(this.logSystem, this.logComponent, `Failed to write Redis commands to disk: ${wfErr.message}`);
                }
            }
        }
    }

    async shieldingCycle() {
        if (!this.requireShielding) {
            return;
        }
        try {
            const tBalance = await this.listUnspent(this.poolConfig.address, null, this.minConfShield).catch(() => 0);
            const shieldingThreshold = this.coinsToSatoshis(0.001);
            if (tBalance > shieldingThreshold) {
                await this.sendTToZ(tBalance);
            } else {
                const zBalance = await this.listUnspentZ(this.poolConfig.zAddress, this.minConfShield).catch(() => 0);
                if (zBalance > shieldingThreshold) {
                    await this.sendZToT(zBalance);
                }
            }
        } catch (e) {
            this.logger.error(this.logSystem, this.logComponent, `Shielding cycle error: ${e.message}`);
        }
    }

    async sendTToZ(tBalance) {
        if (this.opidCount > 0) {
            return;
        }
        const amount = this.satoshisToCoins(tBalance - 10000);
        if (amount <= 0) {
            return;
        }
        const params = [this.poolConfig.address, [{ address: this.poolConfig.zAddress, amount }]];
        const opid = await this.cmd('z_sendmany', params);
        this.opidCount++; this.opids.push(opid);
        this.logger.info(this.logSystem, this.logComponent, `T->Z opid ${opid}`);
    }

    async sendZToT(zBalance) {
        if (this.opidCount > 0) {
            return;
        }
        let amount = this.satoshisToCoins(zBalance - 10000);
        if (amount <= 0) {
            return;
        }
        if (amount > 100) {
            amount = 100;
        }
        const params = [this.poolConfig.zAddress, [{ address: this.poolConfig.tAddress, amount }]];
        const opid = await this.cmd('z_sendmany', params);
        this.opidCount++; this.opids.push(opid);
        this.logger.info(this.logSystem, this.logComponent, `Z->T opid ${opid}`);
    }

    async checkOpids() {
        if (!this.opids.length) {
            return;
        }
        const statuses = await this.cmd('z_getoperationstatus', [this.opids]).catch(() => null);
        if (!statuses) {
            return;
        }
        statuses.forEach(op => {
            if (op && (op.status === 'success' || op.status === 'failed')) {
                const idx = this.opids.indexOf(op.id || op.opid);
                if (idx >= 0) {
                    this.opids.splice(idx, 1); this.opidCount = Math.max(0, this.opidCount - 1);
                }
            }
        });
    }

    async cacheNetworkStats() {
        try {
            const [miningInfo, networkInfo] = await Promise.all([this.cmd('getmininginfo', []), this.cmd('getnetworkinfo', [])]);
            const cmds = [
                ['hset', `${this.coin}:stats`, 'networkBlocks', miningInfo.blocks],
                ['hset', `${this.coin}:stats`, 'networkDiff', miningInfo.difficulty],
                ['hset', `${this.coin}:stats`, 'networkSols', miningInfo.networkhashps],
                ['hset', `${this.coin}:stats`, 'networkConnections', networkInfo.connections],
            ];
            await this.redis.multi(cmds).exec();
        } catch (e) {
            this.logger.error(this.logSystem, this.logComponent, `Cache network stats error: ${e.message}`);
        }
    }

    async cacheMarketStats() {
        try {
            let coinName = this.coin.replace('_testnet', '').toLowerCase();
            if (coinName === 'zen') {
                coinName = 'zencash';
            }

            const { body } = await request({
                url: `https://api.coinmarketcap.com/v1/ticker/${coinName}/`,
                json: true,
                timeout: 10000,
                headers: { 'User-Agent': 'NOMP Pool Software' }
            });

            if (body && body.length > 0) {
                await this.redis.hset(`${this.coin}:stats`, 'coinmarketcap', JSON.stringify(body));
                this.logger.debug(this.logSystem, this.logComponent, `Successfully cached market stats for ${coinName}`);
            } else {
                this.logger.warn(this.logSystem, this.logComponent, `No market data returned for ${coinName}`);
            }
        } catch (error) {
            if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
                this.logger.warn(this.logSystem, this.logComponent, `CoinMarketCap API unavailable: ${error.message}`);
            } else if (error.statusCode === 429) {
                this.logger.warn(this.logSystem, this.logComponent, `CoinMarketCap API rate limit exceeded`);
            } else {
                this.logger.error(this.logSystem, this.logComponent, `Error caching market stats: ${error.message}`);
            }
        }
    }

    async listUnspent(address, notAddress, minConf) {
        const args = [minConf || 1, 9999999];
        if (address) {
            args.push(address);
        }
        if (notAddress) {
            args.push(notAddress);
        }
        const unspent = await this.cmd('listunspent', args).catch(() => []);
        let balance = 0;
        (unspent || []).forEach(u => {
            if (!notAddress || u.address !== notAddress) {
                balance += (u.amount || 0);
            }
        });
        return this.coinsToSatoshis(balance);
    }

    async listUnspentZ(address, minConf) {
        const balance = await this.cmd('z_getbalance', [address, minConf]).catch(() => 0);
        return this.coinsToSatoshis(balance || 0);
    }

    getProperAddress(address) {
        const isValid = WAValidator.validate(String(address).split('.')[0], 'VRSC');
        if (!isValid) {
            this.logger && this.logger.warn && this.logger.warn(this.logSystem, this.logComponent, `Invalid address ${address}, converting to pool address.`);
            return this.poolConfig.invalidAddress || this.poolConfig.address;
        }
        return address;
    }

    cmd(command, params) {
        return new Promise((resolve, reject) => {
            try {
                // Use daemon.cmd to match existing daemon interface which aggregates results
                this.daemon.cmd(command, params || [], (results) => {
                    // daemon.cmd returns an array of result objects or a single object
                    // prefer first successful response.response if available
                    if (!results) {
                        return resolve(null);
                    }
                    if (Array.isArray(results)) {
                        // find first without error
                        for (let i = 0; i < results.length; i++) {
                            if (!results[i].error) {
                                return resolve(results[i].response);
                            }
                        }
                        // no successful response, return first error
                        return reject(new Error(JSON.stringify(results[0].error || results)));
                    }
                    // single result
                    if (results.error) {
                        return reject(new Error(JSON.stringify(results.error)));
                    }
                    return resolve(results.response);
                }, true, true);
            } catch (e) {
                reject(e);
            }
        });
    }

    batchCmd(batch) {
        return new Promise((resolve, reject) => {
            try {
                // Use daemon.batchCmd to match original batch handling on first daemon
                this.daemon.batchCmd(batch, (error, results) => {
                    if (error) {
                        return reject(error);
                    }
                    return resolve(results);
                });
            } catch (e) {
                reject(e);
            }
        });
    }

    satoshisToCoins(satoshis) {
        return this.roundTo(satoshis / this.magnitude, this.coinPrecision);
    }
    coinsToSatoshis(coins) {
        return Math.round(Number(coins) * this.magnitude);
    }
    coinsRound(n) {
        return this.roundTo(n, this.coinPrecision);
    }
    roundTo(n, digits) {
        const m = Math.pow(10, digits); n = parseFloat((n * m).toFixed(11)); return Math.round(n) / m;
    }
}

module.exports = function initV10() {
    let portalConfig = {};
    if (process.env.portalConfig) {
        try {
            portalConfig = JSON.parse(process.env.portalConfig);
        } catch (e) { }
    }

    const poolConfigs = JSON.parse(process.env.pools || '{}');
    for (const coin in poolConfigs) {
        const poolOptions = poolConfigs[coin];
        if (poolOptions.paymentProcessing && poolOptions.paymentProcessing.enabled) {
            const pp = new PaymentProcessor(poolOptions, portalConfig);
            pp.start().catch(() => { });
        }
    }
};
