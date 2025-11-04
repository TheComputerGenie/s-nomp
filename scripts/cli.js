/**
 * @fileoverview NOMP (Node Open Mining Portal) Command Line Interface Client
 * 
 * This script provides a command-line interface for communicating with a running NOMP
 * mining pool instance. It establishes a TCP socket connection to send commands and
 * receive responses from the pool server.
 * 
 * The CLI supports various command-line arguments and options:
 * - Commands: Basic operations to execute on the pool
 * - Parameters: Arguments for the commands
 * - Options: Configuration flags in the format -key=value
 * 
 * Usage Examples:
 *   node cli.js status
 *   node cli.js restart -pool=vrsc
 *   node cli.js stats -host=192.168.1.100 -port=17118
 * 
 * @author NOMP Development Team
 * @version 1.0.0
 * @since 2024
 */

const net = require('net');

/**
 * Default TCP port for connecting to the NOMP instance
 * This port should match the CLI listener port configured in the main pool
 * @constant {number}
 * @default 17117
 */
const defaultPort = 17117;

/**
 * Default host address for connecting to the NOMP instance
 * Typically localhost when running CLI on the same machine as the pool
 * @constant {string}
 * @default '127.0.0.1'
 */
const defaultHost = '127.0.0.1';

/**
 * Command line arguments excluding node executable and script name
 * process.argv contains: [node_path, script_path, ...user_args]
 * We slice(2) to get only the user-provided arguments
 * @type {string[]}
 */
const args = process.argv.slice(2);

/**
 * Array to store command parameters (non-option arguments)
 * These are positional arguments that don't start with '-'
 * Example: For "node cli.js restart pool1", params will contain ["restart", "pool1"]
 * @type {string[]}
 */
const params = [];

/**
 * Object to store command-line options in key-value format
 * Options are arguments that start with '-' and contain '='
 * Example: For "-host=192.168.1.100 -port=17118", options will be:
 * { host: "192.168.1.100", port: "17118" }
 * @type {Object.<string, string>}
 */
const options = {};

/**
 * Parse command-line arguments into parameters and options
 * 
 * This loop processes each argument and categorizes it as either:
 * 1. Option: Arguments starting with '-' and containing '=' (e.g., -host=localhost)
 * 2. Parameter: All other arguments (commands, values, etc.)
 * 
 * The parsing logic:
 * - Options are split at '=' and stored as key-value pairs in the options object
 * - Parameters are stored in order in the params array
 * 
 * @example
 * Input: ["status", "-host=192.168.1.100", "-port=17118", "pool1"]
 * Result: 
 *   params = ["status", "pool1"]
 *   options = { host: "192.168.1.100", port: "17118" }
 */
for (let i = 0; i < args.length; i++) {
    // Check if argument is an option (starts with '-' and contains '=')
    if (args[i].indexOf('-') === 0 && args[i].indexOf('=') !== -1) {
        // Split option into key-value pair, removing the leading '-'
        const s = args[i].substr(1).split('=');
        options[s[0]] = s[1];
    } else {
        // Regular parameter - add to params array
        params.push(args[i]);
    }
}

/**
 * Extract the first parameter as the command to execute
 * shift() removes and returns the first element from the params array
 * 
 * After this operation:
 * - command contains the main operation to perform (e.g., "status", "restart")
 * - params contains any remaining arguments for the command
 * 
 * @type {string|undefined} The command to execute, or undefined if no parameters provided
 */
const command = params.shift();

/**
 * Create and configure TCP client connection to the NOMP instance
 * 
 * This establishes a socket connection to the pool's CLI listener service.
 * The connection uses either user-specified host/port options or defaults.
 * 
 * Connection flow:
 * 1. Attempt to connect to the specified/default host and port
 * 2. On successful connection, send the command payload as JSON
 * 3. Listen for response data and error events
 * 4. Handle connection cleanup on close
 * 
 * @type {net.Socket} TCP socket client for pool communication
 */
const client = net.connect(options.port || defaultPort, options.host || defaultHost, () => {
    /**
     * Connection established successfully - send command payload
     * 
     * The payload is a JSON object containing:
     * - command: The main operation to execute
     * - params: Additional parameters for the command
     * - options: Configuration options (host, port, etc.)
     * 
     * The message is terminated with a newline character as expected
     * by the NOMP CLI listener protocol.
     */
    client.write(`${JSON.stringify({
        command: command,
        params: params,
        options: options
    })}\n`);
}).on('error', (error) => {
    /**
     * Handle socket connection and communication errors
     * 
     * Common error scenarios:
     * - ECONNREFUSED: Pool instance is not running or CLI listener is disabled
     * - Network errors: Firewall, routing, or connectivity issues
     * - Protocol errors: Malformed messages or unexpected responses
     * 
     * @param {Error} error - The error object containing details about the failure
     */
    if (error.code === 'ECONNREFUSED') {
        // Pool is not running or not accepting CLI connections
        console.log(`Could not connect to NOMP instance at ${defaultHost}:${defaultPort}`);
    } else {
        // Other socket-related errors (network, protocol, etc.)
        console.log(`Socket error ${JSON.stringify(error)}`);
    }
}).on('data', (data) => {
    /**
     * Handle incoming data from the NOMP instance
     * 
     * The pool server sends response data which typically contains:
     * - Command execution results
     * - Status information
     * - Error messages
     * - Confirmation messages
     * 
     * Data is received as a Buffer, so we convert it to string for display.
     * The response format depends on the command executed and may be:
     * - Plain text messages
     * - JSON formatted data
     * - Multi-line status reports
     * 
     * @param {Buffer} data - Raw response data from the pool server
     */
    console.log(data.toString());
}).on('close', () => {
    /**
     * Handle socket connection closure
     * 
     * This event fires when the connection is closed, either:
     * - Normally after command completion
     * - Due to server-side disconnection
     * - After an error condition
     * 
     * In most cases, the CLI script will exit naturally after this event.
     * No explicit cleanup is needed as the socket resources are automatically released.
     */
    // Connection closed - script will exit naturally
});