const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');
const { pipeline } = require('stream');

function safeParseEnvJSON(name, opts = {}) {
    const { defaultValue } = opts || {};

    const raw = process.env[name];
    if (typeof raw === 'undefined') {
        return typeof defaultValue !== 'undefined' ? defaultValue : undefined;
    }

    const failures = [];

    const tryParse = (str) => {
        try {
            return { ok: true, value: JSON.parse(str) };
        } catch (e) {
            return { ok: false, err: e };
        }
    };

    let res = tryParse(raw);
    if (res.ok) {
        return res.value;
    }
    failures.push({ attempt: 'direct', error: res.err });

    res = tryParse(raw);
    if (res.ok && typeof res.value === 'string') {
        const second = tryParse(res.value);
        if (second.ok) {
            return second.value;
        }
        failures.push({ attempt: 'double-encoded', error: second.err });
    }
    let attempt = raw;
    if (attempt.length >= 2 && ((attempt[0] === '"' && attempt[attempt.length - 1] === '"') || (attempt[0] === '\'' && attempt[attempt.length - 1] === '\''))) {
        attempt = attempt.slice(1, -1);
    }
    attempt = attempt.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\r/g, '\r');
    res = tryParse(attempt);
    if (res.ok) {
        return res.value;
    }
    failures.push({ attempt: 'unwrapped', error: res.err });
    const sample = String(raw).slice(0, 240).replace(/\n/g, '\\n');
    return typeof defaultValue !== 'undefined' ? defaultValue : undefined;
}

function watchPaths(pathsToWatch, cb, logger) {
    pathsToWatch.forEach((watchPath) => {
        try {
            const absPath = path.isAbsolute(watchPath) ? watchPath : path.join(__dirname, '..', watchPath);

            // Try to watch the path itself (works for files and directories)
            try {
                fs.watch(absPath, { persistent: true }, (eventType, filename) => {
                    let fullPath = null;
                    if (filename) {
                        fullPath = path.join(absPath, filename);
                    }
                    try {
                        cb(fullPath || absPath);
                    } catch (e) {
                        if (logger && typeof logger.error === 'function') {
                            logger.error('Watch', `Watch callback error for ${absPath}: ${e}`);
                        }
                    }
                });
            } catch (e) {
                if (logger && typeof logger.error === 'function') {
                    logger.error('Watch', `Failed to watch path ${absPath} - ${e}`);
                }
            }

            // If this is a directory, also watch its immediate files to cope with
            // platforms that sometimes only emit directory-level events or omit
            // filenames. This increases reliability without pulling in external deps.
            try {
                const stat = fs.statSync(absPath);
                if (stat.isDirectory()) {
                    const children = fs.readdirSync(absPath);
                    children.forEach((child) => {
                        const childAbs = path.join(absPath, child);
                        try {
                            fs.watch(childAbs, { persistent: true }, (eventType, filename) => {
                                let fullPath = null;
                                if (filename) {
                                    fullPath = path.join(path.dirname(childAbs), filename);
                                }
                                try {
                                    cb(fullPath || childAbs);
                                } catch (e) {
                                    if (logger && typeof logger.error === 'function') {
                                        logger.error('Watch', `Watch callback error for ${childAbs}: ${e}`);
                                    }
                                }
                            });
                        } catch (e) {
                            // ignore individual child watch failures but log if logger available
                            if (logger && typeof logger.error === 'function') {
                                logger.error('Watch', `Failed to watch child path ${childAbs} - ${e}`);
                            }
                        }
                    });
                }
            } catch (e) {
                // stat/read dir could fail (non-existent path) - log and continue
                if (logger && typeof logger.error === 'function') {
                    logger.error('Watch', `Failed inspecting path ${absPath} - ${e}`);
                }
            }
        } catch (e) {
            if (logger && typeof logger.error === 'function') {
                logger.error('Watch', `Failed to process watchPath ${watchPath} - ${e}`);
            }
        }
    });
}

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

module.exports = {
    safeParseEnvJSON,
    watchPaths,
    serveStatic,
    createMiniApp
};
