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
const PoolLogger = require('./logUtil.js');
const { safeParseEnvJSON } = require('./poolUtil.js');

function serveStatic(root) {
    const rootAbs = path.resolve(root);
    const extMime = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon'
    };

    return (req, res, next) => {
        try {
            const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
            if (!pathname.startsWith('/static')) {
                return next();
            }
            const rel = decodeURIComponent(pathname.replace(/^\/static\//, ''));
            const fsPath = path.resolve(rootAbs, rel);
            const relCheck = path.relative(rootAbs, fsPath);
            if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
                return next();
            }

            fs.stat(fsPath, (err, stats) => {
                if (err || !stats.isFile()) {
                    return next();
                }
                const ext = path.extname(fsPath).toLowerCase();
                const mt = extMime[ext] || 'application/octet-stream';
                try {
                    res.setHeader('Content-Type', mt);
                } catch (e) { }
                try {
                    res.setHeader('Cache-Control', 'public, max-age=3600');
                } catch (e) { }
                try {
                    res.setHeader('Content-Length', String(stats.size));
                } catch (e) { }

                const smallExts = ['.js', '.css', '.html', '.json'];
                const SMALL_THRESHOLD = 256 * 1024;
                if (stats.size <= SMALL_THRESHOLD && smallExts.indexOf(ext) !== -1) {
                    fs.readFile(fsPath, (rfErr, data) => {
                        if (rfErr) {
                            return next();
                        }
                        try {
                            res.setHeader('Content-Length', String(data.length));
                        } catch (e) { }
                        try {
                            return res.end(data);
                        } catch (e) {
                            return next();
                        }
                    });
                    return;
                }

                const stream = fs.createReadStream(fsPath);
                const onClose = () => {
                    try {
                        stream.destroy();
                    } catch (e) { }
                };
                res.on('close', onClose);
                const onResError = (rErr) => {
                    try {
                        stream.destroy();
                    } catch (e) { }
                };
                const onResFinish = () => {
                    try {
                        stream.destroy();
                    } catch (e) { }
                };
                res.on('error', onResError);
                res.on('finish', onResFinish);
                stream.on('error', (sErr) => {
                    try {
                        if (!res.headersSent) {
                            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                        }
                    } catch (e) { }
                    try {
                        if (!res.writableEnded && !res.finished) {
                            res.end('Internal Server Error');
                        }
                    } catch (e) { }
                });

                pipeline(stream, res, (err) => {
                    try {
                        res.removeListener('close', onClose);
                    } catch (e) { }
                    try {
                        res.removeListener('error', onResError);
                    } catch (e) { }
                    try {
                        res.removeListener('finish', onResFinish);
                    } catch (e) { }
                    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
                        try {
                            if (!res.headersSent) {
                                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                            }
                        } catch (e) { }
                        try {
                            if (!res.writableEnded && !res.finished) {
                                res.end('Internal Server Error');
                            }
                        } catch (e) { }
                    }
                });
                return;
            });
        } catch (e) {
            return next();
        }
    };
}

