const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { pipeline } = require('stream');

const Stratum = require('./stratum');
const util = require('./stratum/util.js');
const api = require('./api.js');
const CreateRedisClient = require('./createRedisClient.js');
const PoolLogger = require('./PoolLogger.js');
const { safeParseEnvJSON, watchPaths, serveStatic, createMiniApp } = require('./webUtil.js');

// Use the official doT package instead of the local implementation
let dot;
try {
    dot = require('dot');
} catch (e) {
    // Fallback: provide a minimal shim that preserves the api used in this file
    dot = { templateSettings: { strip: false }, template: (t) => () => t };
}

// Ensure the strip setting is explicitly set as the original code expected
if (!dot.templateSettings) dot.templateSettings = {};
dot.templateSettings.strip = false;


/**
 * Initialize and start the website server for the portal.
 * Reads templates, serves static assets, and wires API endpoints.
 * This function is called from the main init script.
 *
 * No arguments; configuration is read from environment via safeParseEnvJSON('portalConfig').
 */
module.exports = function () {
    const portalConfig = safeParseEnvJSON('portalConfig') || {};

    const logger = new PoolLogger({ logLevel: portalConfig.logLevel, logColors: portalConfig.logColors });
    const poolConfigs = safeParseEnvJSON('pools') || {};
    const websiteConfig = (portalConfig && portalConfig.website) ? portalConfig.website : {};
    const portalApi = new api(logger, portalConfig, poolConfigs);
    const portalStats = portalApi.stats || {};
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


    const readPageFiles = function (files) {
        Promise.all(files.map(fileName => new Promise((resolve, reject) => {
            const relPath = `website/${fileName === 'index.html' ? '' : 'pages/'}${fileName}`;
            const filePath = path.join(__dirname, '..', relPath);
            fs.readFile(filePath, 'utf8', (err, data) => {
                if (err) {
                    logger.error(logSystem, 'Template', `Failed to read template file: ${filePath}`);
                    reject(err);
                    return;
                }
                try {
                    const pTemp = dot.template(data);
                    pageTemplates[pageFiles[fileName]] = pTemp;
                    resolve();
                } catch (e) {
                    logger.error(logSystem, 'Template', `Failed compiling template ${filePath}: ${e}`);
                    reject(e);
                }
            });
        }))).then(() => {
            processTemplates();
        }).catch((err) => {
            logger.error(logSystem, 'Template', `error reading files for creating dot templates: ${err && err.message ? err.message : err}`);
        });
    };


    const processTemplates = function () {
        Object.keys(pageTemplates).forEach((pageName) => {
            if (pageName === 'index') {
                return;
            }
            const tpl = pageTemplates[pageName];
            if (typeof tpl !== 'function') {
                logger.error(logSystem, 'Template', `Template for page ${pageName} is not a function`);
                return;
            }
            try {
                pageProcessed[pageName] = tpl({ poolsConfigs: poolConfigs, stats: portalStats.stats, portalConfig: portalConfig });
            } catch (e) {
                logger.error(logSystem, 'Template', `Failed rendering template for ${pageName}: ${e}`);
                pageProcessed[pageName] = `<!-- rendering error for ${pageName} -->`;
            }
        });
        // Decouple index processing from page processing to avoid re-rendering everything
        Object.keys(pageTemplates).forEach(pageName => {
            if (pageName === 'index' || !pageProcessed[pageName]) return;
            if (typeof pageTemplates.index === 'function') {
                try {
                    indexesProcessed[pageName] = pageTemplates.index({ page: pageProcessed[pageName], selected: pageName, stats: portalStats.stats, poolConfigs: poolConfigs, portalConfig: portalConfig });
                } catch (e) {
                    logger.error(logSystem, 'Template', `Failed rendering index wrapper for ${pageName}: ${e}`);
                    indexesProcessed[pageName] = pageProcessed[pageName];
                }
            } else {
                logger.error(logSystem, 'Template', 'Index template missing; serving raw page content');
                indexesProcessed[pageName] = pageProcessed[pageName];
            }
        });
    };




    watchPaths(['website', 'website/pages'], (evtPath) => {
        const basename = path.basename(evtPath);
        if (basename in pageFiles) {
            readPageFiles([basename]);
            logger.info(logSystem, 'Server', `Reloaded file ${basename}`);
        }
    });
    portalStats.getGlobalStats(() => {
        readPageFiles(Object.keys(pageFiles));
    });

    const buildKeyScriptPage = async function () {
        try {
            const { client, coinBytes } = await new Promise((resolve, reject) => {
                try {
                    const redisConf = portalConfig.redis || {};
                    const client = CreateRedisClient(redisConf);
                    if (redisConf && redisConf.password && typeof client.auth === 'function') {
                        client.auth(redisConf.password);
                    }
                    client.hgetall('coinVersionBytes', (err, coinBytes) => {
                        if (err) {
                            try {
                                client.quit();
                            } catch (e) { }
                            reject(`Failed grabbing coin version bytes from redis ${JSON.stringify(err)}`); return;
                        }
                        resolve({ client, coinBytes: coinBytes || {} });
                    });
                } catch (e) {
                    reject(e);
                }
            });

            const enabledCoins = Object.keys(poolConfigs).map((c) => c.toLowerCase());
            const missingCoins = [];
            enabledCoins.forEach((c) => {
                if (!(c in coinBytes)) {
                    missingCoins.push(c);
                }
            });

            const coinsForRedis = {};
            await Promise.all(missingCoins.map(c => new Promise((resolve) => {
                const coinInfo = (function () {
                    return Object.keys(poolConfigs).reduce((acc, pName) => {
                        if (pName.toLowerCase() === c) {
                            return { daemon: poolConfigs[pName].paymentProcessing && poolConfigs[pName].paymentProcessing.daemon, address: poolConfigs[pName].address };
                        }
                        return acc;
                    }, null);
                })();
                if (!coinInfo || !coinInfo.daemon || !coinInfo.address) {
                    resolve(); return;
                }
                const daemon = new Stratum.daemon.interface([coinInfo.daemon], ((severity, message) => {
                    logger[severity](logSystem, c, message);
                }));
                daemon.cmd('dumpprivkey', [coinInfo.address], (result) => {
                    if (result[0].error) {
                        logger.error(logSystem, c, `Could not dumpprivkey for ${c} ${JSON.stringify(result[0].error)}`); resolve(); return;
                    }
                    const vBytePub = util.getVersionByte(coinInfo.address)[0];
                    const vBytePriv = util.getVersionByte(result[0].response)[0];
                    coinBytes[c] = `${vBytePub.toString()},${vBytePriv.toString()}`;
                    coinsForRedis[c] = coinBytes[c];
                    resolve();
                });
            })));

            if (Object.keys(coinsForRedis).length > 0) {
                await new Promise((resolve, reject) => {
                    client.hmset('coinVersionBytes', coinsForRedis, (err) => {
                        if (err) {
                            logger.error(logSystem, 'Init', `Failed inserting coin byte version into redis ${JSON.stringify(err)}`); reject(err); return;
                        } resolve();
                    });
                });
            }
            client.quit();
            try {
                const keyPath = path.join(__dirname, '..', 'website', 'key.html');
                keyScriptTemplate = dot.template(fs.readFileSync(keyPath, { encoding: 'utf8' }));
                keyScriptProcessed = keyScriptTemplate({ coins: coinBytes });
            } catch (e) {
                logger.error(logSystem, 'Init', 'Failed to read key.html file');
            }
        } catch (err) {
            logger.error(logSystem, 'Init', err);
        }
    };
    buildKeyScriptPage();

    const buildUpdatedWebsite = function () {
        try {
            portalStats.getGlobalStats(() => {
                processTemplates();
                const statData = `data: ${JSON.stringify(portalStats.stats || {})}\n\n`;
                for (const uid in (portalApi.liveStatConnections || {})) {
                    const res = portalApi.liveStatConnections[uid];
                    try {
                        if (res && !res.writableEnded && !res.finished) {
                            res.write(statData);
                        }
                    } catch (e) { }
                }
            });
        } catch (e) {
            logger.error(logSystem, 'Server', `Error updating website stats: ${e}`);
        }
    };
    // normalize interval and provide a safe default
    const statsIntervalSec = (websiteConfig && websiteConfig.stats && Number(websiteConfig.stats.updateInterval)) ? Number(websiteConfig.stats.updateInterval) : 10;
    const _statsInterval = setInterval(buildUpdatedWebsite, Math.max(1, statsIntervalSec) * 1000);
    if (typeof _statsInterval.unref === 'function') {
        try {
            _statsInterval.unref();
        } catch (e) { }
    }

    const getPage = function (pageId) {
        if (pageId in pageProcessed) {
            return pageProcessed[pageId];
        }
    };

    const minerpage = function (req, res, next) {
        let address = req.params.address || null;
        if (address != null) {
            address = address.split('.')[0];
            portalStats.getBalanceByAddress(address, () => {
                processTemplates(); res.header('Content-Type', 'text/html'); res.end(indexesProcessed['miner_stats']);
            });
        } else {
            next();
        }
    };

    const payout = function (req, res, next) {
        const address = req.params.address || null;
        if (address != null) {
            portalStats.getPayout(address, (data) => {
                try {
                    if (!res.writableEnded && !res.finished) {
                        res.write(data.toString());
                        res.end();
                    }
                } catch (e) {
                    try {
                        if (!res.writableEnded && !res.finished) {
                            res.end();
                        }
                    } catch (er) { }
                }
            });
        } else {
            next();
        }
    };

    const shares = function (req, res, next) {
        portalStats.getCoins(() => {
            processTemplates();
            try { res.setHeader('Content-Type', 'text/html; charset=utf-8'); } catch (e) { }
            res.end(indexesProcessed['user_shares']);
        });
    };

    const usershares = function (req, res, next) {
        const coin = req.params.coin || null; if (coin != null) {
            portalStats.getCoinTotals(coin, null, () => {
                processTemplates();
                try { res.setHeader('Content-Type', 'text/html; charset=utf-8'); } catch (e) { }
                res.end(indexesProcessed['user_shares']);
            });
        } else {
            next();
        }
    };

    const route = function (req, res, next) {
        const pageId = req.params.page || '';
        if (pageId in indexesProcessed) {
            res.header('Content-Type', 'text/html'); res.end(indexesProcessed[pageId]); return;
        }
        try {
            processTemplates(); if (pageId in indexesProcessed) {
                res.header('Content-Type', 'text/html'); res.end(indexesProcessed[pageId]); return;
            }
        } catch (e) {
            logger.error(logSystem, 'Server', `Error regenerating templates for ${pageId}: ${e}`);
        }
        next();
    };

    const app = createMiniApp();
    const staticRoot = path.join(__dirname, '..', 'website', 'static');
    app.use(serveStatic(staticRoot));

    app.get('/get_page', (req, res, next) => {
        const requestedPage = getPage(req.query.id); if (requestedPage) {
            try { res.setHeader('Content-Type', 'text/html; charset=utf-8'); } catch (e) { }
            res.end(requestedPage); return;
        } next();
    });
    app.get('/key.html', (req, res, next) => {
        try { res.setHeader('Content-Type', 'text/html; charset=utf-8'); } catch (e) { }
        res.end(keyScriptProcessed);
    });
    app.get('/workers/:address', minerpage);
    app.get('/:page', route);
    app.get('/', route);
    app.get('/api/:method', (req, res, next) => {
        portalApi.handleApiRequest(req, res, next);
    });

    app.post('/api/admin/:method', (req, res, next) => {
        if (websiteConfig && websiteConfig.adminCenter && websiteConfig.adminCenter.enabled) {
            let bodyRaw = '';
            req.setEncoding('utf8');
            req.on('data', (c) => {
                bodyRaw += c;
            });
            req.on('end', () => {
                let parsed = {};
                try {
                    parsed = bodyRaw ? JSON.parse(bodyRaw) : {};
                } catch (e) {
                    parsed = {};
                }
                if (websiteConfig.adminCenter.password === parsed.password) {
                    portalApi.handleAdminApiRequest(req, res, next);
                } else {
                    try {
                        res.setHeader('Content-Type', 'application/json');
                    } catch (e) { } res.statusCode = 401; return res.end(JSON.stringify({ error: 'Incorrect Password' }));
                }
            });
        } else {
            next();
        }
    });

    app.use((err, req, res, next) => {
        try {
            logger.error(logSystem, 'Server', err && err.stack ? err.stack : String(err));
        } catch (e) { } try {
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            }
        } catch (e) { } try {
            if (!res.writableEnded && !res.finished) {
                res.end('Something broke!');
            }
        } catch (e) { }
    });

    try {
        const host = (websiteConfig && websiteConfig.host) ? websiteConfig.host : '0.0.0.0';
        const port = (websiteConfig && websiteConfig.port) ? websiteConfig.port : 80;
        if (websiteConfig.tlsOptions && websiteConfig.tlsOptions.enabled === true) {
            const TLSoptions = { key: fs.readFileSync(websiteConfig.tlsOptions.key), cert: fs.readFileSync(websiteConfig.tlsOptions.cert) };
            https.createServer(TLSoptions, app).listen(port, host, () => {
                logger.debug(logSystem, 'Server', `TLS Website started on ${host}:${port}`);
            });
        } else {
            app.listen(port, host, () => {
                logger.debug(logSystem, 'Server', `Website started on ${host}:${port}`);
            });
        }
    } catch (e) {
        logger.error(logSystem, 'Server', `Could not start website on ${host}:${port} - ${e && e.message}`);
    }

};
