const fs = require('fs');
const path = require('path');
const os = require('os');
const cluster = require('cluster');

const async = require('async');
const extend = require('extend');

const redis = require('redis');

const PoolLogger = require('./libs/logUtil.js');
const CliListener = require('./libs/cliListener.js');
const PoolWorker = require('./libs/poolWorker.js');
const PaymentProcessor = require('./libs/paymentProcessor.js');
const Website = require('./libs/website.js');
const ProfitSwitch = require('./libs/profitSwitch.js');
const CreateRedisClient = require('./libs/createRedisClient.js');

const algos = require('./libs/stratum/algoProperties.js');
const COIN_CONSTANTS = require('./libs/coinConstants.js');

JSON.minify = JSON.minify || require('node-json-minify');

if (!fs.existsSync('config.json')) {
    console.log('config.json file does not exist. Read the installation/setup instructions.');
    return;
}

const portalConfig = JSON.parse(JSON.minify(fs.readFileSync('config.json', { encoding: 'utf8' })));
let poolConfigs;


const logger = new PoolLogger({
    logLevel: portalConfig.logLevel,
    logColors: portalConfig.logColors
});

try {
    require('newrelic');
    if (cluster.isMaster) {
        logger.debug('NewRelic', 'Monitor', 'New Relic initiated');
    }
} catch (e) { }


//Try to give process ability to handle 100k concurrent connections
try {
    const posix = require('posix');
    try {
        posix.setrlimit('nofile', { soft: 100000, hard: 100000 });
    } catch (e) {
        if (cluster.isMaster) {
            logger.warn('POSIX', 'Connection Limit', '(Safe to ignore) Must be ran as root to increase resource limits');
        }
    } finally {
        // Find out which user used sudo through the environment variable
        const uid = parseInt(process.env.SUDO_UID);
        // Set our server's uid to that user
        if (uid) {
            process.setuid(uid);
            logger.debug('POSIX', 'Connection Limit', `Raised to 100K concurrent connections, now running as non-root user: ${process.getuid()}`);
        }
    }
} catch (e) {
    if (cluster.isMaster) {
        logger.debug('POSIX', 'Connection Limit', '(Safe to ignore) POSIX module not installed and resource (connection) limit was not raised');
    }
}

if (cluster.isWorker) {

    switch (process.env.workerType) {
        case 'pool':
            new PoolWorker(logger);
            break;
        case 'paymentProcessor':
            PaymentProcessor();
            break;
        case 'website':
            new Website(logger);
            break;
        case 'profitSwitch':
            new ProfitSwitch(logger);
            break;
    }

    return;
}


