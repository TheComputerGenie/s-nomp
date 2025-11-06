const http = require('http');
const cp = require('child_process');
const events = require('events');

/**
 * @fileoverview Daemon Interface for cryptocurrency RPC communication
 * 
 * This module provides a comprehensive interface for communicating with cryptocurrency
 * daemons via JSON-RPC protocol. It supports multiple daemon instances for redundancy
 * and load balancing, handles connection failures gracefully, and provides both
 * individual and batch RPC command execution.
 * 
 * The interface extends EventEmitter to provide event-driven communication patterns
 * for connection status changes and daemon state monitoring.
 * 
 * @author NOMP Pool Software
 * @version 1.0.0
 */

/**
 * @class DaemonInterface
 * @extends EventEmitter
 * @description
 * The daemon interface interacts with cryptocurrency daemons using the JSON-RPC interface.
 * It manages multiple daemon connections for redundancy, handles authentication,
 * and provides methods for executing both single and batch RPC commands.
 * 
 * @param {Array<Object>} daemons - Array of daemon configuration objects
 * @param {string} daemons[].host - Hostname where the daemon is running (defaults to '127.0.0.1')
 * @param {number} daemons[].port - Port where the daemon accepts RPC connections
 * @param {string} daemons[].user - Username for RPC authentication
 * @param {string} daemons[].password - Password for RPC authentication
 * @param {Function} [logger] - Optional logging function for debugging and error reporting
 * 
 * @fires DaemonInterface#online - Emitted when all daemons come online
 * @fires DaemonInterface#connectionFailed - Emitted when daemon connection fails
 * 
 * @example
 * const daemons = [{
 *   host: 'localhost',
 *   port: 8332,
 *   user: 'rpcuser',
 *   password: 'rpcpass'
 * }];
 * 
 * const daemonInterface = new DaemonInterface(daemons, console.log);
 * daemonInterface.init();
 * 
 * daemonInterface.on('online', () => {
 *   console.log('All daemons are online');
 * });
 */
