/**
 * RPC-related helpers
 *
 * @fileoverview Utilities for RPC operations.
 * @author ComputerGenieCo
 * @version 21.7.3
 * @license GPL-3.0-or-later
 * @copyright 2025
 */
const encoding = require('./encoding');

/**
 * Submits a solved block to the cryptocurrency network using the provided
 * daemon interface. This mirrors the previous implementation that lived in
 * `libs/stratum/pool.js`.
 *
 * @param {Object} daemon - Daemon interface (expects .cmd)
 * @param {Object} options - Pool/options object (expects hasSubmitMethod)
 * @param {Object} logger - Logger instance with severity methods
 * @param {string} logSystem - Log system identifier
 * @param {string} logComponent - Log component (coin name)
 * @param {string} logSubCat - Log subcategory
 * @param {number} height - Block height (unused here but kept for parity)
 * @param {string} blockHex - Hex representation of the block
 * @param {Function} callback - Called when submission succeeds
 */
exports.submitBlock = function (daemon, options, logger, logSystem, logComponent, logSubCat, height, blockHex, callback) {
    // Determine which RPC method to use for block submission
    let rpcCommand, rpcArgs;

    if (options.hasSubmitMethod) {
        // Use submitblock method (preferred for most modern daemons)
        rpcCommand = 'submitblock';

        // Special handling for PBaaS: check solution version in block header
        try {
            const solution_ver = parseInt(
                encoding.reverseBuffer(Buffer.from(blockHex.substr(286, 8), 'hex')).toString('hex'),
                16
            );
            if (solution_ver > 6) {
                rpcCommand = 'submitmergedblock';
            }
        } catch (e) {
            // If parsing fails, fall back to default submitblock behavior
        }

        rpcArgs = [blockHex];
    } else {
        // Fallback to getblocktemplate with submit mode (older daemons)
        rpcCommand = 'getblocktemplate';
        rpcArgs = [{ mode: 'submit', data: blockHex }];
    }

    // Submit block to all configured daemon instances
    daemon.cmd(rpcCommand, rpcArgs, (results) => {
        for (let i = 0; i < results.length; i++) {
            const result = results[i];

            if (result.error) {
                logger.error(logSystem, logComponent, logSubCat, `rpc error with daemon instance ${result.instance.index} when submitting block with ${rpcCommand} ${JSON.stringify(result.error)}`);
                return;
            } else if (result.response === 'rejected') {
                logger.error(logSystem, logComponent, logSubCat, `Daemon instance ${result.instance.index} rejected a supposedly valid block`);
                return;
            }
        }

        // All daemon instances accepted the block
        logger.debug(logSystem, logComponent, logSubCat, `Submitted Block using ${rpcCommand} successfully to daemon instance(s)`);
        callback();
    });
};

/**
 * Retrieves block template from daemon and processes it for mining.
 * This is refactored out of `libs/stratum/pool.js` to centralize RPC
 * helper logic. The function accepts the same basic parameters used in
 * pool.js callbacks and will invoke the provided callback with
 * (error, rpcData, processedNewBlock).
 *
 * @param {Object} daemon - Daemon interface (expects .cmd)
 * @param {Object} options - Pool/options object (expects coin and algorithm)
 * @param {Object} jobManager - Job manager instance with processTemplate
 * @param {Object} logger - Logger instance
 * @param {string} logSystem
 * @param {string} logComponent
 * @param {string} logSubCat
 * @param {Function} callback - Callback with (error, rpcData, processedNewBlock)
 */
exports.getBlockTemplate = function (daemon, options, jobManager, logger, logSystem, logComponent, logSubCat, callback) {
    // used to dedupe identical getblocktemplate responses coming from
    // multiple daemon instances when daemon.cmd is run with streamResults=true
    const processedGbtKeys = new Set();

    function getVerusBlockTemplate() {
        const gbtFunction = 'getblocktemplate';
        const gbtArgs = { 'capabilities': ['coinbasetxn', 'workid', 'coinbase/append'] };
        daemon.cmd(gbtFunction, [gbtArgs], (result) => {
            try {
                const key = result.response && result.response.previousblockhash ?
                    `${result.response.previousblockhash}_${result.response.curtime}` : null;

                if (key && processedGbtKeys.has(key)) {
                    return;
                }
                if (key) {
                    processedGbtKeys.add(key);
                }
            } catch (e) {
                // ignore
            }
            if (result.error) {
                logger.error(logSystem, logComponent, logSubCat, `getblocktemplate call failed for daemon instance ${result.instance.index} with error ${JSON.stringify(result.error)}`);
                callback(result.error);
            } else {
                result.response.miner = result.response.coinbasetxn.coinbasevalue / 100000000;
                result.response.founders = 0;
                result.response.securenodes = 0;
                result.response.supernodes = 0;

                const processedNewBlock = jobManager.processTemplate(result.response);
                callback(null, result.response, processedNewBlock);
                callback = () => { };
            }
        }, true);
    }

    getVerusBlockTemplate();

};

/**
 * Checks whether a block with the given hash exists in the daemon's
 * blockchain and returns acceptance information. Adapted from
 * libs/stratum/pool.js CheckBlockAccepted.
 *
 * @param {Object} daemon
 * @param {Object} logger
 * @param {string} logSystem
 * @param {string} logComponent
 * @param {string} logSubCat
 * @param {string} blockHash
 * @param {Function} callback - (isAccepted, txHashOrError)
 */
exports.checkBlockAccepted = function (daemon, logger, logSystem, logComponent, logSubCat, blockHash, callback) {
    daemon.cmd('getblock', [blockHash], (results) => {
        const validResults = results.filter((result) => {
            return result.response && (result.response.hash === blockHash);
        });

        if (validResults.length >= 1) {
            if (validResults[0].response.confirmations >= 0) {
                callback(true, validResults[0].response.tx[0]);
            } else {
                callback(false, { 'confirmations': validResults[0].response.confirmations });
            }
            return;
        }

        callback(false, { 'unknown': 'check coin daemon logs' });
    });
};