function createMiniApp() {
    const middlewares = [];
    const routes = [];

    function registerRoute(method, pathPattern, handler) {
        const parts = pathPattern.split('/').filter(Boolean);
        const paramNames = [];
        const regexParts = parts.map(p => {
            if (p.startsWith(':')) {
                paramNames.push(p.slice(1)); return '([^/]+)';
            }
            return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        });
        const regex = new RegExp(`^/${regexParts.join('/')}$`);
        routes.push({ method, pathPattern, regex, paramNames, handler });
    }

    const handler = (req, res) => {
        try {
            req.query = Object.fromEntries(new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams.entries()); 
        } catch (e) {
            req.query = {}; 
        }
        req.params = {};
        req.get = (h) => req.headers[h.toLowerCase()];
        res.header = (n, v) => res.setHeader(n, v);
        res.flush = () => {
            try {
                if (typeof res.flushHeaders === 'function') {
                    res.flushHeaders();
                } 
            } catch (e) { } 
        };

        const handlers = [];
        middlewares.forEach(mw => handlers.push(mw));

        const method = (req.method || 'GET').toUpperCase();
        const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
        for (const r of routes) {
            if (r.method !== method) {
                continue;
            }
            const match = pathname.match(r.regex);
            if (match) {
                r.paramNames.forEach((n, i) => req.params[n] = match[i + 1]);
                handlers.push(r.handler);
                break;
            }
        }

        let idx = 0;
        const next = (err) => {
            if (err) {
                const h = handlers[idx++];
                if (!h) {
                    if (!res.headersSent) {
                        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                    } return res.end('Something broke!');
                }
                if (h.length === 4) {
                    return h(err, req, res, next);
                }
                return next(err);
            }
            const h = handlers[idx++];
            if (!h) {
                if (!res.headersSent) {
                    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                } return res.end('Not Found');
            }
            if (h.length === 4) {
                return next();
            }
            try {
                return h(req, res, next);
            } catch (e) {
                return next(e);
            }
        };
        next();
    };

    handler.get = (p, h) => registerRoute('GET', p, h);
    handler.post = (p, h) => registerRoute('POST', p, h);
    handler.use = (a, b) => {
        if (typeof a === 'string' && typeof b === 'function') {
            middlewares.push((req, res, next) => {
                try {
                    const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname; if (pathname.startsWith(a)) {
                        return b(req, res, next);
                    }
                } catch (e) { }
                return next();
            });
        } else if (typeof a === 'function') {
            middlewares.push(a);
        }
    };
    handler.listen = (port, host, cb) => http.createServer(handler).listen(port, host, cb);
    return handler;
}

const dot = (function () {
    const api = {};
    api.templateSettings = { strip: false };

    function compile(template) {
        const parts = template.split(/{{([\s\S]*?)}}/g);
        let code = 'let out = "";\n';
        let loopCounter = 0;

        for (let i = 0; i < parts.length; i++) {
            if (i % 2 === 0) {
                if (parts[i].length > 0) {
                    code += `out += ${JSON.stringify(parts[i])};\n`;
                }
            } else {
                const inner = parts[i];
                const s = inner.trim();
                if (s.length === 0) {
                    continue;
                }

                if (s[0] === '=') {
                    code += `out += (${s.slice(1)});\n`;
                } else if (s[0] === '!') {
                    code += `out += (${s.slice(1)});\n`;
                } else if (s[0] === '?') {
                    if (s === '??') {
                        code += '} else {\n';
                    } else if (s === '?') {
                        code += '}\n';
                    } else {
                        code += `if (${s.slice(1)}) {\n`;
                    }
                } else if (s[0] === '~') {
                    if (s === '~') {
                        code += '}\n';
                    } else {
                        const loopSpec = s.slice(1).trim();
                        const bits = loopSpec.split(':').map(b => b.trim()).filter(Boolean);
                        const arrExpr = bits[0] || '[]';
                        const valName = bits[1] || (`_v${loopCounter}`);
                        const idxName = bits[2] || (`_i${loopCounter}`);
                        const arrVar = `__arr${loopCounter}`;
                        loopCounter++;
                        code += `var ${arrVar} = (${arrExpr}) || []; for (var ${idxName} = 0; ${idxName} < ${arrVar}.length; ${idxName}++) { var ${valName} = ${arrVar}[${idxName}];\n`;
                    }
                } else {
                    code += `${s}\n`;
                }
            }
        }

        code += 'return out;';

        try {

            return new Function('it', `with (it || {}) {\n${code}\n}`);
        } catch (e) {

            try {
                if (typeof logger !== 'undefined' && logger && typeof logger.error === 'function') {
                    logger.error('Website', 'Template', `template compile failed: ${e && e.message}`);
                } else {
                    console.error(`template compile failed: ${e && e.message}`);
                }
            } catch (logErr) { }
            return function () {
                return template;
            };
        }
    }

    api.template = compile;
    return api;
})();

dot.templateSettings.strip = false;