function DaemonInterface(daemons, logger) {

    /**
     * @private
     * @description Reference to the DaemonInterface instance for use in callbacks
     * @type {DaemonInterface}
     */
    const _this = this;

    /**
     * @private
     * @description Logger function for debugging and error reporting
     * Falls back to console.log if no logger is provided
     * @type {Function}
     * @param {string} severity - Log level (error, warn, info, debug)
     * @param {string} message - Log message content
     */
    logger = logger || function (severity, message) {
        console.log(`${severity}: ${message}`);
    };

    /**
     * @private
     * @description Array of daemon instances with added index property for identification
     * Each daemon object gets an 'index' property to track its position in the array
     * @type {Array<Object>}
     */
    const instances = (function () {
        // Add index property to each daemon instance for tracking purposes
        for (let i = 0; i < daemons.length; i++) {
            daemons[i]['index'] = i;
        }
        return daemons;
    })();

    /**
     * @method init
     * @description
     * Initializes the daemon interface by checking if all configured daemons are online.
     * Emits an 'online' event if all daemons are successfully connected and responsive.
     * This method should be called after creating a DaemonInterface instance to establish
     * initial connection status.
     * 
     * @fires DaemonInterface#online - When all daemons are online and responsive
     * 
     * @example
     * const daemonInterface = new DaemonInterface(daemons);
     * daemonInterface.init();
     */
    function init() {
        // Check if all daemon instances are online and responsive
        isOnline((online) => {
            if (online) {
                // Emit online event when all daemons are successfully connected
                _this.emit('online');
            }
        });
    }

    /**
     * @method isOnline
     * @description
     * Checks if all configured daemon instances are online and responsive by sending
     * a 'getinfo' RPC command to each daemon. This is a health check mechanism to
     * verify daemon connectivity and responsiveness.
     * 
     * @param {Function} callback - Callback function to handle the online status result
     * @param {boolean} callback.online - True if all daemons are online, false otherwise
     * 
     * @fires DaemonInterface#connectionFailed - When one or more daemons fail to respond
     * 
     * @example
     * daemonInterface.isOnline((online) => {
     *   if (online) {
     *     console.log('All daemons are responsive');
     *   } else {
     *     console.log('Some daemons are offline');
     *   }
     * });
     */
    function isOnline(callback) {
        // Send 'getinfo' command to all daemon instances to check connectivity
        cmd('getinfo', [], (results) => {
            // Check if all daemon responses are successful (no errors)
            const allOnline = results.every((result) => {
                return !results.error;
            });

            // Execute callback with online status
            callback(allOnline);

            // Emit connectionFailed event if any daemon is offline
            if (!allOnline) {
                _this.emit('connectionFailed', results);
            }
        });
    }

    /**
     * @method performHttpRequest
     * @private
     * @description
     * Performs an HTTP POST request to a specific daemon instance using JSON-RPC protocol.
     * Handles authentication, timeout management, error parsing, and response processing.
     * This is the core communication method for all RPC interactions with daemons.
     * 
     * @param {Object} instance - Daemon instance configuration object
     * @param {string} instance.host - Daemon hostname or IP address
     * @param {number} instance.port - Daemon RPC port number
     * @param {string} instance.user - RPC authentication username
     * @param {string} instance.password - RPC authentication password
     * @param {number} instance.index - Daemon instance index for logging
     * @param {string} jsonData - Serialized JSON-RPC request data
     * @param {Function} callback - Response callback function
     * @param {Object|null} callback.error - Error object if request failed, null if successful
     * @param {Object} callback.result - Parsed JSON response from daemon
     * @param {string} callback.data - Raw response data string
     * @param {number} [timeout=60] - Request timeout in seconds
     * 
     * @example
     * const jsonRequest = JSON.stringify({
     *   method: 'getinfo',
     *   params: [],
     *   id: 1
     * });
     * 
     * performHttpRequest(instance, jsonRequest, (error, result, data) => {
     *   if (error) {
     *     console.error('RPC request failed:', error);
     *   } else {
     *     console.log('Daemon info:', result);
     *   }
     * }, 30);
     */
    function performHttpRequest(instance, jsonData, callback, timeout) {
        // Set default timeout to 60 seconds if not specified
        if (!timeout) {
            timeout = 60;
        }

        /**
         * @description HTTP request options for JSON-RPC communication
         * Configures the HTTP POST request with proper authentication and headers
         */
        const options = {
            hostname: (typeof (instance.host) === 'undefined' ? '127.0.0.1' : instance.host),
            port: instance.port,
            method: 'POST',
            auth: `${instance.user}:${instance.password}`, // HTTP Basic Authentication
            headers: {
                'Content-Length': jsonData.length
            }
        };

        /**
         * @function parseJson
         * @private
         * @description
         * Parses the JSON response from the daemon and handles various error conditions.
         * Includes special handling for NaN values that some daemons may return and
         * comprehensive error logging for debugging purposes.
         * 
         * @param {http.IncomingMessage} res - HTTP response object
         * @param {string} data - Raw response data from daemon
         */
        const parseJson = function (res, data) {
            let dataJson;

            // Handle HTTP 401 Unauthorized responses
            if (res.statusCode === 401) {
                logger('error', 'Unauthorized RPC access - invalid RPC username or password');
                return;
            }

            try {
                // Attempt to parse the JSON response
                dataJson = JSON.parse(data);
            } catch (e) {
                // Handle special case where daemon returns NaN values
                if (data.indexOf(':-nan') !== -1) {
                    // Replace NaN values with 0 and retry parsing
                    data = data.replace(/:-nan,/g, ':0');
                    parseJson(res, data);
                    return;
                }
                // Log detailed error information for debugging
                logger('error', `Could not parse rpc data from daemon instance  ${instance.index
                }\nRequest Data: ${jsonData
                }\nReponse Data: ${data}`);

            }

            // Execute callback with parsed data if successful
            if (dataJson) {
                callback(dataJson.error, dataJson, data);
            }
        };

        /**
         * @description Create and configure the HTTP request to the daemon
         * Sets up response handling, timeout management, and error handling
         */
        const req = http.request(options, (res) => {
            let data = '';

            // Set encoding to properly handle text responses
            res.setEncoding('utf8');

            // Accumulate response data chunks
            res.on('data', (chunk) => {
                data += chunk;
            });

            // Process complete response when finished
            res.on('end', () => {
                parseJson(res, data);
            });
        });

        // Set request timeout to prevent hanging connections
        req.setTimeout(timeout * 1000, () => {
            req.abort(); // Force abort on timeout
        });

        /**
         * @description Handle HTTP request errors
         * Provides specific error types for different failure scenarios
         */
        req.on('error', (e) => {
            if (e.code === 'ECONNREFUSED') {
                // Daemon is offline or not accepting connections
                callback({ type: 'offline', message: e.message }, null);
            } else {
                // Other network or request errors
                callback({ type: 'request error', message: e.message }, null);
            }
        });

        // Send the JSON-RPC request data
        req.end(jsonData);
    }

    /**
     * @method batchCmd
     * @description
     * Performs a batch JSON-RPC command execution using only the first configured daemon.
     * This method allows multiple RPC commands to be sent in a single HTTP request,
     * which is more efficient than individual requests for multiple operations.
     * 
     * **Note:** This method only uses the first daemon instance (instances[0]) for
     * batch operations, unlike the regular cmd() method which uses all instances.
     * 
     * @param {Array<Array>} cmdArray - Array of command arrays in format:
     *   [[methodName, [params]], [methodName, [params]], ...]
     * @param {Function} callback - Callback function to handle the batch response
     * @param {Object|null} callback.error - Error object if batch request failed
     * @param {Array|Object} callback.result - Array of results corresponding to each command
     * @param {number} [timeout] - Request timeout in seconds (defaults to 60)
     * 
     * @example
     * const commands = [
     *   ['getinfo', []],
     *   ['getblockcount', []],
     *   ['getmininginfo', []]
     * ];
     * 
     * daemonInterface.batchCmd(commands, (error, results) => {
     *   if (error) {
     *     console.error('Batch command failed:', error);
     *   } else {
     *     console.log('Batch results:', results);
     *   }
     * });
     */
    function batchCmd(cmdArray, callback, timeout) {
        /**
         * @description Build array of JSON-RPC request objects for batch execution
         * Each command gets a unique ID for response correlation
         */
        const requestJson = [];

        // Convert command array to JSON-RPC request format
        for (let i = 0; i < cmdArray.length; i++) {
            requestJson.push({
                method: cmdArray[i][0],    // RPC method name
                params: cmdArray[i][1],    // Method parameters array
                id: Date.now() + Math.floor(Math.random() * 10) + i  // Unique request ID
            });
        }

        // Serialize the batch request array to JSON
        const serializedRequest = JSON.stringify(requestJson);

        // Send batch request to the first daemon instance only
        performHttpRequest(instances[0], serializedRequest, (error, result) => {
            callback(error, result);
        }, timeout);
    }

    /**
     * @method cmd
     * @description
     * Sends a JSON-RPC command to every configured daemon instance. This method provides
     * redundancy and load distribution by executing the same command across multiple daemons.
     * Supports both batch result collection and streaming results for real-time processing.
     * 
     * The method follows the JSON-RPC 2.0 specification (http://json-rpc.org/wiki/specification)
     * and handles response aggregation from multiple daemon instances.
     * 
     * @param {string} method - The RPC method name to execute (e.g., 'getinfo', 'getblockcount')
     * @param {Array} params - Array of parameters to pass to the RPC method
     * @param {Function} callback - Callback function to handle results
     * @param {Array<Object>|Object} callback.results - Results from all daemons (batch mode) or single result (stream mode)
     * @param {Object|null} callback.results[].error - Error object if command failed on this daemon
     * @param {*} callback.results[].response - The actual response data from the daemon
     * @param {Object} callback.results[].instance - The daemon instance that provided this result
     * @param {string} [callback.results[].data] - Raw response data (if returnRawData is true)
     * @param {boolean} [streamResults=false] - If true, callback is called for each daemon response individually
     * @param {boolean} [returnRawData=false] - If true, includes raw response data in the result object
     * 
     * @example
     * // Basic usage - get info from all daemons
     * daemonInterface.cmd('getinfo', [], (results) => {
     *   results.forEach((result, index) => {
     *     if (result.error) {
     *       console.error(`Daemon ${index} error:`, result.error);
     *     } else {
     *       console.log(`Daemon ${index} info:`, result.response);
     *     }
     *   });
     * });
     * 
     * @example
     * // Streaming results - process each daemon response as it arrives
     * daemonInterface.cmd('getblockcount', [], (result) => {
     *   console.log(`Block count from daemon ${result.instance.index}:`, result.response);
     * }, true);
     * 
     * @example
     * // With raw data - useful for debugging or custom parsing
     * daemonInterface.cmd('getmininginfo', [], (results) => {
     *   console.log('Raw response:', results[0].data);
     * }, false, true);
     */
    function cmd(method, params, callback, streamResults, returnRawData) {
        /**
         * @description Array to collect results from all daemon instances
         * Only used when streamResults is false (batch mode)
         */
        const results = [];

        // Execute command on each daemon instance asynchronously
        Promise.all(instances.map(instance => new Promise((eachCallback) => {

            /**
             * @function itemFinished
             * @description
             * Handles the completion of a single daemon request. Formats the response
             * object and either streams it immediately or adds it to the results array.
             * Uses a closure pattern to prevent multiple callbacks on the same request.
             * 
             * @param {Object|null} error - Error object from the daemon request
             * @param {Object} result - Parsed JSON-RPC response object
             * @param {string} data - Raw response data string
             */
            let itemFinished = function (error, result, data) {
                // Create standardized response object for this daemon
                const returnObj = {
                    error: error,
                    response: (result || {}).result,  // Extract the 'result' field from JSON-RPC response
                    instance: instance
                };

                // Include raw data if requested (useful for debugging)
                if (returnRawData) {
                    returnObj.data = data;
                }

                if (streamResults) {
                    // Stream mode: call callback immediately for each result
                    callback(returnObj);
                } else {
                    // Batch mode: collect results for final callback
                    results.push(returnObj);
                }

                // Signal completion to Promise.all
                eachCallback();

                // Prevent multiple callbacks by replacing function with no-op
                itemFinished = function () {
                    // This prevents accidental double-calling of the callback
                };
            };

            /**
             * @description Create JSON-RPC request object with unique ID
             * The ID is used to correlate requests with responses
             */
            const requestJson = JSON.stringify({
                method: method,
                params: params,
                id: Date.now() + Math.floor(Math.random() * 10)  // Generate unique request ID
            });

            // Send the request to this specific daemon instance
            performHttpRequest(instance, requestJson, (error, result, data) => {
                itemFinished(error, result, data);
            });

        }))).then(() => {
            // Called when all daemon requests are complete
            if (!streamResults) {
                // Batch mode: call callback once with all results
                callback(results);
            }
            // Note: In stream mode, callback has already been called for each result
        });

    }

    /**
     * @section Public API Methods
     * @description
     * The following methods are exposed as the public interface of the DaemonInterface class.
     * These methods provide the primary functionality for daemon interaction and management.
     */

    /**
     * @public
     * @description Initialize the daemon interface and check connectivity
     */
    this.init = init;

    /**
     * @public
     * @description Check if all daemon instances are online and responsive
     */
    this.isOnline = isOnline;

    /**
     * @public
     * @description Execute RPC commands on all daemon instances
     */
    this.cmd = cmd;

    /**
     * @public
     * @description Execute batch RPC commands on the first daemon instance
     */
    this.batchCmd = batchCmd;
}

/**
 * @description
 * Extend DaemonInterface with EventEmitter capabilities to support event-driven architecture.
 * This allows the daemon interface to emit events for connection status changes and other
 * important state transitions that applications can listen for and respond to appropriately.
 * 
 * Available events:
 * - 'online': Emitted when all daemons come online during initialization
 * - 'connectionFailed': Emitted when daemon connectivity check fails
 */
DaemonInterface.prototype.__proto__ = events.EventEmitter.prototype;

/**
 * @module DaemonInterface
 * @description
 * Export the DaemonInterface class as the main interface for this module.
 * Applications should use this class to create instances for communicating with
 * cryptocurrency daemons via JSON-RPC protocol.
 * 
 * @example
 * const { interface: DaemonInterface } = require('./daemon');
 * 
 * const daemons = [{
 *   host: 'localhost',
 *   port: 8332,
 *   user: 'rpcuser',
 *   password: 'rpcpass'
 * }];
 * 
 * const daemonInterface = new DaemonInterface(daemons);
 * daemonInterface.init();
 */
exports.interface = DaemonInterface;
