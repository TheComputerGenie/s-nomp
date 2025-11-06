// Copyright (c) 2011-2017 bitcoinjs-lib contributors
// Copyright (c) 2018-2025 ComputerGenieCo
// Distributed under the GNU GENERAL PUBLIC LICENSE software license, see the accompanying
// file LICENSE or https://www.gnu.org/licenses/gpl-3.0.en.html

const typeforce = require('./typeforce');

const coins = {
    DEFAULT: 'default',
    VRSC: 'verus'
};

coins.isZcash = function (network) {
    return !!network.isZcash;
};

coins.isVerus = function (network) {
    return typeforce.value(coins.VRSC)(network.coin);
};

coins.isValidCoin = typeforce.oneOf(
    coins.isZcash,
    coins.isVerus
);

module.exports = coins;