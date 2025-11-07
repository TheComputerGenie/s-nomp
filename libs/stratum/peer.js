/**
 * @fileoverview Peer-to-peer connection handler for Bitcoin-like cryptocurrency networks.
 * This module implements the Bitcoin P2P protocol to connect to network nodes and listen for
 * new blocks and transactions. It handles the low-level networking protocol including
 * message parsing, version handshake, and inventory message processing.
 * 
 * @author s-nomp Contributors
 * @version 1.0.0
 */

const net = require('net');
const crypto = require('crypto');
const events = require('events');

const util = require('../utils/util.js');

// Example of p2p in node from TheSeven: http://paste.pm/e54.js


/**
 * Creates a fixed-length buffer from a string, zero-padded if necessary.
 * This is used for creating protocol command strings that must be exactly 12 bytes.
 * 
 * @param {string} s - The string to convert to a buffer
 * @param {number} len - The desired length of the buffer
 * @returns {Buffer} A buffer of the specified length containing the string data
 */
const fixedLenStringBuffer = function (s, len) {
    const buff = Buffer.alloc(len);
    buff.fill(0);
    buff.write(s);
    return buff;
};

/**
 * Creates a 12-byte buffer for Bitcoin protocol command strings.
 * Bitcoin protocol commands are always exactly 12 bytes long, zero-padded.
 * 
 * @param {string} s - The command string (e.g., 'version', 'inv', 'ping')
 * @returns {Buffer} A 12-byte buffer containing the command string
 */
const commandStringBuffer = function (s) {
    return fixedLenStringBuffer(s, 12);
};

/**
 * Reads a specific amount of bytes from a flowing stream in an asynchronous manner.
 * This is essential for parsing Bitcoin protocol messages which have variable lengths.
 * The function accumulates data until the required amount is reached, then calls back
 * with the data and any excess bytes that were read.
 * 
 * @param {Stream} stream - The readable stream to read from (must emit 'data' events)
 * @param {number} amount - The exact number of bytes to read
 * @param {Buffer|null} preRead - Optional buffer containing data already read
 * @param {Function} callback - Called with (data, lopped) where data is the requested
 *                              bytes and lopped is any excess data read beyond amount
 */
const readFlowingBytes = function (stream, amount, preRead, callback) {
    // Initialize buffer with any pre-read data or empty buffer
    let buff = preRead ? preRead : Buffer.alloc(0);

    /**
     * Internal function to handle incoming data chunks
     * @param {Buffer} data - New data chunk from the stream
     */
    const readData = function (data) {
        // Concatenate new data with existing buffer
        buff = Buffer.concat([buff, data]);

        if (buff.length >= amount) {
            // We have enough data - extract what we need and save the rest
            const returnData = buff.slice(0, amount);
            const lopped = buff.length > amount ? buff.slice(amount) : null;
            callback(returnData, lopped);
        } else {
            // Not enough data yet - wait for more
            stream.once('data', readData);
        }
    };

    // Start the reading process with an empty buffer
    readData(Buffer.alloc(0));
};

/**
 * Peer class - Handles P2P connections to Bitcoin-like cryptocurrency network nodes.
 * This class manages the entire lifecycle of a P2P connection including connection
 * establishment, protocol handshake, message parsing, and event emission for
 * important network events like new blocks.
 * 
 * @class Peer
 * @extends EventEmitter
 * @param {Object} options - Configuration options for the peer connection
 * @param {Object} options.coin - Coin-specific configuration
 * @param {string} options.coin.peerMagic - Magic bytes for mainnet protocol messages
 * @param {string} options.coin.peerMagicTestnet - Magic bytes for testnet protocol messages
 * @param {Object} options.p2p - P2P connection configuration
 * @param {string} options.p2p.host - Host address to connect to
 * @param {number} options.p2p.port - Port number to connect to
 * @param {boolean} options.p2p.disableTransactions - Whether to disable transaction relay
 * @param {boolean} options.testnet - Whether to use testnet protocol
 * @param {number} options.protocolVersion - Bitcoin protocol version to use
 * @param {number} options.startHeight - Starting block height for sync
 * @param {Object} options.logger - Logger instance for error reporting
 * 
 * @emits Peer#connected - When successfully connected and handshake completed
 * @emits Peer#disconnected - When connection is lost after successful handshake
 * @emits Peer#connectionRejected - When connection attempt is rejected
 * @emits Peer#connectionFailed - When connection cannot be established
 * @emits Peer#blockFound - When a new block is announced by the peer
 * @emits Peer#peerMessage - When any message is received from peer
 * @emits Peer#sentMessage - When a message is sent to peer
 * @emits Peer#socketError - When a socket error occurs
 * @emits Peer#error - When a protocol error occurs
 */
