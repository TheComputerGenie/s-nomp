/**
 * Stratum Protocol Implementation (v10-style)
 *
 * This module provides an alternative implementation of the Stratum mining protocol,
 * specifically designed for cryptocurrency mining pools. It handles client-server
 * communication for mining operations, including job distribution, share submission,
 * and difficulty management.
 *
 * The implementation includes both client and server classes:
 * - StratumClient: Handles individual miner connections and protocol messages
 * - StratumServer: Manages multiple client connections and broadcasts mining jobs
 *
 * Key features:
 * - Support for Stratum v1 protocol methods (mining.subscribe, mining.authorize, etc.)
 * - Extra nonce subscription for efficient mining
 * - Dynamic difficulty adjustment
 * - Client banning for invalid shares
 * - TCP proxy protocol support
 * - TLS encryption support
 *
 * @module stratum
 * @author TheComputerGenie
 * @license MIT
 */

const net = require('net');
const tls = require('tls');
const fs = require('fs');
const EventEmitter = require('events');
const util = require('../utils/util.js');

/**
 * Creates a subscription counter that generates unique subscription IDs for Stratum clients.
 * Each ID is based on a fixed base string combined with the pool ID and an incrementing counter.
 *
 * @param {string} poolId - The pool identifier to include in the subscription ID base.
 * @returns {Object} An object with a `next()` method that returns the next unique subscription ID.
 */
function SubscriptionCounter(poolId) {
    let n = 0;
    const base = 'deadbeefcafebabe';
    const pad = (base + (poolId || '')).slice(0, base.length);
    return { next: () => pad + util.packInt64LE(++n).toString('hex') };
}

/**
 * Represents a Stratum client connection in a mining pool.
 *
 * This class handles the lifecycle of a single miner connection, processing
 * Stratum protocol messages, managing authorization, difficulty, and share submission.
 * It extends EventEmitter to notify the pool of various events like submissions,
 * disconnections, and ban triggers.
 *
 * @extends EventEmitter
 */
class StratumClient extends EventEmitter {

    constructor(options) {
        super();
        this.subscriptionId = options.subscriptionId;
        this.authorizeFn = options.authorizeFn;
        this.socket = options.socket;
        this.banning = options.banning;
        this.connectionTimeout = options.connectionTimeout;
        this.tcpProxyProtocol = options.tcpProxyProtocol;
        this.algos = options.algos;
        this.algorithm = options.algorithm;

        // Initialize other properties
        this.remoteAddress = this.socket.remoteAddress;
        this.workerName = null;
        this.workerPass = null;
        this.authorized = false;
        this.lastActivity = Date.now();
        this.shares = { valid: 0, invalid: 0 };
        this.difficulty = 1;
        this.previousDifficulty = null;
        this._pendingDifficulty = null;
        this.extraNonce1 = null;
        this.extraNonce2Size = 8;
        this.supportsExtraNonceSubscription = false;

        this._setupSocket();
    }

    /**
     * Sets up the socket event handlers for data reception, connection management,
     * and error handling. Configures buffering for incoming messages and handles
     * TCP proxy protocol if enabled.
     *
     * @private
     */
    _setupSocket() {
        const s = this.socket;
        s.setEncoding('utf8');
        let buffer = '';

        // Handle TCP proxy protocol for real IP detection
        if (this.tcpProxyProtocol) {
            s.once('data', (d) => {
                if (d.indexOf && d.indexOf('PROXY') === 0) {
                    const parts = d.split(' ');
                    if (parts[2]) {
                        this.remoteAddress = parts[2];
                    }
                } else {
                    this.emit('tcpProxyError', d);
                }
                this.emit('checkBan');
            });
        } else {
            process.nextTick(() => this.emit('checkBan'));
        }

        // Handle incoming data with buffering and flood protection
        s.on('data', (d) => {
            buffer += d;
            // Prevent buffer flooding attacks
            if (Buffer.byteLength(buffer, 'utf8') > 10 * 1024) {
                buffer = '';
                this.emit('socketFlooded');
                try {
                    s.destroy();
                } catch (e) { }
                return;
            }
            // Process complete lines
            if (buffer.indexOf('\n') === -1) {
                return;
            }
            const lines = buffer.split('\n');
            buffer = buffer.endsWith('\n') ? '' : lines.pop();
            for (const line of lines) {
                if (!line) {
                    continue;
                }
                let obj;
                try {
                    obj = JSON.parse(line);
                } catch (e) {
                    this.emit('malformedMessage', line); try {
                        s.destroy();
                    } catch (er) { } return;
                }
                this._handleMessage(obj);
            }
        });

        s.on('close', () => this.emit('socketDisconnect'));
        s.on('error', (err) => {
            if (err && err.code !== 'ECONNRESET') {
                this.emit('socketError', err);
            }
        });
    }

