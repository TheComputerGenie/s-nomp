const redis = require('redis');
const async = require('async');

const stats = require('./stats.js');

module.exports = function (logger, portalConfig, poolConfigs) {

    const _this = this;

    const portalStats = this.stats = new stats(logger, portalConfig, poolConfigs);

    this.liveStatConnections = {};

    this.handleApiRequest = function (req, res, next) {

        switch (req.params.method) {
            case 'stats':
                res.header('Content-Type', 'application/json');
                res.end(portalStats.statsString);
                return;
            case 'pool_stats':
                res.header('Content-Type', 'application/json');
                res.end(JSON.stringify(portalStats.statPoolHistory));
                return;
            case 'blocks':
            case 'getblocksstats':
                portalStats.getBlocks((data) => {
                    res.header('Content-Type', 'application/json');
                    res.end(JSON.stringify(data));
                });
                break;
            case 'worker_balances':
                res.header('Content-Type', 'application/json');
                if (req.url.indexOf('?') > 0) {
                    const url_parms = req.url.split('?');
                    if (url_parms.length > 0) {
                        let address = url_parms[1] || null;
                        if (address != null && address.length > 0) {
                            address = address.split('.')[0];
                            //portalStats.getPoolBalancesByAddress(address, function(balances) {
                            //	res.end(JSON.stringify(balances));
                            //});
                            portalStats.getPoolBalancesByAddress(address, (balances) => {
                                const formattedBalances = {};

                                balances.forEach((balance) => {
                                    if (!formattedBalances[balance.pool]) {
                                        formattedBalances[balance.pool] = {
                                            name: balance.pool,
                                            totalPaid: 0,
                                            totalBalance: 0,
                                            totalImmature: 0,
                                            workers: []
                                        };
                                    }

                                    formattedBalances[balance.pool].totalPaid += balance.paid;
                                    formattedBalances[balance.pool].totalBalance += balance.balance;
                                    formattedBalances[balance.pool].totalImmature += balance.immature;

                                    formattedBalances[balance.pool].workers.push({
                                        name: balance.worker,
                                        balance: balance.balance,
                                        paid: balance.paid,
                                        immature: balance.immature
                                    });
                                    formattedBalances[balance.pool].totalPaid = (Math.round(formattedBalances[balance.pool].totalPaid * 100000000) / 100000000);
                                    formattedBalances[balance.pool].totalBalance = (Math.round(formattedBalances[balance.pool].totalBalance * 100000000) / 100000000);
                                    formattedBalances[balance.pool].totalImmature = (Math.round(formattedBalances[balance.pool].totalImmature * 100000000) / 100000000);
                                });

                                const finalBalances = Object.values(formattedBalances);
                                res.end(JSON.stringify(finalBalances));
                            });
                        } else {
                            res.end(JSON.stringify({ result: 'error', message: 'Invalid wallet address' }));
                        }
                    } else {
                        res.end(JSON.stringify({ result: 'error', message: 'Invalid URL parameters' }));
                    }
                } else {
                    res.end(JSON.stringify({ result: 'error', message: 'URL parameters not found' }));
                }
                return;
            case 'payments':
                const poolBlocks = [];
                for (const pool in portalStats.stats.pools) {
                    poolBlocks.push({ name: pool, pending: portalStats.stats.pools[pool].pending, payments: portalStats.stats.pools[pool].payments });
                }
                res.header('Content-Type', 'application/json');
                res.end(JSON.stringify(poolBlocks));
                return;
            case 'worker_stats':
                res.header('Content-Type', 'application/json');
                if (req.url.indexOf('?') > 0) {
                    const url_parms = req.url.split('?');
                    if (url_parms.length > 0) {
                        const history = {};
                        const workers = {};
                        let address = url_parms[1] || null;
                        //res.end(portalStats.getWorkerStats(address));
                        if (address != null && address.length > 0) {
                            // make sure it is just the miners address
                            address = address.split('.')[0];
                            // get miners balance along with worker balances
                            portalStats.getBalanceByAddress(address, (balances) => {
                                // get current round share total
                                portalStats.getTotalSharesByAddress(address, (shares) => {
                                    let totalHash = parseFloat(0.0);
                                    const totalShares = shares;
                                    let networkSols = 0;
                                    for (const h in portalStats.statHistory) {
                                        for (const pool in portalStats.statHistory[h].pools) {
                                            for (const w in portalStats.statHistory[h].pools[pool].workers) {
                                                if (w.startsWith(address)) {
                                                    if (history[w] == null) {
                                                        history[w] = [];
                                                    }
                                                    if (portalStats.statHistory[h].pools[pool].workers[w].hashrate) {
                                                        history[w].push({ time: portalStats.statHistory[h].time, hashrate: portalStats.statHistory[h].pools[pool].workers[w].hashrate });
                                                    }
                                                }
                                            }
                                            // order check...
                                            //console.log(portalStats.statHistory[h].time);
                                        }
                                    }
                                    for (const pool in portalStats.stats.pools) {
                                        for (const w in portalStats.stats.pools[pool].workers) {
                                            if (w.startsWith(address)) {
                                                workers[w] = portalStats.stats.pools[pool].workers[w];
                                                for (const b in balances.balances) {
                                                    if (w == balances.balances[b].worker) {
                                                        workers[w].paid = balances.balances[b].paid;
                                                        workers[w].balance = balances.balances[b].balance;
                                                    }
                                                }
                                                workers[w].balance = (workers[w].balance || 0);
                                                workers[w].paid = (workers[w].paid || 0);
                                                totalHash += portalStats.stats.pools[pool].workers[w].hashrate;
                                                networkSols = portalStats.stats.pools[pool].poolStats.networkSols;
                                            }
                                        }
                                    }
                                    res.end(JSON.stringify({ miner: address, totalHash: totalHash, totalShares: totalShares, networkSols: networkSols, immature: balances.totalImmature, balance: balances.totalHeld, paid: balances.totalPaid, workers: workers, history: history }));
                                });
                            });
                        } else {
                            res.end(JSON.stringify({ result: 'error' }));
                        }
                    } else {
                        res.end(JSON.stringify({ result: 'error' }));
                    }
                } else {
                    res.end(JSON.stringify({ result: 'error' }));
                }
                return;
            case 'live_stats':
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                });
                res.write('\n');
                const uid = Math.random().toString();
                _this.liveStatConnections[uid] = res;
                res.flush();
                req.on('close', () => {
                    delete _this.liveStatConnections[uid];
                });
                return;
            default:
                next();
        }
    };

    this.handleAdminApiRequest = function (req, res, next) {
        switch (req.params.method) {
            case 'pools': {
                res.end(JSON.stringify({ result: poolConfigs }));
                return;
            }
            default:
                next();
        }
    };

};
