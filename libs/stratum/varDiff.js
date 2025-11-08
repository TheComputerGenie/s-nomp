const events = require('events');

/**
 * Variable Difficulty (VarDiff) module for stratum mining pools.
 *
 * This module implements a variable difficulty adjustment system that automatically
 * adjusts the mining difficulty for individual clients based on their share submission
 * rate. The goal is to maintain a consistent target time between share submissions.
 *
 * Ported from stratum-mining share-limiter:
 * https://github.com/ahmedbodi/stratum-mining/blob/master/mining/basic_share_limiter.py
 *
 * @fileoverview Variable difficulty adjustment system for mining pool clients
 * @author Original Python implementation by ahmedbodi, ported to Node.js
 * @version 1.0.0
 */

/**
 * Ring Buffer implementation for storing time intervals between share submissions.
 * This circular buffer maintains a fixed-size collection of recent timing data
 * to calculate moving averages for difficulty adjustments.
 *
 * @class RingBuffer
 * @param {number} maxSize - Maximum number of elements the buffer can hold
 */
function RingBuffer(maxSize) {
    /** @private {Array} Internal array to store buffer data */
    let data = [];
    /** @private {number} Current position/cursor in the circular buffer */
    let cursor = 0;
    /** @private {boolean} Flag indicating if the buffer has reached maximum capacity */
    let isFull = false;

    /**
     * Appends a new value to the ring buffer.
     * When the buffer is full, it overwrites the oldest value.
     *
     * @param {number} x - The value to append to the buffer
     */
    this.append = function (x) {
        if (isFull) {
            data[cursor] = x;
            cursor = (cursor + 1) % maxSize;
        } else {
            data.push(x);
            cursor++;
            if (data.length === maxSize) {
                cursor = 0;
                isFull = true;
            }
        }
    };

    /**
     * Calculates the average of all values currently in the buffer.
     *
     * @returns {number} The arithmetic mean of all values in the buffer
     */
    this.avg = function () {
        const sum = data.reduce((a, b) => {
            return a + b;
        });
        return sum / (isFull ? maxSize : cursor);
    };

    /**
     * Returns the current number of elements in the buffer.
     *
     * @returns {number} The number of elements currently stored in the buffer
     */
    this.size = function () {
        return isFull ? maxSize : cursor;
    };

    /**
     * Clears all data from the buffer and resets it to initial state.
     */
    this.clear = function () {
        data = [];
        cursor = 0;
        isFull = false;
    };
}

/**
 * Utility function to truncate a number to a fixed amount of decimal places.
 * This ensures consistent precision in difficulty calculations.
 *
 * @param {number} num - The number to truncate
 * @param {number} len - The number of decimal places to keep
 * @returns {number} The number truncated to the specified decimal places
 */
function toFixed(num, len) {
    return parseFloat(num.toFixed(len));
}

/**
 * Variable Difficulty class that manages automatic difficulty adjustments for mining clients.
 *
 * This class implements a sophisticated algorithm that monitors the time intervals between
 * share submissions from mining clients and automatically adjusts their difficulty to
 * maintain optimal share submission rates. The system aims to keep share submissions
 * within a target time range to balance network efficiency and miner experience.
 *
 * Key features:
 * - Automatic difficulty scaling based on share submission timing
 * - Configurable target times and variance thresholds
 * - Support for minimum and maximum difficulty limits
 * - Optional x2 mode for more aggressive adjustments
 * - Ring buffer for moving average calculations
 *
 * @class VarDiff
 * @extends EventEmitter
 * @param {number} port - The stratum port this VarDiff instance manages
 * @param {Object} varDiffOptions - Configuration options for difficulty adjustment
 * @param {number} varDiffOptions.targetTime - Target time between shares in seconds
 * @param {number} varDiffOptions.retargetTime - Time interval for difficulty recalculation
 * @param {number} varDiffOptions.variancePercent - Allowed variance percentage from target time
 * @param {number} varDiffOptions.minDiff - Minimum allowed difficulty
 * @param {number} varDiffOptions.maxDiff - Maximum allowed difficulty
 * @param {boolean} [varDiffOptions.x2mode] - Enable aggressive 2x/0.5x adjustments
 *
 * @fires VarDiff#newDifficulty
 */