    /**
     * Sends one or more JSON-RPC messages to the client over the socket.
     * Each message is stringified and terminated with a newline.
     *
     * @private
     * @param {...Object} objs - The JSON-RPC message objects to send.
     */
    _sendJson(...objs) {
        if (!this.socket || !this.socket.writable) {
            return;
        }
        const out = `${objs.map(o => JSON.stringify(o)).join('\n')}\n`;
        this.socket.write(out);
    }

    /**
     * Processes incoming JSON-RPC messages from the client and dispatches
     * them to appropriate handlers based on the method. Handles all standard
     * Stratum v1 protocol methods.
     *
     * @private
     * @param {Object} msg - The parsed JSON-RPC message object.
     * @param {number} msg.id - The message ID for response correlation.
     * @param {string} msg.method - The Stratum method name.
     * @param {Array} [msg.params] - Method parameters.
     */
    _handleMessage(msg) {
        if (!msg || !msg.method) {
            return;
        }
        const id = msg.id;
        switch (msg.method) {
            case 'mining.subscribe':
                // Handle subscription request - client wants to start mining
                this.emit('subscription', {}, (err, extraNonce1) => {
                    if (err) {
                        return this._sendJson({ id: id, result: null, error: err });
                    }
                    this.extraNonce1 = extraNonce1;
                    this._sendJson({ id: id, result: [[['mining.set_difficulty', this.subscriptionId], ['mining.notify', this.subscriptionId]], extraNonce1, this.extraNonce2Size], error: null });
                });
                break;
            case 'mining.extranonce.subscribe':
                // Client supports extra nonce subscription for efficiency
                this.supportsExtraNonceSubscription = true;
                this._sendJson({ id: id, result: true, error: null });
                this.emit('extranonceSubscribed', { subscriptionId: this.subscriptionId, remoteAddress: this.remoteAddress, workerName: this.workerName });
                break;
            case 'mining.authorize':
                // Handle worker authorization
                this.workerName = util.safeString((msg.params && msg.params[0]) || '');
                this.workerPass = (msg.params && msg.params[1]) || '';
                const addr = (this.workerName || '').split('.')[0];
                this.authorizeFn(this.remoteAddress, this.socket.localPort, addr, this.workerPass, (res) => {
                    this.authorized = !!(res && res.authorized);
                    this._sendJson({ id: id, result: this.authorized, error: res && res.error });
                    if (res && res.disconnect) {
                        try {
                            this.socket.destroy();
                        } catch (e) { }
                    }
                });
                break;
            case 'mining.submit':
                // Handle share submission
                this.lastActivity = Date.now();
                if (!this.workerName) {
                    this.workerName = util.safeString((msg.params && msg.params[0]) || '');
                }
                if (this.authorized === false) {
                    this._sendJson({ id: id, result: null, error: [24, 'unauthorized worker', null] });
                    this._considerBan(false);
                    break;
                }
                if (!this.extraNonce1) {
                    this._sendJson({ id: id, result: null, error: [25, 'not subscribed', null] }); this._considerBan(false); break;
                }
                const p = msg.params || [];
                const payload = { name: this.workerName, jobId: p[1], nTime: p[2], extraNonce2: p[3], soln: p[4], nonce: (this.extraNonce1 || '') + (p[3] || '') };
                this.emit('submit', payload, (error, result) => {
                    if (!this._considerBan(result)) {
                        this._sendJson({ id: id, result: result, error: error });
                    }
                });
                break;
            case 'mining.get_transactions':
                // Not supported in this implementation
                this._sendJson({ id: null, result: [], error: true });
                break;
            default:
                // Unknown method - emit for external handling
                this.emit('unknownStratumMethod', msg);
        }
    }

    /**
     * Evaluates whether to ban the client based on share validity ratio.
     * If banning is enabled and the client has submitted enough shares,
     * checks if the invalid share percentage exceeds the threshold.
     *
     * @private
     * @param {boolean} valid - Whether the last share was valid.
     * @returns {boolean} True if the client was banned, false otherwise.
     */
    _considerBan(valid) {
        if (!this.banning || !this.banning.enabled) {
            return false;
        }
        if (valid) {
            this.shares.valid++;
        } else {
            this.shares.invalid++;
        }
        const tot = this.shares.valid + this.shares.invalid;
        if (tot >= (this.banning.checkThreshold || 100)) {
            const bad = (this.shares.invalid / tot) * 100;
            if (bad >= (this.banning.invalidPercent || 50)) {
                this.emit('triggerBan', `${this.shares.invalid}/${tot}`);
                try {
                    this.socket.destroy();
                } catch (e) { }
                return true;
            }
            this.shares = { valid: 0, invalid: 0 };
        }
        return false;
    }

