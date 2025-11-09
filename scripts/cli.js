/**
 * @fileoverview NOMP CLI Client - Command Line Interface for NOMP Mining Pool
 *
 * A modern command-line client for interacting with a running NOMP (Node Open Mining Portal)
 * instance. This script establishes TCP connections to the pool's CLI listener and executes
 * administrative commands for pool management, statistics, and configuration changes.
 *
 * Features:
 * - Send commands to control pool operations (reload, switch coins, notify blocks)
 * - Hot-swap website directories without restarting the pool
 * - Query pool statistics and status
 * - Configurable connection settings via command-line options or environment variables
 *
 * Usage Examples:
 *   node cli.js help
 *   node cli.js reloadpool vrsc
 *   node cli.js websiteswitch custom_website
 *   node cli.js blocknotify vrsc abc123def456
 *   node cli.js --host=192.168.1.100 --port=17118 coinswitch -coin=vrsc
 *
 * @author ComputerGenieCo
 * @version 21.7.3
 * @copyright 2025
 */

const net = require('net');

/**
 * Default configuration values for CLI connections
 * These can be overridden by command-line options or environment variables
 * @constant {Object}
 */
const DEFAULT_CONFIG = {
    host: process.env.NOMP_CLI_HOST || '127.0.0.1',
    port: parseInt(process.env.NOMP_CLI_PORT) || 17117,
    timeout: 5000  // Connection timeout in milliseconds
};

/**
 * Available CLI commands and their descriptions
 * Used for help display and command validation
 * @constant {Object.<string, string>}
 */
const COMMANDS = {
    'blocknotify': 'Notify pool workers of a new block (params: coin, blockhash)',
    'coinswitch': 'Switch pool to a different coin configuration (params: coin)',
    'reloadpool': 'Reload pool configuration for a specific coin (params: coin)',
    'websiteswitch': 'Hot-swap the website directory (params: directory)',
    'help': 'Display this help message'
};

/**
 * Parse command-line arguments into configuration, command, and parameters
 *
 * Supports the following argument formats:
 * - Options: --host=127.0.0.1, --port=17117
 * - Command: First non-option argument
 * - Parameters: Remaining arguments after command
 *
 * @param {string[]} args - Command-line arguments (excluding node and script path)
 * @returns {Object} Parsed arguments containing config, command, and params
 * @returns {Object} returns.config - Connection configuration overrides
 * @returns {string} returns.command - The command to execute
 * @returns {string[]} returns.params - Parameters for the command
 */
function parseArguments(args) {
    const config = { ...DEFAULT_CONFIG };
    let command = null;
    const params = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        // Check for long options (--key=value)
        if (arg.startsWith('--')) {
            const [key, value] = arg.slice(2).split('=', 2);
            if (key in config) {
                if (key === 'port') {
                    config[key] = parseInt(value);
                } else {
                    config[key] = value;
                }
            } else {
                console.error(`Unknown option: --${key}`);
                process.exit(1);
            }
        } else if (!command) {
            command = arg;
        } else {
            params.push(arg);
        }
    }

    return { config, command, params };
}

/**
 * Display help information and usage examples
 *
 * Shows available commands, options, and examples for using the CLI client
 */
function showHelp() {
    console.log(`
NOMP CLI Client v21.7.3
Command-line interface for NOMP mining pool administration

USAGE:
    node cli.js [options] <command> [parameters...]

OPTIONS:
    --host=HOST        Pool host address (default: ${DEFAULT_CONFIG.host})
    --port=PORT        CLI listener port (default: ${DEFAULT_CONFIG.port})

COMMANDS:`);

    Object.entries(COMMANDS).forEach(([cmd, desc]) => {
        console.log(`    ${cmd.padEnd(14)} ${desc}`);
    });

    console.log(`
EXAMPLES:
    node cli.js help
    node cli.js reloadpool vrsc
    node cli.js websiteswitch custom_theme
    node cli.js blocknotify vrsc 0000000000000000000abc123def456
    node cli.js --host=192.168.1.100 coinswitch vrsc
    node cli.js --port=17118 websiteswitch website_backup

ENVIRONMENT VARIABLES:
    NOMP_CLI_HOST      Default host address
    NOMP_CLI_PORT      Default CLI port

For more information, see the NOMP documentation.
`);
}

/**
 * Send a command to the NOMP CLI listener
 *
 * Establishes a TCP connection to the pool's CLI port, sends the command
 * as JSON, and displays the response.
 *
 * @param {Object} config - Connection configuration
 * @param {string} command - Command to execute
 * @param {string[]} params - Command parameters
 */
function sendCommand(config, command, params) {
    const client = net.connect(config.port, config.host);

    // Set connection timeout
    client.setTimeout(config.timeout);

    client.on('connect', () => {
        // Send command as JSON with newline terminator
        const message = JSON.stringify({
            command: command,
            params: params,
            options: {}
        });
        client.write(`${message}\n`);
    });

    client.on('data', (data) => {
        console.log(data.toString().trim());
        client.end();
    });

    client.on('timeout', () => {
        console.error(`Connection timeout after ${config.timeout}ms`);
        client.destroy();
        process.exit(1);
    });

    client.on('error', (error) => {
        if (error.code === 'ECONNREFUSED') {
            console.error(`Cannot connect to NOMP instance at ${config.host}:${config.port}`);
            console.error('Make sure the pool is running and CLI listener is enabled.');
        } else {
            console.error(`Connection error: ${error.message}`);
        }
        process.exit(1);
    });
}

/**
 * Main CLI execution function
 *
 * Parses arguments, validates input, and executes the appropriate action
 */
function main() {
    const { config, command, params } = parseArguments(process.argv.slice(2));

    // Show help if no command provided or help requested
    if (!command || command === 'help') {
        showHelp();
        return;
    }

    // Validate command
    if (!(command in COMMANDS)) {
        console.error(`Unknown command: ${command}`);
        console.error('Use "help" to see available commands.');
        process.exit(1);
    }

    // Send command to pool
    sendCommand(config, command, params);
}

// Execute main function
main();
