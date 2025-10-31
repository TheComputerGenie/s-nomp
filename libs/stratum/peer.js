var net = require('net');
var crypto = require('crypto');
var events = require('events');

var util = require('./util.js');


//Example of p2p in node from TheSeven: http://paste.pm/e54.js


var fixedLenStringBuffer = function (s, len) {
    var buff = Buffer.alloc(len);
    buff.fill(0);
    buff.write(s);
    return buff;
};

var commandStringBuffer = function (s) {
    return fixedLenStringBuffer(s, 12);
};

/* Reads a set amount of bytes from a flowing stream, argument descriptions:
 - stream to read from, must have data emitter
 - amount of bytes to read
 - preRead argument can be used to set start with an existing data buffer
 - callback returns 1) data buffer and 2) lopped/over-read data */
var readFlowingBytes = function (stream, amount, preRead, callback) {

    var buff = preRead ? preRead : Buffer.alloc(0);

    var readData = function (data) {
        buff = Buffer.concat([buff, data]);
        if (buff.length >= amount) {
            var returnData = buff.slice(0, amount);
            var lopped = buff.length > amount ? buff.slice(amount) : null;
            callback(returnData, lopped);
        }
        else
            stream.once('data', readData);
    };

    readData(Buffer.alloc(0));
};

var Peer = module.exports = function (options) {

    var _this = this;
    var client;
    var maxAttempts = 5;
    var attemptCount = 0;
    var retryIntervalMs = 5000;
    var magic = Buffer.from(options.testnet ? options.coin.peerMagicTestnet : options.coin.peerMagic, 'hex');
    var magicInt = magic.readUInt32LE(0);
    var verack = false;
    var validConnectionConfig = true;

    //https://en.bitcoin.it/wiki/Protocol_specification#Inventory_Vectors
    var invCodes = {
        error: 0,
        tx: 1,
        block: 2
    };

    var networkServices = Buffer.from('0100000000000000', 'hex'); //NODE_NETWORK services (value 1 packed as uint64)
    var emptyNetAddress = Buffer.from('010000000000000000000000000000000000ffff000000000000', 'hex');
    var userAgent = util.varStringBuffer('/node-stratum/');
    var blockStartHeight = util.packUInt32LE(options.startHeight || 0); //block start_height

    //If protocol version is new enough, add do not relay transactions flag byte, outlined in BIP37
    //https://github.com/bitcoin/bips/blob/master/bip-0037.mediawiki#extensions-to-existing-messages
    var relayTransactions = options.p2p.disableTransactions === true ? Buffer.from([false]) : Buffer.from([true]);

    var commands = {
        version: commandStringBuffer('version'),
        inv: commandStringBuffer('inv'),
        ping: commandStringBuffer('ping'),
        verack: commandStringBuffer('verack'),
        addr: commandStringBuffer('addr'),
        getblocks: commandStringBuffer('getblocks')
    };


    (function init() {
        Connect();
    })();


    function Connect() {

        attemptCount++;
        client = net.connect({
            host: options.p2p.host,
            port: options.p2p.port
        }, function () {
            SendVersion();
        });
        client.on('close', function () {
            if (verack) {
                _this.emit('disconnected');
                verack = false;
                attemptCount = 0;
            } else if (validConnectionConfig) {
                _this.emit('connectionRejected');
                if (attemptCount < maxAttempts) {
                    if (options.logger && typeof options.logger.error === 'function') {
                        options.logger.error('Pool', 'P2P', '', 'Retrying P2P connection attempt ' + attemptCount + ' of ' + maxAttempts + ' in 5 seconds...');
                    } else {
                        console.error('Retrying P2P connection attempt ' + attemptCount + ' of ' + maxAttempts + ' in 5 seconds...');
                    }
                    setTimeout(function () {
                        Connect();
                    }, retryIntervalMs);
                }
            }
        });
        client.on('error', function (e) {
            if (e.code === 'ECONNREFUSED') {
                validConnectionConfig = false;
                _this.emit('connectionFailed');
            }
            else
                _this.emit('socketError', e);
        });

        SetupMessageParser(client);

    }

    function SetupMessageParser(client) {

        var beginReadingMessage = function (preRead) {

            readFlowingBytes(client, 24, preRead, function (header, lopped) {

                var msgMagic = header.readUInt32LE(0);
                if (msgMagic !== magicInt) {
                    _this.emit('error', 'bad magic number from peer');
                    while (header.readUInt32LE(0) !== magicInt && header.length >= 4) {
                        header = header.subarray(1);
                    }
                    if (header.readUInt32LE(0) === magicInt) {
                        beginReadingMessage(header);
                    } else {
                        beginReadingMessage(Buffer.alloc(0));
                    }
                    return;
                }
                var msgCommand = header.subarray(4, 16).toString();
                var msgLength = header.readUInt32LE(16);
                var msgChecksum = header.readUInt32LE(20);
                readFlowingBytes(client, msgLength, lopped, function (payload, lopped) {
                    if (util.sha256d(payload).readUInt32LE(0) !== msgChecksum) {
                        _this.emit('error', 'bad payload - failed checksum');
                        beginReadingMessage(null);
                        return;
                    }
                    HandleMessage(msgCommand, payload);
                    beginReadingMessage(lopped);
                });
            });
        };

        beginReadingMessage(null);
    }


    //Parsing inv message https://en.bitcoin.it/wiki/Protocol_specification#inv
    function HandleInv(payload) {
        //sloppy varint decoding
        var count = payload.readUInt8(0);
        payload = payload.subarray(1);
        if (count >= 0xfd) {
            count = payload.readUInt16LE(0);
            payload = payload.subarray(2);
        }
        while (count--) {
            switch (payload.readUInt32LE(0)) {
                case invCodes.error:
                    break;
                case invCodes.tx:
                    var tx = payload.subarray(4, 36).toString('hex');
                    break;
                case invCodes.block:
                    var block = payload.subarray(4, 36).toString('hex');
                    _this.emit('blockFound', block);
                    break;
            }
            payload = payload.subarray(36);
        }
    }

    function HandleMessage(command, payload) {
        _this.emit('peerMessage', { command: command, payload: payload });
        switch (command) {
            case commands.inv.toString():
                HandleInv(payload);
                break;
            case commands.verack.toString():
                if (!verack) {
                    verack = true;
                    attemptCount = 0;
                    _this.emit('connected');
                }
                break;
            case commands.ping.toString():
                //how has this NOT had a feken pong all these years?
                SendMessage(commandStringBuffer('pong'), Buffer.alloc(0));
                break;
            default:
                break;
        }

    }

    //Message structure defined at: https://en.bitcoin.it/wiki/Protocol_specification#Message_structure
    function SendMessage(command, payload) {
        var message = Buffer.concat([
            magic,
            command,
            util.packUInt32LE(payload.length),
            util.sha256d(payload).subarray(0, 4),
            payload
        ]);
        client.write(message);
        _this.emit('sentMessage', message);
    }

    function SendVersion() {
        var payload = Buffer.concat([
            util.packUInt32LE(options.protocolVersion),
            networkServices,
            util.packInt64LE(Date.now() / 1000 | 0),
            emptyNetAddress, //addr_recv, can be empty
            emptyNetAddress, //addr_from, can be empty
            crypto.pseudoRandomBytes(8), //nonce, random unique ID
            userAgent,
            blockStartHeight,
            relayTransactions
        ]);
        SendMessage(commands.version, payload);
    }

};

Peer.prototype.__proto__ = events.EventEmitter.prototype;