const Peer = module.exports = function (options) {
    const _this = this;

    /** @type {net.Socket} TCP socket connection to the peer */
    let client;

    /** @type {number} Maximum number of connection attempts before giving up */
    const maxAttempts = 5;

    /** @type {number} Current connection attempt counter */
    let attemptCount = 0;

    /** @type {number} Milliseconds to wait between connection retries */
    const retryIntervalMs = 5000;

    /** @type {Buffer} Magic bytes for message headers (network-specific) */
    const magic = Buffer.from(options.testnet ? options.coin.peerMagicTestnet : options.coin.peerMagic, 'hex');

    /** @type {number} Magic bytes as 32-bit little-endian integer for fast comparison */
    const magicInt = magic.readUInt32LE(0);

    /** @type {boolean} Whether version acknowledgment has been received */
    let verack = false;

    /** @type {boolean} Whether the connection configuration is valid */
    let validConnectionConfig = true;

    /**
     * Inventory vector type codes as defined in Bitcoin protocol specification.
     * These codes identify the type of data being announced in inventory messages.
     * @see https://en.bitcoin.it/wiki/Protocol_specification#Inventory_Vectors
     * @type {Object.<string, number>}
     */
    const invCodes = {
        error: 0,    // Error condition
        tx: 1,       // Transaction hash
        block: 2     // Block hash
    };

    /** @type {Buffer} NODE_NETWORK services flag (value 1 packed as uint64 little-endian) */
    const networkServices = Buffer.from('0100000000000000', 'hex');

    /** @type {Buffer} Empty network address structure for version message */
    const emptyNetAddress = Buffer.from('010000000000000000000000000000000000ffff000000000000', 'hex');

    /** @type {Buffer} User agent string identifying this client */
    const userAgent = util.varStringBuffer('/node-stratum/');

    /** @type {Buffer} Starting block height for blockchain sync */
    const blockStartHeight = util.packUInt32LE(options.startHeight || 0);

    /**
     * Transaction relay flag for version message.
     * If protocol version is new enough, this flag controls whether the peer
     * should relay transactions to us. Outlined in BIP37.
     * @see https://github.com/bitcoin/bips/blob/master/bip-0037.mediawiki#extensions-to-existing-messages
     * @type {Buffer}
     */
    const relayTransactions = options.p2p.disableTransactions === true ? Buffer.from([false]) : Buffer.from([true]);

    /**
     * Bitcoin protocol command strings as 12-byte buffers.
     * These are used in message headers to identify message types.
     * @type {Object.<string, Buffer>}
     */
    const commands = {
        version: commandStringBuffer('version'),     // Version handshake message
        inv: commandStringBuffer('inv'),            // Inventory announcement message
        ping: commandStringBuffer('ping'),          // Ping message for keepalive
        verack: commandStringBuffer('verack'),      // Version acknowledgment
        addr: commandStringBuffer('addr'),          // Address announcement
        getblocks: commandStringBuffer('getblocks') // Request block hashes
    };


    /**
     * Initialize the peer connection immediately upon construction.
     * This IIFE (Immediately Invoked Function Expression) starts the connection process.
     */
    (function init() {
        Connect();
    })();


    /**
     * Establishes a TCP connection to the peer and sets up event handlers.
     * This function handles connection retry logic and emits appropriate events
     * based on connection success or failure states.
     * 
     * @private
     */
    function Connect() {
        // Increment attempt counter for retry logic
        attemptCount++;

        // Create TCP connection to the peer
        client = net.connect({
            host: options.p2p.host,
            port: options.p2p.port
        }, () => {
            // Connection established - send version message to start handshake
            SendVersion();
        });

        /**
         * Handle connection close events
         */
        client.on('close', () => {
            if (verack) {
                // We had a successful connection that was lost
                _this.emit('disconnected');
                verack = false;
                attemptCount = 0;
            } else if (validConnectionConfig) {
                // Connection was rejected during handshake - retry if attempts remain
                _this.emit('connectionRejected');
                if (attemptCount < maxAttempts) {
                    // Log retry attempt
                    if (options.logger && typeof options.logger.error === 'function') {
                        options.logger.error('Pool', 'P2P', '', `Retrying P2P connection attempt ${attemptCount} of ${maxAttempts} in 5 seconds...`);
                    } else {
                        console.error(`Retrying P2P connection attempt ${attemptCount} of ${maxAttempts} in 5 seconds...`);
                    }
                    // Schedule retry after delay
                    setTimeout(() => {
                        Connect();
                    }, retryIntervalMs);
                }
            }
        });

        /**
         * Handle socket errors
         */
        client.on('error', (e) => {
            if (e.code === 'ECONNREFUSED') {
                // Connection refused - likely invalid host/port configuration
                validConnectionConfig = false;
                _this.emit('connectionFailed');
            } else {
                // Other socket errors
                _this.emit('socketError', e);
            }
        });

        // Set up the message parsing system for this connection
        SetupMessageParser(client);
    }

    /**
     * Sets up the Bitcoin protocol message parser for the client connection.
     * This handles the continuous parsing of incoming data stream into discrete
     * protocol messages according to Bitcoin's message format specification.
     * 
     * Bitcoin message format:
     * - 4 bytes: Magic number (network identifier)
     * - 12 bytes: Command string (null-padded)
     * - 4 bytes: Payload length
     * - 4 bytes: Checksum (first 4 bytes of double SHA256 of payload)
     * - Variable: Payload data
     * 
     * @param {net.Socket} client - The TCP socket to parse messages from
     * @private
     */
    function SetupMessageParser(client) {
        /**
         * Recursive function to continuously read and parse messages from the stream.
         * This function reads the 24-byte header first, validates it, then reads
         * the payload based on the length specified in the header.
         * 
         * @param {Buffer|null} preRead - Any leftover data from previous message parsing
         */
        const beginReadingMessage = function (preRead) {
            // Read the 24-byte message header
            readFlowingBytes(client, 24, preRead, (header, lopped) => {
                // Extract and validate magic number (first 4 bytes)
                const msgMagic = header.readUInt32LE(0);
                if (msgMagic !== magicInt) {
                    _this.emit('error', 'bad magic number from peer');

                    // Attempt to resynchronize by finding the next valid magic number
                    while (header.readUInt32LE(0) !== magicInt && header.length >= 4) {
                        header = header.subarray(1);
                    }

                    // Continue parsing with the synchronized position
                    if (header.readUInt32LE(0) === magicInt) {
                        beginReadingMessage(header);
                    } else {
                        beginReadingMessage(Buffer.alloc(0));
                    }
                    return;
                }

                // Extract message components from header
                const msgCommand = header.subarray(4, 16).toString();  // Command string (bytes 4-15)
                const msgLength = header.readUInt32LE(16);             // Payload length (bytes 16-19)
                const msgChecksum = header.readUInt32LE(20);           // Checksum (bytes 20-23)

                // Read the payload based on the length specified in header
                readFlowingBytes(client, msgLength, lopped, (payload, lopped) => {
                    // Verify payload integrity using double SHA256 checksum
                    if (util.sha256d(payload).readUInt32LE(0) !== msgChecksum) {
                        _this.emit('error', 'bad payload - failed checksum');
                        beginReadingMessage(null);
                        return;
                    }

                    // Process the validated message
                    HandleMessage(msgCommand, payload);

                    // Continue parsing any remaining data
                    beginReadingMessage(lopped);
                });
            });
        };

        // Start the message parsing loop
        beginReadingMessage(null);
    }


    /**
     * Handles inventory (inv) messages from peers.
     * Inventory messages announce available data (transactions, blocks) that the peer has.
     * This function parses the variable-length list of inventory vectors and emits
     * events for blocks (which are important for mining pool operations).
     * 
     * @see https://en.bitcoin.it/wiki/Protocol_specification#inv
     * @param {Buffer} payload - The inv message payload containing inventory vectors
     * @private
     */
    function HandleInv(payload) {
        // Parse the count of inventory items using simplified varint decoding
        // Note: This is a simplified implementation that handles most common cases
        let count = payload.readUInt8(0);
        payload = payload.subarray(1);

        // Handle extended varint encoding for counts >= 253
        if (count >= 0xfd) {
            count = payload.readUInt16LE(0);
            payload = payload.subarray(2);
        }

        // Process each inventory vector in the list
        while (count--) {
            // Each inventory vector is 36 bytes: 4 bytes type + 32 bytes hash
            const invType = payload.readUInt32LE(0);
            const hashBytes = payload.subarray(4, 36);

            switch (invType) {
                case invCodes.error:
                    // Error condition - typically ignored
                    break;

                case invCodes.tx:
                    // Transaction announcement - extract hash but don't emit event
                    // (transactions are typically not needed for mining pool operations)
                    const tx = hashBytes.toString('hex');
                    break;

                case invCodes.block:
                    // Block announcement - this is what mining pools care about!
                    const block = hashBytes.toString('hex');
                    _this.emit('blockFound', block);
                    break;
            }

            // Move to the next inventory vector (36 bytes per item)
            payload = payload.subarray(36);
        }
    }

    /**
     * Handles incoming protocol messages based on their command type.
     * This is the main message dispatcher that routes different message types
     * to appropriate handlers and emits relevant events.
     * 
     * @param {string} command - The message command (e.g., 'inv', 'verack', 'ping')
     * @param {Buffer} payload - The message payload data
     * @private
     */
    function HandleMessage(command, payload) {
        // Emit a general message event for debugging/logging purposes
        _this.emit('peerMessage', { command: command, payload: payload });

        // Route message to appropriate handler based on command type
        switch (command) {
            case commands.inv.toString():
                // Inventory message - announces available transactions/blocks
                HandleInv(payload);
                break;

            case commands.verack.toString():
                // Version acknowledgment - completes the handshake process
                if (!verack) {
                    verack = true;           // Mark handshake as complete
                    attemptCount = 0;       // Reset retry counter
                    _this.emit('connected'); // Notify that we're fully connected
                }
                break;

            case commands.ping.toString():
                /**
                 * Ping message handler - Critical for connection keepalive and peer health monitoring.
                 * 
                 * The ping/pong mechanism was introduced in Bitcoin protocol version 60000 (circa 2012)
                 * as part of BIP 31 to improve network connectivity and detect dead connections.
                 * This implements a standard network keepalive pattern similar to ICMP ping/pong
                 * but at the application layer within the Bitcoin P2P protocol.
                 * 
                 * RFC Context: While not defined in a specific RFC, this follows the same principles
                 * as RFC 792 (ICMP) from 1981, adapted for Bitcoin's peer-to-peer network.
                 * The implementation mirrors standard network keepalive mechanisms found in
                 * TCP (RFC 1122, 1989) and other networking protocols.
                 * 
                 * Importance of Ping/Pong:
                 * 1. Connection Liveness: Ensures the peer is still responsive and connected
                 * 2. Network Health: Helps detect network partitions or connection issues
                 * 3. Resource Management: Allows cleanup of dead connections to free resources
                 * 4. Latency Measurement: Can be used to measure round-trip times to peers
                 * 5. Protocol Compliance: Required by Bitcoin protocol specification for proper peer behavior
                 * 
                 * Without proper ping/pong handling, connections may appear active when they're
                 * actually dead, leading to:
                 * - Missed block announcements (critical for mining pools)
                 * - Resource leaks from zombie connections
                 * - Network topology issues
                 * - Reduced mining efficiency due to stale connections
                 * 
                 * The payload contains a nonce that must be echoed back in the pong response
                 * to prove the peer actually processed the ping message.
                 */
                // Send pong response with the same payload (nonce) that was sent in ping
                SendMessage(commandStringBuffer('pong'), payload);
                break;

            default:
                // Unknown or unhandled message types are silently ignored
                break;
        }
    }

    /**
     * Sends a protocol message to the peer following Bitcoin's message structure.
     * Constructs a complete message with header and payload, then sends it over the socket.
     * 
     * Message structure defined at: https://en.bitcoin.it/wiki/Protocol_specification#Message_structure
     * - 4 bytes: Magic number (network identifier)
     * - 12 bytes: Command string (null-padded)
     * - 4 bytes: Payload length (little-endian)
     * - 4 bytes: Checksum (first 4 bytes of double SHA256 of payload)
     * - Variable: Payload data
     * 
     * @param {Buffer} command - The 12-byte command buffer (e.g., from commandStringBuffer())
     * @param {Buffer} payload - The message payload data
     * @private
     */
    function SendMessage(command, payload) {
        // Construct the complete message with all required components
        const message = Buffer.concat([
            magic,                                          // Network magic bytes
            command,                                        // Command string (12 bytes)
            util.packUInt32LE(payload.length),            // Payload length
            util.sha256d(payload).subarray(0, 4),         // Checksum (first 4 bytes of double SHA256)
            payload                                         // The actual payload data
        ]);

        // Send the message over the TCP connection
        client.write(message);

        // Emit event for debugging/logging purposes
        _this.emit('sentMessage', message);
    }

    /**
     * Sends the version message to initiate the Bitcoin protocol handshake.
     * This is the first message sent when connecting to a peer and contains
     * information about our client capabilities and network configuration.
     * 
     * The version message structure includes:
     * - Protocol version number
     * - Services we support (NODE_NETWORK)
     * - Current timestamp
     * - Network addresses (can be empty for basic operation)
     * - Random nonce for connection identification
     * - User agent string identifying our software
     * - Starting block height for sync purposes
     * - Transaction relay preference flag
     * 
     * @private
     */
    function SendVersion() {
        // Construct the version message payload according to protocol specification
        const payload = Buffer.concat([
            util.packUInt32LE(options.protocolVersion),    // Protocol version we support
            networkServices,                               // Services flags (NODE_NETWORK = 1)
            util.packInt64LE(Date.now() / 1000 | 0),      // Current timestamp (seconds since epoch)
            emptyNetAddress,                               // addr_recv - receiving node address (can be empty)
            emptyNetAddress,                               // addr_from - sending node address (can be empty)
            crypto.pseudoRandomBytes(8),                   // nonce - random 8-byte connection identifier
            userAgent,                                     // User agent string (/node-stratum/)
            blockStartHeight,                              // Starting block height for sync
            relayTransactions                              // Whether to relay transactions to us
        ]);

        // Send the constructed version message
        SendMessage(commands.version, payload);
    }

};

/**
 * Make Peer inherit from EventEmitter to enable event-driven architecture.
 * This allows the Peer class to emit events like 'connected', 'blockFound', etc.
 * and enables other parts of the application to listen for these events.
 */
Peer.prototype.__proto__ = events.EventEmitter.prototype;
