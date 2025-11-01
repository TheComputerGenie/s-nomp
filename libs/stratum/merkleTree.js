const Promise = require('promise');
const merklebitcoin = Promise.denodeify(require('merkle-bitcoin'));
const util = require('./util.js');


function calcRoot(hashes) {
    const result = merklebitcoin(hashes);
    //console.log(Object.values(result)[2].root);
    return Object.values(result)[2].root;
}

exports.getRoot = function (rpcData, generateTxRaw) {
    hashes = [util.reverseBuffer(Buffer.from(generateTxRaw, 'hex')).toString('hex')];
    rpcData.transactions.forEach((value) => {
        hashes.push(value.hash);
    });
    if (hashes.length === 1) {
        return hashes[0];
    }
    const result = calcRoot(hashes);
    return result;
};
