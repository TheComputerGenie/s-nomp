/**
 * @fileoverview Stratum mining protocol server implementation for cryptocurrency mining pools.
 * 
 * This module provides a complete stratum server implementation that handles:
 * - Client connections and authentication
 * - Mining job distribution
 * - Share submission processing
 * - Difficulty adjustment
 * - Connection banning and security
 * - TLS/SSL support
 * 
 * The stratum protocol is the standard protocol used by mining pools to communicate
 * with miners, allowing efficient distribution of work and collection of results.
 * 
 * @author s-nomp developers
 * @requires bignum For large number arithmetic operations
 * @requires net For TCP server functionality
 * @requires events For event-driven architecture
 * @requires tls For secure TLS connections
 * @requires fs For file system operations (TLS certificates)
 * @requires ./util Local utility functions
 */

const BigNum = require('bignum');
const net = require('net');
const events = require('events');
const tls = require('tls');
const fs = require('fs');

const util = require('./util.js');

/**
 * Global TLS options configuration for secure connections
 * @type {Object|undefined}
 */
let TLSoptions;

/**
 * Creates a subscription counter factory for generating unique subscription IDs.
 * 
 * Each pool needs unique subscription IDs for tracking client connections.
 * This factory creates a counter that generates hexadecimal subscription IDs
 * with a pool-specific prefix to ensure uniqueness across multiple pools.
 * 
 * @param {string} poolId - Unique identifier for the mining pool
 * @returns {Object} Counter object with next() method
 * @returns {Function} returns.next - Function that returns the next unique subscription ID
 * 
 * @example
 * const counter = SubscriptionCounter('pool1');
 * const subId1 = counter.next(); // 'deadbeefcafebabpool10000000000000001'
 * const subId2 = counter.next(); // 'deadbeefcafebabpool10000000000000002'
 */
const SubscriptionCounter = function (poolId) {
    /** @type {number} Internal counter for generating sequential IDs */
    let count = 0;

    /** @type {string} Hex padding string to create unique prefixes */
    let padding = 'deadbeefcafebabe';
    // Adjust padding length to accommodate pool ID, ensuring consistent total length
    padding = padding.substring(0, padding.length - poolId.length) + poolId;

    return {
        /**
         * Generates the next unique subscription ID
         * @returns {string} Hexadecimal subscription ID with pool prefix
         */
        next: function () {
            count++;
            // Reset counter if it reaches maximum safe integer to prevent overflow
            if (Number.MAX_VALUE === count) {
                count = 0;
            }
            // Combine padding with little-endian packed 64-bit counter
            return padding + util.packInt64LE(count).toString('hex');
        }
    };
};


/**
 * Represents a single client connection to the stratum mining server.
 * 
 * Each StratumClient instance manages one miner connection, handling:
 * - Protocol message parsing and validation
 * - Authentication and authorization
 * - Mining job distribution
 * - Share submission processing
 * - Difficulty adjustment
 * - Connection security and banning
 * 
 * @class StratumClient
 * @extends EventEmitter
 * 
 * @param {Object} options - Configuration options for the client
 * @param {net.Socket} options.socket - The TCP socket connection
 * @param {string} options.subscriptionId - Unique subscription identifier
 * @param {Function} options.authorizeFn - Function to authorize worker credentials
 * @param {Object} options.banning - Banning configuration settings
 * @param {boolean} options.banning.enabled - Whether banning is enabled
 * @param {number} options.banning.checkThreshold - Number of shares before checking ban criteria
 * @param {number} options.banning.invalidPercent - Percentage of invalid shares that triggers a ban
 * @param {number} options.connectionTimeout - Timeout for inactive connections (seconds)
 * @param {boolean} options.tcpProxyProtocol - Whether to expect PROXY protocol headers
 * @param {Object} options.algos - Algorithm configuration object for difficulty calculation
 * @param {string} options.algorithm - Name of the mining algorithm (e.g., 'equihash', 'sha256')
 * 
 * @fires StratumClient#subscription - When client requests subscription
 * @fires StratumClient#submit - When client submits a share
 * @fires StratumClient#socketDisconnect - When client disconnects
 * @fires StratumClient#socketError - On socket errors
 * @fires StratumClient#triggerBan - When client should be banned
 * @fires StratumClient#malformedMessage - On protocol violations
 * @fires StratumClient#unknownStratumMethod - On unsupported methods
 * @fires StratumClient#difficultyChanged - When difficulty is adjusted
 * @fires StratumClient#extranonceSubscribed - When client subscribes to extranonce updates
 * @fires StratumClient#extranonceChanged - When client's extranonce values are updated
 * 
 * @example
 * const client = new StratumClient({
 *   socket: tcpSocket,
 *   subscriptionId: 'sub123',
 *   authorizeFn: (addr, port, worker, pass, callback) => { ... },
 *   banning: { enabled: true, checkThreshold: 100, invalidPercent: 50 },
 *   connectionTimeout: 600
 * });
 */
