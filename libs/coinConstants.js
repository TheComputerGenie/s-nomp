/**
 * Coin constants for Verus Coin (VRSC)
 * Since we only support Verus Coin now, these values are hardcoded as constants
 */

const COIN_CONSTANTS = {
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
};

module.exports = COIN_CONSTANTS;