module.exports = function () {
    const portalConfig = safeParseEnvJSON('portalConfig');

    const logger = new PoolLogger({ logLevel: portalConfig.logLevel, logColors: portalConfig.logColors });
    const poolConfigs = safeParseEnvJSON('pools');
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


    const readPageFiles = function (files) {
        Promise.all(files.map(fileName => new Promise((resolve, reject) => {
            const filePath = `website/${fileName === 'index.html' ? '' : 'pages/'}${fileName}`;
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
        for (const pageName in pageTemplates) {
            if (pageName === 'index') {
                continue;
            }
            const tpl = pageTemplates[pageName];
            if (typeof tpl !== 'function') {
                logger.error(logSystem, 'Template', `Template for page ${pageName} is not a function`);
                continue;
            }
            try {
                pageProcessed[pageName] = tpl({ poolsConfigs: poolConfigs, stats: portalStats.stats, portalConfig: portalConfig });
            } catch (e) {
                logger.error(logSystem, 'Template', `Failed rendering template for ${pageName}: ${e}`);
                pageProcessed[pageName] = `<!-- rendering error for ${pageName} -->`;
            }
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
        }
    };


    const watchPaths = function (pathsToWatch, cb) {
        pathsToWatch.forEach((watchPath) => {
            try {
                fs.watch(watchPath, { persistent: true }, (eventType, filename) => {
                    let fullPath = null;
                    if (filename) {
                        fullPath = path.join(watchPath, filename);
                    }
                    cb(fullPath || watchPath);
                });
            } catch (e) {
                logger.error(logSystem, 'Watch', `Failed to watch path ${watchPath} - ${e}`);
            }
        });
    };

    watchPaths(['./website', './website/pages'], (evtPath) => {
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
                const client = CreateRedisClient(portalConfig.redis);
                if (portalConfig.redis.password) {
                    client.auth(portalConfig.redis.password);
                }
                client.hgetall('coinVersionBytes', (err, coinBytes) => {
                    if (err) {
                        client.quit(); reject(`Failed grabbing coin version bytes from redis ${JSON.stringify(err)}`); return;
                    }
                    resolve({ client, coinBytes: coinBytes || {} });
                });
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
                    for (const pName in poolConfigs) {
                        if (pName.toLowerCase() === c) {
                            return { daemon: poolConfigs[pName].paymentProcessing.daemon, address: poolConfigs[pName].address };
                        }
                    }
                })();
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
                keyScriptTemplate = dot.template(fs.readFileSync('website/key.html', { encoding: 'utf8' }));
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
        portalStats.getGlobalStats(() => {
            processTemplates();
            const statData = `data: ${JSON.stringify(portalStats.stats)}\n\n`;
            for (const uid in portalApi.liveStatConnections) {
                const res = portalApi.liveStatConnections[uid];
                try {
                    if (res && !res.writableEnded && !res.finished) {
                        res.write(statData);
                    }
                } catch (e) { }
            }
        });
    };
    setInterval(buildUpdatedWebsite, websiteConfig.stats.updateInterval * 1000);

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
            processTemplates(); res.end(indexesProcessed['user_shares']);
        });
    };

    const usershares = function (req, res, next) {
        const coin = req.params.coin || null; if (coin != null) {
            portalStats.getCoinTotals(coin, null, () => {
                processTemplates(); res.end(indexesProcessed['user_shares']);
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
            res.end(requestedPage); return;
        } next();
    });
    app.get('/key.html', (req, res, next) => {
        res.end(keyScriptProcessed);
    });
    app.get('/workers/:address', minerpage);
    app.get('/:page', route);
    app.get('/', route);
    app.get('/api/:method', (req, res, next) => {
        portalApi.handleApiRequest(req, res, next);
    });

    app.post('/api/admin/:method', (req, res, next) => {
        if (portalConfig.website && portalConfig.website.adminCenter && portalConfig.website.adminCenter.enabled) {
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
                if (portalConfig.website.adminCenter.password === parsed.password) {
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
        if (portalConfig.website.tlsOptions && portalConfig.website.tlsOptions.enabled === true) {
            const TLSoptions = { key: fs.readFileSync(portalConfig.website.tlsOptions.key), cert: fs.readFileSync(portalConfig.website.tlsOptions.cert) };
            https.createServer(TLSoptions, app).listen(portalConfig.website.port, portalConfig.website.host, () => {
                logger.debug(logSystem, 'Server', `TLS Website started on ${portalConfig.website.host}:${portalConfig.website.port}`);
            });
        } else {
            app.listen(portalConfig.website.port, portalConfig.website.host, () => {
                logger.debug(logSystem, 'Server', `Website started on ${portalConfig.website.host}:${portalConfig.website.port}`);
            });
        }
    } catch (e) {
        logger.error(logSystem, 'Server', `Could not start website on ${portalConfig.website.host}:${portalConfig.website.port} - ${e && e.message}`);
    }

};
