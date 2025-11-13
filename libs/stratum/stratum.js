/**
 * Stratum protocol server and client
 *
 * Implements a Stratum TCP/TLS server and per-socket client handler used by
 * the pool to accept miner subscriptions, authorizations, and share submits.
 * Provides client management, difficulty updates, extranonce handling, and
 * basic banning/abuse protections.
 *
 * Events emitted by `StratumServer`:
 * - 'started' () - emitted when all configured ports are listening
 * - 'client.connected' (client) - a new client connected
 * - 'client.disconnected' (client) - a client disconnected
 * - 'extranonceChangesBroadcast' (result) - result of extranonce broadcast
 *
 * Events emitted by `StratumClient`:
 * - 'submit' (payload, callback)
 * - 'subscription' (opts, callback)
 * - 'socketDisconnect' ()
 * - 'socketError' (err)
 * - 'malformedMessage' (line)
 *
 * @fileoverview Stratum server and client implementation
 * @author ComputerGenieCo
 * @version 21.7.3
 * @copyright 2025
 */

const EventEmitter = require('events');
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const util = require('../utils/util.js');

function SubscriptionCounter(poolId) {
    let n = 0;
    const base = 'deadbeefcafebabe';
    const pad = (base + (poolId || '')).slice(0, base.length);
    return { next: () => pad + util.packInt64LE(++n).toString('hex') };
}

/**
 * StratumClient
 *
 * Handles a single miner TCP/TLS connection speaking the Stratum JSON-RPC
 * protocol. Responsible for parsing incoming JSON lines, subscription and
 * authorization handling, difficulty updates, extranonce management, and
 * submit forwarding.
 *
 * Events emitted:
 * - 'submit' (payload, callback)
 * - 'subscription' (opts, callback)
 * - 'socketDisconnect' ()
 * - 'socketError' (err)
 * - 'malformedMessage' (line)
 *
 * @class StratumClient
 * @extends EventEmitter
 * @param {Object} options - Connection options and callbacks
 * @param {string} options.subscriptionId - Unique subscription id for client
 * @param {Function} options.authorizeFn - Function to authorize worker names
 * @param {net.Socket|tls.TLSSocket} options.socket - Underlying socket
 */
class StratumClient extends EventEmitter {
    #authorizeFn;
    #socket;
    #banning;
    #connectionTimeout;
    #tcpProxyProtocol;
    #algos;
    #algorithm;
    #lastActivity;
    #shares;
    #previousDifficulty;
    #pendingDifficulty;
    #destroyed = false;

    constructor(options) {
        super();
        this.setMaxListeners(1000);
        this.subscriptionId = options.subscriptionId;
        this.#authorizeFn = options.authorizeFn;
        this.#socket = options.socket;
        this.#banning = options.banning;
        this.#connectionTimeout = options.connectionTimeout;
        this.#tcpProxyProtocol = options.tcpProxyProtocol;
        this.#algos = options.algos;
        this.#algorithm = options.algorithm;
        this.remoteAddress = this.#socket.remoteAddress;
        this.workerName = null;
        this.workerPass = null;
        this.authorized = false;
        this.#lastActivity = Date.now();
        this.#shares = { valid: 0, invalid: 0 };
        this.difficulty = 1;
        this.previousDifficulty = null;
        this.#pendingDifficulty = null;
        this.extraNonce1 = null;
        this.extraNonce2Size = 8;
        this.supportsExtraNonceSubscription = false;
        this.#setupSocket();
    }

    #setupSocket() {
        const s = this.#socket;
        s.setEncoding('utf8');
        let buffer = '';
        const onDataProxy = (d) => {
            if (d.indexOf && d.indexOf('PROXY') === 0) {
                const parts = d.split(' ');
                if (parts[2]) {
                    this.remoteAddress = parts[2];
                }
            } else {
                this.emit('tcpProxyError', d);
            }
            this.emit('checkBan');
        };
        if (this.#tcpProxyProtocol) {
            s.once('data', onDataProxy);
        } else {
            process.nextTick(() => this.emit('checkBan'));
        }

