/**
 * @fileoverview Website module for S-NOMP (Stratum Node Open Mining Portal)
 * This module creates and manages the web interface for the mining pool, including:
 * - Express.js web server setup with routing
 * - Dynamic template processing using doT templates
 * - Real-time statistics updates via Server-Sent Events
 * - Cryptocurrency key script generation
 * - API endpoints for pool data access
 * - Administrative interface functionality
 * - File watching for hot-reloading of templates
 * 
 * @author S-NOMP Contributors
 * @version 1.0.0
 * @requires https
 * @requires fs
 * @requires path
 * @requires node-watch
 * @requires redis
 * @requires dot
 * @requires express
 * @requires body-parser
 * @requires compression
 * @requires ./stratum
 * @requires ./stratum/util.js
 * @requires ./api.js
 * @requires ./createRedisClient.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Use native fs.watch instead of the external `node-watch` package.
// We implement a tiny compatibility wrapper `watchPaths` that calls the
// supplied callback with a single path argument (similar to older
// node-watch behavior) so the rest of the file can remain unchanged.
const redis = require('redis');

// Minimal in-file doT-compatible template compiler to avoid pulling the
// external `dot` dependency while preserving the same API used below.
// This supports the common doT patterns used by the project's templates:
//  - Interpolation: {{= expression }}
//  - Raw output:   {{! expression }}
//  - Code blocks:  {{ code... }}
// The compiled function receives a single argument (commonly called `it`).
// It uses `with(it||{})` so templates can reference properties either as
// `it.foo` or directly as `foo` (to maximize compatibility with existing
// templates).
const dot = (function () {
    const api = {};
    api.templateSettings = { strip: false };

    // Compile a template string into a rendering function(fn(it)).
    function compile(template) {
        // Split on doT-style delimiters {{ ... }} and keep capture groups
        const parts = template.split(/{{([\s\S]*?)}}/g);
        let code = 'let out = "";\n';
        let loopCounter = 0;

        for (let i = 0; i < parts.length; i++) {
            if (i % 2 === 0) {
                // Plain text
                if (parts[i].length > 0) {
                    code += 'out += ' + JSON.stringify(parts[i]) + ';\n';
                }
            } else {
                // Expression or code inside {{ ... }}
                const inner = parts[i];
                const s = inner.trim();
                if (s.length === 0) continue;

                // Interpolation: {{= expr }} -> out += (expr)
                if (s[0] === '=') {
                    code += 'out += (' + s.slice(1) + ');\n';
                }
                // Raw output (treat same as interpolation): {{! expr }}
                else if (s[0] === '!') {
                    code += 'out += (' + s.slice(1) + ');\n';
                }
                // Handle doT-style control sequences
                // Conditional: {{? condition}} ... {{?}} -> if (condition) { ... }
                else if (s[0] === '?') {
                    if (s === '??') {
                        // Else branch
                        code += '} else {\n';
                    } else if (s === '?') {
                        // Closing conditional
                        code += '}\n';
                    } else {
                        // Opening conditional
                        code += 'if (' + s.slice(1) + ') {\n';
                    }
                }
                // Loop/iteration: {{~ arr:val:index }} ... {{~}} -> for loop
                else if (s[0] === '~') {
                    if (s === '~') {
                        // Closing loop
                        code += '}\n';
                    } else {
                        // Opening loop - parse `arr:val:index` (val/index optional)
                        const loopSpec = s.slice(1).trim();
                        const bits = loopSpec.split(':').map(b => b.trim()).filter(Boolean);
                        const arrExpr = bits[0] || '[]';
                        const valName = bits[1] || ('_v' + loopCounter);
                        const idxName = bits[2] || ('_i' + loopCounter);
                        const arrVar = '__arr' + loopCounter;
                        loopCounter++;
                        code += 'var ' + arrVar + ' = (' + arrExpr + ') || []; for (var ' + idxName + ' = 0; ' + idxName + ' < ' + arrVar + '.length; ' + idxName + '++) { var ' + valName + ' = ' + arrVar + '[' + idxName + '];\n';
                    }
                }
                // Code block: include as-is (allows arbitrary JS)
                else {
                    code += s + '\n';
                }
            }
        }

        code += 'return out;';

        try {
            // Create a function that takes the `it` object and executes
            // generated code inside a `with` scope for compatibility.
            return new Function('it', 'with (it || {}) {\n' + code + '\n}');
        } catch (e) {
            // If compilation fails, fall back to a harmless renderer that
            // returns the raw template string so the site doesn't crash.
            try {
                // Log a larger portion of the generated code and the original
                // template to aid debugging of why new Function() fails.
                const codeSnippet = ('' + code).slice(0, 16000);
                const tplSnippet = ('' + template).slice(0, 16000);
                console.error('template compile failed', e);
                console.error('generated template code (first 16k chars):\n' + codeSnippet);
                console.error('original template (first 16k chars):\n' + tplSnippet);
            } catch (logErr) {
                console.error('template compile failed and logging also failed', logErr);
            }
            return function () { return template; };
        }
    }

    api.template = compile;
    return api;
})();

const http = require('http');
const { URL } = require('url');

// Lightweight in-file Express adapter (only the minimal API used by this file)
// Provides: express() -> app, app.use([path], fn), app.get/post(path, fn),
// app.listen, and express.static(root) middleware factory. This avoids
// requiring the full Express package while keeping the rest of the file
// unchanged. We intentionally keep body-parser and compression as external
// modules (they remain required below) so behavior is preserved.
function createMiniExpress() {
    function makeApp() {
        const middlewares = [];
        const routes = [];

        function registerRoute(method, pathPattern, handler) {
            const parts = pathPattern.split('/').filter(Boolean);
            const paramNames = [];
            const regexParts = parts.map(p => {
                if (p.startsWith(':')) { paramNames.push(p.slice(1)); return '([^/]+)'; }
                return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            });
            const regex = new RegExp('^/' + regexParts.join('/') + '$');
            routes.push({ method, pathPattern, regex, paramNames, handler });
        }

        const handler = (req, res) => {
            // basic request augmentation for compatibility
            try {
                req.query = Object.fromEntries(new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams.entries());
            } catch (e) {
                req.query = {};
            }
            req.params = {};
            req.get = (h) => req.headers[h.toLowerCase()];
            res.header = (n, v) => res.setHeader(n, v);
            // Provide a flush() shim expected by some handlers (e.g. SSE or
            // API methods). If a compressor is attached to the response it
            // will attempt to flush it; otherwise fall back to
            // flushHeaders() when available.
            res.flush = () => {
                try {
                    if (res._compressor && typeof res._compressor.flush === 'function') {
                        try { res._compressor.flush(); } catch (e) { /* best-effort */ }
                        return;
                    }
                    if (typeof res.flushHeaders === 'function') return res.flushHeaders();
                } catch (e) { }
            };
            res.send = (a, b) => {
                if (typeof a === 'number') {
                    res.statusCode = a;
                    if (b !== undefined) {
                        if (!res.headersSent) res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                        return res.end(typeof b === 'string' ? b : JSON.stringify(b));
                    }
                    return res.end();
                }
                if (!res.headersSent) res.setHeader('Content-Type', 'text/html; charset=utf-8');
                return res.end(typeof a === 'string' ? a : JSON.stringify(a));
            };

            // compose middleware list then the matching route handler
            const handlers = [];
            middlewares.forEach(mw => handlers.push(mw));

            const method = req.method.toUpperCase();
            for (const r of routes) {
                if (r.method !== method) continue;
                const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
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
                    // find next error handler (fn.length === 4)
                    while (true) {
                        const h = handlers[idx++];
                        if (!h) {
                            if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                            return res.end('Something broke!');
                        }
                        if (h.length === 4) {
                            try { return h(err, req, res, next); } catch (e) { console.error(e); continue; }
                        }
                    }
                }

                const h = handlers[idx++];
                if (!h) {
                    if (!res.headersSent) res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                    return res.end('Not Found');
                }
                if (h.length === 4) return next(); // skip error handlers in normal flow
                try { return h(req, res, next); } catch (e) { console.error(e); return next(e); }
            };

            next();
        };

        handler.get = (p, h) => registerRoute('GET', p, h);
        handler.post = (p, h) => registerRoute('POST', p, h);
        handler.use = (a, b) => {
            if (typeof a === 'string' && typeof b === 'function') {
                middlewares.push((req, res, next) => {
                    try {
                        const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
                        if (pathname.startsWith(a)) return b(req, res, next);
                    } catch (e) { }
                    return next();
                });
            } else if (typeof a === 'function') {
                middlewares.push(a);
            }
        };
        handler.listen = (port, host, cb) => {
            if (typeof host === 'function') { cb = host; host = undefined; }
            return http.createServer(handler).listen(port, host, cb);
        };
        return handler;
    }

    function expressStatic(root) {
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
                // remove leading / if present
                const rel = decodeURIComponent(pathname.replace(/^\//, ''));
                // If mounted at /static the pathname will start with 'static/...'
                const relPath = rel.replace(/^static\//, '');
                const fsPath = path.join(rootAbs, relPath);
                if (!fsPath.startsWith(rootAbs)) return next();
                if (fs.existsSync(fsPath) && fs.statSync(fsPath).isFile()) {
                    const ext = path.extname(fsPath).toLowerCase();
                    const mt = extMime[ext] || 'application/octet-stream';
                    res.setHeader('Content-Type', mt);
                    // Basic caching for static assets
                    res.setHeader('Cache-Control', 'public, max-age=3600');
                    const stream = fs.createReadStream(fsPath);
                    stream.on('error', () => next());
                    stream.pipe(res);
                    return;
                }
            } catch (e) { }
            return next();
        };
    }

    const exp = () => makeApp();
    exp.static = expressStatic;
    return exp;
}

