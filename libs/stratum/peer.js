/**
 * @fileoverview Peer - Bitcoin P2P network peer connection
 *
 * Manages connections to Bitcoin network peers for receiving block and transaction
 * notifications via the P2P protocol.
 *
 * @author ComputerGenieCo
 * @version 21.7.3
 * @copyright 2025
 */
'use strict';

const crypto = require('crypto');
const events = require('events');
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const util = require('../utils/util.js');

/**
 * Peer
 *
 * Manages a connection to a Bitcoin P2P network peer. Handles the Bitcoin protocol
 * handshake, message parsing, and emits events for blocks and transactions.
 *
 * Events emitted:
 * - 'connected' - When the peer handshake is complete
 * - 'disconnected' - When the peer connection is closed
 * - 'connectionRejected' - When connection is rejected
 * - 'connectionFailed' - When connection fails
 * - 'socketError' (error) - On socket errors
 * - 'peerMessage' ({command, payload}) - For all received messages
 * - 'transactionReceived' (txHash) - When a new transaction is announced
 * - 'blockFound' (blockHash) - When a new block is announced
 * - 'sentMessage' (message) - When a message is sent
 * - 'error' (message) - On protocol errors
 *
 * @class Peer
 * @extends events.EventEmitter
 * @param {Object} options - Configuration options
 * @param {Object} options.coin - Coin configuration
 * @param {string} options.coin.peerMagic - Mainnet peer magic bytes
 * @param {string} options.coin.peerMagicTestnet - Testnet peer magic bytes
 * @param {boolean} options.testnet - Whether to use testnet
 * @param {number} options.protocolVersion - Bitcoin protocol version
 * @param {number} options.startHeight - Starting block height
 * @param {Object} options.p2p - P2P connection options
 * @param {string} options.p2p.host - Peer host
 * @param {number} options.p2p.port - Peer port
 * @param {boolean} options.p2p.disableTransactions - Whether to disable transaction relay
 * @param {Object} options.logger - Logger instance
 * @param {Object} options.tlsOptions - TLS configuration options
 */
class Peer extends events.EventEmitter {
    #client = null;
    #verack = false;
    #attemptCount = 0;
    #validConnectionConfig = true;

    constructor(options) {
        super();
        this.options = options;
        this.tlsOptions = options.tlsOptions;

        this.maxAttempts = 5;
        this.retryIntervalMs = 5000;

        this.magic = Buffer.from(options.testnet ? options.coin.peerMagicTestnet : options.coin.peerMagic, 'hex');
        this.magicInt = this.magic.readUInt32LE(0);
        this.invCodes = { error: 0, tx: 1, block: 2 };
        this.networkServices = Buffer.from('0100000000000000', 'hex');
        this.emptyNetAddress = Buffer.from('010000000000000000000000000000000000ffff000000000000', 'hex');
        this.userAgent = util.varStringBuffer('FixYourPaddingFekers');
        this.blockStartHeight = util.packUInt32LE(options.startHeight - 1);

        this.relayTransactions = options.p2p.disableTransactions === true ? Buffer.from([false]) : Buffer.from([true]);
        this.commands = {
            version: this.#commandStringBuffer('version'),
            inv: this.#commandStringBuffer('inv'),
            ping: this.#commandStringBuffer('ping'),
            verack: this.#commandStringBuffer('verack'),
            addr: this.#commandStringBuffer('addr'),
            getblocks: this.#commandStringBuffer('getblocks')
        };

        this.connect();
    }

    #readFlowingBytes(stream, amount, preRead, callback) {
        let buff = preRead ? preRead : Buffer.alloc(0);

        const readData = function (data) {
            buff = Buffer.concat([buff, data]);

            if (buff.length >= amount) {
                const returnData = buff.slice(0, amount);
                const lopped = buff.length > amount ? buff.slice(amount) : null;
                callback(returnData, lopped);
            } else {
                stream.once('data', readData);
            }
        };