const varDiff = module.exports = function varDiff(port, varDiffOptions) {
    const _this = this;

    //if (!varDiffOptions) return;

    /** @private {number} Calculated variance in seconds based on target time and percentage */
    const variance = varDiffOptions.targetTime * (varDiffOptions.variancePercent / 100);

    /** @private {number} Size of the ring buffer for timing data, calculated as 4x the retarget intervals */
    const bufferSize = varDiffOptions.retargetTime / varDiffOptions.targetTime * 4;

    /** @private {number} Minimum acceptable time between shares (target - variance) */
    const tMin = varDiffOptions.targetTime - variance;

    /** @private {number} Maximum acceptable time between shares (target + variance) */
    const tMax = varDiffOptions.targetTime + variance;

    /**
     * Manages difficulty adjustment for a specific mining client.
     *
     * This method sets up event listeners for the client's share submissions and
     * implements the core difficulty adjustment algorithm. It tracks timing between
     * shares and adjusts difficulty when the average timing falls outside the
     * acceptable range.
     *
     * Algorithm flow:
     * 1. Listen for 'submit' events from the client
     * 2. Track time intervals between submissions in a ring buffer
     * 3. Calculate moving average of submission times
     * 4. Adjust difficulty if average is outside target range
     * 5. Emit 'newDifficulty' event when adjustment is needed
     *
     * @param {Object} client - The mining client object
     * @param {Object} client.socket - The client's socket connection
     * @param {number} client.socket.localPort - The port the client is connected to
     * @param {number} client.difficulty - The client's current difficulty
     */
    this.manageClient = function (client) {

        const stratumPort = client.socket.localPort;

        if (stratumPort != port) {
            console.error('Handling a client which is not of this vardiff?');
        }
        const options = varDiffOptions;

        /** @private {number} Timestamp of the last share submission */
        let lastTs;

        /** @private {number} Timestamp of the last retarget calculation */
        let lastRtc;

        /** @private {RingBuffer} Buffer storing recent time intervals between shares */
        let timeBuffer;

        /**
         * Event handler for client share submissions.
         *
         * This handler is called every time the client submits a share. It:
         * 1. Records the current timestamp
         * 2. Calculates time since last submission
         * 3. Stores timing data in the ring buffer
         * 4. Triggers difficulty adjustment if conditions are met
         *
         * Difficulty adjustment occurs when:
         * - Enough time has passed since last retarget (retargetTime)
         * - The ring buffer contains timing data
         * - The average submission time is outside the acceptable range
         */
        client.on('submit', () => {

            // Get current timestamp in seconds
            const ts = (Date.now() / 1000) | 0;

            // Initialize tracking variables on first submission
            if (!lastRtc) {
                lastRtc = ts - options.retargetTime / 2;
                lastTs = ts;
                timeBuffer = new RingBuffer(bufferSize);
                return;
            }

            // Calculate time since last share submission
            const sinceLast = ts - lastTs;

            // Store the interval in our ring buffer and update timestamp
            timeBuffer.append(sinceLast);
            lastTs = ts;

            // Check if enough time has passed since last retarget and we have data
            if ((ts - lastRtc) < options.retargetTime && timeBuffer.size() > 0) {
                return;
            }

            // Time to recalculate difficulty
            lastRtc = ts;
            const avg = timeBuffer.avg();

            // Calculate difficulty multiplier based on average vs target time
            let ddiff = options.targetTime / avg;

            // Check if shares are coming too slowly (avg > tMax) - decrease difficulty
            if (avg > tMax && client.difficulty > options.minDiff) {
                if (options.x2mode) {
                    // Aggressive mode: cut difficulty in half
                    ddiff = 0.5;
                }
                // Ensure we don't go below minimum difficulty
                if (ddiff * client.difficulty < options.minDiff) {
                    ddiff = options.minDiff / client.difficulty;
                }
            } else if (avg < tMin) {// Check if shares are coming too quickly (avg < tMin) - increase difficulty

                if (options.x2mode) {
                    // Aggressive mode: double the difficulty
                    ddiff = 2;
                }
                const diffMax = options.maxDiff;
                // Ensure we don't exceed maximum difficulty
                if (ddiff * client.difficulty > diffMax) {
                    ddiff = diffMax / client.difficulty;
                }
            } else { // Shares are within acceptable range - no adjustment needed
                return;
            }

            // Calculate new difficulty and clear timing buffer for fresh data
            const newDiff = toFixed(client.difficulty * ddiff, 8);
            timeBuffer.clear();

            /**
             * New difficulty event - emitted when a client's difficulty needs adjustment.
             *
             * @event VarDiff#newDifficulty
             * @param {Object} client - The mining client object
             * @param {number} newDiff - The new difficulty value for the client
             */
            _this.emit('newDifficulty', client, newDiff);
        });
    };
};

// Set up prototype inheritance from EventEmitter to enable event emission
varDiff.prototype.__proto__ = events.EventEmitter.prototype;