const express = createMiniExpress();

// Native JSON body parser replacement for body-parser.json()
// Supports POST/PUT/PATCH and parses application/json payloads.
const bodyParser = {
    json: () => (req, res, next) => {
        const method = (req.method || '').toUpperCase();
        if (!['POST', 'PUT', 'PATCH'].includes(method)) return next();

        const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
        if (contentType !== 'application/json') return next();

        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
            if (!raw) { req.body = {}; return next(); }
            try {
                req.body = JSON.parse(raw);
            } catch (e) {
                // keep req.body minimal on parse error
                req.body = {};
            }
            return next();
        });
        req.on('error', () => { req.body = {}; return next(); });
    }
};

// Lightweight native compression middleware to replace the external
// `compression` package. This uses Node's built-in zlib to provide
// Brotli/Gzip/Deflate compression based on the client's Accept-Encoding
// header. It mirrors the minimal middleware shape (fn(req,res,next)) so
// existing `app.use(compress())` calls keep working.
const zlib = require('zlib');
const compress = () => {
    return (req, res, next) => {
        try {
            const method = (req.method || '').toUpperCase();
            // Don't compress responses to HEAD requests
            if (method === 'HEAD') return next();

            const accept = req.headers['accept-encoding'] || '';
            let encoding = null;
            if (/\bbr\b/.test(accept)) encoding = 'br';
            else if (/\bgzip\b/.test(accept)) encoding = 'gzip';
            else if (/\bdeflate\b/.test(accept)) encoding = 'deflate';
            if (!encoding) return next();

            // If response is already encoded, skip
            if (typeof res.getHeader === 'function' && res.getHeader('Content-Encoding')) return next();

            // Advertise that we vary by Accept-Encoding
            try {
                const prev = res.getHeader && res.getHeader('Vary');
                if (!prev) res.setHeader('Vary', 'Accept-Encoding');
                else if (!/Accept-Encoding/i.test(prev)) res.setHeader('Vary', prev + ', Accept-Encoding');
            } catch (e) { }

            // Lazy compression: only create compressor on first write/end and
            // only for compressible content-types. This avoids compressing
            // SSE (text/event-stream) and binary assets that shouldn't be
            // altered.
            // If another instance already wrapped this response, skip to avoid
            // double-wrapping/double-compression which corrupts output.
            if (res._compressMiddlewareApplied) return next();
            try { res._compressMiddlewareApplied = true; } catch (e) { }

            const _write = res.write.bind(res);
            const _end = res.end.bind(res);
            let headerWritten = false;
            let compressor = null;
            let decided = false;
            const compressible = (ct) => {
                if (!ct) return true; // unknown -> allow
                ct = ct.split(';')[0].trim().toLowerCase();
                if (!ct) return true;
                // Don't compress server-sent events or already-compressed media
                if (ct === 'text/event-stream') return false;
                if (ct.startsWith('image/')) return false;
                if (ct === 'application/zip' || ct === 'application/gzip') return false;
                if (ct.startsWith('video/')) return false;
                if (ct.startsWith('audio/')) return false;
                // Compress common text-ish types
                if (ct.startsWith('text/')) return true;
                if (ct === 'application/javascript' || ct === 'application/json' || ct === 'application/xml' || ct === 'application/xhtml+xml') return true;
                return false;
            };

            const makeCompressor = () => {
                if (compressor) return compressor;
                if (encoding === 'br' && typeof zlib.createBrotliCompress === 'function') compressor = zlib.createBrotliCompress();
                else if (encoding === 'gzip') compressor = zlib.createGzip();
                else compressor = zlib.createDeflate();
                try { res._compressor = compressor; } catch (e) { }
                compressor.on('data', (chunk) => { try { _write(chunk); } catch (e) { /* best-effort */ } });
                compressor.on('end', () => { try { delete res._compressor; _end(); } catch (e) { /* best-effort */ } });
                compressor.on('error', (err) => { console.error('compression error', err); try { delete res._compressor; _end(); } catch (e) { } });
                return compressor;
            };

            // Override res.write and res.end to decide lazily whether to compress
            res.write = function (chunk, encodingArg, cb) {
                if (!decided) {
                    decided = true;
                    // Choose based on Content-Type header
                    const ct = (typeof res.getHeader === 'function') ? res.getHeader('Content-Type') : null;
                    const doCompress = encoding && compressible(ct);
                    if (!doCompress) {
                        // restore original behaviour and write directly
                        try { if (typeof res.removeHeader === 'function') res.removeHeader('Content-Encoding'); } catch (e) { }
                        res.write = _write;
                        res.end = _end;
                        return res.write(chunk, encodingArg, cb);
                    }
                    // perform compression
                    try { res.setHeader('Content-Encoding', encoding); } catch (e) { }
                    if (typeof res.removeHeader === 'function') {
                        try { res.removeHeader('Content-Length'); } catch (e) { }
                    }
                    headerWritten = true;
                    makeCompressor();
                }
                if (chunk) {
                    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encodingArg);
                    return compressor.write(buf, cb);
                }
                if (typeof cb === 'function') cb();
                return true;
            };

            res.end = function (chunk, encodingArg, cb) {
                if (!decided) {
                    decided = true;
                    const ct = (typeof res.getHeader === 'function') ? res.getHeader('Content-Type') : null;
                    const doCompress = encoding && compressible(ct);
                    if (!doCompress) {
                        try { if (typeof res.removeHeader === 'function') res.removeHeader('Content-Encoding'); } catch (e) { }
                        res.write = _write;
                        res.end = _end;
                        return res.end(chunk, encodingArg, cb);
                    }
                    try { res.setHeader('Content-Encoding', encoding); } catch (e) { }
                    if (typeof res.removeHeader === 'function') {
                        try { res.removeHeader('Content-Length'); } catch (e) { }
                    }
                    headerWritten = true;
                    makeCompressor();
                }
                if (chunk) {
                    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encodingArg);
                    return compressor.end(buf, cb);
                }
                return compressor ? compressor.end(cb) : _end(cb);
            };

            return next();
        } catch (e) {
            // If anything goes wrong in the middleware, don't break the app
            console.error('compression middleware failed', e);
            return next();
        }
    };
};

