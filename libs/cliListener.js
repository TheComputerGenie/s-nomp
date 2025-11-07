/**
 * @fileoverview CLI Listener - TCP admin command listener
 *
 * Provides a small TCP server that accepts newline-terminated JSON commands and
 * emits events for processing by the application.
 *
 * @author ComputerGenieCo
 * @version 21.7.3
 * @copyright 2025
 */
const EventEmitter = require('events');
const net = require('net');

/**
 * CLI Listener
 *
 * TCP-based admin command listener. Accepts newline-terminated JSON messages
 * containing a { command, params, options } payload and emits events for
 * consumers to handle.
 *
 * Events emitted:
 * - 'command' (command, params, options, callback)
 * - 'log' (message)
 *
 * @class CLIListener
 * @extends EventEmitter
 * @param {string} server - Host or IP address to bind to
 * @param {number} port - TCP port to listen on
 */
class CLIListener extends EventEmitter {
    constructor(server, port) {
        super();
        this.server = server;
        this.port = port;
    }

    /**
     * Start the CLI TCP listener. When a newline-terminated JSON message is
     * received it will emit the 'command' event with the parsed payload.
     * @returns {void}
     */
    start() {
        const self = this;
        net.createServer((c) => {
            let data = '';
            try {
                c.on('data', (d) => {
                    data += d;
                    if (data.slice(-1) === '\n') {
                        let message;
                        try {
                            message = JSON.parse(data);
                        } catch (err) {
                            self.emit('log', `CLI listener failed to parse message ${data}`);
                            return;
                        }
                        self.emit('command', message.command, message.params, message.options, (messageResp) => {
                            c.end(messageResp);
                        });
                    }
                });
                c.on('end', () => { });
                c.on('error', () => { });
            } catch (e) {
                self.emit('log', `CLI listener failed to parse message ${data}`);
            }
        }).listen(this.port, this.server, () => {
            this.emit('log', `CLI listening on  ${this.server}:${this.port}`);
        });
    }
}

module.exports = CLIListener;
