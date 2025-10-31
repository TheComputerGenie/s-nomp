const https = require('https');
const fs = require('fs');
const path = require('path');

const async = require('async');
const watch = require('node-watch');
const redis = require('redis');

const dot = require('dot');
const express = require('express');
const bodyParser = require('body-parser');
const compress = require('compression');

const Stratum = require('stratum-pool');
const util = require('stratum-pool/lib/util.js');

const api = require('./api.js');

const CreateRedisClient = require('./createRedisClient.js');

module.exports = function(logger){

    dot.templateSettings.strip = false;

    const portalConfig = JSON.parse(process.env.portalConfig);
    const poolConfigs = JSON.parse(process.env.pools);

    const websiteConfig = portalConfig.website;

    const portalApi = new api(logger, portalConfig, poolConfigs);
    const portalStats = portalApi.stats;

    const logSystem = 'Website';


    const pageFiles = {
        'index.html': 'index',
        'home.html': '',
        'getting_started.html': 'getting_started',
        'stats.html': 'stats',
        'tbs.html': 'tbs',
        'workers.html': 'workers',
        'api.html': 'api',
        'admin.html': 'admin',
        'mining_key.html': 'mining_key',
        'miner_stats.html': 'miner_stats',
        'payments.html': 'payments'
    };

    const pageTemplates = {};

    const pageProcessed = {};
    const indexesProcessed = {};

    let keyScriptTemplate = '';
    let keyScriptProcessed = '';

    const processTemplates = function(){

        for (const pageName in pageTemplates){
            if (pageName === 'index') {
                continue;
            }
            pageProcessed[pageName] = pageTemplates[pageName]({
                poolsConfigs: poolConfigs,
                stats: portalStats.stats,
                portalConfig: portalConfig
            });
            indexesProcessed[pageName] = pageTemplates.index({
                page: pageProcessed[pageName],
                selected: pageName,
                stats: portalStats.stats,
                poolConfigs: poolConfigs,
                portalConfig: portalConfig
            });
        }

        //logger.debug(logSystem, 'Stats', 'Website updated to latest stats');
    };



    const readPageFiles = function(files){
        async.each(files, (fileName, callback) =>{
            const filePath = `website/${  fileName === 'index.html' ? '' : 'pages/'  }${fileName}`;
            fs.readFile(filePath, 'utf8', (err, data) =>{
                const pTemp = dot.template(data);
                pageTemplates[pageFiles[fileName]] = pTemp;
                callback();
            });
        }, (err) =>{
            if (err){
                console.log(`error reading files for creating dot templates: ${ JSON.stringify(err)}`);
                return;
            }
            processTemplates();
        });
    };


    // if an html file was changed reload it
    /* requires node-watch 0.5.0 or newer */
    watch(['./website', './website/pages'], (evt, filename) =>{
        let basename;
        // support older versions of node-watch automatically
        if (!filename && evt) {
            basename = path.basename(evt);
        } else {
            basename = path.basename(filename);
        }
        
        if (basename in pageFiles){
            readPageFiles([basename]);
            logger.special(logSystem, 'Server', `Reloaded file ${  basename}`);
        }
    });

    portalStats.getGlobalStats(() =>{
        readPageFiles(Object.keys(pageFiles));
    });

    const buildUpdatedWebsite = function(){
        portalStats.getGlobalStats(() =>{
            processTemplates();

            const statData = `data: ${  JSON.stringify(portalStats.stats)  }\n\n`;
            for (const uid in portalApi.liveStatConnections){
                const res = portalApi.liveStatConnections[uid];
                res.write(statData);
            }

        });
    };

    setInterval(buildUpdatedWebsite, websiteConfig.stats.updateInterval * 1000);

    const buildKeyScriptPage = function(){
        async.waterfall([
            function(callback){
                const client = CreateRedisClient(portalConfig.redis);
                if (portalConfig.redis.password) {
                    client.auth(portalConfig.redis.password);
                }
                client.hgetall('coinVersionBytes', (err, coinBytes) =>{
                    if (err){
                        client.quit();
                        return callback(`Failed grabbing coin version bytes from redis ${  JSON.stringify(err)}`);
                    }
                    callback(null, client, coinBytes || {});
                });
            },
            function (client, coinBytes, callback){
                const enabledCoins = Object.keys(poolConfigs).map((c) =>{
                    return c.toLowerCase();
                });
                const missingCoins = [];
                enabledCoins.forEach((c) =>{
                    if (!(c in coinBytes)) {
                        missingCoins.push(c);
                    }
                });
                callback(null, client, coinBytes, missingCoins);
            },
            function(client, coinBytes, missingCoins, callback){
                const coinsForRedis = {};
                async.each(missingCoins, (c, cback) =>{
                    const coinInfo = (function(){
                        for (const pName in poolConfigs){
                            if (pName.toLowerCase() === c) {
                                return {
                                    daemon: poolConfigs[pName].paymentProcessing.daemon,
                                    address: poolConfigs[pName].address
                                };
                            }
                        }
                    })();
                    const daemon = new Stratum.daemon.interface([coinInfo.daemon], ((severity, message) =>{
                        logger[severity](logSystem, c, message);
                    }));
                    daemon.cmd('dumpprivkey', [coinInfo.address], (result) =>{
                        if (result[0].error){
                            logger.error(logSystem, c, `Could not dumpprivkey for ${  c  } ${  JSON.stringify(result[0].error)}`);
                            cback();
                            return;
                        }

                        const vBytePub = util.getVersionByte(coinInfo.address)[0];
                        const vBytePriv = util.getVersionByte(result[0].response)[0];

                        coinBytes[c] = `${vBytePub.toString()  },${  vBytePriv.toString()}`;
                        coinsForRedis[c] = coinBytes[c];
                        cback();
                    });
                }, (err) =>{
                    callback(null, client, coinBytes, coinsForRedis);
                });
            },
            function(client, coinBytes, coinsForRedis, callback){
                if (Object.keys(coinsForRedis).length > 0){
                    client.hmset('coinVersionBytes', coinsForRedis, (err) =>{
                        if (err) {
                            logger.error(logSystem, 'Init', `Failed inserting coin byte version into redis ${  JSON.stringify(err)}`);
                        }
                        client.quit();
                    });
                } else{
                    client.quit();
                }
                callback(null, coinBytes);
            }
        ], (err, coinBytes) =>{
            if (err){
                logger.error(logSystem, 'Init', err);
                return;
            }
            try{
                keyScriptTemplate = dot.template(fs.readFileSync('website/key.html', {encoding: 'utf8'}));
                keyScriptProcessed = keyScriptTemplate({coins: coinBytes});
            } catch(e){
                logger.error(logSystem, 'Init', 'Failed to read key.html file');
            }
        });

    };
    buildKeyScriptPage();

    const getPage = function(pageId){
        if (pageId in pageProcessed){
            const requestedPage = pageProcessed[pageId];
            return requestedPage;
        }
    };

    const minerpage = function(req, res, next){
        let address = req.params.address || null;
        if (address != null) {
            address = address.split('.')[0];
            portalStats.getBalanceByAddress(address, () =>{
                processTemplates();
                res.header('Content-Type', 'text/html');
                res.end(indexesProcessed['miner_stats']);
            });
        } else {
            next();
        }
    };

    const payout = function(req, res, next){
        const address = req.params.address || null;
        if (address != null){
            portalStats.getPayout(address, (data) =>{
                res.write(data.toString());
                res.end();
            });
        } else {
            next();
        }
    };

    const shares = function(req, res, next){
        portalStats.getCoins(() =>{
            processTemplates();
            res.end(indexesProcessed['user_shares']);

        });
    };

    const usershares = function(req, res, next){
        const coin = req.params.coin || null;
        if(coin != null){
            portalStats.getCoinTotals(coin, null, () =>{
                processTemplates();
                res.end(indexesProcessed['user_shares']);
            });
        } else {
            next();
        }
    };

    const route = function(req, res, next){
        const pageId = req.params.page || '';
        if (pageId in indexesProcessed){
            res.header('Content-Type', 'text/html');
            res.end(indexesProcessed[pageId]);
        } else {
            next();
        }

    };



    const app = express();


    app.use(bodyParser.json());

    app.get('/get_page', (req, res, next) =>{
        const requestedPage = getPage(req.query.id);
        if (requestedPage){
            res.end(requestedPage);
            return;
        }
        next();
    });

    app.get('/key.html', (req, res, next) =>{
        res.end(keyScriptProcessed);
    });

    //app.get('/stats/shares/:coin', usershares);
    //app.get('/stats/shares', shares);
    //app.get('/payout/:address', payout);
    app.use(compress());
    app.get('/workers/:address', minerpage);
    app.get('/:page', route);
    app.get('/', route);

    app.get('/api/:method', (req, res, next) =>{
        portalApi.handleApiRequest(req, res, next);
    });

    app.post('/api/admin/:method', (req, res, next) =>{
        if (portalConfig.website
            && portalConfig.website.adminCenter
            && portalConfig.website.adminCenter.enabled){
            if (portalConfig.website.adminCenter.password === req.body.password) {
                portalApi.handleAdminApiRequest(req, res, next);
            } else {
                res.send(401, JSON.stringify({error: 'Incorrect Password'}));
            }

        } else {
            next();
        }

    });

    app.use(compress());
    app.use('/static', express.static('website/static'));

    app.use((err, req, res, next) =>{
        console.error(err.stack);
        res.send(500, 'Something broke!');
    });

    try {        
        if (portalConfig.website.tlsOptions && portalConfig.website.tlsOptions.enabled === true) {
            const TLSoptions = {
                key: fs.readFileSync(portalConfig.website.tlsOptions.key),
                cert: fs.readFileSync(portalConfig.website.tlsOptions.cert)
            };

            https.createServer(TLSoptions, app).listen(portalConfig.website.port, portalConfig.website.host, () => {
                logger.debug(logSystem, 'Server', `TLS Website started on ${  portalConfig.website.host  }:${  portalConfig.website.port}`);
            });        
        } else {
            app.listen(portalConfig.website.port, portalConfig.website.host, () => {
                logger.debug(logSystem, 'Server', `Website started on ${  portalConfig.website.host  }:${  portalConfig.website.port}`);
            });
        }
    } catch(e){
        console.log(e);
        logger.error(logSystem, 'Server', `Could not start website on ${  portalConfig.website.host  }:${  portalConfig.website.port
        } - its either in use or you do not have permission`);
    }


};
