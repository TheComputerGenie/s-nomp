const async = require('async');
const net = require('net');
const bignum = require('bignum');
const algos = require('./stratum/algoProperties.js');
const util = require('./stratum/util.js');
const Stratum = require('./stratum');

module.exports = function (logger) {

    const _this = this;

    const portalConfig = JSON.parse(process.env.portalConfig);
    const poolConfigs = JSON.parse(process.env.pools);

    const logSystem = 'Profit';

    // 
    // build status tracker for collecting coin market information
    //
    const profitStatus = {};
    const symbolToAlgorithmMap = {};
    Object.keys(poolConfigs).forEach((coin) => {

        const poolConfig = poolConfigs[coin];
        const algo = poolConfig.coin.algorithm;

        if (!profitStatus.hasOwnProperty(algo)) {
            profitStatus[algo] = {};
        }
        const coinStatus = {
            name: poolConfig.coin.name,
            symbol: poolConfig.coin.symbol,
            difficulty: 0,
            reward: 0,
            exchangeInfo: {}
        };
        profitStatus[algo][poolConfig.coin.symbol] = coinStatus;
        symbolToAlgorithmMap[poolConfig.coin.symbol] = algo;
    });


    // 
    // ensure we have something to switch
    //
    Object.keys(profitStatus).forEach((algo) => {
        if (Object.keys(profitStatus[algo]).length <= 1) {
            delete profitStatus[algo];
            Object.keys(symbolToAlgorithmMap).forEach((symbol) => {
                if (symbolToAlgorithmMap[symbol] === algo) {
                    delete symbolToAlgorithmMap[symbol];
                }
            });
        }
    });
    if (Object.keys(profitStatus).length == 0) {
        logger.debug(logSystem, 'Config', 'No alternative coins to switch to in current config, switching disabled.');
        return;
    }



    // Exchange APIs removed. Profit switching will only use on-chain daemon info
    // and local mining rate calculations. External exchange market collectors
    // were intentionally removed.

    // Exchange-specific collectors removed


    this.getCoindDaemonInfo = function (callback) {
        const daemonTasks = [];
        Object.keys(profitStatus).forEach((algo) => {
            Object.keys(profitStatus[algo]).forEach((symbol) => {
                const coinName = profitStatus[algo][symbol].name;
                const poolConfig = poolConfigs[coinName];
                const daemonConfig = poolConfig.paymentProcessing.daemon;
                daemonTasks.push((callback) => {
                    _this.getDaemonInfoForCoin(symbol, daemonConfig, callback);
                });
            });
        });

        if (daemonTasks.length == 0) {
            callback();
            return;
        }
        async.series(daemonTasks, (err) => {
            if (err) {
                callback(err);
                return;
            }
            callback(null);
        });
    };
    this.getDaemonInfoForCoin = function (symbol, cfg, callback) {
        const daemon = new Stratum.daemon.interface([cfg], ((severity, message) => {
            logger[severity](logSystem, symbol, message);
            callback(null); // fail gracefully for each coin
        }));

        daemon.cmd('getblocktemplate', [{ 'capabilities': ['coinbasetxn', 'workid', 'coinbase/append'] }], (result) => {
            if (result[0].error != null) {
                logger.error(logSystem, symbol, `Error while reading daemon info: ${JSON.stringify(result[0])}`);
                callback(null); // fail gracefully for each coin
                return;
            }
            const coinStatus = profitStatus[symbolToAlgorithmMap[symbol]][symbol];
            const response = result[0].response;

            // some shitcoins dont provide target, only bits, so we need to deal with both
            const target = response.target ? bignum(response.target, 16) : util.bignumFromBitsHex(response.bits);
            coinStatus.difficulty = parseFloat((diff1 / target.toNumber()).toFixed(9));
            logger.debug(logSystem, symbol, `difficulty is ${coinStatus.difficulty}`);

            coinStatus.reward = response.coinbasevalue / 100000000;
            callback(null);
        });
    };


    this.getMiningRate = function (callback) {
        const daemonTasks = [];
        Object.keys(profitStatus).forEach((algo) => {
            Object.keys(profitStatus[algo]).forEach((symbol) => {
                const coinStatus = profitStatus[symbolToAlgorithmMap[symbol]][symbol];
                coinStatus.blocksPerMhPerHour = 86400 / ((coinStatus.difficulty * Math.pow(2, 32)) / (1 * 1000 * 1000));
                coinStatus.coinsPerMhPerHour = coinStatus.reward * coinStatus.blocksPerMhPerHour;
            });
        });
        callback(null);
    };


    this.switchToMostProfitableCoins = function () {
        Object.keys(profitStatus).forEach((algo) => {
            const algoStatus = profitStatus[algo];

            let bestExchange;
            let bestCoin;
            let bestBtcPerMhPerHour = 0;

            Object.keys(profitStatus[algo]).forEach((symbol) => {
                const coinStatus = profitStatus[algo][symbol];

                Object.keys(coinStatus.exchangeInfo).forEach((exchange) => {
                    const exchangeData = coinStatus.exchangeInfo[exchange];
                    if (exchangeData.hasOwnProperty('BTC') && exchangeData['BTC'].hasOwnProperty('weightedBid')) {
                        const btcPerMhPerHour = exchangeData['BTC'].weightedBid * coinStatus.coinsPerMhPerHour;
                        if (btcPerMhPerHour > bestBtcPerMhPerHour) {
                            bestBtcPerMhPerHour = btcPerMhPerHour;
                            bestExchange = exchange;
                            bestCoin = profitStatus[algo][symbol].name;
                        }
                        coinStatus.btcPerMhPerHour = btcPerMhPerHour;
                        logger.debug(logSystem, 'CALC', `BTC/${symbol} on ${exchange} with ${coinStatus.btcPerMhPerHour.toFixed(8)} BTC/day per Mh/s`);
                    }
                    if (exchangeData.hasOwnProperty('LTC') && exchangeData['LTC'].hasOwnProperty('weightedBid')) {
                        const btcPerMhPerHour = (exchangeData['LTC'].weightedBid * coinStatus.coinsPerMhPerHour) * exchangeData['LTC'].ltcToBtc;
                        if (btcPerMhPerHour > bestBtcPerMhPerHour) {
                            bestBtcPerMhPerHour = btcPerMhPerHour;
                            bestExchange = exchange;
                            bestCoin = profitStatus[algo][symbol].name;
                        }
                        coinStatus.btcPerMhPerHour = btcPerMhPerHour;
                        logger.debug(logSystem, 'CALC', `LTC/${symbol} on ${exchange} with ${coinStatus.btcPerMhPerHour.toFixed(8)} BTC/day per Mh/s`);
                    }
                });
            });
            logger.debug(logSystem, 'RESULT', `Best coin for ${algo} is ${bestCoin} on ${bestExchange} with ${bestBtcPerMhPerHour.toFixed(8)} BTC/day per Mh/s`);


            const client = net.connect(portalConfig.cliPort, () => {
                client.write(`${JSON.stringify({
                    command: 'coinswitch',
                    params: [bestCoin],
                    options: { algorithm: algo }
                })}\n`);
            }).on('error', (error) => {
                if (error.code === 'ECONNREFUSED') {
                    logger.error(logSystem, 'CLI', `Could not connect to NOMP instance on port ${portalConfig.cliPort}`);
                } else {
                    logger.error(logSystem, 'CLI', `Socket error ${JSON.stringify(error)}`);
                }
            });

        });
    };


    const checkProfitability = function () {
        logger.debug(logSystem, 'Check', 'Collecting profitability data.');

        const profitabilityTasks = [];
        // Exchange collectors removed; only use on-chain daemon info and mining rate
        profitabilityTasks.push(_this.getCoindDaemonInfo);
        profitabilityTasks.push(_this.getMiningRate);

        // has to be series 
        async.series(profitabilityTasks, (err) => {
            if (err) {
                logger.error(logSystem, 'Check', `Error while checking profitability: ${err}`);
                return;
            }
            //
            // TODO offer support for a userConfigurable function for deciding on coin to override the default
            // 
            _this.switchToMostProfitableCoins();
        });
    };
    setInterval(checkProfitability, portalConfig.profitSwitch.updateInterval * 1000);

};