//Read all pool configs from pool_configs and join them with their coin profile
const buildPoolConfigs = function () {
    const configs = {};
    const configDir = 'pool_configs/';

    const poolConfigFiles = [];


    /* Get filenames of pool config json files that are enabled */
    fs.readdirSync(configDir).forEach((file) => {
        if (!fs.existsSync(configDir + file) || path.extname(configDir + file) !== '.json') {
            return;
        }
        const poolOptions = JSON.parse(JSON.minify(fs.readFileSync(configDir + file, { encoding: 'utf8' })));
        if (!poolOptions.enabled) {
            return;
        }
        poolOptions.fileName = file;
        poolConfigFiles.push(poolOptions);
    });


    /* Ensure no pool uses any of the same ports as another pool */
    for (let i = 0; i < poolConfigFiles.length; i++) {
        const ports = Object.keys(poolConfigFiles[i].ports);
        for (let f = 0; f < poolConfigFiles.length; f++) {
            if (f === i) {
                continue;
            }
            const portsF = Object.keys(poolConfigFiles[f].ports);
            for (let g = 0; g < portsF.length; g++) {
                if (ports.indexOf(portsF[g]) !== -1) {
                    logger.error('Master', poolConfigFiles[f].fileName, `Has same configured port of ${portsF[g]} as ${poolConfigFiles[i].fileName}`);
                    process.exit(1);
                    return;
                }
            }
        }
    }


    poolConfigFiles.forEach((poolOptions) => {

        // Since we only support Verus Coin now, use hardcoded constants
        const coinProfile = { ...COIN_CONSTANTS }; // Make a copy to avoid modifying constants
        poolOptions.coin = coinProfile;
        poolOptions.coin.name = poolOptions.coin.name.toLowerCase();
        poolOptions.redis = portalConfig.redis;

        if (poolOptions.coin.name in configs) {

            logger.error('Master', poolOptions.fileName, `Pool has same configured coin name ${poolOptions.coin.name} as pool config ${configs[poolOptions.coin.name].fileName}`);

            process.exit(1);
            return;
        }

        for (const option in portalConfig.defaultPoolConfigs) {
            if (!(option in poolOptions)) {
                const toCloneOption = portalConfig.defaultPoolConfigs[option];
                let clonedOption = {};
                if (toCloneOption.constructor === Object) {
                    extend(true, clonedOption, toCloneOption);
                } else {
                    clonedOption = toCloneOption;
                }
                poolOptions[option] = clonedOption;
            }
        }


        configs[poolOptions.coin.name] = poolOptions;

        if (!(coinProfile.algorithm in algos)) {
            logger.error('Master', coinProfile.name, `Cannot run a pool for unsupported algorithm "${coinProfile.algorithm}"`);
            delete configs[poolOptions.coin.name];
        }

    });
    return configs;
};

function roundTo(n, digits) {
    if (digits === undefined) {
        digits = 0;
    }
    const multiplicator = Math.pow(10, digits);
    n = parseFloat((n * multiplicator).toFixed(11));
    const test = (Math.round(n) / multiplicator);
    return +(test.toFixed(digits));
}

const _lastStartTimes = [];
const _lastShareTimes = [];