    /**
     * Returns a human-readable label for this client, including worker name and IP address.
     * Used for logging and identification purposes.
     *
     * @returns {string} A label string in the format "workerName [remoteAddress]".
     */
    getLabel() {
        return `${this.workerName || '(unauthorized)'} [${this.remoteAddress}]`;
    }

    /**
     * Queues the next difficulty value to be sent to the client.
     * The difficulty will be applied on the next mining job notification.
     *
     * @param {number} d - The new difficulty value to enqueue.
     * @returns {boolean} Always returns true.
     */
    enqueueNextDifficulty(d) {
        this._pendingDifficulty = d; return true;
    }

    /**
     * Sends a difficulty change notification to the client using the mining.set_target method.
     * Calculates the target value from the difficulty and algorithm's proof-of-work limit.
     * Only sends if the difficulty has actually changed.
     *
     * @param {number} d - The new difficulty value.
     * @returns {boolean} True if the difficulty was sent, false if it was unchanged.
     */
    sendDifficulty(d) {
        if (this.difficulty === d) {
            return false;
        }
        this.previousDifficulty = this.difficulty;
        this.difficulty = d;
        const powLimit = this.algos.getDiff(this.algorithm) || 0;
        const adj = powLimit / d || 0;
        let hex = Math.floor(adj).toString(16);
        if (hex.length < 64) {
            hex = '0'.repeat(64 - hex.length) + hex;
        }
        this._sendJson({ id: null, method: 'mining.set_target', params: [hex] });
        return true;
    }

    /**
     * Sends a mining job notification to the client using the mining.notify method.
     * Includes any pending difficulty changes and checks for connection timeout.
     * If the client has been inactive too long, the connection is terminated.
     *
     * @param {Array} jobParams - The job parameters array for the mining.notify method.
     */
    sendMiningJob(jobParams) {
        if (Date.now() - this.lastActivity > this.connectionTimeout * 1000) {
            try {
                this.socket.destroy();
            } catch (e) { } return;
        }
        if (this._pendingDifficulty !== null) {
            const r = this.sendDifficulty(this._pendingDifficulty); this._pendingDifficulty = null; if (r) {
                this.emit('difficultyChanged', this.difficulty);
            }
        }
        this._sendJson({ id: null, method: 'mining.notify', params: jobParams });
    }

    /**
     * Sends an extra nonce change notification to the client if they support it.
     * Uses the mining.set_extranonce method to update the extra nonce values.
     *
     * @param {string} newExtra - The new extra nonce 1 value.
     * @param {number} newSize - The new extra nonce 2 size.
     * @returns {boolean} True if the notification was sent, false if client doesn't support it.
     */
    sendSetExtraNonce(newExtra, newSize) {
        if (!this.supportsExtraNonceSubscription) {
            return false;
        }
        this.extraNonce1 = newExtra;
        this.extraNonce2Size = newSize;
        this._sendJson({ id: null, method: 'mining.set_extranonce', params: [newExtra, newSize] });
        this.emit('extranonceChanged', { extraNonce1: newExtra, extraNonce2Size: newSize });
        return true;
    }

    /**
     * Manually triggers the authorization process for this client.
     * Useful for testing or when reconstructing client state.
     *
     * @param {string} u - The worker username.
     * @param {string} p - The worker password.
     */
    manuallyAuthClient(u, p) {
        this._handleMessage({ id: 1, method: 'mining.authorize', params: [u, p] });
    }

    /**
     * Manually sets client values, typically used when reconstructing client state
     * from persisted data or for testing purposes.
     *
     * @param {Object} other - Object containing values to copy.
     * @param {string} other.extraNonce1 - The extra nonce 1 value.
     * @param {number} other.previousDifficulty - The previous difficulty.
     * @param {number} other.difficulty - The current difficulty.
     */
    manuallySetValues(other) {
        this.extraNonce1 = other.extraNonce1; this.previousDifficulty = other.previousDifficulty; this.difficulty = other.difficulty;
    }
}

/**
 * Manages a Stratum mining pool server, handling multiple client connections
 * and coordinating mining operations. Listens on configured ports, manages
 * client lifecycle, broadcasts jobs, and handles banning policies.
 *
 * @extends EventEmitter
 */
