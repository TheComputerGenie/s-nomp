/**
 * @fileoverview Website and API server for the mining pool portal.
 *
 * This module initializes and starts the web server, which serves the portal's
 * frontend, static assets, and API endpoints. It reads page templates,
 * pre-compiles them, and sets up routes for both the website and the API.
 * It also manages real-time statistics updates via Server-Sent Events (SSE).
 *
 * @author ComputerGenieCo
 * @version 21.7.3
 * @copyright 2025
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const Stratum = require('./stratum');
const util = require('./utils/util.js');
const Api = require('./api.js');
const CreateRedisClient = require('./createRedisClient.js');
const PoolLogger = require('./PoolLogger.js');
const { safeParseEnvJSON, watchPaths, serveStatic, createMiniApp } = require('./webUtil.js');

let dot;
try {
    dot = require('dot');
} catch (e) {
    dot = { templateSettings: { strip: false }, template: (t) => () => t };
}

if (!dot.templateSettings) {
    dot.templateSettings = {};
}
dot.templateSettings.strip = false;

/**
 * Website server for the mining pool portal.
 * @class Website
 */
class Website {
    /**
     * Checks if a directory contains the essential website files.
     * @param {string} dir - Directory name relative to project root.
     * @returns {boolean} True if essential files exist.
     */
    hasWebsiteFiles(dir) {
        try {
            const dirPath = path.join(__dirname, '..', dir);
            const indexPath = path.join(dirPath, 'index.html');
            const keyPath = path.join(dirPath, 'key.html');
            return fs.existsSync(indexPath) && fs.existsSync(keyPath);
        } catch (e) {
            return false;
        }
    }