        readData(Buffer.alloc(0));
    }

    #fixedLenStringBuffer(s, len) {
        const buff = Buffer.alloc(len);
        buff.fill(0);
        buff.write(s);
        return buff;
    }

    #commandStringBuffer(s) {
        return this.#fixedLenStringBuffer(s, 12);
    }

    /**
     * Initiates connection to the peer.
     * @returns {void}
     */
    connect() {
        this.#attemptCount++;
        if (this.tlsOptions && this.tlsOptions.enabled) {
            // Validate certificate files
            try {
                if (!fs.existsSync(this.tlsOptions.serverKey)) {
                    throw new Error('serverKey file not found');
                }
                if (!fs.existsSync(this.tlsOptions.serverCert)) {
                    throw new Error('serverCert file not found');
                }
                if (this.tlsOptions.ca && !fs.existsSync(this.tlsOptions.ca)) {
                    throw new Error('ca file not found');
                }
            } catch (err) {
                this.emit('error', `TLS certificate validation failed: ${err.message}`);
                this.#validConnectionConfig = false;
                return;
            }

            const tlsOpts = {
                host: this.options.p2p.host,
                port: this.options.p2p.port,
                key: fs.readFileSync(this.tlsOptions.serverKey),
                cert: fs.readFileSync(this.tlsOptions.serverCert),
                ca: this.tlsOptions.ca ? fs.readFileSync(this.tlsOptions.ca) : undefined,
                rejectUnauthorized: false
            };

            this.#client = tls.connect(tlsOpts, () => this.sendVersion());

            if (this.options.logger) {
                this.options.logger.debug('Pool', 'P2P', 'TLS', `Connecting to peer via TLS: ${this.options.p2p.host}:${this.options.p2p.port}`);
            }
        } else {
            this.#client = net.connect({
                host: this.options.p2p.host,
                port: this.options.p2p.port
            }, () => this.sendVersion());
        }

        this.#client.on('close', () => {
            if (this.#verack) {
                this.emit('disconnected');
                this.#verack = false;
                this.#attemptCount = 0;
            } else if (this.#validConnectionConfig) {
                this.emit('connectionRejected');
                if (this.#attemptCount < this.maxAttempts) {
                    if (this.options.logger && typeof this.options.logger.error === 'function') {
                        this.options.logger.error('Pool', 'P2P', '', `Retrying P2P connection attempt ${this.#attemptCount} of ${this.maxAttempts} in 5 seconds...`);
                    } else {
                        console.error(`Retrying P2P connection attempt ${this.#attemptCount} of ${this.maxAttempts} in 5 seconds...`);
                    }
                    setTimeout(() => this.connect(), this.retryIntervalMs);
                }
            }
        });

        this.#client.on('error', (e) => {
            if (e.code === 'ECONNREFUSED') {
                this.#validConnectionConfig = false;
                this.emit('connectionFailed');
            } else {
                this.emit('socketError', e);
            }
        });

        this.setupMessageParser(this.#client);
    }

    /**
     * Sets up the message parser for the client socket.
     * @param {net.Socket} client - The client socket
     * @returns {void}
     */
    setupMessageParser(client) {
        const beginReadingMessage = (preRead) => {
            this.#readFlowingBytes(client, 24, preRead, (header, lopped) => {
                const msgMagic = header.readUInt32LE(0);
                if (msgMagic !== this.magicInt) {
                    this.emit('error', 'bad magic number from peer');
                    while (header.readUInt32LE(0) !== this.magicInt && header.length >= 4) {
                        header = header.subarray(1);
                    }
                    if (header.readUInt32LE(0) === this.magicInt) {
                        beginReadingMessage(header);
                    } else {
                        beginReadingMessage(Buffer.alloc(0));
                    }
                    return;
                }
                const msgCommand = header.subarray(4, 16).toString();
                const msgLength = header.readUInt32LE(16);
                const msgChecksum = header.readUInt32LE(20);
                this.#readFlowingBytes(client, msgLength, lopped, (payload, lopped2) => {
                    if (util.sha256d(payload).readUInt32LE(0) !== msgChecksum) {
                        this.emit('error', 'bad payload - failed checksum');
                        beginReadingMessage(null);
                        return;
                    }
                    this.handleMessage(msgCommand, payload);
                    beginReadingMessage(lopped2);
                });
            });
        };
        beginReadingMessage(null);
    }

    /**
     * Handles an inventory message from the peer.
     * @param {Buffer} payload - The message payload
     * @returns {void}
     */
    handleInv(payload) {
        let count = payload.readUInt8(0);
        payload = payload.subarray(1);
        if (count >= 0xfd) {
            count = payload.readUInt16LE(0);
            payload = payload.subarray(2);
        }
        while (count--) {
            const invType = payload.readUInt32LE(0);
            const hashBytes = payload.subarray(4, 36);
            switch (invType) {
                case this.invCodes.error: break;
                case this.invCodes.tx: {
                    const tx = hashBytes.toString('hex');
                    this.emit('transactionReceived', tx);
                    break;
                }
                case this.invCodes.block: {
                    const block = hashBytes.toString('hex');
                    this.emit('blockFound', block);
                    break;
                }
            }
            payload = payload.subarray(36);
        }
    }

    /**
     * Handles a message received from the peer.
     * @param {string} command - The message command
     * @param {Buffer} payload - The message payload
     * @returns {void}
     */
    handleMessage(command, payload) {
        this.emit('peerMessage', { command, payload });
        switch (command) {
            case this.commands.inv.toString():
                this.handleInv(payload); break;
            case this.commands.verack.toString():
                if (!this.#verack) {
                    this.#verack = true;
                    this.#attemptCount = 0;
                    this.emit('connected');
                }
                break;
            case this.commands.ping.toString():
                this.sendMessage(this.#commandStringBuffer('pong'), payload);
                break;
            default: break;
        }
    }

    /**
     * Sends a message to the peer.
     * @param {Buffer} command - Command buffer
     * @param {Buffer} payload - Payload buffer
     * @returns {void}
     */
    sendMessage(command, payload) {
        if (!this.#client) {
            return;
        }
        const message = Buffer.concat([
            this.magic,
            command,
            util.packUInt32LE(payload.length),
            util.sha256d(payload).subarray(0, 4),
            payload
        ]);
        this.#client.write(message);
        this.emit('sentMessage', message);
    }

    /**
     * Sends the version handshake message.
     * @returns {void}
     */
    sendVersion() {
        if (!this.#client) {
            return;
        }
        const command = this.#commandStringBuffer('version');
        const payload = Buffer.concat([
            util.packUInt32LE(this.options.protocolVersion),
            this.networkServices,
            util.packInt64LE(Date.now() / 1000 | 0),
            this.emptyNetAddress,
            this.emptyNetAddress,
            crypto.pseudoRandomBytes(8),
            // Reserved bytes 80-100  - must be zero padded
            Buffer.alloc(20, 0),
            this.userAgent,
            this.blockStartHeight,
            this.relayTransactions
        ]);
        const message = Buffer.concat([
            this.magic,
            command,
            util.packUInt32LE(payload.length),
            util.sha256d(payload).subarray(0, 4),
            payload
        ]);
        this.#client.write(message);

        this.#client.once('error', err => this.emit('socketError', err));
    }

}

module.exports = Peer;
