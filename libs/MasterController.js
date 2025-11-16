/**
 * @fileoverview MasterController - master process orchestration
 *
 * Implements master responsibilities: configuration loading, worker
 * spawning and monitoring, payment processor and website worker lifecycle,
 * and CLI listener wiring.
 *
 * @author ComputerGenieCo
 * @version 21.7.3
 * @copyright 2025
 */

const CreateRedisClient = require('./createRedisClient.js');
const CliListener = require('./cliListener.js');
const PaymentProcessor = require('./paymentProcessor.js');
const PplntTracker = require('./payments/PplntTracker.js');
const PoolLogger = require('./PoolLogger.js');
const PoolConfigLoader = require('./init/PoolConfigLoader.js');
const Website = require('./website.js');
const algos = require('./stratum/algoProperties.js');
const cluster = require('cluster');
const coinConstants = require('./coinConstants.js');
const fs = require('fs');
const { minify } = require('./utils/jsonMinify.js');
const os = require('os');
const path = require('path');

/**
 * MasterController
 *
 * @class MasterController
 */
class MasterController {
    constructor() {
        if (!fs.existsSync('config.json')) {
            console.log('config.json file does not exist. Read the installation/setup instructions.');
            console.error('Missing config.json');
            process.exit(1);
        }

        try {
            this.portalConfig = JSON.parse(minify(fs.readFileSync('config.json', { encoding: 'utf8' })));
        } catch (e) {
            console.error('Failed to parse config.json:', e.message);
            process.exit(1);
        }

        this.poolConfigs = {};
        this.websiteWorker = null;
        this.exitCounters = {};
        this.logger = new PoolLogger({
            logLevel: this.portalConfig.logLevel,
            logColors: this.portalConfig.logColors
        });

        try {
            const posix = require('posix');
            try {
                posix.setrlimit('nofile', { soft: 100000, hard: 100000 });
            } catch (e) {
                if (cluster.isPrimary) {
                    this.logger.warn('POSIX', 'Connection Limit', '(Safe to ignore) Must be ran as root to increase resource limits');
                }
            } finally {
                const uid = parseInt(process.env.SUDO_UID);
                if (uid) {
                    process.setuid(uid);
                    this.logger.debug('POSIX', 'Connection Limit', `Raised to 100K concurrent connections, now running as non-root user: ${process.getuid()}`);
                }
            }
        } catch (e) {
            if (cluster.isPrimary) {
                this.logger.debug('POSIX', 'Connection Limit', '(Safe to ignore) POSIX module not installed and resource (connection) limit was not raised');
            }
        }

        // PPLNT tracker (extracted to its own module under libs/payments)
        this.pplntTracker = new PplntTracker(this.logger, this.poolConfigs, this.roundTo.bind(this));

        // Parse command line arguments for coin selection
        this.isPbaas = process.argv.length > 2 && process.argv[2] === 'pbaas';
        if (this.isPbaas) {
            if (process.argv.length > 3) {
                const coinName = process.argv[3].toLowerCase();
                if (coinConstants.get(coinName)) {
                    this.selectedCoin = coinName;
                } else {
                    this.selectedCoin = 'chips';
                }
            } else {
                this.selectedCoin = 'chips';
            }
        } else {
            this.selectedCoin = 'verus';
        }
    }

    roundTo(n, digits) {
        if (digits === undefined) {
            digits = 0;
        }
        const multiplicator = Math.pow(10, digits);
        n = parseFloat((n * multiplicator).toFixed(11));
        const test = (Math.round(n) / multiplicator);
        return +(test.toFixed(digits));
    }

    buildPoolConfigs() {
        // Delegate to PoolConfigLoader for clearer responsibilities and testability.
        const loader = new PoolConfigLoader(this.portalConfig, this.logger, this.selectedCoin, this.isPbaas);
        return loader.load();
    }