    /**
     * @constructor
     * @param {Object} logger - Logger instance.
     */
    constructor(logger) {
        this.portalConfig = safeParseEnvJSON('portalConfig') || {};
        this.logger = logger;
        this.poolConfigs = safeParseEnvJSON('pools') || {};
        this.websiteConfig = this.portalConfig.website || {};
        // Directory name where website files live (allows theming by changing this)
        this.websiteDir = String(this.websiteConfig.directory || 'website');
        // Resolve directory to an existing directory with website files if possible; fallback to default 'website'
        try {
            const candidate = path.join(__dirname, '..', this.websiteDir);
            const defaultDir = path.join(__dirname, '..', 'website');
            if (!fs.existsSync(candidate) || !this.hasWebsiteFiles(this.websiteDir)) {
                if (fs.existsSync(defaultDir) && this.hasWebsiteFiles('website')) {
                    this.logger && this.logger.warn && this.logger.warn(this.logSystem, 'Server', `Configured website.directory '${this.websiteDir}' does not contain required website files; falling back to 'website'`);
                    this.websiteDir = 'website';
                } else {
                    this.logger && this.logger.warn && this.logger.warn(this.logSystem, 'Server', `Configured website.directory '${this.websiteDir}' does not contain required website files and default 'website' directory is also missing or incomplete. Static/templates may fail until created.`);
                }
            }
        } catch (e) {
            // ignore filesystem errors here and proceed with configured value
        }
        this.logSystem = 'Website';

        this.portalApi = new Api(this.logger, this.portalConfig, this.poolConfigs);
        this.portalStats = this.portalApi.stats || {};

        this.pageFiles = {
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
        this.pageTemplates = {};
        this.pageProcessed = {};
        this.indexesProcessed = {};
        this.keyScriptTemplate = '';
        this.keyScriptProcessed = '';
        this.server = null;
        this._statsInterval = null;
    }

    /**
     * Start the website server and related processes.
     */
    start() {
        this.portalStats.getGlobalStats(() => {
            this.readPageFiles(Object.keys(this.pageFiles));
        });

        this.buildKeyScriptPage();

        // pass logger so failures to watch an absent directory are reported via logger
        watchPaths([this.websiteDir, `${this.websiteDir}/pages`], (evtPath) => {
            const basename = path.basename(evtPath);
            if (basename in this.pageFiles) {
                this.readPageFiles([basename]);
                this.logger.info(this.logSystem, 'Server', `Reloaded file ${basename}`);
            }
        });

        const statsIntervalSec = (this.websiteConfig.stats && Number(this.websiteConfig.stats.updateInterval)) || 10;
        this._statsInterval = setInterval(() => this.buildUpdatedWebsite(), Math.max(1, statsIntervalSec) * 1000);
        if (typeof this._statsInterval.unref === 'function') {
            this._statsInterval.unref();
        }

        this.startServer();
    }

    /**
     * Reads and compiles page templates.
     * @param {string[]} files - Array of filenames to process.
     */
    readPageFiles(files) {
        Promise.all(files.map(fileName => new Promise((resolve, reject) => {
            const relPath = `${this.websiteDir}/${fileName === 'index.html' ? '' : 'pages/'}${fileName}`;
            const filePath = path.join(__dirname, '..', relPath);
            fs.readFile(filePath, 'utf8', (err, data) => {
                if (err) {
                    this.logger.error(this.logSystem, 'Template', `Failed to read template file: ${filePath}`);
                    return reject(err);
                }
                try {
                    this.pageTemplates[this.pageFiles[fileName]] = dot.template(data);
                    resolve();
                } catch (e) {
                    this.logger.error(this.logSystem, 'Template', `Failed compiling template ${filePath}: ${e}`);
                    reject(e);
                }
            });
        }))).then(() => {
            this.processTemplates();
        }).catch((err) => {
            this.logger.error(this.logSystem, 'Template', `Error reading files: ${err.message}`);
        });
    }

    /**
     * Renders the page templates with current data.
     */
    processTemplates() {
        Object.keys(this.pageTemplates).forEach((pageName) => {
            if (pageName === 'index') {
                return;
            }
            const tpl = this.pageTemplates[pageName];
            if (typeof tpl !== 'function') {
                this.logger.error(this.logSystem, 'Template', `Template for page ${pageName} is not a function`);
                return;
            }
            try {
                this.pageProcessed[pageName] = tpl({ poolsConfigs: this.poolConfigs, stats: this.portalStats.stats, portalConfig: this.portalConfig });
            } catch (e) {
                this.logger.error(this.logSystem, 'Template', `Failed rendering template for ${pageName}: ${e}`);
                this.pageProcessed[pageName] = `<!-- rendering error for ${pageName} -->`;
            }
        });

        Object.keys(this.pageTemplates).forEach(pageName => {
            if (pageName === 'index' || !this.pageProcessed[pageName]) {
                return;
            }
            if (typeof this.pageTemplates.index === 'function') {
                try {
                    this.indexesProcessed[pageName] = this.pageTemplates.index({ page: this.pageProcessed[pageName], selected: pageName, stats: this.portalStats.stats, poolConfigs: this.poolConfigs, portalConfig: this.portalConfig });
                } catch (e) {
                    this.logger.error(this.logSystem, 'Template', `Failed rendering index wrapper for ${pageName}: ${e}`);
                    this.indexesProcessed[pageName] = this.pageProcessed[pageName];
                }
            } else {
                this.logger.error(this.logSystem, 'Template', 'Index template missing; serving raw page content');
                this.indexesProcessed[pageName] = this.pageProcessed[pageName];
            }
        });
    }

    /**
     * Builds the key generation script page.
     */
    async buildKeyScriptPage() {
        try {
            const redisConf = this.portalConfig.redis || {};
            const client = CreateRedisClient(redisConf);
            if (redisConf.password) {
                client.auth(redisConf.password);
            }

            const coinBytes = await new Promise((resolve, reject) => {
                client.hgetall('coinVersionBytes', (err, res) => {
                    client.quit();
                    if (err) {
                        return reject(err);
                    }
                    resolve(res || {});
                });
            });

            const keyPath = path.join(__dirname, '..', this.websiteDir, 'key.html');
            this.keyScriptTemplate = dot.template(fs.readFileSync(keyPath, 'utf8'));
            this.keyScriptProcessed = this.keyScriptTemplate({ coins: coinBytes });
        } catch (e) {
            this.logger.error(this.logSystem, 'KeyScript', `Failed to build key script page: ${e.message}`);
        }
    }

    /**
     * Periodically updates website stats and pushes to live connections.
     */
    buildUpdatedWebsite() {
        this.portalStats.getGlobalStats(() => {
            this.processTemplates();
            const statData = `data: ${JSON.stringify(this.portalStats.stats || {})}\n\n`;
            for (const uid in this.portalApi.liveStatConnections) {
                const res = this.portalApi.liveStatConnections[uid];
                if (res && !res.writableEnded && !res.finished) {
                    res.write(statData);
                }
            }
        });
    }

    /**
     * Renders the miner stats page.
     * @param {http.IncomingMessage} req - The request object.
     * @param {http.ServerResponse} res - The response object.
     * @param {Function} next - The next middleware function.
     */
    minerPage(req, res, next) {
        const address = (req.params.address || '').split('.')[0];
        if (address) {
            this.portalStats.getBalanceByAddress(address, () => {
                this.processTemplates();
                res.setHeader('Content-Type', 'text/html');
                res.end(this.indexesProcessed['miner_stats']);
            });
        } else {
            next();
        }
    }

    /**
     * Generic page routing handler.
     * @param {http.IncomingMessage} req - The request object.
     * @param {http.ServerResponse} res - The response object.
     * @param {Function} next - The next middleware function.
     */
    route(req, res, next) {
        const pageId = req.params.page || '';
        if (this.indexesProcessed[pageId]) {
            res.setHeader('Content-Type', 'text/html');
            res.end(this.indexesProcessed[pageId]);
        } else {
            // Fallback for home page
            if (pageId === '' && this.indexesProcessed['']) {
                res.setHeader('Content-Type', 'text/html');
                res.end(this.indexesProcessed['']);
                return;
            }
            this.processTemplates();
            if (this.indexesProcessed[pageId]) {
                res.setHeader('Content-Type', 'text/html');
                res.end(this.indexesProcessed[pageId]);
            } else {
                next();
            }
        }
    }

    /**
     * Initializes and starts the HTTP/HTTPS server.
     */
    startServer() {
        const app = createMiniApp();
        const staticRoot = path.join(__dirname, '..', this.websiteDir, 'static');
        app.use(serveStatic(staticRoot));

        app.get('/get_page', (req, res, next) => {
            const pageId = req.query.id;
            if (this.pageProcessed[pageId]) {
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                res.end(this.pageProcessed[pageId]);
            } else {
                next();
            }
        });

        app.get('/key.html', (req, res) => {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(this.keyScriptProcessed);
        });

        app.get('/workers/:address', (req, res, next) => this.minerPage(req, res, next));
        app.get('/:page', (req, res, next) => this.route(req, res, next));
        app.get('/', (req, res, next) => this.route(req, res, next));

        app.get('/api/:method', (req, res, next) => {
            this.portalApi.handleApiRequest(req, res, next);
        });

        app.post('/api/admin/:method', (req, res, next) => {
            if (this.websiteConfig.adminCenter && this.websiteConfig.adminCenter.enabled) {
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
                    if (this.websiteConfig.adminCenter.password === parsed.password) {
                        this.portalApi.handleAdminApiRequest(req, res, next);
                    } else {
                        res.setHeader('Content-Type', 'application/json');
                        res.statusCode = 401;
                        res.end(JSON.stringify({ error: 'Incorrect Password' }));
                    }
                });
            } else {
                next();
            }
        });

        app.use((err, req, res, next) => {
            this.logger.error(this.logSystem, 'Server', err.stack || String(err));
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            }
            if (!res.writableEnded && !res.finished) {
                res.end('Something broke!');
            }
        });

        const host = this.websiteConfig.host || '0.0.0.0';
        const port = this.websiteConfig.port || 80;
        const useTls = this.websiteConfig.tlsOptions && this.websiteConfig.tlsOptions.enabled;

        if (useTls) {
            try {
                const tlsOptions = {
                    key: fs.readFileSync(this.websiteConfig.tlsOptions.key),
                    cert: fs.readFileSync(this.websiteConfig.tlsOptions.cert)
                };
                this.server = https.createServer(tlsOptions, app);
            } catch (e) {
                this.logger.error(this.logSystem, 'Server', `Could not create TLS server: ${e.message}`);
                return;
            }
        } else {
            this.server = http.createServer(app);
        }

        this.server.listen(port, host, () => {
            this.logger.debug(this.logSystem, 'Server', `Website started on ${host}:${port} serving from '${this.websiteDir}'${useTls ? ' with TLS' : ''}`);
        });
    }
}

module.exports = Website;