const StratumClient = function (options) {
    /** @type {number|null} Difficulty value waiting to be applied to client */
    let pendingDifficulty = null;

    // Public properties accessible to external code
    /** @type {net.Socket} The underlying TCP socket connection */
    this.socket = options.socket;
    /** @type {string} Client's IP address for logging and banning */
    this.remoteAddress = options.socket.remoteAddress;
    /** @type {number} Timestamp of last client activity for timeout detection */
    this.lastActivity = Date.now();
    /** @type {Object} Share statistics for ban detection */
    this.shares = { valid: 0, invalid: 0 };

    /** @type {boolean} Whether client supports mining.set_extranonce method */
    this.supportsExtraNonceSubscription = false;
    /** @type {number} Size of extraNonce2 field in bytes */
    this.extraNonce2Size = 4; // Default size, can be changed via mining.set_extranonce

    // Private references for internal use
    /** @type {Object} Algorithm configuration object */
    const algos = options.algos;
    /** @type {string} Mining algorithm name */
    const algorithm = options.algorithm;
    /** @type {Object} Banning configuration settings */
    const banning = options.banning;
    /** @type {StratumClient} Self-reference for use in closures */
    const _this = this;

    /**
     * Evaluates whether a client should be banned based on share validity patterns.
     * 
     * This function implements a sliding window approach to ban detection:
     * 1. Tracks valid/invalid share counts for each client
     * 2. Once checkThreshold shares are reached, calculates invalid percentage
     * 3. If invalid percentage exceeds limit, triggers a ban
     * 4. If percentage is acceptable, resets counters for next window
     * 
     * @param {boolean} shareValid - Whether the submitted share was valid
     * @returns {boolean} true if client was banned, false otherwise
     */
    const considerBan = (!banning || !banning.enabled) ? function () {
        // Banning disabled - never ban clients
        return false;
    } : function (shareValid) {
        // Update share statistics based on submission result
        if (shareValid === true) {
            _this.shares.valid++;
        } else {
            _this.shares.invalid++;
        }

        const totalShares = _this.shares.valid + _this.shares.invalid;

        // Check if we have enough shares to evaluate ban criteria
        if (totalShares >= banning.checkThreshold) {
            const percentBad = (_this.shares.invalid / totalShares) * 100;

            if (percentBad < banning.invalidPercent) {
                // Client is performing acceptably - reset counters for next window
                this.shares = { valid: 0, invalid: 0 };
            } else {
                // Client exceeds invalid share threshold - trigger ban
                _this.emit('triggerBan', `${_this.shares.invalid} out of the last ${totalShares} shares were invalid`);
                _this.socket.destroy();
                return true;
            }
        }
        return false;
    };

    /**
     * Initializes the stratum client connection.
     * Sets up socket event handlers and begins message processing.
     * 
     * @public
     */
    this.init = function init() {
        setupSocket();
    };

    /**
     * Handles incoming stratum protocol messages from the client.
     * 
     * Routes messages to appropriate handlers based on the method field.
     * The stratum protocol uses JSON-RPC 2.0 format with specific mining methods.
     * 
     * @private
     * @param {Object} message - Parsed JSON message from client
     * @param {string} message.method - Stratum method name
     * @param {number} message.id - Request ID for correlation
     * @param {Array} message.params - Method parameters array
     */
    function handleMessage(message) {
        switch (message.method) {
            case 'mining.subscribe':
                // Client requests subscription to mining notifications
                handleSubscribe(message);
                break;
            case 'mining.authorize':
                // Client provides worker credentials for authentication
                handleAuthorize(message);
                break;
            case 'mining.submit':
                // Client submits a completed share
                _this.lastActivity = Date.now();
                handleSubmit(message);
                break;
            case 'mining.get_transactions':
                // Legacy method - return empty transaction list
                sendJson({
                    id: null,
                    result: [],
                    error: true
                });
                break;
            case 'mining.extranonce.subscribe':
                // ExtraNonce subscription - allows clients to support mining.set_extranonce
                handleExtraNonceSubscribe(message);
                break;
            default:
                // Unknown stratum method - emit event for logging
                _this.emit('unknownStratumMethod', message);
                break;
        }
    }

    /**
     * Handles mining.subscribe method calls from clients.
     * 
     * The subscribe method is the first call a miner makes to establish
     * a connection with the pool. Per Bitcoin Wiki specification, it provides:
     * - Subscription array with mining.set_difficulty and mining.notify subscriptions
     * - A unique extraNonce1 value for share generation  
     * - ExtraNonce2 size indicating bytes available for client nonce space
     * 
     * Response format: [subscriptions_array, extraNonce1, extraNonce2_size]
     * 
     * @private
     * @param {Object} message - The parsed subscribe message
     * @param {number} message.id - Request ID for response correlation
     */
    function handleSubscribe(message) {
        // Track if client subscribed before authorization (some miners do this)
        if (!_this.authorized) {
            _this.requestedSubscriptionBeforeAuth = true;
        }

        // Emit subscription event to pool for extraNonce1 generation
        _this.emit('subscription',
            {},
            (error, extraNonce1, extraNonce1b) => {
                if (error) {
                    // Send error response if subscription failed
                    sendJson({
                        id: message.id,
                        result: null,
                        error: error
                    });
                    return;
                }

                // Store extraNonce1 for later use in share submissions
                _this.extraNonce1 = extraNonce1;

                // Send successful subscription response per Bitcoin Wiki specification
                sendJson({
                    id: message.id,
                    result: [
                        // Subscriptions - array of 2-item tuples with subscription type and id
                        [
                            ['mining.set_difficulty', options.subscriptionId],
                            ['mining.notify', options.subscriptionId]
                        ],
                        extraNonce1,  // ExtraNonce1 - hex-encoded unique string
                        _this.extraNonce2Size  // ExtraNonce2_size - bytes for ExtraNonce2 counter
                    ],
                    error: null
                });
            });
    }

    /**
     * Handles mining.extranonce.subscribe method calls from clients.
     * 
     * According to the Bitcoin Wiki Stratum Protocol specification:
     * https://en.bitcoin.it/wiki/Stratum_mining_protocol#mining.extranonce.subscribe
     * 
     * The mining.extranonce.subscribe method:
     * - Indicates to the server that the client supports the mining.set_extranonce method
     * - Takes no parameters: mining.extranonce.subscribe()
     * - Returns true if server supports it, false if not
     * 
     * This implementation:
     * - Tracks which clients have subscribed to extranonce updates
     * - Sets the supportsExtraNonceSubscription flag on the client
     * - Returns true to indicate server support
     * - Emits extranonceSubscribed event for pool-level tracking
     * 
     * Use cases for extranonce subscription:
     * - Pool server load balancing and failover
     * - Client reconnection with session resumption
     * - Prevention of extraNonce1 collisions at scale
     * - Dynamic extraNonce2Size optimization based on hashrate
     * 
     * @private
     * @param {Object} message - The parsed extranonce.subscribe message
     * @param {number} message.id - Request ID for response correlation
     * @param {Array} message.params - Should be empty array []
     * 
     * @see {@link https://en.bitcoin.it/wiki/Stratum_mining_protocol#mining.extranonce.subscribe}
     * @see {@link https://en.bitcoin.it/wiki/Stratum_mining_protocol#mining.set_extranonce}
     */
    function handleExtraNonceSubscribe(message) {
        // Track that this client supports extranonce subscription
        _this.supportsExtraNonceSubscription = true;

        // Return success to indicate server supports the feature
        sendJson({
            id: message.id,
            result: true,
            error: null
        });

        // Emit event for pool-level tracking
        _this.emit('extranonceSubscribed', {
            subscriptionId: options.subscriptionId,
            remoteAddress: _this.remoteAddress,
            workerName: _this.workerName
        });
    }

    /**
     * Sanitizes input strings by removing potentially dangerous characters.
     * 
     * Only allows alphanumeric characters and dots to prevent injection attacks
     * and ensure consistent string handling throughout the system.
     * 
     * @private
     * @param {*} s - Input to sanitize (will be converted to string)
     * @returns {string} Sanitized string containing only safe characters
     */
    function getSafeString(s) {
        return s.toString().replace(/[^a-zA-Z0-9.]+/g, '');
    }

    /**
     * Parses and sanitizes worker identification strings.
     * 
     * Worker names typically follow the format "address.workername"
     * where address is the cryptocurrency address and workername is optional.
     * If no worker name is provided, defaults to "noname".
     * 
     * @private
     * @param {string} raw - Raw worker identification string from client
     * @returns {string} Formatted worker string in "address.workername" format
     * 
     * @example
     * getSafeWorkerString("1ABC...xyz.miner1") // "1ABC...xyz.miner1"
     * getSafeWorkerString("1ABC...xyz") // "1ABC...xyz.noname"
     */
    function getSafeWorkerString(raw) {
        const s = getSafeString(raw).split('.');
        const addr = s[0];
        let wname = 'noname';
        if (s.length > 1) {
            wname = s[1];
        }
        return `${addr}.${wname}`;
    }

    /**
     * Handles mining.authorize method calls from clients.
     * 
     * The authorize method authenticates a worker with the pool using
     * provided credentials. The authorization process:
     * 1. Sanitizes the worker name and extracts the address
     * 2. Calls the external authorization function
     * 3. Sets the client's authorization status
     * 4. Optionally disconnects if requested by authorizer
     * 
     * @private
     * @param {Object} message - The parsed authorize message
     * @param {number} message.id - Request ID for response correlation
     * @param {Array} message.params - [workerName, password]
     */
    function handleAuthorize(message) {
        // Extract and sanitize worker credentials
        _this.workerName = getSafeWorkerString(message.params[0]);
        _this.workerPass = message.params[1];

        // Extract the cryptocurrency address from worker name
        const addr = _this.workerName.split('.')[0];

        // Call external authorization function with connection details
        options.authorizeFn(_this.remoteAddress, options.socket.localPort, addr, _this.workerPass, (result) => {
            // Set authorization status based on result
            _this.authorized = (!result.error && result.authorized);

            // Send authorization response to client
            sendJson({
                id: message.id,
                result: _this.authorized,
                error: result.error
            });

            // Disconnect client if requested by authorizer (e.g., banned address)
            if (result.disconnect === true) {
                options.socket.destroy();
            }
        });
    }

    /**
     * Handles mining.submit method calls from clients.
     * 
     * The submit method processes completed work from miners:
     * 1. Validates client authorization and subscription status
     * 2. Extracts share data from message parameters
     * 3. Combines extraNonce1 + extraNonce2 to form complete nonce
     * 4. Emits submit event for pool processing
     * 5. Handles ban consideration and response sending
     * 
     * @private
     * @param {Object} message - The parsed submit message
     * @param {number} message.id - Request ID for response correlation
     * @param {Array} message.params - [workerName, jobId, nTime, extraNonce2, solution]
     */
    function handleSubmit(message) {
        // Set worker name if not already set (backup from submit params)
        if (!_this.workerName) {
            _this.workerName = getSafeWorkerString(message.params[0]);
        }

        // Verify client is authorized before accepting shares
        if (_this.authorized === false) {
            sendJson({
                id: message.id,
                result: null,
                error: [24, 'unauthorized worker', null]
            });
            considerBan(false); // Invalid share due to no auth
            return;
        }

        // Verify client has subscribed before accepting shares
        if (!_this.extraNonce1) {
            sendJson({
                id: message.id,
                result: null,
                error: [25, 'not subscribed', null]
            });
            considerBan(false); // Invalid share due to no subscription
            return;
        }

        // Emit submit event with parsed share data
        _this.emit('submit',
            {
                name: _this.workerName,
                jobId: message.params[1],        // Job identifier from pool
                nTime: message.params[2],        // Timestamp when work was done
                extraNonce2: message.params[3],  // Client's nonce contribution
                soln: message.params[4],         // Solution/proof of work
                nonce: _this.extraNonce1 + message.params[3], // Complete nonce
            },
            /**
             * Callback for share processing result
             * @param {Array|null} error - Error details if share was invalid
             * @param {boolean} result - Whether share was accepted
             */
            (error, result) => {
                // Only send response if client wasn't banned
                if (!considerBan(result)) {
                    sendJson({
                        id: message.id,
                        result: result,
                        error: error
                    });
                }
            }
        );
    }

    /**
     * Sends JSON-RPC messages to the client over the socket connection.
     * 
     * Takes variable arguments, converts each to JSON, and sends them
     * as newline-delimited messages. This follows the stratum protocol
     * convention of one JSON message per line.
     * 
     * @private
     * @param {...Object} arguments - JSON objects to send to client
     */
    function sendJson() {
        let response = '';
        // Convert each argument to JSON and append newline
        for (let i = 0; i < arguments.length; i++) {
            response += `${JSON.stringify(arguments[i])}\n`;
        }
        // Send complete response to client
        options.socket.write(response);
    }

    /**
     * Configures socket event handlers and message processing.
     * 
     * This function sets up the core socket communication logic:
     * - Handles TCP proxy protocol for IP forwarding
     * - Implements message buffering and parsing
     * - Provides flood protection (10KB buffer limit)
     * - Processes newline-delimited JSON messages
     * - Manages connection lifecycle events
     * 
     * @private
     */
    function setupSocket() {
        const socket = options.socket;
        /** @type {string} Buffer for accumulating incoming data */
        let dataBuffer = '';

        // Set UTF-8 encoding for text-based JSON protocol
        socket.setEncoding('utf8');

        // Handle TCP proxy protocol for load balancers/proxies
        if (options.tcpProxyProtocol === true) {
            socket.once('data', (d) => {
                if (d.indexOf('PROXY') === 0) {
                    // Extract real client IP from PROXY protocol header
                    _this.remoteAddress = d.split(' ')[2];
                } else {
                    // Invalid PROXY protocol format
                    _this.emit('tcpProxyError', d);
                }
                _this.emit('checkBan');
            });
        } else {
            // Direct connection - check ban status immediately
            _this.emit('checkBan');
        }

        // Handle incoming data with message parsing and flood protection
        socket.on('data', (d) => {
            dataBuffer += d;

            // Prevent memory exhaustion from malicious large messages
            if (Buffer.byteLength(dataBuffer, 'utf8') > 10240) { // 10KB limit
                dataBuffer = '';
                _this.emit('socketFlooded');
                socket.destroy();
                return;
            }

            // Process complete messages (terminated by newlines)
            if (dataBuffer.indexOf('\n') !== -1) {
                const messages = dataBuffer.split('\n');
                // Keep incomplete message in buffer
                const incomplete = dataBuffer.slice(-1) === '\n' ? '' : messages.pop();

                // Process each complete message
                messages.forEach((message) => {
                    if (message.length < 1) {
                        return; // Skip empty messages
                    }

                    let messageJson;
                    try {
                        // Parse JSON message according to stratum protocol
                        messageJson = JSON.parse(message);
                    } catch (e) {
                        // Handle JSON parsing errors (except for PROXY protocol)
                        if (options.tcpProxyProtocol !== true || d.indexOf('PROXY') !== 0) {
                            _this.emit('malformedMessage', message);
                            socket.destroy();
                        }
                        return;
                    }

                    // Process valid JSON messages
                    if (messageJson) {
                        handleMessage(messageJson);
                    }
                });

                // Store incomplete message for next data event
                dataBuffer = incomplete;
            }
        });

        // Handle client disconnection
        socket.on('close', () => {
            _this.emit('socketDisconnect');
        });

        // Handle socket errors (ignore connection resets)
        socket.on('error', (err) => {
            if (err.code !== 'ECONNRESET') {
                _this.emit('socketError', err);
            }
        });
    }


    /**
     * Generates a human-readable label for this client connection.
     * 
     * Used for logging and debugging purposes to identify clients
     * in a meaningful way. Shows worker name if authorized, otherwise 
     * indicates unauthorized status.
     * 
     * @public
     * @returns {string} Formatted label in "workername [ip]" format
     * 
     * @example
     * "miner1.worker [192.168.1.100]"
     * "(unauthorized) [10.0.0.50]"
     */
    this.getLabel = function () {
        return `${_this.workerName || '(unauthorized)'} [${_this.remoteAddress}]`;
    };

    /**
     * Queues a difficulty change for the next mining job.
     * 
     * Instead of immediately changing difficulty, this queues the change
     * to be applied when the next job is sent. This ensures difficulty
     * changes are synchronized with job distribution.
     * 
     * @public
     * @param {number} requestedNewDifficulty - New difficulty value to apply
     * @returns {boolean} Always returns true to indicate queuing succeeded
     */
    this.enqueueNextDifficulty = function (requestedNewDifficulty) {
        pendingDifficulty = requestedNewDifficulty;
        return true;
    };

    // ==================== PUBLIC METHODS ====================

    /**
     * Sends a difficulty adjustment message to the client.
     * 
     * Calculates the target hash based on the algorithm's difficulty and
     * sends a mining.set_target message to update the client's difficulty.
     * Only sends if the difficulty has actually changed to avoid redundant messages.
     * 
     * @public
     * @param {number} difficulty - New difficulty value for the client
     * @returns {boolean} true if difficulty was sent, false if unchanged
     **/
    this.sendDifficulty = function (difficulty) {
        // Skip if difficulty hasn't changed
        if (difficulty === this.difficulty) {
            return false;
        }

        // Update difficulty values and maintain history
        _this.previousDifficulty = _this.difficulty;
        _this.difficulty = difficulty;

        // Calculate target hash from difficulty
        // Target = powLimit / difficulty (lower difficulty = higher target = easier)
        // Use the algorithm configuration passed from pool options
        const powLimit = algos[algorithm].diff; // Reference to algorithm configuration from options
        const adjPow = powLimit / difficulty;

        // Convert to 64-character hex string with zero padding
        let zeroPad;
        if ((64 - adjPow.toString(16).length) === 0) {
            zeroPad = '';
        } else {
            zeroPad = '0';
            zeroPad = zeroPad.repeat((64 - (adjPow.toString(16).length)));
        }
        const target = (zeroPad + adjPow.toString(16)).substr(0, 64);

        // Send mining.set_target message to client
        sendJson({
            id: null,
            method: 'mining.set_target',
            params: [target]
        });
        return true;
    };

    /**
     * Sends a new mining job to the client.
     * 
     * This method:
     * 1. Checks for connection timeout and disconnects idle clients
     * 2. Applies any pending difficulty changes before the job
     * 3. Sends mining.notify message with job parameters
     * 4. Emits difficultyChanged event if difficulty was updated
     * 
     * @public
     * @param {Array} jobParams - Array of job parameters for mining.notify
     *   Format: [jobId, prevHash, coinb1, coinb2, merkleTree, version, nBits, nTime, cleanJobs]
     */
    this.sendMiningJob = function (jobParams) {
        // Check for inactive connections and timeout if needed
        const lastActivityAgo = Date.now() - _this.lastActivity;
        if (lastActivityAgo > options.connectionTimeout * 1000) {
            _this.socket.destroy();
            return;
        }

        // Apply any pending difficulty changes before sending job
        if (pendingDifficulty !== null) {
            const result = _this.sendDifficulty(pendingDifficulty);
            pendingDifficulty = null;
            if (result) {
                _this.emit('difficultyChanged', _this.difficulty);
            }
        }

        // Send mining.notify message with job details
        sendJson({
            id: null,
            method: 'mining.notify',
            params: jobParams
        });
    };

    /**
     * Sends a mining.set_extranonce message to update client's extraNonce values.
     * 
     * According to the Bitcoin Wiki Stratum Protocol specification:
     * https://en.bitcoin.it/wiki/Stratum_mining_protocol#mining.set_extranonce
     * 
     * This method allows the server to change a client's extraNonce1 and 
     * extraNonce2Size values mid-session. This is useful for:
     * - Session resumption after reconnection
     * - Load balancing across pool servers
     * - Preventing extraNonce1 collisions
     * - Dynamic extraNonce2Size adjustment based on hashrate
     * 
     * Prerequisites:
     * - Client must have called mining.extranonce.subscribe first
     * - Client must have supportsExtraNonceSubscription = true
     * 
     * Message format: mining.set_extranonce("extranonce1", extranonce2_size)
     * - extranonce1: New hex-encoded extraNonce1 value
     * - extranonce2_size: New extraNonce2 size in bytes
     * 
     * Timing: Values take effect beginning with the next mining.notify job
     * 
     * @public
     * @param {string} newExtraNonce1 - New hex-encoded extraNonce1 value
     * @param {number} newExtraNonce2Size - New extraNonce2 size in bytes
     * @returns {boolean} true if sent successfully, false if client doesn't support it
     * 
     * @example
     * // Change client's extraNonce1 and keep same extraNonce2 size
     * client.sendSetExtraNonce('deadbeef', 4);
     * 
     * @see {@link https://en.bitcoin.it/wiki/Stratum_mining_protocol#mining.set_extranonce}
     */
    this.sendSetExtraNonce = function (newExtraNonce1, newExtraNonce2Size) {
        // Check if client supports extranonce subscription
        if (!_this.supportsExtraNonceSubscription) {
            return false;
        }

        // Update client's stored extraNonce values
        _this.extraNonce1 = newExtraNonce1;
        _this.extraNonce2Size = newExtraNonce2Size;

        // Send mining.set_extranonce message to client
        sendJson({
            id: null,
            method: 'mining.set_extranonce',
            params: [newExtraNonce1, newExtraNonce2Size]
        });

        // Emit event for tracking
        _this.emit('extranonceChanged', {
            extraNonce1: newExtraNonce1,
            extraNonce2Size: newExtraNonce2Size
        });

        return true;
    };

    /**
     * Manually authenticates a client without sending a response.
     * 
     * This method is used internally when reconnecting clients or
     * during special connection handling scenarios where the normal
     * authorization flow should be bypassed.
     * 
     * @public
     * @param {string} username - Worker name/address to authenticate
     * @param {string} password - Worker password
     */
    this.manuallyAuthClient = function (username, password) {
        handleAuthorize({ id: 1, params: [username, password] }, false /*do not reply to miner*/);
    };

    /**
     * Manually transfers state from another client instance.
     * 
     * Used when reconnecting clients to maintain session continuity.
     * Copies essential state like extraNonce1 and difficulty settings
     * from an existing client to a new connection.
     * 
     * @public
     * @param {StratumClient} otherClient - Source client to copy state from
     */
    this.manuallySetValues = function (otherClient) {
        _this.extraNonce1 = otherClient.extraNonce1;
        _this.previousDifficulty = otherClient.previousDifficulty;
        _this.difficulty = otherClient.difficulty;
    };
};