const spawnPoolWorkers = function () {

    let redisConfig;
    let connection;

    Object.keys(poolConfigs).forEach((coin) => {
        const pcfg = poolConfigs[coin];
        if (!Array.isArray(pcfg.daemons) || pcfg.daemons.length < 1) {
            logger.error('Master', coin, 'No daemons configured so a pool cannot be started for this coin.');
            delete poolConfigs[coin];
        } else if (!connection) {
            redisConfig = pcfg.redis;
            connection = CreateRedisClient(redisConfig);
            if (redisConfig.password != '') {
                connection.auth(redisConfig.password);
                connection.on('error', (err) => {
                    logger.error('redis', coin, `An error occured while attempting to authenticate redis: ${err}`);
                });
            }
            connection.on('ready', () => {
                logger.debug('PPLNT', coin, `TimeShare processing setup with redis (${connection.snompEndpoint})`);
            });
        }
    });

    if (Object.keys(poolConfigs).length === 0) {
        logger.warn('Master', 'PoolSpawner', 'No pool configs exists or are enabled in pool_configs folder. No pools spawned.');
        return;
    }


    const serializedConfigs = JSON.stringify(poolConfigs);

    const numForks = (function () {
        if (!portalConfig.clustering || !portalConfig.clustering.enabled) {
            return 1;
        }
        if (portalConfig.clustering.forks === 'auto') {
            return os.cpus().length;
        }
        if (!portalConfig.clustering.forks || isNaN(portalConfig.clustering.forks)) {
            return 1;
        }
        return portalConfig.clustering.forks;
    })();

    const poolWorkers = {};

    const createPoolWorker = function (forkId) {
        const worker = cluster.fork({
            workerType: 'pool',
            forkId: forkId,
            pools: serializedConfigs,
            portalConfig: JSON.stringify(portalConfig)
        });
        worker.forkId = forkId;
        worker.type = 'pool';
        poolWorkers[forkId] = worker;
        worker.on('exit', (code, signal) => {
            logger.error('Master', 'PoolSpawner', `Fork ${forkId} died, spawning replacement worker...`);
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
                    // pplnt time share tracking of workers
                    if (msg.isValidShare && !msg.isValidBlock) {
                        const now = Date.now();
                        let lastShareTime = now;
                        let lastStartTime = now;
                        const workerAddress = msg.data.worker.split('.')[0];

                        // if needed, initialize PPLNT objects for coin
                        if (!_lastShareTimes[msg.coin]) {
                            _lastShareTimes[msg.coin] = {};
                        }
                        if (!_lastStartTimes[msg.coin]) {
                            _lastStartTimes[msg.coin] = {};
                        }

                        // did they just join in this round?
                        if (!_lastShareTimes[msg.coin][workerAddress] || !_lastStartTimes[msg.coin][workerAddress]) {
                            _lastShareTimes[msg.coin][workerAddress] = now;
                            _lastStartTimes[msg.coin][workerAddress] = now;
                            logger.debug('PPLNT', msg.coin, `Thread ${msg.thread}`, `${workerAddress} joined.`);
                        }
                        // grab last times from memory objects
                        if (_lastShareTimes[msg.coin][workerAddress] != null && _lastShareTimes[msg.coin][workerAddress] > 0) {
                            lastShareTime = _lastShareTimes[msg.coin][workerAddress];
                            lastStartTime = _lastStartTimes[msg.coin][workerAddress];
                        }

                        const redisCommands = [];

                        // if its been less than 15 minutes since last share was submitted by any stratum
                        const lastShareTimeUnified = Math.max(redisCommands.push(['hget', `${msg.coin}:lastSeen`, workerAddress]), lastShareTime);
                        const timeChangeSec = roundTo(Math.max(now - lastShareTimeUnified, 0) / 1000, 4);
                        //var timeChangeTotal = roundTo(Math.max(now - lastStartTime, 0) / 1000, 4);
                        if (timeChangeSec < 900) {
                            // loyal miner keeps mining :)
                            redisCommands.push(['hincrbyfloat', `${msg.coin}:shares:timesCurrent`, `${workerAddress}.${poolConfigs[msg.coin].poolId}`, timeChangeSec]);
                            //logger.debug('PPLNT', msg.coin, 'Thread '+msg.thread, workerAddress+':{totalTimeSec:'+timeChangeTotal+', timeChangeSec:'+timeChangeSec+'}');
                            connection.multi(redisCommands).exec((err, replies) => {
                                if (err) {
                                    logger.error('PPLNT', msg.coin, `Thread ${msg.thread}`, `Error with time share processor call to redis ${JSON.stringify(err)}`);
                                }
                            });
                        } else {
                            // they just re-joined the pool
                            _lastStartTimes[workerAddress] = now;
                            logger.debug('PPLNT', msg.coin, `Thread ${msg.thread}`, `${workerAddress} re-joined.`);
                        }

                        // track last time share
                        _lastShareTimes[msg.coin][workerAddress] = now;
                    }
                    if (msg.isValidBlock) {
                        // reset pplnt share times for next round
                        _lastShareTimes[msg.coin] = {};
                        _lastStartTimes[msg.coin] = {};
                    }
                    break;
            }
        });
    };

    let i = 0;
    const spawnInterval = setInterval(() => {
        createPoolWorker(i);
        i++;
        if (i === numForks) {
            clearInterval(spawnInterval);
            logger.debug('Master', 'PoolSpawner', `Spawned ${Object.keys(poolConfigs).length} pool(s) on ${numForks} thread(s)`);
        }
    }, 250);

};