    spawnPoolWorkers() {
        let redisConfig;
        let connection;

        Object.keys(this.poolConfigs).forEach((coin) => {
            const pcfg = this.poolConfigs[coin];
            if (!Array.isArray(pcfg.daemons) || pcfg.daemons.length < 1) {
                this.logger.error('Master', coin, 'No daemons configured so a pool cannot be started for this coin.');
                delete this.poolConfigs[coin];
            } else if (!connection) {
                redisConfig = pcfg.redis;
                connection = CreateRedisClient(redisConfig);
                if (redisConfig.password != '') {
                    connection.auth(redisConfig.password);
                    connection.on('error', (err) => {
                        this.logger.error('redis', coin, `An error occured while attempting to authenticate redis: ${err}`);
                    });
                }
                connection.on('ready', () => {
                    this.logger.debug('PPLNT', coin, `TimeShare processing setup with redis (${connection.snompEndpoint})`, true);
                    try {
                        this.pplntTracker.init(connection);
                    } catch (e) {
                        this.logger.error('PPLNT', coin, `Failed to initialize PPLNT tracker with redis connection: ${e}`);
                    }
                });
            }
        });

        if (Object.keys(this.poolConfigs).length === 0) {
            this.logger.warn('PoolSpawner', 'Master', 'No pool configs exists or are enabled in configFiles folder. No pools spawned.');
            return;
        }

        const serializedConfigs = JSON.stringify(this.poolConfigs);

        // compute numForks in a safer way using this.portalConfig
        const forks = (() => {
            if (!this.portalConfig.clustering || !this.portalConfig.clustering.enabled) {
                return 1;
            }
            if (this.portalConfig.clustering.forks === 'auto') {
                return os.cpus().length;
            }
            if (!this.portalConfig.clustering.forks || isNaN(this.portalConfig.clustering.forks)) {
                return 1;
            }
            return this.portalConfig.clustering.forks;
        })();

        const poolWorkers = {};

        const createPoolWorker = (forkId) => {
            const worker = cluster.fork({
                workerType: 'pool',
                forkId: forkId,
                pools: serializedConfigs,
                portalConfig: JSON.stringify(this.portalConfig)
            });
            worker.forkId = forkId;
            worker.type = 'pool';
            poolWorkers[forkId] = worker;
            worker.on('exit', (code, signal) => {
                const type = `pool-${forkId}`;
                const now = Date.now();
                if (!this.exitCounters[type]) {
                    this.exitCounters[type] = { count: 0, lastTime: now };
                }
                const counter = this.exitCounters[type];
                if (now - counter.lastTime < 10000) {
                    counter.count++;
                    if (counter.count >= 3) {
                        this.logger.error('PoolSpawner', 'Master', `Fork ${forkId} exited 3 times in 10s, not respawning to prevent loop`);
                        return;
                    }
                } else {
                    counter.count = 1;
                    counter.lastTime = now;
                }
                this.logger.error('PoolSpawner', 'Master', `Fork ${forkId} died, spawning replacement worker...`);
                setTimeout(() => {
                    createPoolWorker(forkId);
                }, 2000);
            }).on('message', (msg) => {
                switch (msg.type) {
                    case 'banIP':
                        Object.keys(cluster.workers).forEach((id) => {
                            if (cluster.workers[id].type === 'pool') {
                                cluster.workers[id].send({ type: 'banIP', ip: msg.ip });
                            }
                        });
                        break;
                    case 'shareTrack':
                        this.pplntTracker.handleShare(msg);
                        break;
                }
            });
        };

        let i = 0;
        const spawnInterval = setInterval(() => {
            createPoolWorker(i);
            i++;
            if (i === forks) {
                clearInterval(spawnInterval);
                this.logger.debug('PoolSpawner', 'Master', `Spawned ${Object.keys(this.poolConfigs).length} pool(s) on ${forks} thread(s)`);
            }
        }, 250);
    }

    hasWebsiteFiles(dir) {
        try {
            const dirPath = path.join(__dirname, '..', 'websites', dir);
            const indexPath = path.join(dirPath, 'index.html');
            const keyPath = path.join(dirPath, 'key.html');
            return fs.existsSync(indexPath) && fs.existsSync(keyPath);
        } catch (e) {
            return false;
        }
    }

    startCliListener() {
        const cliPort = this.portalConfig.cliPort;
        const cliServer = this.portalConfig.cliServer || '127.0.0.1';
        const listener = new CliListener(cliServer, cliPort);
        listener.on('log', (text) => {
            this.logger.debug('CLI', 'Master', text);
        }).on('command', (command, params, options, reply) => {
            switch (command) {
                case 'blocknotify':
                    Object.keys(cluster.workers).forEach((id) => {
                        cluster.workers[id].send({ type: 'blocknotify', coin: params[0], hash: params[1] });
                    });
                    reply('Pool workers notified');
                    break;
                case 'coinswitch':
                    this.processCoinSwitchCommand(params, options, reply);
                    break;
                case 'reloadpool':
                    Object.keys(cluster.workers).forEach((id) => {
                        cluster.workers[id].send({ type: 'reloadpool', coin: params[0] });
                    });
                    reply(`reloaded pool ${params[0]}`);
                    break;
                case 'websiteswitch':
                    const newDir = params[0];
                    if (!newDir) {
                        reply('Missing directory parameter for websiteswitch'); break;
                    }
                    const candidate = path.join(__dirname, '..', 'websites', newDir);
                    const defaultDir = path.join(__dirname, '..', 'websites', 'modern');
                    let replyMessage;
                    if (!fs.existsSync(candidate) || !this.hasWebsiteFiles(newDir)) {
                        if (fs.existsSync(defaultDir) && this.hasWebsiteFiles('modern')) {
                            replyMessage = `Website directory switched to ${newDir} (does not contain required website files, falling back to 'modern')`;
                            this.portalConfig.website.directory = 'modern';
                        } else {
                            replyMessage = `Website directory switched to ${newDir} (does not contain required website files, and default 'websites/modern' directory is also missing or incomplete)`;
                            this.portalConfig.website.directory = newDir;
                        }
                    } else {
                        replyMessage = `Website directory switched to ${newDir}`;
                        this.portalConfig.website.directory = newDir;
                    }
                    if (this.websiteWorker) {
                        this.websiteWorker.removeAllListeners('exit');
                        this.websiteWorker.kill();
                        this.websiteWorker = null;
                    }
                    this.startWebsite();
                    reply(replyMessage);
                    break;
                default:
                    reply(`unrecognized command "${command}"`);
                    break;
            }
        }).start();
    }

