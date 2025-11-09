/**
 * Coin constants for supported coins.
 * We expose a small helper API so callers can request a coin profile by name.
 * This allows multiple coins (verus, vdex, varrr, chips) to be supported
 * while keeping a simple access pattern.
 *
 * Assumptions:
 * - Pool config files are named after the coin (e.g. `vrsc.json`) and the
 *   coin name will be derived from that filename when selecting a profile.
 */

const COIN_CONSTANTS = {
    verus: {
        name: 'verus',
        symbol: 'vrsc',
        algorithm: 'verushash',
        sapling: 227520,
        peerMagic: 'ad8a58e2',
        txfee: 0.0001,
        burnFees: false,
        explorer: {
            txURL: 'https://insight.verus.io/tx/',
            blockURL: 'https://insight.verus.io/block/'
        }
    },
    vdex: {
        name: 'vdex',
        symbol: 'vdex',
        algorithm: 'verushash',
        sapling: 0,
        peerMagic: '317962c4', // from default pool pbaasChains
        txfee: 0.0001,
        burnFees: false,
        explorer: {
            txURL: null,
            blockURL: null
        }
    },
    varrr: {
        name: 'varrr',
        symbol: 'varrr',
        algorithm: 'verushash',
        sapling: 0,
        peerMagic: 'dd1700ab',
        txfee: 0.0001,
        burnFees: false,
        explorer: {
            txURL: null,
            blockURL: null
        }
    },
    chips: {
        name: 'chips',
        symbol: 'chips',
        algorithm: 'verushash',
        sapling: 0,
        peerMagic: '2c40c93c',
        txfee: 0.0001,
        burnFees: false,
        explorer: {
            txURL: null,
            blockURL: null
        }
    }
};

// Helper: return a coin profile by name. If no name provided, return verus.
function getCoin(name) {
    if (!name) return COIN_CONSTANTS.verus;
    const key = name.toString().toLowerCase();
    // Accept a few common aliases
    if (key === 'vrsc' || key === 'verus') return COIN_CONSTANTS.verus;
    if (key === 'vdex') return COIN_CONSTANTS.vdex;
    if (key === 'varrr' || key === 'varr' || key === 'var') return COIN_CONSTANTS.varrr;
    if (key === 'chips') return COIN_CONSTANTS.chips;
    return null;
}

// Attach helper methods as non-enumerable properties to preserve the
// coin keys when enumerating COIN_CONSTANTS.
Object.defineProperty(COIN_CONSTANTS, 'get', {
    value: getCoin,
    enumerable: false,
    configurable: false,
    writable: false
});
Object.defineProperty(COIN_CONSTANTS, 'default', {
    value: COIN_CONSTANTS.verus,
    enumerable: false,
    configurable: false,
    writable: false
});

module.exports = COIN_CONSTANTS;
