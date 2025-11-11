/**
 * @fileoverview Application entry and process manager
 *
 * Orchestrates master vs worker process behavior. When run as the master the
 * module delegates orchestration to `libs/MasterController.js`. When running
 * as a worker the existing worker bootstrap semantics apply (unchanged).
 *
 * @author ComputerGenieCo
 * @version 21.7.3
 * @copyright 2025
 */
const CliListener = require('./libs/cliListener.js');
const Entry = require('./libs/Entry.js');
const MasterController = require('./libs/MasterController.js');
const PoolLogger = require('./libs/PoolLogger.js');
const cluster = require('cluster');
const fs = require('fs');
const os = require('os');
const path = require('path');
const redis = require('redis');
if (require.main === module) {
    const entry = new Entry();
    entry.start();
}

const startPaymentProcessor = function () {
    let enabledForAny = false;
    for (const pool in poolConfigs) {
        const p = poolConfigs[pool];
        const enabled = p.enabled && p.paymentProcessing && p.paymentProcessing.enabled;
        if (enabled) {
            enabledForAny = true;
            break;
        }
    }

    if (!enabledForAny) {
        return;
    }

    const worker = cluster.fork({
        workerType: 'paymentProcessor',
        pools: JSON.stringify(poolConfigs)
    });

    worker.on('exit', (code, signal) => {
        logger.error('Master', 'Payment Processor', 'Payment processor died, spawning replacement...');
        setTimeout(() => {
            startPaymentProcessor(poolConfigs);
        }, 2000);
    });
};

const startWebsite = function () {

    if (!portalConfig.website.enabled) {
        return;
    }

    const worker = cluster.fork({
        workerType: 'website',
        pools: JSON.stringify(poolConfigs),
        portalConfig: JSON.stringify(portalConfig)
    });

    websiteWorker = worker;

    worker.on('exit', (code, signal) => {
        logger.error('Master', 'Website', 'Website process died, spawning replacement...');
        setTimeout(() => {
            startWebsite(portalConfig, poolConfigs);
        }, 2000);
    });
};

// Worker bootstrap: when forked, child processes execute the appropriate
// worker module based on the environment variable `workerType`.
if (cluster.isWorker) {
    const workerType = process.env.workerType || 'pool';
    // Parse portalConfig from env if available for logger settings
    let portalConfig = {};
    try {
        if (process.env.portalConfig) portalConfig = JSON.parse(process.env.portalConfig);
    } catch (e) { /* ignore parse errors */ }

    switch (workerType) {
        case 'pool': {
            const poolWorker = require('./libs/poolWorker.js');
            const logger = new PoolLogger({ logLevel: portalConfig.logLevel, logColors: portalConfig.logColors });
            // poolWorker will read process.env.pools and process.env.portalConfig
            poolWorker(logger);
            break;
        }
        case 'paymentProcessor': {
            const payment = require('./libs/paymentProcessor.js');
            payment();
            break;
        }
        case 'website': {
            const Website = require('./libs/website.js');
            const logger = new PoolLogger({ logLevel: portalConfig.logLevel, logColors: portalConfig.logColors });
            const site = new Website(logger);
            site.start();
            break;
        }
        default:
            // Unknown worker type: exit to avoid silent failures
            console.error(`Unknown workerType: ${workerType}`);
            process.exit(1);
    }
}