const startCliListener = function () {

    const cliPort = portalConfig.cliPort;
    const cliServer = portalConfig.cliServer || '127.0.0.1';

    const listener = new CliListener(cliServer, cliPort);
    listener.on('log', (text) => {
        logger.debug('Master', 'CLI', text);
    }).on('command', (command, params, options, reply) => {

        switch (command) {
            case 'blocknotify':
                Object.keys(cluster.workers).forEach((id) => {
                    cluster.workers[id].send({ type: 'blocknotify', coin: params[0], hash: params[1] });
                });
                reply('Pool workers notified');
                break;
            case 'coinswitch':
                processCoinSwitchCommand(params, options, reply);
                break;
            case 'reloadpool':
                Object.keys(cluster.workers).forEach((id) => {
                    cluster.workers[id].send({ type: 'reloadpool', coin: params[0] });
                });
                reply(`reloaded pool ${params[0]}`);
                break;
            default:
                reply(`unrecognized command "${command}"`);
                break;
        }
    }).start();
};


const processCoinSwitchCommand = function (params, options, reply) {

    const logSystem = 'CLI';
    const logComponent = 'coinswitch';

    const replyError = function (msg) {
        reply(msg);
        logger.error(logSystem, logComponent, msg);
    };

    if (!params[0]) {
        replyError('Coin name required');
        return;
    }

    if (!params[1] && !options.algorithm) {
        replyError('If switch key is not provided then algorithm options must be specified');
        return;
    } else if (params[1] && !portalConfig.switching[params[1]]) {
        replyError(`Switch key not recognized: ${params[1]}`);
        return;
    } else if (options.algorithm && !Object.keys(portalConfig.switching).filter((s) => {
        return portalConfig.switching[s].algorithm === options.algorithm;
    })[0]) {
        replyError(`No switching options contain the algorithm ${options.algorithm}`);
        return;
    }

    const messageCoin = params[0].toLowerCase();
    const newCoin = Object.keys(poolConfigs).filter((p) => {
        return p.toLowerCase() === messageCoin;
    })[0];

    if (!newCoin) {
        replyError(`Switch message to coin that is not recognized: ${messageCoin}`);
        return;
    }


    const switchNames = [];

    if (params[1]) {
        switchNames.push(params[1]);
    } else {
        for (const name in portalConfig.switching) {
            if (portalConfig.switching[name].enabled && portalConfig.switching[name].algorithm === options.algorithm) {
                switchNames.push(name);
            }
        }
    }

    switchNames.forEach((name) => {
        if (poolConfigs[newCoin].coin.algorithm !== portalConfig.switching[name].algorithm) {
            replyError(`Cannot switch a ${portalConfig.switching[name].algorithm
                } algo pool to coin ${newCoin} with ${poolConfigs[newCoin].coin.algorithm} algo`);
            return;
        }

        Object.keys(cluster.workers).forEach((id) => {
            cluster.workers[id].send({ type: 'coinswitch', coin: newCoin, switchName: name });
        });
    });

    reply('Switch message sent to pool workers');

};



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
    worker.on('exit', (code, signal) => {
        logger.error('Master', 'Website', 'Website process died, spawning replacement...');
        setTimeout(() => {
            startWebsite(portalConfig, poolConfigs);
        }, 2000);
    });
};


const startProfitSwitch = function () {

    if (!portalConfig.profitSwitch || !portalConfig.profitSwitch.enabled) {
        //logger.error('Master', 'Profit', 'Profit auto switching disabled');
        return;
    }

    const worker = cluster.fork({
        workerType: 'profitSwitch',
        pools: JSON.stringify(poolConfigs),
        portalConfig: JSON.stringify(portalConfig)
    });
    worker.on('exit', (code, signal) => {
        logger.error('Master', 'Profit', 'Profit switching process died, spawning replacement...');
        setTimeout(() => {
            startWebsite(portalConfig, poolConfigs);
        }, 2000);
    });
};



(function init() {

    poolConfigs = buildPoolConfigs();

    spawnPoolWorkers();

    startPaymentProcessor();

    startWebsite();

    startProfitSwitch();

    startCliListener();

})();
