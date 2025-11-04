/*
 * stratumV25.js
 *
 * A ground-up implementation of the Stratum v1 protocol server/client
 * primitives used by the pool.
 */

const net = require('net');
const tls = require('tls');
const fs = require('fs');
const EventEmitter = require('events');
const util = require('./util.js');

// --- small helpers kept private to this file ---
const isString = (v) => typeof v === 'string';
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

function sanitizeWorkerName(name) {
    if (name === undefined || name === null) {
        return '';
    }
    return String(name).replace(/[^A-Za-z0-9.]/g, '');
}

function createSubscriptionCounter(poolId = '') {
    let n = 0;
    const base = 'deadbeefcafebabe';
    const seed = (base + poolId).slice(0, base.length);
    return {
        next() {
            n += 1;
            return seed + util.packInt64LE(n).toString('hex');
        }
    };
}

// JSON line framing helper
function frameJson(...objs) {
    return `${objs.map(o => JSON.stringify(o)).join('\n')}\n`;
}

// --- StratumClient: per-socket logic ---
class StratumClient extends EventEmitter {
    constructor(opts) {
        super();
        if (!opts || !opts.socket) {
            throw new TypeError('socket required');
        }
        this.socket = opts.socket;
        this.subscriptionId = opts.subscriptionId;
        this.authorizeFn = opts.authorizeFn || ((...a) => a[a.length - 1]({ authorized: true }));
        this.algos = opts.algos || {};
        this.algorithm = opts.algorithm;
        this.banning = opts.banning || { enabled: false };
        this.connectionTimeout = opts.connectionTimeout || 600;
        this.tcpProxyProtocol = !!opts.tcpProxyProtocol;

        // state
        this.extraNonce1 = null;
        this.extraNonce2Size = 0;
        this.supportsExtraNonceSubscription = false;
        this.authorized = null;
        this.workerName = null;
        this.workerPass = null;
        this.shares = { valid: 0, invalid: 0 };
        this.lastActivity = Date.now();
        this._pendingDifficulty = null;

        this._buffer = '';
        this._setupSocket();
    }