class StratumServer extends EventEmitter {
    /**
     * Creates a new StratumServer instance.
     *
     * @param {Object} options - Server configuration options.
     * @param {Object} options.ports - Port configurations (port numbers as keys).
     * @param {Object} [options.banning] - Banning configuration.
     * @param {boolean} [options.banning.enabled=false] - Whether banning is enabled.
     * @param {number} [options.banning.time=600] - Ban duration in seconds.
     * @param {number} [options.banning.purgeInterval=300] - Ban list cleanup interval in seconds.
     * @param {number} [options.connectionTimeout] - Connection timeout in seconds.
     * @param {boolean} [options.tcpProxyProtocol] - Whether to use TCP proxy protocol.
     * @param {Object} [options.tlsOptions] - TLS configuration.
     * @param {string} [options.poolId] - Pool identifier for subscription IDs.
     * @param {number} [options.jobRebroadcastTimeout=55] - Job rebroadcast timeout in seconds.
     * @param {string} [options.algorithm] - Default mining algorithm.
     * @param {Function} authorizeFn - Function to authorize clients (remoteAddress, localPort, workerName, password, callback).
     * @param {Object} [algos={}] - Algorithm configurations.
     */
    constructor(options, authorizeFn, algos) {
        super();
        this.options = options || {};
        this.authorizeFn = authorizeFn || function () {
            arguments[arguments.length - 1]({ authorized: true });
        };
        this.algos = algos;
        this.counter = SubscriptionCounter(this.options.poolId || '');
        this.clients = {};
        this.bannedIPs = {};
        this._rebroadcastTimer = null;
        this._init();
    }

    /**
     * Initializes the server by setting up banning cleanup intervals and
     * starting listeners on configured ports. Supports both plain TCP and TLS connections.
     *
     * @private
     */
    _init() {
        const banning = this.options.banning || { enabled: false };
        // Set up periodic cleanup of expired bans
        if (banning.enabled) {
            setInterval(() => {
                Object.keys(this.bannedIPs).forEach((ip) => {
                    if (Date.now() - this.bannedIPs[ip] > (banning.time || 600) * 1000) {
                        delete this.bannedIPs[ip];
                    }
                });
            }, 1000 * (banning.purgeInterval || 300));
        }

        let tlsOptions = null;
        // Configure TLS if enabled
        if (this.options.tlsOptions && (this.options.tlsOptions.enabled === true || this.options.tlsOptions.enabled === 'true')) {
            tlsOptions = { key: fs.readFileSync(this.options.tlsOptions.serverKey), cert: fs.readFileSync(this.options.tlsOptions.serverCert), requestCert: true };
        }

        const ports = this.options.ports || {};
        const keys = Object.keys(ports);
        let started = 0;
        // Start listeners on each configured port
        keys.forEach((p) => {
            const cfg = ports[p];
            const num = parseInt(p, 10);
            if (!cfg || cfg.tls === false || cfg.tls === 'false') {
                // Plain TCP listener
                const srv = net.createServer({ allowHalfOpen: false }, (socket) => this._handleNewClient(socket));
                srv.listen(num, () => {
                    started++; if (started === keys.length) {
                        this.emit('started');
                    }
                });
            } else {
                // TLS listener
                const srv = tls.createServer(tlsOptions, (socket) => this._handleNewClient(socket));
                srv.listen(num, () => {
                    started++; if (started === keys.length) {
                        this.emit('started');
                    }
                });
            }
        });
    }

    /**
     * Handles a new incoming client connection by creating a StratumClient instance
     * and setting up event listeners for client lifecycle management.
     *
     * @private
     * @param {net.Socket|tls.TLSSocket} socket - The incoming socket connection.
     * @returns {string} The subscription ID of the created client.
     */
    _handleNewClient(socket) {
        try {
            socket.setKeepAlive(true);
        } catch (e) { }
        const sub = this.counter.next();
        const client = new StratumClient({ subscriptionId: sub, authorizeFn: this.authorizeFn, socket: socket, banning: this.options.banning, connectionTimeout: this.options.connectionTimeout, tcpProxyProtocol: this.options.tcpProxyProtocol, algos: this.algos, algorithm: this.options.algorithm });
        this.clients[sub] = client;
        this.emit('client.connected', client);
        client.on('socketDisconnect', () => {
            this.removeStratumClientBySubId(sub); this.emit('client.disconnected', client);
        })
            .on('checkBan', () => this._checkBan(client))
            .on('triggerBan', () => this.addBannedIP(client.remoteAddress));
        return sub;
    }

