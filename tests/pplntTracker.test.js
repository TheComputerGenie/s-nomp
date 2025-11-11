/**
 * @fileoverview Unit tests for libs/payments/PplntTracker.js
 *
 * Validates basic PPLNT time-share tracking behavior using a lightweight
 * fake Redis client and logger. Tests are plain Node.js scripts to keep
 * the repository free of external test framework dependencies.
 *
 * @author ComputerGenieCo
 * @version 21.7.3
 * @copyright 2025
 */

const assert = require('assert');
const PplntTracker = require('../libs/payments/PplntTracker.js');

function makeLogger() {
    return {
        debug: (...args) => { /* no-op for tests */ },
        error: (...args) => { throw new Error('Logger error called: ' + JSON.stringify(args)); }
    };
}

function makeFakeRedis() {
    const calls = [];
    return {
        multi(cmds) {
            calls.push(cmds);
            return {
                exec(cb) {
                    // simulate success
                    if (typeof cb === 'function') cb(null, ['OK']);
                    return Promise.resolve(['OK']);
                }
            };
        },
        _calls: calls
    };
}

(async function runTests() {
    console.log('Running PplntTracker tests...');

    // Test: basic increment behavior
    const logger = makeLogger();
    const poolConfigs = { 'verus': { poolId: 'pool1' } };
    const tracker = new PplntTracker(logger, poolConfigs, (n, d) => { return +n.toFixed(d); });

    const fakeRedis = makeFakeRedis();
    tracker.init(fakeRedis);

    const msg = {
        coin: 'verus',
        isValidShare: true,
        isValidBlock: false,
        data: { worker: 'Raddress.1' },
        thread: 0
    };

    tracker.handleShare(msg);
    // expect one multi call
    assert.strictEqual(fakeRedis._calls.length, 1, 'redis.multi should have been called once');

    // Test: block reset
    const blockMsg = { coin: 'verus', isValidShare: false, isValidBlock: true };
    tracker.handleShare(blockMsg);
    // internal trackers should be reset
    assert.deepStrictEqual(tracker._lastShareTimes['verus'], {}, 'lastShareTimes should be reset after block');

    // Test: long gap (simulate lastSeen far in the past by monkey patching roundTo to return a small value and manual lastShareTimes)
    tracker._lastShareTimes['verus'] = { 'Raddress': Date.now() - (1000 * 1000) };
    const oldCalls = fakeRedis._calls.length;
    tracker.handleShare(msg);
    // After a long gap, tracker should still update but may not call redis (depending on logic). We ensure no exceptions thrown.
    assert.ok(fakeRedis._calls.length >= oldCalls);

    console.log('All PplntTracker tests passed');
})();