    _setupSocket() {
        const s = this.socket;
        try {
            s.setEncoding('utf8');
        } catch (e) { }

        if (this.tcpProxyProtocol) {
            s.once('data', (d) => {
                if (isString(d) && d.startsWith('PROXY')) {
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

        s.on('data', (chunk) => this._onData(chunk));
        s.on('close', () => this.emit('socketDisconnect'));
        s.on('error', (err) => {
            if (err && err.code !== 'ECONNRESET') {
                this.emit('socketError', err);
            }
        });
    }

    _onData(chunk) {
        this._buffer += chunk;
        // flood protection
        if (Buffer.byteLength(this._buffer, 'utf8') > 10 * 1024) {
            this._buffer = '';
            this.emit('socketFlooded');
            try {
                this.socket.destroy();
            } catch (e) { }
            return;
        }

        // process newline-delimited JSON
        let idx;
        while ((idx = this._buffer.indexOf('\n')) !== -1) {
            const line = this._buffer.slice(0, idx).trim();
            this._buffer = this._buffer.slice(idx + 1);
            if (!line) {
                continue;
            }
            let msg;
            try {
                msg = JSON.parse(line);
            } catch (err) {
                this.emit('malformedMessage', line);
                try {
                    this.socket.destroy();
                } catch (e) { }
                return;
            }
            this._handleMessage(msg);
        }
    }

    _send(...objs) {
        if (!this.socket || !this.socket.writable) {
            return;
        }
        this.socket.write(frameJson(...objs));
    }

    _handleMessage(msg) {
        if (!msg || !msg.method) {
            return;
        }
        const id = msg.id;
        switch (msg.method) {
            case 'mining.subscribe':
                this.emit('subscription', {}, (err, extraNonce1) => {
                    if (err) {
                        return this._send({ id, result: null, error: err });
                    }
                    this.extraNonce1 = extraNonce1;
                    this._send({ id, result: [[['mining.set_difficulty', this.subscriptionId], ['mining.notify', this.subscriptionId]], extraNonce1, this.extraNonce2Size], error: null });
                });
                break;
            case 'mining.extranonce.subscribe':
                this.supportsExtraNonceSubscription = true;
                this._send({ id, result: true, error: null });
                this.emit('extranonceSubscribed', { subscriptionId: this.subscriptionId, remoteAddress: this.remoteAddress, workerName: this.workerName });
                break;
            case 'mining.authorize':
                this.workerName = sanitizeWorkerName((msg.params && msg.params[0]) || '');
                this.workerPass = (msg.params && msg.params[1]) || '';
                const addr = (this.workerName || '').split('.')[0];
                this.authorizeFn(this.remoteAddress, this.socket.localPort, addr, this.workerPass, (res) => {
                    this.authorized = !!(res && res.authorized);
                    this._send({ id, result: this.authorized, error: res && res.error });
                    if (res && res.disconnect) {
                        try {
                            this.socket.destroy();
                        } catch (e) { }
                    }
                });
                break;
            case 'mining.submit':
                this.lastActivity = Date.now();
                if (!this.workerName) {
                    this.workerName = sanitizeWorkerName((msg.params && msg.params[0]) || '');
                }
                if (this.authorized === false) {
                    this._send({ id, result: null, error: [24, 'unauthorized worker', null] });
                    this._considerBan(false);
                    break;
                }
                if (!this.extraNonce1) {
                    this._send({ id, result: null, error: [25, 'not subscribed', null] }); this._considerBan(false); break;
                }
                {
                    const p = msg.params || [];
                    const payload = { name: this.workerName, jobId: p[1], nTime: p[2], extraNonce2: p[3], soln: p[4], nonce: (this.extraNonce1 || '') + (p[3] || '') };
                    this.emit('submit', payload, (error, result) => {
                        if (!this._considerBan(result)) {
                            this._send({ id, result, error });
                        }
                    });
                }
                break;
            case 'mining.get_transactions':
                this._send({ id: null, result: [], error: true });
                break;
            default:
                this.emit('unknownStratumMethod', msg);
        }
    }

    _considerBan(valid) {
        if (!this.banning || !this.banning.enabled) {
            return false;
        }
        if (valid) {
            this.shares.valid++;
        } else {
            this.shares.invalid++;
        }
        const total = this.shares.valid + this.shares.invalid;
        if (total >= (this.banning.checkThreshold || 100)) {
            const bad = (this.shares.invalid / total) * 100;
            if (bad >= (this.banning.invalidPercent || 50)) {
                this.emit('triggerBan', `${this.shares.invalid}/${total}`);
                try {
                    this.socket.destroy();
                } catch (e) { }
                return true;
            }
            this.shares = { valid: 0, invalid: 0 };
        }
        return false;
    }

    getLabel() {
        return `${this.workerName || '(unauthorized)'} [${this.remoteAddress}]`;
    }

    enqueueNextDifficulty(d) {
        this._pendingDifficulty = d; return true;
    }

    sendDifficulty(d) {
        if (this.difficulty === d) {
            return false;
        }
        this.previousDifficulty = this.difficulty;
        this.difficulty = d;
        const algo = this.algos[this.algorithm] || {};
        const powLimit = algo.diff || 0;
        const adj = powLimit / d || 0;
        let hex = Math.floor(adj).toString(16);
        if (hex.length < 64) {
            hex = '0'.repeat(64 - hex.length) + hex;
        }
        this._send({ id: null, method: 'mining.set_target', params: [hex] });
        return true;
    }

    sendMiningJob(jobParams) {
        if (Date.now() - this.lastActivity > this.connectionTimeout * 1000) {
            try {
                this.socket.destroy();
            } catch (e) { }
            return;
        }
        if (this._pendingDifficulty !== null) {
            const changed = this.sendDifficulty(this._pendingDifficulty);
            this._pendingDifficulty = null;
            if (changed) {
                this.emit('difficultyChanged', this.difficulty);
            }
        }
        this._send({ id: null, method: 'mining.notify', params: jobParams });
    }

    sendSetExtraNonce(newExtra, newSize) {
        if (!this.supportsExtraNonceSubscription) {
            return false;
        }
        this.extraNonce1 = newExtra;
        this.extraNonce2Size = newSize;
        this._send({ id: null, method: 'mining.set_extranonce', params: [newExtra, newSize] });
        this.emit('extranonceChanged', { extraNonce1: newExtra, extraNonce2Size: newSize });
        return true;
    }

    manuallyAuthClient(u, p) {
        this._handleMessage({ id: 1, method: 'mining.authorize', params: [u, p] });
    }
    manuallySetValues(other) {
        if (isObject(other)) {
            this.extraNonce1 = other.extraNonce1; this.previousDifficulty = other.previousDifficulty; this.difficulty = other.difficulty;
        }
    }
}

// --- StratumServer: manages connections ---
class StratumServer extends EventEmitter {
    constructor(options = {}, authorizeFn, algos = {}) {
        super();
        this.options = options || {};
        this.authorizeFn = authorizeFn || ((...a) => a[a.length - 1]({ authorized: true }));
        this.algos = algos || {};
        this.counter = createSubscriptionCounter(this.options.poolId || '');
        this.clients = new Map(); // subscriptionId -> StratumClient
        this.bannedIPs = {};
        this._rebroadcastTimer = null;
        this._init();
    }

    _init() {
        const banning = this.options.banning || { enabled: false };
        if (banning.enabled) {
            setInterval(() => {
                Object.keys(this.bannedIPs).forEach(ip => {
                    if (Date.now() - this.bannedIPs[ip] > (banning.time || 600) * 1000) {
                        delete this.bannedIPs[ip];
                    }
                });
            }, 1000 * (banning.purgeInterval || 300));
        }

        let tlsOpts = null;
        if (this.options.tlsOptions && (this.options.tlsOptions.enabled === true || this.options.tlsOptions.enabled === 'true')) {
            tlsOpts = { key: fs.readFileSync(this.options.tlsOptions.serverKey), cert: fs.readFileSync(this.options.tlsOptions.serverCert), requestCert: true };
        }

        const ports = this.options.ports || {};
        const keys = Object.keys(ports);
        let started = 0;
        keys.forEach((p) => {
            const cfg = ports[p];
            const port = parseInt(p, 10);
            if (!cfg || cfg.tls === false || cfg.tls === 'false') {
                const srv = net.createServer({ allowHalfOpen: false }, (socket) => this._accept(socket));
                srv.listen(port, () => {
                    started++; if (started === keys.length) {
                        this.emit('started');
                    }
                });
            } else {
                const srv = tls.createServer(tlsOpts, (socket) => this._accept(socket));
                srv.listen(port, () => {
                    started++; if (started === keys.length) {
                        this.emit('started');
                    }
                });
            }
        });
    }

    _accept(socket) {
        try {
            socket.setKeepAlive(true);
        } catch (e) { }
        const sid = this.counter.next();
        const conn = new StratumClient({ socket, subscriptionId: sid, authorizeFn: this.authorizeFn, banning: this.options.banning, connectionTimeout: this.options.connectionTimeout, tcpProxyProtocol: this.options.tcpProxyProtocol, algos: this.algos, algorithm: this.options.algorithm });
        this.clients.set(sid, conn);
        this.emit('client.connected', conn);

        conn.on('socketDisconnect', () => {
            this.removeStratumClientBySubId(sid); this.emit('client.disconnected', conn);
        })
            .on('checkBan', () => this._checkBan(conn))
            .on('triggerBan', () => this.addBannedIP(conn.remoteAddress));

        return sid;
    }

    _checkBan(conn) {
        const banning = this.options.banning || { enabled: false };
        if (!banning.enabled) {
            return;
        }
        if (banning.banned && banning.banned.indexOf(conn.remoteAddress) !== -1) {
            conn.socket.destroy(); conn.emit('kickedBannedIP', 9999999); return;
        }
        if (this.bannedIPs[conn.remoteAddress]) {
            const since = Date.now() - this.bannedIPs[conn.remoteAddress];
            const left = (banning.time * 1000) - since;
            if (left > 0) {
                conn.socket.destroy(); conn.emit('kickedBannedIP', Math.floor(left / 1000));
            } else {
                delete this.bannedIPs[conn.remoteAddress]; conn.emit('forgaveBannedIP');
            }
        }
    }

    broadcastMiningJobs(jobParams) {
        for (const conn of this.clients.values()) {
            try {
                conn.sendMiningJob(jobParams);
            } catch (e) { }
        }
        clearTimeout(this._rebroadcastTimer);
        this._rebroadcastTimer = setTimeout(() => this.emit('broadcastTimeout'), (this.options.jobRebroadcastTimeout || 55) * 1000);
    }

    addBannedIP(ip) {
        this.bannedIPs[ip] = Date.now();
    }
    getStratumClients() {
        const obj = {};
        for (const [k, v] of this.clients.entries()) {
            obj[k] = v;
        }
        return obj;
    }
    removeStratumClientBySubId(subId) {
        this.clients.delete(subId);
    }

    manuallyAddStratumClient(clientObj) {
        const sid = this._accept(clientObj.socket);
        if (sid) {
            const c = this.clients.get(sid); c.manuallyAuthClient(clientObj.workerName, clientObj.workerPass); c.manuallySetValues(clientObj);
        }
    }

    broadcastExtraNonceChange(opts = {}) {
        const result = { attempted: 0, successful: 0, unsupported: [] };
        const targets = Array.isArray(opts.clientIds) ? opts.clientIds.map(id => this.clients.get(id)).filter(Boolean) : Array.from(this.clients.values());
        for (const c of targets) {
            result.attempted++;
            if (!c.supportsExtraNonceSubscription) {
                result.unsupported.push(c.subscriptionId || 'unknown'); continue;
            }
            const newExtra = (typeof opts.extraNonce1Generator === 'function') ? opts.extraNonce1Generator(c.extraNonce1) : c.extraNonce1;
            const newSize = (typeof opts.newExtraNonce2Size !== 'undefined') ? opts.newExtraNonce2Size : c.extraNonce2Size;
            if (c.sendSetExtraNonce(newExtra, newSize)) {
                result.successful++;
                if (opts.forceCleanJobs && Array.isArray(opts.jobParams)) {
                    const j = opts.jobParams.slice(); j[8] = true; c.sendMiningJob(j);
                }
            }
        }
        this.emit('extranonceChangesBroadcast', result);
        return result;
    }
}

module.exports = { Server: StratumServer, Client: StratumClient };