const Stratum = require('./stratum');
const util = require('./stratum/util.js');

const api = require('./api.js');

const CreateRedisClient = require('./createRedisClient.js');

/**
 * Creates and configures the website module for the mining pool interface.
 * This is the main entry point that sets up the entire web server infrastructure,
 * including template processing, routing, and real-time statistics updates.
 * 
 * @param {Object} logger - Logger instance for system logging
 * @param {Function} logger.debug - Debug level logging function
 * @param {Function} logger.info - Info level logging function  
 * @param {Function} logger.error - Error level logging function
 * @returns {void} - Initializes the web server but doesn't return a value
 * 
 * @example
 * const logger = require('./logUtil.js')('Website');
 * const websiteModule = require('./website.js');
 * websiteModule(logger);
 */
module.exports = function (logger) {

    // Configure doT template engine to preserve whitespace
    dot.templateSettings.strip = false;

    /**
     * Portal configuration loaded from environment variables
     * Contains website settings, Redis configuration, and other portal-wide settings
     * @type {Object}
     */
    const portalConfig = JSON.parse(process.env.portalConfig);

    /**
     * Pool configurations for all enabled cryptocurrency pools
     * Contains daemon connections, payout settings, and pool-specific configurations
     * @type {Object}
     */
    const poolConfigs = JSON.parse(process.env.pools);

    /**
     * Website-specific configuration extracted from portal config
     * @type {Object}
     */
    const websiteConfig = portalConfig.website;

    /**
     * Portal API instance providing statistics and data access methods
     * @type {Object}
     */
    const portalApi = new api(logger, portalConfig, poolConfigs);

    /**
     * Statistics module from the portal API for accessing pool and miner data
     * @type {Object}
     */
    const portalStats = portalApi.stats;

    /**
     * Log system identifier for this module
     * @constant {string}
     */
    const logSystem = 'Website';

    /**
     * Mapping of HTML filenames to their corresponding page identifiers
     * Used for template processing and routing
     * @type {Object.<string, string>}
     */
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

    /**
     * Storage for compiled doT template functions
     * Each key corresponds to a page identifier from pageFiles
     * @type {Object.<string, Function>}
     */
    const pageTemplates = {};

    /**
     * Storage for processed page content (without index wrapper)
     * Contains the rendered HTML for individual pages
     * @type {Object.<string, string>}
     */
    const pageProcessed = {};

    /**
     * Storage for complete processed pages (with index wrapper)
     * Contains the final HTML output ready to serve to clients
     * @type {Object.<string, string>}
     */
    const indexesProcessed = {};

    /**
     * Template function for the cryptocurrency key generation page
     * @type {Function|string}
     */
    let keyScriptTemplate = '';

    /**
     * Processed HTML content for the key generation page
     * @type {string}
     */
    let keyScriptProcessed = '';

    /**
     * Processes all page templates with current statistics and configuration data.
     * This function regenerates all page content by applying the latest stats and
     * configuration to the compiled templates, then wraps them in the index template.
     * 
     * @function processTemplates
     * @returns {void}
     * 
     * @description
     * The processing happens in two stages:
     * 1. Process individual page templates with stats and config data
     * 2. Wrap processed pages in the index template for complete page structure
     */
    const processTemplates = function () {

        // Process each page template (except index which is used as wrapper)
        for (const pageName in pageTemplates) {
            if (pageName === 'index') {
                continue; // Skip index template as it's used as a wrapper
            }

            // Render the page content with current statistics and configuration
            pageProcessed[pageName] = pageTemplates[pageName]({
                poolsConfigs: poolConfigs,
                stats: portalStats.stats,
                portalConfig: portalConfig
            });

            // Wrap the processed page content in the index template
            // This creates the complete HTML page with navigation and layout
            indexesProcessed[pageName] = pageTemplates.index({
                page: pageProcessed[pageName],
                selected: pageName,
                stats: portalStats.stats,
                poolConfigs: poolConfigs,
                portalConfig: portalConfig
            });
        }

        // Note: Uncomment for debugging template updates
        //logger.debug(logSystem, 'Stats', 'Website updated to latest stats');
    };

    /**
     * Reads and compiles HTML template files into doT template functions.
     * This function handles the asynchronous loading of template files and
     * compiles them using the doT template engine for later use.
     * 
     * @function readPageFiles
     * @param {string[]} files - Array of HTML filenames to read and compile
     * @returns {void}
     * 
     * @description
     * The function:
     * 1. Determines the correct file path (root for index.html, pages/ for others)
     * 2. Reads each file asynchronously using fs.readFile
     * 3. Compiles the file content into a doT template function
     * 4. Stores the compiled template in the pageTemplates object
     * 5. Processes all templates once all files are loaded
     */
    const readPageFiles = function (files) {
        Promise.all(files.map(fileName => new Promise((resolve, reject) => {
            // Determine file path: index.html is in root, others are in pages/ subdirectory
            const filePath = `website/${fileName === 'index.html' ? '' : 'pages/'}${fileName}`;

            fs.readFile(filePath, 'utf8', (err, data) => {
                if (err) {
                    logger.error(logSystem, 'Template', `Failed to read template file: ${filePath}`);
                    reject(err);
                    return;
                }

                // Compile the HTML template into a doT template function
                const pTemp = dot.template(data);
                pageTemplates[pageFiles[fileName]] = pTemp;
                resolve();
            });
        }))).then(() => {
            // Once all templates are loaded, process them with current data
            processTemplates();
        }).catch((err) => {
            console.log(`error reading files for creating dot templates: ${JSON.stringify(err)}`);
        });
    };

    /**
     * File System Watcher Setup
     * 
     * Monitors HTML template files for changes and automatically reloads them.
     * This enables hot-reloading of templates during development without
     * requiring a server restart.
     *  @function watchPaths
     * @param {string[]} pathsToWatch - Array of directory paths to monitor
     * @param {Function} cb - Callback function to invoke on file changes
     * @returns {void}
     */
    // Native watcher wrapper using fs.watch
    const watchPaths = function (pathsToWatch, cb) {
        pathsToWatch.forEach((watchPath) => {
            try {
                fs.watch(watchPath, { persistent: true }, (eventType, filename) => {
                    // `filename` may be null on some platforms/edits; attempt to
                    // construct a sensible path. We call the callback with a
                    // single argument (full path if available) to match the
                    // older node-watch behavior used below.
                    let fullPath = null;
                    if (filename) {
                        fullPath = path.join(watchPath, filename);
                    }

                    // If filename isn't provided, fall back to the watched path
                    // this allows the downstream handler to at least inspect the
                    // basename and decide what to do.
                    cb(fullPath || watchPath);
                });
            } catch (e) {
                logger.error(logSystem, 'Watch', `Failed to watch path ${watchPath} - ${e}`);
            }
        });
    };

    // Start watching template directories for changes. When a file changes
    // call the same handler logic as before (we pass a single path-like
    // argument so the existing basename extraction works).
    watchPaths(['./website', './website/pages'], (evtPath) => {
        const basename = path.basename(evtPath);

        // Only reload files that are defined in our pageFiles mapping
        if (basename in pageFiles) {
            readPageFiles([basename]);
            logger.info(logSystem, 'Server', `Reloaded file ${basename}`);
        }
    });

    // Initial setup: Load global statistics and read all template files
    portalStats.getGlobalStats(() => {
        readPageFiles(Object.keys(pageFiles));
    });

    /**
     * Builds and updates the website with fresh statistics data.
     * This function is called periodically to refresh all page content with
     * the latest mining statistics and sends updates to live connections.
     * 
     * @function buildUpdatedWebsite
     * @returns {void}
     * 
     * @description
     * The update process:
     * 1. Retrieves the latest global statistics from the portal
     * 2. Reprocesses all templates with the new data
     * 3. Sends real-time updates to connected clients via Server-Sent Events (SSE)
     */
    const buildUpdatedWebsite = function () {
        portalStats.getGlobalStats(() => {
            // Regenerate all page content with latest statistics
            processTemplates();

            // Prepare statistics data for Server-Sent Events (SSE) format
            const statData = `data: ${JSON.stringify(portalStats.stats)}\n\n`;

            // Send updated statistics to all live connections
            for (const uid in portalApi.liveStatConnections) {
                const res = portalApi.liveStatConnections[uid];
                res.write(statData);
            }
        });
    };

    // Set up periodic website updates based on configuration interval
    setInterval(buildUpdatedWebsite, websiteConfig.stats.updateInterval * 1000);

    /**
     * Builds the cryptocurrency key script generation page.
     * This function creates a specialized page that allows users to generate
     * private keys for different cryptocurrencies supported by the pool.
     * 
     * @function buildKeyScriptPage
     * @returns {void}
     * 
     * @description
     * This complex function performs several operations:
     * 1. Retrieves cryptocurrency version bytes from Redis cache
     * 2. Identifies missing version bytes for enabled coins
     * 3. Connects to cryptocurrency daemons to extract version byte information
     * 4. Caches the version bytes in Redis for future use
     * 5. Generates the key script page template with all coin data
     * 
     * The waterfall pattern ensures operations execute in the correct sequence
     * with proper error handling and resource cleanup.
     */
    const buildKeyScriptPage = async function () {
        try {
            // Step 1: Connect to Redis and retrieve existing coin version bytes
            const { client, coinBytes } = await new Promise((resolve, reject) => {
                const client = CreateRedisClient(portalConfig.redis);

                // Authenticate with Redis if password is configured
                if (portalConfig.redis.password) {
                    client.auth(portalConfig.redis.password);
                }

                // Retrieve all stored coin version bytes from Redis hash
                client.hgetall('coinVersionBytes', (err, coinBytes) => {
                    if (err) {
                        client.quit();
                        reject(`Failed grabbing coin version bytes from redis ${JSON.stringify(err)}`);
                        return;
                    }
                    resolve({ client, coinBytes: coinBytes || {} });
                });
            });

            // Step 2: Identify coins that are missing version byte information
            const enabledCoins = Object.keys(poolConfigs).map((c) => {
                return c.toLowerCase();
            });

            // Find coins that don't have version bytes cached in Redis
            const missingCoins = [];
            enabledCoins.forEach((c) => {
                if (!(c in coinBytes)) {
                    missingCoins.push(c);
                }
            });

            // Step 3: Extract version bytes from cryptocurrency daemons for missing coins
            const coinsForRedis = {}; // New version bytes to cache in Redis

            await Promise.all(missingCoins.map(c => new Promise((resolve, reject) => {
                // Find the pool configuration for this coin
                const coinInfo = (function () {
                    for (const pName in poolConfigs) {
                        if (pName.toLowerCase() === c) {
                            return {
                                daemon: poolConfigs[pName].paymentProcessing.daemon,
                                address: poolConfigs[pName].address
                            };
                        }
                    }
                })();

                // Create daemon interface for this coin
                const daemon = new Stratum.daemon.interface([coinInfo.daemon], ((severity, message) => {
                    logger[severity](logSystem, c, message);
                }));

                // Extract private key to determine version bytes
                daemon.cmd('dumpprivkey', [coinInfo.address], (result) => {
                    if (result[0].error) {
                        logger.error(logSystem, c, `Could not dumpprivkey for ${c} ${JSON.stringify(result[0].error)}`);
                        resolve();
                        return;
                    }

                    // Extract version bytes from public and private key formats
                    const vBytePub = util.getVersionByte(coinInfo.address)[0];
                    const vBytePriv = util.getVersionByte(result[0].response)[0];

                    // Store version bytes in format "public,private"
                    coinBytes[c] = `${vBytePub.toString()},${vBytePriv.toString()}`;
                    coinsForRedis[c] = coinBytes[c];
                    resolve();
                });
            })));

            // Step 4: Cache new version bytes in Redis and cleanup connections
            if (Object.keys(coinsForRedis).length > 0) {
                await new Promise((resolve, reject) => {
                    client.hmset('coinVersionBytes', coinsForRedis, (err) => {
                        if (err) {
                            logger.error(logSystem, 'Init', `Failed inserting coin byte version into redis ${JSON.stringify(err)}`);
                            reject(err);
                            return;
                        }
                        resolve();
                    });
                });
            }
            client.quit();

            // Generate the key script page with all coin version bytes
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

    // Initialize the key script page on startup
    buildKeyScriptPage();

    /**
     * Retrieves a processed page by its identifier.
     * Returns the rendered HTML content for a specific page without the index wrapper.
     * 
     * @function getPage
     * @param {string} pageId - The page identifier (e.g., 'stats', 'workers', etc.)
     * @returns {string|undefined} The processed page HTML or undefined if not found
     */
    const getPage = function (pageId) {
        if (pageId in pageProcessed) {
            const requestedPage = pageProcessed[pageId];
            return requestedPage;
        }
    };

    /**
     * Express route handler for individual miner statistics pages.
     * Extracts miner address from URL parameters and displays their statistics.
     * 
     * @function minerpage
     * @param {Object} req - Express request object
     * @param {Object} req.params - Request parameters
     * @param {string} req.params.address - Miner's wallet address (may include worker name)
     * @param {Object} res - Express response object
     * @param {Function} next - Express next middleware function
     * @returns {void}
     * 
     * @description
     * This handler:
     * 1. Extracts the wallet address (removing worker suffix if present)
     * 2. Retrieves balance information for the address
     * 3. Regenerates templates with updated data
     * 4. Serves the miner statistics page
     */
    const minerpage = function (req, res, next) {
        let address = req.params.address || null;
        if (address != null) {
            // Extract wallet address (remove worker name suffix if present)
            address = address.split('.')[0];

            // Retrieve balance and statistics for this specific address
            portalStats.getBalanceByAddress(address, () => {
                processTemplates(); // Regenerate templates with updated miner data
                res.header('Content-Type', 'text/html');
                res.end(indexesProcessed['miner_stats']);
            });
        } else {
            next(); // No address provided, pass to next middleware
        }
    };

    /**
     * Express route handler for payout information requests.
     * Returns payout data for a specific wallet address in raw format.
     * 
     * @function payout
     * @param {Object} req - Express request object
     * @param {Object} req.params - Request parameters
     * @param {string} req.params.address - Wallet address to get payout info for
     * @param {Object} res - Express response object
     * @param {Function} next - Express next middleware function
     * @returns {void}
     */
    const payout = function (req, res, next) {
        const address = req.params.address || null;
        if (address != null) {
            portalStats.getPayout(address, (data) => {
                res.write(data.toString());
                res.end();
            });
        } else {
            next();
        }
    };

    /**
     * Express route handler for share statistics overview.
     * Displays share information across all coins and users.
     * 
     * @function shares
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     * @param {Function} next - Express next middleware function
     * @returns {void}
     */
    const shares = function (req, res, next) {
        portalStats.getCoins(() => {
            processTemplates();
            res.end(indexesProcessed['user_shares']);
        });
    };

    /**
     * Express route handler for coin-specific share statistics.
     * Displays share information for a particular cryptocurrency.
     * 
     * @function usershares
     * @param {Object} req - Express request object
     * @param {Object} req.params - Request parameters
     * @param {string} req.params.coin - Coin symbol to get share stats for
     * @param {Object} res - Express response object
     * @param {Function} next - Express next middleware function
     * @returns {void}
     */
    const usershares = function (req, res, next) {
        const coin = req.params.coin || null;
        if (coin != null) {
            portalStats.getCoinTotals(coin, null, () => {
                processTemplates();
                res.end(indexesProcessed['user_shares']);
            });
        } else {
            next();
        }
    };

    /**
     * Express route handler for general page routing.
     * Serves processed HTML pages based on the page parameter.
     * 
     * @function route
     * @param {Object} req - Express request object
     * @param {Object} req.params - Request parameters
     * @param {string} req.params.page - Page identifier to serve
     * @param {Object} res - Express response object
     * @param {Function} next - Express next middleware function
     * @returns {void}
     */
    const route = function (req, res, next) {
        const pageId = req.params.page || ''; // Default to empty string for home page

        // Check if the requested page exists in our processed pages
        if (pageId in indexesProcessed) {
            res.header('Content-Type', 'text/html');
            res.end(indexesProcessed[pageId]);
        } else {
            next(); // Page not found, pass to next middleware (likely 404 handler)
        }
    };

    /**
     * Express Application Setup and Route Configuration
     * 
     * Creates and configures the main Express.js application with all
     * necessary middleware, routes, and error handling.
     */

    /**
     * Main Express application instance
     * @type {Object}
     */
    const app = express();

    // Configure JSON body parsing middleware for API requests
    app.use(bodyParser.json());

    /**
     * Route: GET /get_page
     * AJAX endpoint for dynamically loading page content without full page refresh
     */
    app.get('/get_page', (req, res, next) => {
        const requestedPage = getPage(req.query.id);
        if (requestedPage) {
            res.end(requestedPage);
            return;
        }
        next();
    });

    /**
     * Route: GET /key.html
     * Serves the cryptocurrency key generation page with embedded coin data
     */
    app.get('/key.html', (req, res, next) => {
        res.end(keyScriptProcessed);
    });

    // Commented out routes - potentially deprecated or not yet implemented
    //app.get('/stats/shares/:coin', usershares);
    //app.get('/stats/shares', shares);
    //app.get('/payout/:address', payout);

    // Enable gzip compression for better performance
    app.use(compress());

    /**
     * Route: GET /workers/:address
     * Individual miner statistics page showing hashrate, shares, and earnings
     */
    app.get('/workers/:address', minerpage);

    /**
     * Route: GET /:page
     * General page routing for all static pages (stats, workers, api, etc.)
     */
    app.get('/:page', route);

    /**
     * Route: GET /
     * Home page route (empty page parameter defaults to home page)
     */
    app.get('/', route);

    /**
     * Route: GET /api/:method
     * Public API endpoints for pool statistics and information
     */
    app.get('/api/:method', (req, res, next) => {
        portalApi.handleApiRequest(req, res, next);
    });

    /**
     * Route: POST /api/admin/:method
     * Administrative API endpoints requiring password authentication
     */
    app.post('/api/admin/:method', (req, res, next) => {
        // Check if admin center is enabled in configuration
        if (portalConfig.website
            && portalConfig.website.adminCenter
            && portalConfig.website.adminCenter.enabled) {

            // Verify admin password before allowing access
            if (portalConfig.website.adminCenter.password === req.body.password) {
                portalApi.handleAdminApiRequest(req, res, next);
            } else {
                res.send(401, JSON.stringify({ error: 'Incorrect Password' }));
            }
        } else {
            next(); // Admin center not enabled, pass to 404 handler
        }
    });

    // Apply compression middleware for all remaining routes
    app.use(compress());

    /**
     * Route: GET /static/*
     * Static file serving for CSS, JavaScript, images, and other assets
     */
    app.use('/static', express.static('website/static'));

    /**
     * Global error handler middleware
     * Catches and handles any unhandled errors in the application
     */
    app.use((err, req, res, next) => {
        console.error(err.stack);
        res.send(500, 'Something broke!');
    });

    /**
     * Server Startup Configuration
     * 
     * Starts either HTTPS or HTTP server based on configuration settings.
     * Supports TLS/SSL encryption for secure connections when enabled.
     */
    try {
        // Check if TLS/SSL is enabled in configuration
        if (portalConfig.website.tlsOptions && portalConfig.website.tlsOptions.enabled === true) {
            /**
             * TLS/SSL options for HTTPS server
             * @type {Object}
             */
            const TLSoptions = {
                key: fs.readFileSync(portalConfig.website.tlsOptions.key),
                cert: fs.readFileSync(portalConfig.website.tlsOptions.cert)
            };

            // Start HTTPS server with TLS encryption
            https.createServer(TLSoptions, app).listen(portalConfig.website.port, portalConfig.website.host, () => {
                logger.debug(logSystem, 'Server', `TLS Website started on ${portalConfig.website.host}:${portalConfig.website.port}`);
            });
        } else {
            // Start standard HTTP server
            app.listen(portalConfig.website.port, portalConfig.website.host, () => {
                logger.debug(logSystem, 'Server', `Website started on ${portalConfig.website.host}:${portalConfig.website.port}`);
            });
        }
    } catch (e) {
        console.log(e);
        logger.error(logSystem, 'Server', `Could not start website on ${portalConfig.website.host}:${portalConfig.website.port
            } - its either in use or you do not have permission`);
    }

};