    processCoinSwitchCommand(params, options, reply) {
        const logSystem = 'CLI';
        const logComponent = 'coinswitch';
        const replyError = (msg) => {
            reply(msg); this.logger.error(logSystem, logComponent, msg);
        };

        if (!params[0]) {
            replyError('Coin name required'); return;
        }
        if (!params[1] && !options.algorithm) {
            replyError('If switch key is not provided then algorithm options must be specified'); return;
        } else if (params[1] && !this.portalConfig.switching[params[1]]) {
            replyError(`Switch key not recognized: ${params[1]}`); return;
        } else if (options.algorithm && !Object.keys(this.portalConfig.switching).filter((s) => {
            return this.portalConfig.switching[s].algorithm === options.algorithm;
        })[0]) {
            replyError(`No switching options contain the algorithm ${options.algorithm}`); return;
        }

        const messageCoin = params[0].toLowerCase();
        const newCoin = Object.keys(this.poolConfigs).filter((p) => {
            return p.toLowerCase() === messageCoin;
        })[0];
        if (!newCoin) {
            replyError(`Switch message to coin that is not recognized: ${messageCoin}`); return;
        }

        const switchNames = [];
        if (params[1]) {
            switchNames.push(params[1]);
        } else {
            for (const name in this.portalConfig.switching) {
                if (this.portalConfig.switching[name].enabled && this.portalConfig.switching[name].algorithm === options.algorithm) {
                    switchNames.push(name);
                }
            }
        }

        switchNames.forEach((name) => {
            if (this.poolConfigs[newCoin].coin.algorithm !== this.portalConfig.switching[name].algorithm) {
                replyError(`Cannot switch a ${this.portalConfig.switching[name].algorithm} algo pool to coin ${newCoin} with ${this.poolConfigs[newCoin].coin.algorithm} algo`);
                return;
            }
            Object.keys(cluster.workers).forEach((id) => {
                cluster.workers[id].send({ type: 'coinswitch', coin: newCoin, switchName: name });
            });
        });

        reply('Switch message sent to pool workers');
    }

    startPaymentProcessor() {
        let enabledForAny = false;
        for (const pool in this.poolConfigs) {
            const p = this.poolConfigs[pool];
            const enabled = p.enabled && p.paymentProcessing && p.paymentProcessing.enabled;
            if (enabled) {
                enabledForAny = true; break;
            }
        }
        if (!enabledForAny) {
            return;
        }

        const worker = cluster.fork({ workerType: 'paymentProcessor', pools: JSON.stringify(this.poolConfigs) });
        worker.on('exit', (code, signal) => {
            const type = 'paymentProcessor';
            const now = Date.now();
            if (!this.exitCounters[type]) {
                this.exitCounters[type] = { count: 0, lastTime: now };
            }
            const counter = this.exitCounters[type];
            if (now - counter.lastTime < 10000) {
                counter.count++;
                if (counter.count >= 3) {
                    this.logger.error('Master', 'Payment Processor', 'Payment processor exited 3 times in 10s, not respawning to prevent loop');
                    return;
                }
            } else {
                counter.count = 1;
                counter.lastTime = now;
            }
            this.logger.error('Master', 'Payment Processor', 'Payment processor died, spawning replacement...');
            setTimeout(() => {
                this.startPaymentProcessor();
            }, 2000);
        });
    }

    startWebsite() {
        if (!this.portalConfig.website.enabled) {
            return;
        }
        const worker = cluster.fork({ workerType: 'website', pools: JSON.stringify(this.poolConfigs), portalConfig: JSON.stringify(this.portalConfig) });
        this.websiteWorker = worker;
        worker.on('exit', (code, signal) => {
            const type = 'website';
            const now = Date.now();
            if (!this.exitCounters[type]) {
                this.exitCounters[type] = { count: 0, lastTime: now };
            }
            const counter = this.exitCounters[type];
            if (now - counter.lastTime < 10000) {
                counter.count++;
                if (counter.count >= 3) {
                    this.logger.error('Master', 'Website', 'Website process exited 3 times in 10s, not respawning to prevent loop');
                    return;
                }
            } else {
                counter.count = 1;
                counter.lastTime = now;
            }
            this.logger.error('Master', 'Website', 'Website process died, spawning replacement...');
            setTimeout(() => {
                this.startWebsite();
            }, 2000);
        });
    }

    start() {
        this.poolConfigs = this.buildPoolConfigs();
        this.spawnPoolWorkers();
        this.startPaymentProcessor();
        this.startWebsite();
        this.startCliListener();
    }
}

module.exports = MasterController;