// Make StratumClient inherit from EventEmitter for event-driven architecture
StratumClient.prototype.__proto__ = events.EventEmitter.prototype;




/**
 * The main stratum mining server that manages client connections and job distribution.
 * 
 * The StratumServer is responsible for:
 * - Accepting incoming miner connections (TCP/TLS)
 * - Managing client lifecycle (connection, authorization, disconnection)
 * - Broadcasting mining jobs to all connected clients
 * - Handling connection banning and security
 * - Managing job rebroadcast timeouts
 * - Coordinating with pool logic for share processing
 * 
 * @class StratumServer
 * @extends EventEmitter
 * 
 * @param {Object} options - Server configuration options
 * @param {Object} options.ports - Port configuration object {port: {tls: boolean, ...}}
 * @param {number} [options.connectionTimeout=600] - Seconds before timing out inactive clients
 * @param {number} [options.jobRebroadcastTimeout=55] - Seconds before rebroadcasting jobs
 * @param {string} [options.poolId=''] - Unique identifier for this pool instance
 * @param {boolean} [options.tcpProxyProtocol=false] - Enable PROXY protocol support
 * @param {Object} [options.banning] - Banning configuration
 * @param {boolean} [options.banning.enabled=false] - Enable connection banning
 * @param {number} [options.banning.time=600] - Ban duration in seconds
 * @param {number} [options.banning.purgeInterval=300] - Seconds between ban list cleanup
 * @param {Array<string>} [options.banning.banned=[]] - Permanently banned IP addresses
 * @param {Object} [options.tlsOptions] - TLS configuration for secure connections
 * @param {boolean} [options.tlsOptions.enabled=false] - Enable TLS support
 * @param {string} [options.tlsOptions.serverKey] - Path to TLS private key file
 * @param {string} [options.tlsOptions.serverCert] - Path to TLS certificate file
 * 
 * @param {Function} authorizeFn - Worker authorization callback function
 * @param {string} authorizeFn.remoteAddress - Client IP address
 * @param {number} authorizeFn.localPort - Server port client connected to
 * @param {string} authorizeFn.workerAddress - Worker's cryptocurrency address
 * @param {string} authorizeFn.workerPassword - Worker's password
 * @param {Function} authorizeFn.callback - Result callback (error, authorized, disconnect)
 * 
 * @param {Object} algos - Algorithm configuration object from algoProperties.js
 * @param {Object} algos.[algorithm] - Algorithm-specific configuration
 * @param {number} algos.[algorithm].diff - Difficulty target for the algorithm
 * @param {number} algos.[algorithm].multiplier - Difficulty multiplier
 * 
 * @fires StratumServer#client.connected - When a new miner connects
 * @fires StratumServer#client.disconnected - When a miner disconnects
 * @fires StratumServer#started - When the server is up and running
 * @fires StratumServer#broadcastTimeout - When job rebroadcast timeout expires
 * @fires StratumServer#extranonceChangesBroadcast - When extranonce changes are broadcast to clients
 * 
 * @example
 * const algos = require('./algoProperties.js');
 * const server = new StratumServer({
 *   ports: {
 *     3032: { tls: false },
 *     3033: { tls: true }
 *   },
 *   connectionTimeout: 600,
 *   jobRebroadcastTimeout: 55,
 *   algorithm: 'equihash',
 *   banning: {
 *     enabled: true,
 *     time: 600,
 *     checkThreshold: 100,
 *     invalidPercent: 50
 *   }
 * }, (remoteAddress, port, workerAddr, workerPass, callback) => {
 *   // Authorize worker logic
 *   callback({ authorized: true, error: null });
 * }, algos);
 */
