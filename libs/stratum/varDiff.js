/**
 * @fileoverview Variable Difficulty Manager for Stratum Mining
 *
 * Manages variable difficulty adjustments for mining clients based on submission times.
 * Uses a ring buffer to track time intervals and emits difficulty changes.
 *
 * @author ComputerGenieCo
 * @version 21.7.3
 * @copyright 2025
 */
const events = require('events');

/**
 * Variable Difficulty Manager
 *
 * Handles dynamic difficulty adjustment for stratum mining clients. Tracks submission
 * times using a ring buffer and adjusts difficulty to maintain target submission rates.
 *
 * Events emitted:
 * - 'newDifficulty' (client, newDiff)
 *
 * @class VarDiff
 * @extends EventEmitter
 * @param {number} port - The stratum port this VarDiff instance manages
 * @param {Object} varDiffOptions - Configuration options for difficulty adjustment
 * @param {number} varDiffOptions.targetTime - Target time between submissions in seconds
 * @param {number} varDiffOptions.variancePercent - Allowed variance percentage
 * @param {number} varDiffOptions.retargetTime - Time interval for retargeting
 * @param {number} varDiffOptions.minDiff - Minimum allowed difficulty
 * @param {number} varDiffOptions.maxDiff - Maximum allowed difficulty
 * @param {boolean} varDiffOptions.x2mode - Whether to use x2 mode for adjustments
 */
class VarDiff extends events.EventEmitter {
    static RingBuffer = class {
        constructor(maxSize) {
            this.data = [];
            this.cursor = 0;
            this.isFull = false;
            this.maxSize = maxSize;
        }

        append(x) {
            if (this.isFull) {
                this.data[this.cursor] = x;
                this.cursor = (this.cursor + 1) % this.maxSize;
            } else {
                this.data.push(x);
                this.cursor++;
                if (this.data.length === this.maxSize) {
                    this.cursor = 0;
                    this.isFull = true;
                }
            }
        }

        avg() {
            const sum = this.data.reduce((a, b) => a + b, 0);
            return sum / (this.isFull ? this.maxSize : this.cursor);
        }

        size() {
            return this.isFull ? this.maxSize : this.cursor;
        }

        clear() {
            this.data = [];
            this.cursor = 0;
            this.isFull = false;
        }
    };

    static validateOptions(varDiffOptions) {
        const errors = [];
        if (!varDiffOptions) {
            errors.push('varDiffOptions is required');
            return { isValid: false, errors };
        }
        const options = varDiffOptions;
        if (typeof options.targetTime !== 'number' || options.targetTime <= 0) {
            errors.push('targetTime must be a positive number');
        }
        if (typeof options.variancePercent !== 'number' || options.variancePercent < 0 || options.variancePercent > 100) {
            errors.push('variancePercent must be a number between 0 and 100');
        }
        if (typeof options.retargetTime !== 'number' || options.retargetTime <= 0) {
            errors.push('retargetTime must be a positive number');
        }
        if (typeof options.minDiff !== 'number' || options.minDiff <= 0) {
            errors.push('minDiff must be a positive number');
        }
        if (typeof options.maxDiff !== 'number' || options.maxDiff <= options.minDiff) {
            errors.push('maxDiff must be a number greater than minDiff');
        }
        if (options.x2mode !== undefined && typeof options.x2mode !== 'boolean') {
            errors.push('x2mode must be a boolean');
        }
        return { isValid: errors.length === 0, errors };
    }

    #variance;
    #bufferSize;
    #tMin;
    #tMax;

    /**
     * @param {number} port
     * @param {Object} varDiffOptions
     */
    constructor(port, varDiffOptions) {
        super();
        this.port = port;
        this.options = varDiffOptions;
        const validation = VarDiff.validateOptions(varDiffOptions);
        this.isValid = validation.isValid;
        if (!this.isValid) {
            console.warn(`Invalid varDiffOptions for port ${port}:`, validation.errors.join(', '));
            // Use defaults
            this.options = { targetTime: 10, variancePercent: 20, retargetTime: 60, minDiff: 1, maxDiff: 1000, x2mode: false };
        }
        // Set private fields
        const options = this.options;
        this.#variance = options.targetTime * (options.variancePercent / 100);
        this.#bufferSize = Math.floor(options.retargetTime / options.targetTime * 4);
        this.#tMin = options.targetTime - this.#variance;
        this.#tMax = options.targetTime + this.#variance;
    }

    #toFixed(num, len) {
        return parseFloat(num.toFixed(len));
    }

    /**
     * Manage difficulty for a mining client
     *
     * Attaches a submit event listener to the client and adjusts difficulty based on
     * submission timing to maintain target rates.
     *
     * @param {Object} client - The mining client object with socket and difficulty properties
     * @returns {void}
     */
    manageClient(client) {
        const stratumPort = client.socket.localPort;

        if (stratumPort != this.port) {
            console.error('Handling a client which is not of this vardiff?');
        }
        const options = this.options;

        let lastTs;
        let lastRtc;
        let timeBuffer;

        client.on('submit', () => {
            const ts = (Date.now() / 1000) | 0;

            if (!lastRtc) {
                lastRtc = ts - options.retargetTime / 2;
                lastTs = ts;
                timeBuffer = new VarDiff.RingBuffer(this.#bufferSize);
                return;
            }

            const sinceLast = ts - lastTs;

            timeBuffer.append(sinceLast);
            lastTs = ts;

            if ((ts - lastRtc) < options.retargetTime && timeBuffer.size() > 0) {
                return;
            }

            lastRtc = ts;
            const avg = timeBuffer.avg();

            if (avg <= 0 || isNaN(avg)) {
                return;
            }

            let ddiff = options.targetTime / avg;

            if (avg > this.#tMax && client.difficulty > options.minDiff) {
                if (options.x2mode) {
                    ddiff = 0.5;
                }
                if (ddiff * client.difficulty < options.minDiff) {
                    ddiff = options.minDiff / client.difficulty;
                }
            } else if (avg < this.#tMin) {
                if (options.x2mode) {
                    ddiff = 2;
                }
                const diffMax = options.maxDiff;
                if (ddiff * client.difficulty > diffMax) {
                    ddiff = diffMax / client.difficulty;
                }
            } else {
                return;
            }

            const newDiff = this.#toFixed(client.difficulty * ddiff, 8);
            timeBuffer.clear();

            this.emit('newDifficulty', client, newDiff);
        });
    }
}

module.exports = VarDiff;
