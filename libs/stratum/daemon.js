/**
 * @fileoverview Daemon Interface - RPC communication with cryptocurrency daemons
 *
 * Provides an interface for making RPC calls to multiple daemon instances,
 * handling connection status and batch commands.
 *
 * @author ComputerGenieCo
 * @version 21.7.3
 * @copyright 2025
 */
const http = require('http');
const cp = require('child_process');
const events = require('events');

/**
 * Daemon Interface
 *
 * RPC-based interface for communicating with cryptocurrency daemon instances.
 * Supports batch commands and connection monitoring.
 *
 * Events emitted:
 * - 'online' ()
 * - 'connectionFailed' (results)
 *
 * @class DaemonInterface
 * @extends EventEmitter
 * @param {Array} daemons - Array of daemon configuration objects
 * @param {Function} [logger] - Optional logging function
 */
class DaemonInterface extends events.EventEmitter {
    #logger;
    #instances;

    constructor(daemons, logger) {
        super();

        this.#logger = logger || function (severity, message) {
            console.log(`${severity}: ${message}`);
        };

        this.#instances = (function () {
            for (let i = 0; i < daemons.length; i++) {
                daemons[i]['index'] = i;
            }
            return daemons;
        })();
    }

    #init() {
        this.#isOnline((online) => {
            if (online) {
                this.emit('online');
            }
        });
    }

    #isOnline(callback) {
        this.#cmd('getinfo', [], (results) => {
            const allOnline = results.every((result) => {
                return !results.error;
            });

            callback(allOnline);

            if (!allOnline) {
                this.emit('connectionFailed', results);
            }
        });
    }

    #performHttpRequest(instance, jsonData, callback, timeout) {
        if (!timeout) {
            timeout = 60;
        }

        const options = {
            hostname: (typeof (instance.host) === 'undefined' ? '127.0.0.1' : instance.host),
            port: instance.port,
            method: 'POST',
            auth: `${instance.user}:${instance.password}`,
            headers: {
                'Content-Length': jsonData.length
            }
        };

        const parseJson = function (res, data) {
            let dataJson;

            if (res.statusCode === 401) {
                this.#logger('error', 'Unauthorized RPC access - invalid RPC username or password');
                return;
            }

            try {
                dataJson = JSON.parse(data);
            } catch (e) {
                if (data.indexOf(':-nan') !== -1) {
                    data = data.replace(/:-nan,/g, ':0');
                    parseJson(res, data);
                    return;
                }
                this.#logger('error', `Could not parse rpc data from daemon instance  ${instance.index
                }\nRequest Data: ${jsonData
                }\nReponse Data: ${data}`);

            }

            if (dataJson) {
                callback(dataJson.error, dataJson, data);
            }
        }.bind(this);

        const req = http.request(options, (res) => {
            let data = '';

            res.setEncoding('utf8');

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                parseJson(res, data);
            });
        });

        req.setTimeout(timeout * 1000, () => {
            req.abort();
        });

        req.on('error', (e) => {
            if (e.code === 'ECONNREFUSED') {
                callback({ type: 'offline', message: e.message }, null);
            } else {
                callback({ type: 'request error', message: e.message }, null);
            }
        });

        req.end(jsonData);
    }

    #batchCmd(cmdArray, callback, timeout) {
        const requestJson = [];

        for (let i = 0; i < cmdArray.length; i++) {
            requestJson.push({
                method: cmdArray[i][0],
                params: cmdArray[i][1],
                id: Date.now() + Math.floor(Math.random() * 10) + i
            });
        }

        const serializedRequest = JSON.stringify(requestJson);

        this.#performHttpRequest(this.#instances[0], serializedRequest, (error, result) => {
            callback(error, result);
        }, timeout);
    }

    #cmd(method, params, callback, streamResults, returnRawData) {
        const results = [];

        Promise.all(this.#instances.map(instance => new Promise((eachCallback) => {

            let itemFinished = function (error, result, data) {
                const returnObj = {
                    error: error,
                    response: (result || {}).result,
                    instance: instance
                };

                if (returnRawData) {
                    returnObj.data = data;
                }

                if (streamResults) {
                    callback(returnObj);
                } else {
                    results.push(returnObj);
                }

                eachCallback();

                itemFinished = function () {
                };
            };

            const requestJson = JSON.stringify({
                method: method,
                params: params,
                id: Date.now() + Math.floor(Math.random() * 10)
            });

            this.#performHttpRequest(instance, requestJson, (error, result, data) => {
                itemFinished(error, result, data);
            });

        }))).then(() => {
            if (!streamResults) {
                callback(results);
            }
        });

    }

    /**
     * Initialize the daemon interface and check online status.
     * @returns {void}
     */
    init() {
        this.#init();
    }

    /**
     * Check if all daemon instances are online.
     * @param {Function} callback - Callback function called with boolean online status
     * @returns {void}
     */
    isOnline(callback) {
        this.#isOnline(callback);
    }

    /**
     * Execute an RPC command on all daemon instances.
     * @param {string} method - RPC method name
     * @param {Array} params - RPC method parameters
     * @param {Function} callback - Callback function
     * @param {boolean} [streamResults] - Whether to stream results
     * @param {boolean} [returnRawData] - Whether to return raw data
     * @returns {void}
     */
    cmd(method, params, callback, streamResults, returnRawData) {
        this.#cmd(method, params, callback, streamResults, returnRawData);
    }

    /**
     * Execute a batch of RPC commands.
     * @param {Array} cmdArray - Array of [method, params] pairs
     * @param {Function} callback - Callback function
     * @param {number} [timeout] - Request timeout in seconds
     * @returns {void}
     */
    batchCmd(cmdArray, callback, timeout) {
        this.#batchCmd(cmdArray, callback, timeout);
    }
}

exports.interface = DaemonInterface;