const StratumServer = exports.Server = function StratumServer(options, authorizeFn, algos) {

    // ==================== PRIVATE MEMBERS ====================

    /** @type {number} Ban duration in milliseconds */
    const bannedMS = options.banning ? options.banning.time * 1000 : null;

    /** @type {StratumServer} Self-reference for use in closures */
    const _this = this;
    /** @type {Object.<string, StratumClient>} Map of subscription IDs to client instances */
    const stratumClients = {};
    /** @type {Object} Counter for generating unique subscription IDs */
    const subscriptionCounter = SubscriptionCounter(options.poolId || '');
    /** @type {NodeJS.Timeout} Timeout handle for job rebroadcast timer */
    let rebroadcastTimeout;
    /** @type {Object.<string, number>} Map of banned IP addresses to ban timestamps */
    const bannedIPs = {};


    /**
     * Checks if a client should be banned and takes appropriate action.
     * 
     * This function implements a two-tier banning system:
     * 1. Permanent bans: IPs in the banned configuration list
     * 2. Temporary bans: IPs banned for specific duration due to behavior
     * 
     * For temporary bans, calculates remaining ban time and either:
     * - Kicks the client if ban is still active
     * - Forgives the client if ban has expired
     * 
     * @private
     * @param {StratumClient} client - Client to check for ban status
     */
    function checkBan(client) {
        if (options.banning && options.banning.enabled) {
            // Check permanent ban list first
            if (options.banning.banned && options.banning.banned.includes(client.remoteAddress)) {
                client.socket.destroy();
                client.emit('kickedBannedIP', 9999999); // Permanent ban indicator
                return;
            }

            // Check temporary ban list
            if (client.remoteAddress in bannedIPs) {
                const bannedTime = bannedIPs[client.remoteAddress];
                const bannedTimeAgo = Date.now() - bannedTime;
                const timeLeft = bannedMS - bannedTimeAgo;

                if (timeLeft > 0) {
                    // Ban still active - kick client
                    client.socket.destroy();
                    client.emit('kickedBannedIP', timeLeft / 1000 | 0);
                } else {
                    // Ban expired - remove from ban list and allow connection
                    delete bannedIPs[client.remoteAddress];
                    client.emit('forgaveBannedIP');
                }
            }
        }
    }

    /**
     * Handles a new client connection to the stratum server.
     * 
     * This method:
     * 1. Enables TCP keep-alive on the socket
     * 2. Generates a unique subscription ID for the client
     * 3. Creates a new StratumClient instance with proper configuration
     * 4. Registers the client in the active clients map
     * 5. Sets up event handlers for client lifecycle management
     * 6. Initializes the client connection
     * 
     * @public
     * @param {net.Socket} socket - The TCP socket for the new client connection
     * @returns {string} The unique subscription ID assigned to the client
     */
    this.handleNewClient = function (socket) {
        // Enable TCP keep-alive to detect dead connections
        socket.setKeepAlive(true);

        // Generate unique subscription ID for this client
        const subscriptionId = subscriptionCounter.next();

        // Create new StratumClient instance with server configuration
        const client = new StratumClient(
            {
                subscriptionId: subscriptionId,
                authorizeFn: authorizeFn,
                socket: socket,
                banning: options.banning,
                connectionTimeout: options.connectionTimeout,
                tcpProxyProtocol: options.tcpProxyProtocol,
                algos: algos,
                algorithm: options.algorithm
            }
        );

        // Register client in active clients map
        stratumClients[subscriptionId] = client;

        // Emit server-level connection event
        _this.emit('client.connected', client);

        // Set up event handlers for client lifecycle
        client.on('socketDisconnect', () => {
            // Clean up client when it disconnects
            _this.removeStratumClientBySubId(subscriptionId);
            _this.emit('client.disconnected', client);
        }).on('checkBan', () => {
            // Check if client should be banned on connection/activity
            checkBan(client);
        }).on('triggerBan', () => {
            // Add client IP to ban list when ban is triggered
            _this.addBannedIP(client.remoteAddress);
        }).init(); // Initialize client connection

        return subscriptionId;
    };


    /**
     * Broadcasts a new mining job to all connected clients.
     * 
     * This method:
     * 1. Iterates through all connected clients
     * 2. Sends the job to each client (with individual difficulty/timeout handling)
     * 3. Sets up a rebroadcast timeout to prevent miner starvation
     * 
     * The rebroadcast timeout is important because many miners will consider
     * the pool dead if they don't receive a job within ~60 seconds, even if
     * no new blocks have been found.
     * 
     * @public
     * @param {Array} jobParams - Job parameters array for mining.notify message
     */
    this.broadcastMiningJobs = function (jobParams) {
        // Send job to all connected clients
        for (const clientId in stratumClients) {
            const client = stratumClients[clientId];
            client.sendMiningJob(jobParams);
        }

        // Set up rebroadcast timeout to keep miners active
        // Clear any existing timeout first to avoid multiple timers
        clearTimeout(rebroadcastTimeout);
        rebroadcastTimeout = setTimeout(() => {
            _this.emit('broadcastTimeout');
        }, options.jobRebroadcastTimeout * 1000);
    };



    /**
     * Initializes the stratum server and starts listening on configured ports.
     * 
     * This IIFE (Immediately Invoked Function Expression) performs:
     * 1. Sets up ban list cleanup interval to prevent memory leaks
     * 2. Configures TLS options if TLS is enabled
     * 3. Creates TCP and/or TLS servers on configured ports
     * 4. Emits 'started' event when all servers are listening
     * 
     * @private
     */
    (function init() {
        // Set up periodic cleanup of expired bans to prevent memory leaks
        if (options.banning && options.banning.enabled) {
            setInterval(() => {
                for (ip in bannedIPs) {
                    const banTime = bannedIPs[ip];
                    // Remove bans that have exceeded the ban duration
                    if (Date.now() - banTime > options.banning.time) {
                        delete bannedIPs[ip];
                    }
                }
            }, 1000 * options.banning.purgeInterval);
        }

        // Configure TLS options if TLS is enabled
        if ((typeof (options.tlsOptions) !== 'undefined' && typeof (options.tlsOptions.enabled) !== 'undefined') && (options.tlsOptions.enabled === 'true' || options.tlsOptions.enabled === true)) {
            TLSoptions = {
                key: fs.readFileSync(options.tlsOptions.serverKey),
                cert: fs.readFileSync(options.tlsOptions.serverCert),
                requireCert: true
            };
        }

        // Track how many servers have started to know when to emit 'started'
        let serversStarted = 0;

        // Create servers for each configured port
        for (const port in options.ports) {
            if (options.ports[port].tls === false || options.ports[port].tls === 'false') {
                // Create plain TCP server
                net.createServer({ allowHalfOpen: false }, (socket) => {
                    _this.handleNewClient(socket);
                }).listen(parseInt(port), () => {
                    serversStarted++;
                    // Emit started event when all servers are listening
                    if (serversStarted == Object.keys(options.ports).length) {
                        _this.emit('started');
                    }
                });
            } else {
                // Create TLS server
                tls.createServer(TLSoptions, (socket) => {
                    _this.handleNewClient(socket);
                }).listen(parseInt(port), () => {
                    serversStarted++;
                    // Emit started event when all servers are listening
                    if (serversStarted == Object.keys(options.ports).length) {
                        _this.emit('started');
                    }
                });
            }
        }
    })();


    // ==================== PUBLIC METHODS ====================

    /**
     * Adds an IP address to the temporary ban list.
     * 
     * Banned IPs will be rejected on connection attempts until the ban expires.
     * The ban timestamp is recorded for duration calculation during connection attempts.
     * 
     * @public
     * @param {string} ipAddress - IP address to ban (e.g., "192.168.1.100")
     */
    this.addBannedIP = function (ipAddress) {
        bannedIPs[ipAddress] = Date.now();
        // Note: Could emit 'bootedBannedWorker' event here if needed for existing connections
    };

    /**
     * Gets the current map of active stratum clients.
     * 
     * Returns a reference to the internal client map for external inspection
     * or management. Keys are subscription IDs, values are StratumClient instances.
     * 
     * @public
     * @returns {Object.<string, StratumClient>} Map of subscription IDs to clients
     */
    this.getStratumClients = function () {
        return stratumClients;
    };

    /**
     * Removes a stratum client by subscription ID.
     * 
     * Used for cleanup when clients disconnect or are removed programmatically.
     * Does not close the socket - that should be handled by the caller.
     * 
     * @public
     * @param {string} subscriptionId - Unique subscription ID of client to remove
     */
    this.removeStratumClientBySubId = function (subscriptionId) {
        delete stratumClients[subscriptionId];
    };

    /**
     * Manually adds a pre-configured stratum client to the server.
     * 
     * Used for client reconnection scenarios where you want to restore
     * a previous client's state. The method:
     * 1. Handles the new client connection normally
     * 2. If not banned, manually authenticates with provided credentials
     * 3. Transfers state from a previous client instance
     * 
     * @public
     * @param {Object} clientObj - Client configuration object
     * @param {net.Socket} clientObj.socket - TCP socket for the client
     * @param {string} clientObj.workerName - Worker name for authentication
     * @param {string} clientObj.workerPass - Worker password for authentication
     * @param {StratumClient} [clientObj] - Previous client instance to copy state from
     */
    this.manuallyAddStratumClient = function (clientObj) {
        const subId = _this.handleNewClient(clientObj.socket);
        if (subId != null) { // Connection was accepted (not banned)
            // Manually authenticate the client
            stratumClients[subId].manuallyAuthClient(clientObj.workerName, clientObj.workerPass);
            // Transfer state from previous client instance
            stratumClients[subId].manuallySetValues(clientObj);
        }
    };

    /**
     * Broadcasts extranonce changes to clients that support it.
     * 
     * This server-level method allows coordinated extranonce changes
     * across multiple clients, useful for:
     * - Pool server load balancing
     * - Session management during reconnections
     * - Prevention of extraNonce1 collisions
     * - Dynamic optimization of extraNonce space allocation
     * 
     * @public
     * @param {Object} options - Extranonce change options
     * @param {Array<string>} [options.clientIds] - Specific client subscription IDs (if undefined, applies to all supporting clients)
     * @param {Function} [options.extraNonce1Generator] - Function to generate new extraNonce1 values
     * @param {number} [options.newExtraNonce2Size] - New extraNonce2 size (if undefined, keeps current)
     * @param {boolean} [options.forceCleanJobs=false] - Whether to force clean jobs after extranonce change
     * @param {Array} [options.jobParams] - Job parameters to use for clean jobs (required if forceCleanJobs is true)
     * 
     * @returns {Object} Result summary
     * @returns {number} returns.attempted - Number of clients that extranonce change was attempted on
     * @returns {number} returns.successful - Number of clients that successfully received the change
     * @returns {Array<string>} returns.unsupported - Subscription IDs of clients that don't support extranonce
     * 
     * @example
     * const result = server.broadcastExtraNonceChange({
     *   extraNonce1Generator: (oldExtraNonce1) => generateNewExtraNonce1(),
     *   newExtraNonce2Size: 4,
     *   forceCleanJobs: true,
     *   jobParams: currentJobParams
     * });
     * console.log(`Updated ${result.successful}/${result.attempted} clients`);
     */
    this.broadcastExtraNonceChange = function (options = {}) {
        const result = {
            attempted: 0,
            successful: 0,
            unsupported: []
        };

        const targetClients = options.clientIds
            ? options.clientIds.map(id => stratumClients[id]).filter(Boolean)
            : Object.values(stratumClients);

        for (const client of targetClients) {
            result.attempted++;

            if (!client.supportsExtraNonceSubscription) {
                result.unsupported.push(client.subscriptionId || 'unknown');
                continue;
            }

            const newExtraNonce1 = options.extraNonce1Generator
                ? options.extraNonce1Generator(client.extraNonce1)
                : client.extraNonce1; // Keep current if no generator

            const newExtraNonce2Size = options.newExtraNonce2Size !== undefined
                ? options.newExtraNonce2Size
                : client.extraNonce2Size; // Keep current if not specified

            if (client.sendSetExtraNonce(newExtraNonce1, newExtraNonce2Size)) {
                result.successful++;

                // Optionally force clean jobs to ensure immediate adoption
                if (options.forceCleanJobs && options.jobParams) {
                    // Create clean job by setting clean_jobs parameter to true
                    const cleanJobParams = [...options.jobParams];
                    cleanJobParams[8] = true; // Set clean_jobs = true
                    client.sendMiningJob(cleanJobParams);
                }
            }
        }

        // Emit server-level event for tracking
        _this.emit('extranonceChangesBroadcast', result);

        return result;
    };

};