    /**
     * Checks if a client should be banned based on IP address and ban list.
     * If the client is banned, terminates the connection and emits appropriate events.
     *
     * @private
     * @param {StratumClient} client - The client to check for banning.
     */
    _checkBan(client) {
        const banning = this.options.banning || { enabled: false };
        if (!banning.enabled) {
            return;
        }
        if (banning.banned && banning.banned.indexOf(client.remoteAddress) !== -1) {
            client.socket.destroy(); client.emit('kickedBannedIP', 9999999); return;
        }
        if (this.bannedIPs[client.remoteAddress]) {
            const since = Date.now() - this.bannedIPs[client.remoteAddress];
            const left = (banning.time * 1000) - since;
            if (left > 0) {
                client.socket.destroy(); client.emit('kickedBannedIP', Math.floor(left / 1000));
            } else {
                delete this.bannedIPs[client.remoteAddress]; client.emit('forgaveBannedIP');
            }
        }
    }

    /**
     * Broadcasts mining job notifications to all connected clients.
     * Sets up a timeout for rebroadcasting if no new jobs are received.
     *
     * @param {Array} jobParams - The job parameters array for the mining.notify method.
     */
    broadcastMiningJobs(jobParams) {
        Object.keys(this.clients).forEach((id) => {
            try {
                this.clients[id].sendMiningJob(jobParams);
            } catch (e) { }
        });
        clearTimeout(this._rebroadcastTimer);
        this._rebroadcastTimer = setTimeout(() => this.emit('broadcastTimeout'), (this.options.jobRebroadcastTimeout || 55) * 1000);
    }

    /**
     * Adds an IP address to the banned list with the current timestamp.
     *
     * @param {string} ip - The IP address to ban.
     */
    addBannedIP(ip) {
        this.bannedIPs[ip] = Date.now();
    }

    /**
     * Returns the current collection of connected Stratum clients.
     *
     * @returns {Object<string, StratumClient>} Object mapping subscription IDs to client instances.
     */
    getStratumClients() {
        return this.clients;
    }

    /**
     * Removes a client from the server by its subscription ID.
     *
     * @param {string} subId - The subscription ID of the client to remove.
     */
    removeStratumClientBySubId(subId) {
        delete this.clients[subId];
    }

    /**
     * Manually adds a pre-configured Stratum client to the server.
     * Useful for reconstructing client state or testing.
     *
     * @param {Object} clientObj - The client object to add.
     * @param {net.Socket|tls.TLSSocket} clientObj.socket - The socket for the client.
     * @param {string} clientObj.workerName - The worker name.
     * @param {string} clientObj.workerPass - The worker password.
     */
    manuallyAddStratumClient(clientObj) {
        const sid = this._handleNewClient(clientObj.socket);
        if (sid) {
            this.clients[sid].manuallyAuthClient(clientObj.workerName, clientObj.workerPass); this.clients[sid].manuallySetValues(clientObj);
        }
    }

    /**
     * Broadcasts extra nonce changes to clients that support it.
     * Can target specific clients or all clients, and optionally forces clean jobs.
     *
     * @param {Object} opts - Broadcast options.
     * @param {Array<string>} [opts.clientIds] - Specific client IDs to target (all clients if omitted).
     * @param {Function} [opts.extraNonce1Generator] - Function to generate new extra nonce 1 values.
     * @param {number} [opts.newExtraNonce2Size] - New extra nonce 2 size.
     * @param {boolean} [opts.forceCleanJobs] - Whether to send clean jobs after nonce change.
     * @param {Array} [opts.jobParams] - Job parameters for clean jobs.
     * @returns {Object} Result object with attempted, successful, and unsupported counts.
     */
    broadcastExtraNonceChange(opts) {
        opts = opts || {};
        const result = { attempted: 0, successful: 0, unsupported: [] };
        const targets = opts.clientIds ? opts.clientIds.map(id => this.clients[id]).filter(Boolean) : Object.values(this.clients);
        targets.forEach((c) => {
            result.attempted++;
            if (!c.supportsExtraNonceSubscription) {
                result.unsupported.push(c.subscriptionId || 'unknown'); return;
            }
            const newExtra = (typeof opts.extraNonce1Generator === 'function') ? opts.extraNonce1Generator(c.extraNonce1) : c.extraNonce1;
            const newSize = (typeof opts.newExtraNonce2Size !== 'undefined') ? opts.newExtraNonce2Size : c.extraNonce2Size;
            if (c.sendSetExtraNonce(newExtra, newSize)) {
                result.successful++;
                if (opts.forceCleanJobs && Array.isArray(opts.jobParams)) {
                    const j = opts.jobParams.slice(); j[8] = true; c.sendMiningJob(j);
                }
            }
        });
        this.emit('extranonceChangesBroadcast', result);
        return result;
    }
}

module.exports = { Server: StratumServer, Client: StratumClient };
