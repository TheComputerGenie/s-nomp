'use strict';

/*
 * Copyright (c) 2025 ComputerGenieCo. All rights reserved.
 */

/**
 * PoolLogger - A logging utility for mining pools
 *
 * Provides structured logging with severity levels, colored output, and configurable filtering.
 * Argument order for log calls: (system, component, subcat, text)
 * Preserves colored output: opening '[' and closing ']' are grey, system name is white
 * Defaults: logLevel='debug', logColors=process.stdout.isTTY
 */
class PoolLogger {
    /**
     * Creates a new PoolLogger instance
     *
     * @param {Object} [configuration={}] - Configuration options
     * @param {string} [configuration.logLevel='debug'] - Minimum log level ('trace'|'debug'|'verbose'|'info'|'notice'|'warn'|'error'|'alert'|'critical'|'fatal')
     * @param {boolean} [configuration.logColors] - Whether to use colored output (defaults to true for TTY)
     */
    constructor(configuration = {}) {
        const cfg = { ...configuration };
        this.logLevel = (cfg.logLevel && severityValues[cfg.logLevel]) ? cfg.logLevel : 'debug';
        this.logLevelInt = severityValues[this.logLevel];
        // Default to true when stdout is a TTY and config doesn't explicitly disable colors
        this.logColors = (typeof cfg.logColors === 'boolean') ? cfg.logColors : Boolean(process.stdout.isTTY);

        // Bind shorthand methods for each severity level
        Object.keys(severityValues).forEach((logType) => {
            this[logType] = (...args) => {
                this._log(logType, ...args);
            };
        });
    }

    /**
     * Internal logging method
     *
     * @private
     * @param {string} severity - Log severity level
     * @param {string} [system=''] - System identifier
     * @param {string} [component=''] - Component identifier
     * @param {string} [subcat=''] - Subcategory (thread)
     * @param {string} [text=''] - Log message text
     */
    _log(severity, system = '', component = '', subcat = '', text = '') {
        const sevRank = severityValues[severity] || Number.POSITIVE_INFINITY;
        if (sevRank < this.logLevelInt) {
            return;
        }

        // If text is empty but subcat has content, treat subcat as the main message
        if (!text && subcat) {
            text = subcat;
            subcat = '';
        }

        const timeStr = formatDate(new Date());

        // Build prefix with colored brackets and system name
        const openingBracket = this.logColors ? `${colors.grey}[${colors.reset}` : '[';
        const systemLabel = this.logColors ? `${colors.white}${String(system)}${colors.reset}` : String(system);
        const closingBracket = this.logColors ? `${colors.grey}]${colors.reset}` : ']';
        const prefix = `${timeStr} ${openingBracket}${systemLabel}${closingBracket}`;

        let entryDesc = `${prefix.padEnd(62)}\t`;
        if (this.logColors) {
            entryDesc = `${colors.grey}${entryDesc}${colors.reset}`;
        }

        // Build the complete log string
        let logString = '';
        if (this.logColors) {
            logString = `${entryDesc}${colors.white}[${component}] ${colors.reset}`;
            if (subcat) {
                logString += `${colors.bold}${colors.grey}(${subcat}) ${colors.reset}`;
            }
            logString += severityToColor(severity, String(text));
        } else {
            logString = `${entryDesc}[${component}] `;
            if (subcat) {
                logString += `(${subcat}) `;
            }
            logString += String(text);
        }

        // Use console.error for errors to help log aggregation, otherwise console.log
        if (severity === 'error') {
            console.error(logString);
        } else {
            console.log(logString);
        }
    }
}

// ANSI escape codes for terminal colors
const colors = {
    reset: '\x1b[0m',
    black: '\x1b[30m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    grey: '\x1b[90m',
    lred: '\x1b[91m',
    lgreen: '\x1b[92m',
    lyellow: '\x1b[93m',
    lblue: '\x1b[94m',
    lmagenta: '\x1b[95m',
    lcyan: '\x1b[96m',
    lwhite: '\x1b[97m',
    bold: '\x1b[1m',
    underline: '\x1b[4m'
};

// Severity levels mapped to numeric ranks for filtering
const severityValues = {
    trace: 1,
    debug: 2,
    verbose: 3,
    info: 4,
    notice: 5,
    warn: 6,
    error: 7,
    alert: 8,
    critical: 9,
    fatal: 10
};

/**
 * Applies color formatting based on severity level
 *
 * @param {string} severity - The severity level
 * @param {string} text - The text to color
 * @returns {string} The colored text or original text if severity unknown
 */
const severityToColor = (severity, text) => {
    switch (severity) {
        case 'trace':
            return `${colors.grey}${text}${colors.reset}`;
        case 'debug':
            return `${colors.lblue}${text}${colors.reset}`;
        case 'verbose':
            return `${colors.green}${text}${colors.reset}`;
        case 'info':
            return `${colors.lgreen}${text}${colors.reset}`;
        case 'notice':
            return `${colors.cyan}${text}${colors.reset}`;
        case 'warn':
            return `${colors.yellow}${text}${colors.reset}`;
        case 'error':
            return `${colors.red}${text}${colors.reset}`;
        case 'alert':
            return `${colors.lred}${text}${colors.reset}`;
        case 'critical':
            return `${colors.magenta}${colors.underline}${text}${colors.reset}`;
        case 'fatal':
            return `${colors.bold}${colors.underline}${colors.red}${text}${colors.reset}`;
        default:
            // Unknown severity -> return unmodified (no exception)
            return text;
    }
};

/**
 * Formats a date object into a readable string
 *
 * @param {Date} date - The date to format
 * @returns {string} Formatted date string in HH:MM:SSAM/PM MM-DD-YYYY format
 */
function formatDate(date) {
    const hours = date.getHours();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const hh = ((hours % 12) || 12).toString().padStart(2, '0');
    const MM = date.getMinutes().toString().padStart(2, '0');
    const ss = date.getSeconds().toString().padStart(2, '0');
    const mm = (date.getMonth() + 1).toString().padStart(2, '0');
    const dd = date.getDate().toString().padStart(2, '0');
    const yyyy = date.getFullYear();
    return `${hh}:${MM}:${ss}${ampm} ${mm}-${dd}-${yyyy}`;
}

module.exports = PoolLogger;