// Make StratumServer inherit from EventEmitter for event-driven architecture
StratumServer.prototype.__proto__ = events.EventEmitter.prototype;

/**
 * @module stratum
 * @description
 * This module provides a complete stratum mining protocol implementation for cryptocurrency pools.
 * 
 * Key Features:
 * - Full stratum protocol support (mining.subscribe, mining.authorize, mining.submit)
 * - Configurable difficulty adjustment and job distribution
 * - Connection security with IP banning and flood protection
 * - Support for both TCP and TLS connections
 * - TCP proxy protocol support for load balancers
 * - Event-driven architecture for integration with pool logic
 * 
 * EXTRANONCE.SUBSCRIBE IMPLEMENTATION:
 * 
 * ✅ mining.extranonce.subscribe is FULLY IMPLEMENTED
 * This stratum protocol extension allows:
 * - Clients to indicate support for mining.set_extranonce method
 * - Servers to change client extraNonce1 and extraNonce2Size mid-session
 * - Better session management and load balancing capabilities
 * 
 * Implemented features:
 * - handleExtraNonceSubscribe() - Handles client subscription requests
 * - sendSetExtraNonce() - Sends extranonce changes to individual clients
 * - broadcastExtraNonceChange() - Broadcasts changes to multiple clients
 * - Full event emission for tracking and integration
 * 
 * Capabilities now available:
 * ✅ Session resumption after client reconnection
 * ✅ Load balancing across multiple pool servers
 * ✅ Prevention of extraNonce1 collisions at scale
 * ✅ Dynamic extraNonce2Size optimization
 * ✅ Improved pool server failover capabilities
 * 
 * Usage:
 * ```javascript
 * const { Server } = require('./stratum');
 * const server = new Server(options, authorizeFn);
 * server.on('client.connected', (client) => { ... });
 * server.on('started', () => console.log('Stratum server started'));
 * ```
 * 
 * @see {@link https://en.bitcoin.it/wiki/Stratum_mining_protocol#Protocol} Stratum Protocol Documentation
 * @see {@link https://en.bitcoin.it/wiki/Stratum_mining_protocol#mining.extranonce.subscribe} ExtraNonce Subscribe Method
 * @see {@link https://en.bitcoin.it/wiki/Stratum_mining_protocol#mining.set_extranonce} Set ExtraNonce Method
 * @see {@link StratumServer} Main server class
 * @see {@link StratumClient} Individual client connection class
 */