        s.on('data', (d) => {
            buffer += d;
            if (Buffer.byteLength(buffer, 'utf8') > 10 * 1024) {
                buffer = '';
                this.emit('socketFlooded');
                try {
                    s.destroy();
                } catch (e) { }
                return;
            }
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
                    this.emit('malformedMessage', line);
                    try {
                        s.destroy();
                    } catch (er) { }
                    return;
                }
                this.#handleMessage(obj);
            }
        });

        s.on('close', () => this.emit('socketDisconnect'));
        s.on('error', (err) => {
            if (err && err.code !== 'ECONNRESET') {
                this.emit('socketError', err);
            }
        });

        this.once('destroy', () => {
            try {
                s.removeListener('data', onDataProxy);
            } catch (e) { }
            try {
                s.destroy();
            } catch (e) { }
        });
    }

    #sendJson(...objs) {
        if (!this.#socket || !this.#socket.writable) {
            return;
        }
        const out = `${objs.map(o => JSON.stringify(o)).join('\n')}\n`;
        this.#socket.write(out);
    }

    #handleMessage(msg) {
        if (!msg || !msg.method) {
            return;
        }
        const id = msg.id;
        switch (msg.method) {
            case 'mining.subscribe':
                this.emit('subscription', {}, (err, extraNonce1) => {
                    if (err) {
                        return this.#sendJson({ id: id, result: null, error: err });
                    }
                    this.extraNonce1 = extraNonce1;
                    this.#sendJson({ id: id, result: [[['mining.set_difficulty', this.subscriptionId], ['mining.notify', this.subscriptionId]], extraNonce1, this.extraNonce2Size], error: null });
                });
                break;
            case 'mining.extranonce.subscribe':
                this.supportsExtraNonceSubscription = true;
                this.#sendJson({ id: id, result: true, error: null });
                this.emit('extranonceSubscribed', { subscriptionId: this.subscriptionId, remoteAddress: this.remoteAddress, workerName: this.workerName });
                break;
            case 'mining.authorize':
                this.workerName = util.safeString((msg.params && msg.params[0]) || '');
                this.workerPass = (msg.params && msg.params[1]) || '';
                const addr = (this.workerName || '').split('.')[0];
                this.#authorizeFn(this.remoteAddress, this.#socket.localPort, addr, this.workerPass, (res) => {
                    this.authorized = !!(res && res.authorized);
                    this.#sendJson({ id: id, result: this.authorized, error: res && res.error });
                    if (res && res.disconnect) {
                        try {
                            this.#socket.destroy();
                        } catch (e) { }
                    }
                });
                break;
            case 'mining.submit':
                this.#lastActivity = Date.now();
                if (!this.workerName) {
                    this.workerName = util.safeString((msg.params && msg.params[0]) || '');
                }
                if (this.authorized === false) {
                    this.#sendJson({ id: id, result: null, error: [24, 'unauthorized worker', null] });
                    this.#considerBan(false);
                    break;
                }
                if (!this.extraNonce1) {
                    this.#sendJson({ id: id, result: null, error: [25, 'not subscribed', null] }); this.#considerBan(false); break;
                }
                {
                    const p = msg.params || [];
                    const payload = { name: this.workerName, jobId: p[1], nTime: p[2], extraNonce2: p[3], soln: p[4], nonce: (this.extraNonce1 || '') + (p[3] || '') };
                    this.emit('submit', payload, (error, result) => {
                        if (!this.#considerBan(result)) {
                            this.#sendJson({ id: id, result: result, error: error });
                        }
                    });
                }
                break;
            case 'mining.get_transactions':
                this.#sendJson({ id: null, result: [], error: true });
                break;
            default:
                this.emit('unknownStratumMethod', msg);
        }
    }

    #considerBan(valid) {
        if (!this.#banning || !this.#banning.enabled) {
            return false;
        }
        if (valid) {
            this.#shares.valid++;
        } else {
            this.#shares.invalid++;
        }
        const tot = this.#shares.valid + this.#shares.invalid;
        if (tot >= (this.#banning.checkThreshold || 100)) {
            const bad = (this.#shares.invalid / tot) * 100;
            if (bad >= (this.#banning.invalidPercent || 50)) {
                this.emit('triggerBan', `${this.#shares.invalid}/${tot}`);
                try {
                    this.#socket.destroy();
                } catch (e) { }
                return true;
            }
            this.#shares = { valid: 0, invalid: 0 };
        }
        return false;
    }

    getLabel() {
        return `${this.workerName || '(unauthorized)'} [${this.remoteAddress}]`;
    }

    enqueueNextDifficulty(d) {
        this.#pendingDifficulty = d; return true;
    }

    sendDifficulty(d) {
        if (this.difficulty === d) {
            return false;
        }
        this.#previousDifficulty = this.difficulty;
        this.difficulty = d;
        const powLimit = this.#algos.getDiff(this.#algorithm) || 0;
        const adj = powLimit / d || 0;
        let hex = Math.floor(adj).toString(16);
        if (hex.length < 64) {
            hex = '0'.repeat(64 - hex.length) + hex;
        }
        this.#sendJson({ id: null, method: 'mining.set_target', params: [hex] });
        return true;
    }

    sendMiningJob(jobParams) {
        if (Date.now() - this.#lastActivity > this.#connectionTimeout * 1000) {
            try {
                this.#socket.destroy();
            } catch (e) { } return;
        }
        if (this.#pendingDifficulty !== null) {
            const r = this.sendDifficulty(this.#pendingDifficulty); this.#pendingDifficulty = null; if (r) {
                this.emit('difficultyChanged', this.difficulty);
            }
        }
        this.#sendJson({ id: null, method: 'mining.notify', params: jobParams });
    }

    sendSetExtraNonce(newExtra, newSize) {
        if (!this.supportsExtraNonceSubscription) {
            return false;
        }
        this.extraNonce1 = newExtra;
        this.extraNonce2Size = newSize;
        this.#sendJson({ id: null, method: 'mining.set_extranonce', params: [newExtra, newSize] });
        this.emit('extranonceChanged', { extraNonce1: newExtra, extraNonce2Size: newSize });
        return true;
    }

    manuallyAuthClient(u, p) {
        this.#handleMessage({ id: 1, method: 'mining.authorize', params: [u, p] });
    }

    manuallySetValues(other) {
        this.extraNonce1 = other.extraNonce1; this.previousDifficulty = other.previousDifficulty; this.difficulty = other.difficulty;
    }

    destroy() {
        if (this.#destroyed) {
            return;
        }
        this.#destroyed = true;
        try {
            if (this.#socket) {
                this.#socket.removeAllListeners();
                try {
                    this.#socket.destroy();
                } catch (e) { }
            }
        } catch (e) { }
        this.emit('destroy');
        this.removeAllListeners();
    }

    get socket() {
        return this.#socket;
    }
    get previousDiff() {
        return this.#previousDifficulty;
    }
}

/**
 * StratumServer
 *
 * Creates TCP/TLS listeners for configured ports and manages connected
 * `StratumClient` instances. Provides methods to broadcast jobs, update
 * extranonce values, and maintain a banned IP list.
 *
 * Events emitted:
 * - 'started' ()
 * - 'client.connected' (client)
 * - 'client.disconnected' (client)
 * - 'extranonceChangesBroadcast' (result)
 *
 * @class StratumServer
 * @extends EventEmitter
 * @param {Object} options - Server configuration options
 * @param {Function} authorizeFn - Authorization callback used for clients
 * @param {Object} algos - Algorithm helper with getDiff method
 */
class StratumServer extends EventEmitter {
    constructor(options, authorizeFn, algos) {
        super();
        this.options = options || {};
        this.authorizeFn = authorizeFn || function () {
            arguments[arguments.length - 1]({ authorized: true });
        };
        this.algos = algos;
        this.counter = SubscriptionCounter(this.options.poolId || '');
        this.clients = Object.create(null);
        this.bannedIPs = Object.create(null);
        this._servers = [];
        this._rebroadcastTimer = null;
        this._init();
    }

    _init() {
        const banning = this.options.banning || { enabled: false };
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
        if (this.options.tlsOptions && (this.options.tlsOptions.enabled === true || this.options.tlsOptions.enabled === 'true')) {
            try {
                tlsOptions = { key: fs.readFileSync(this.options.tlsOptions.serverKey), cert: fs.readFileSync(this.options.tlsOptions.serverCert), requestCert: true };
            } catch (e) {
                throw new Error(`Failed to read TLS key/cert: ${e.message}`);
            }
        }

        const ports = this.options.ports || {};
        const keys = Object.keys(ports);
        let started = 0;
        keys.forEach((p) => {
            const cfg = ports[p];
            const num = parseInt(p, 10);
            if (!cfg || cfg.tls === false || cfg.tls === 'false') {
                const srv = net.createServer({ allowHalfOpen: false }, (socket) => this._handleNewClient(socket));
                srv.listen(num, () => {
                    started++; if (started === keys.length) {
                        this.emit('started');
                    }
                });
                this._servers.push(srv);
            } else {
                const srv = tls.createServer(tlsOptions, (socket) => this._handleNewClient(socket));
                srv.listen(num, () => {
                    started++; if (started === keys.length) {
                        this.emit('started');
                    }
                });
                this._servers.push(srv);
            }
        });
    }

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

    _checkBan(client) {
        const banning = this.options.banning || { enabled: false };
        if (!banning.enabled) {
            return;
        }
        if (banning.banned && banning.banned.indexOf(client.remoteAddress) !== -1) {
            try {
                client.socket.destroy();
            } catch (e) { }
            client.emit('kickedBannedIP', 9999999); return;
        }
        if (this.bannedIPs[client.remoteAddress]) {
            const since = Date.now() - this.bannedIPs[client.remoteAddress];
            const left = (banning.time * 1000) - since;
            if (left > 0) {
                try {
                    client.socket.destroy();
                } catch (e) { }
                client.emit('kickedBannedIP', Math.floor(left / 1000));
            } else {
                delete this.bannedIPs[client.remoteAddress]; client.emit('forgaveBannedIP');
            }
        }
    }

    broadcastMiningJobs(jobParams) {
        Object.keys(this.clients).forEach((id) => {
            try {
                this.clients[id].sendMiningJob(jobParams);
            } catch (e) { }
        });
        clearTimeout(this._rebroadcastTimer);
        this._rebroadcastTimer = setTimeout(() => this.emit('broadcastTimeout'), (this.options.jobRebroadcastTimeout || 55) * 1000);
    }

    addBannedIP(ip) {
        this.bannedIPs[ip] = Date.now();
    }

    getStratumClients() {
        return this.clients;
    }

    removeStratumClientBySubId(subId) {
        if (this.clients[subId]) {
            try {
                this.clients[subId].destroy();
            } catch (e) { }
            delete this.clients[subId];
        }
    }

    manuallyAddStratumClient(clientObj) {
        const sid = this._handleNewClient(clientObj.socket);
        if (sid) {
            this.clients[sid].manuallyAuthClient(clientObj.workerName, clientObj.workerPass); this.clients[sid].manuallySetValues(clientObj);
        }
    }

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

    destroy() {
        try {
            Object.keys(this.clients).forEach((id) => {
                try {
                    this.clients[id].destroy();
                } catch (e) { }
                delete this.clients[id];
            });
        } catch (e) { }
        try {
            if (this._rebroadcastTimer) {
                clearTimeout(this._rebroadcastTimer);
            }
        } catch (e) { }
        try {
            this._servers.forEach((s) => {
                try {
                    s.close();
                } catch (e) { }
            });
            this._servers = [];
        } catch (e) { }
        this.removeAllListeners();
    }
}

module.exports = { Server: StratumServer, Client: StratumClient };
