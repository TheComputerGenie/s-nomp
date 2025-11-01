'use strict';

/**
 * PoolLogger
 * - argument order for log calls: (system, component, subcat, text)
 * - preserves colored output: opening '[' and closing ']' are grey, system name is white
 * - defaults: logLevel='debug', logColors=process.stdout.isTTY
 */
const dateFormat = require('dateformat');
require('colors'); // colors augments String prototype

// Map severities to numeric ranks for filtering
const severityValues = {
    debug: 1,
    warning: 2,
    error: 3,
    special: 4
};

const severityToColor = (severity, text) => {
    switch (severity) {
        case 'special':
            return text.cyan.underline;
        case 'debug':
            return text.green;
        case 'warning':
            return text.yellow;
        case 'error':
            return text.red;
        default:
            // unknown severity -> return unmodified (no exception)
            return text;
    }
};

class PoolLogger {
    /*
    configuration: {
      logLevel: 'debug'|'warning'|'error'|'special' (default: 'debug'),
      logColors: boolean (default: true for TTY)
    }
    */
    constructor(configuration = {}) {
        const cfg = Object.assign({}, configuration);
        this.logLevel = (cfg.logLevel && severityValues[cfg.logLevel]) ? cfg.logLevel : 'debug';
        this.logLevelInt = severityValues[this.logLevel];
        // default to true when stdout is a TTY and config doesn't explicitly disable colors
        this.logColors = (typeof cfg.logColors === 'boolean') ? cfg.logColors : Boolean(process.stdout.isTTY);

        // bind shorthand methods for each severity
        Object.keys(severityValues).forEach((logType) => {
            this[logType] = (...args) => {
                this._log(logType, ...args);
            };
        });
    }

    // note: argument order is (system, component, subcat, text) to match existing callers
    _log(severity, system = '', component = '', subcat = '', text = '') {
        const sevRank = severityValues[severity] || Number.POSITIVE_INFINITY;
        if (sevRank < this.logLevelInt) {
            return;
        }

        // Build timestamp and prefix correctly
        const timeStr = dateFormat(new Date(), 'hh:MM:ssTT mm-dd-yyyy');

        // Color brackets separately so the opening/closing brackets remain grey
        const openingBracket = this.logColors ? '['.grey : '[';
        const systemLabel = this.logColors ? String(system).white : String(system);
        const closingBracket = this.logColors ? ']'.grey : ']';
        const prefix = `${timeStr} ${openingBracket}${systemLabel}${closingBracket}`;
        let entryDesc = `${prefix.padEnd(62)  }\t`;
        if (this.logColors) {
            entryDesc = entryDesc.grey;
        }

        // Ensure subcategory (thread) is always printed before the main text
        let logString = '';
        if (this.logColors) {
            logString = entryDesc + (`[${component}] `).white;
            if (subcat) {
                logString += (`(${subcat}) `).bold.grey;
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

module.exports = PoolLogger;
