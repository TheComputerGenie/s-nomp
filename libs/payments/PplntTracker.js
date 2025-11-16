/**
 * @fileoverview PPLNT time-share tracker (payments location)
 *
 * Same implementation as the original PplntTracker but moved under
 * `libs/payments/` so payment-related helpers live together.
 *
 * @author ComputerGenieCo
 * @version 21.7.3
 * @copyright 2025
 */

/**
 * PplntTracker
 *
 * Tracks per-worker time-shares for PPLNT and writes to Redis when possible.
 * @class PplntTracker
 */
class PplntTracker {
    constructor(logger, poolConfigsRef, roundTo) {
        this.logger = logger;
        this.poolConfigs = poolConfigsRef;
        this.roundTo = roundTo;

        // internal trackers
        this._lastStartTimes = {};
        this._lastShareTimes = {};

        // Redis connection (set when available)
        this.connection = null;
    }

    init(connection) {
        this.connection = connection;
    }

    handleShare(msg) {
        // msg expected shape: { coin, isValidShare, isValidBlock, data:{ worker }, thread }
        if (msg.isValidShare && !msg.isValidBlock) {
            const now = Date.now();
            let lastShareTime = now;
            let lastStartTime = now;
            const workerAddress = msg.data.worker.split('.')[0];

            if (!this._lastShareTimes[msg.coin]) {
                this._lastShareTimes[msg.coin] = {};
            }
            if (!this._lastStartTimes[msg.coin]) {
                this._lastStartTimes[msg.coin] = {};
            }

            if (!this._lastShareTimes[msg.coin][workerAddress] || !this._lastStartTimes[msg.coin][workerAddress]) {
                this._lastShareTimes[msg.coin][workerAddress] = now;
                this._lastStartTimes[msg.coin][workerAddress] = now;
                this.logger.debug('PPLNT', msg.coin, `${msg.thread}`, `${workerAddress} joined.`);
            }

            if (this._lastShareTimes[msg.coin][workerAddress] != null && this._lastShareTimes[msg.coin][workerAddress] > 0) {
                lastShareTime = this._lastShareTimes[msg.coin][workerAddress];
                lastStartTime = this._lastStartTimes[msg.coin][workerAddress];
            }

            const redisCommands = [];
            const lastShareTimeUnified = Math.max(redisCommands.push(['hget', `${msg.coin}:lastSeen`, workerAddress]), lastShareTime);
            const timeChangeSec = this.roundTo(Math.max(now - lastShareTimeUnified, 0) / 1000, 4);

            if (timeChangeSec < 900) {
                // track time-share on a per-pool basis
                const poolId = (this.poolConfigs[msg.coin] && this.poolConfigs[msg.coin].poolId) ? this.poolConfigs[msg.coin].poolId : '';
                redisCommands.push(['hincrbyfloat', `${msg.coin}:shares:timesCurrent`, `${workerAddress}.${poolId}`, timeChangeSec]);
                if (this.connection) {
                    this.connection.multi(redisCommands).exec((err, replies) => {
                        if (err) {
                            this.logger.error('PPLNT', msg.coin, `${msg.thread}`, `Error with time share processor call to redis ${JSON.stringify(err)}`);
                        }
                    });
                }
            } else {
                // treat as re-join after a long gap
                this._lastStartTimes[msg.coin][workerAddress] = now;
                this.logger.debug('PPLNT', msg.coin, `${msg.thread}`, `${workerAddress} re-joined.`);
            }

            this._lastShareTimes[msg.coin][workerAddress] = now;
        }

        if (msg.isValidBlock) {
            // reset trackers for this coin on a found block
            this._lastShareTimes[msg.coin] = {};
            this._lastStartTimes[msg.coin] = {};
        }
    }
}

module.exports = PplntTracker;
