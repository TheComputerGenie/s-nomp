/**
 * @fileoverview Application Entry controller
 *
 * Small bootstrapper class that centralizes startup for master vs worker
 * processes. This class is intentionally minimal: when run as master it
 * delegates to `MasterController`; when run as a worker it leaves the
 * existing worker bootstrap semantics intact.
 *
 * @author ComputerGenieCo
 * @version 21.7.3
 * @copyright 2025
 */

const cluster = require('cluster');

const MasterController = require('./MasterController.js');

/**
 * Entry bootstrapper
 *
 * Minimal bootstrap class used by `init.js` to start the master process.
 * @class Entry
 */
class Entry {
    constructor(options = {}) {
        this.options = options;
    }

    start() {
        if (cluster.isMaster) {
            const master = new MasterController();
            master.start();
        }
        // Worker bootstrap remains handled by existing code paths in init.js
    }
}

module.exports = Entry;
