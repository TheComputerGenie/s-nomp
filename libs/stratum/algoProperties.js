const util = require('./util.js');

const diff1 = global.diff1 = 0x0007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;

const algos = module.exports = global.algos = {
    sha256: {
        //Uncomment diff if you want to use hardcoded truncated diff
        //diff: '00000000ffff0000000000000000000000000000000000000000000000000000',
        hash: function(){
            return function(){
                return util.sha256d.apply(this, arguments);
            };
        }
    },
    verushash: {
        multiplier: 1,
        diff: parseInt('0x0007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'),
        hashReserved: '0000000000000000000000000000000000000000000000000000000000000000',
        hash: function(coinOptions) {
            return function(){
                return true;
            };            
        }
    },
    'equihash': {
        multiplier: 1,
        diff: parseInt('0x0007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'),
        hash: function(coinOptions) {
            let parameters = coinOptions.parameters;
            if (!parameters) {
                parameters = {
                    N: 200,
                    K: 9,
                    personalization: 'ZcashPoW'
                };
            }

            const N = parameters.N || 200;
            const K = parameters.K || 9;
            const personalization = parameters.personalization || 'ZcashPoW';
        }
    }
};

for (const algo in algos){
    if (!algos[algo].multiplier) {
        algos[algo].multiplier = 1;
    }
}
