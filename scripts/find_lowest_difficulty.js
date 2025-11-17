const fs = require('fs').promises;
const path = require('path');
const DaemonInterface = require('../libs/stratum/daemon').interface;

async function getDifficulty(daemons) {
    return new Promise((resolve, reject) => {
        const daemon = new DaemonInterface(daemons, console.log);
        daemon.cmd('getinfo', [], (results) => {
            if (results && results[0] && !results[0].error && results[0].response && typeof results[0].response.difficulty === 'number') {
                resolve(results[0].response.difficulty);
            } else {
                reject(new Error('Failed to get difficulty'));
            }
        });
    });
}

async function main() {
    const chains = ['vrsc', 'vdex', 'varrr', 'chips'];
    let minDiff = Infinity;
    let minChain = null;
    const results = [];

    for (const chain of chains) {
        const configPath = path.join(__dirname, '..', 'configFiles', `${chain}.json`);
        try {
            const configData = await fs.readFile(configPath, 'utf8');
            const config = JSON.parse(configData);
            if (!config.daemons || !Array.isArray(config.daemons) || config.daemons.length === 0) {
                console.error(`Invalid daemons config for ${chain}`);
                continue;
            }
            const diff = await getDifficulty(config.daemons);
            results.push({ chain, diff });
            if (diff < minDiff) {
                minDiff = diff;
                minChain = chain;
            }
        } catch (e) {
            console.error(`Error for ${chain}: ${e.message}`);
        }
    }

    // Find max length of integer part for alignment
    const maxIntLen = Math.max(...results.map(r => r.diff.toString().split('.')[0].length));

    // Print aligned
    for (const result of results) {
        const diffStr = result.diff.toString();
        const [intPart, decPart] = diffStr.split('.');
        const paddedInt = intPart.padStart(maxIntLen);
        const formattedDiff = decPart ? `${paddedInt}.${decPart}` : `${paddedInt}`;
        console.log(`${result.chain}:\t${formattedDiff}`);
    }

    if (minChain) {
        const minDiffStr = minDiff.toString();
        const [intPart, decPart] = minDiffStr.split('.');
        const paddedInt = intPart.padStart(maxIntLen);
        const formattedMinDiff = decPart ? `${paddedInt}.${decPart}` : `${paddedInt}`;
        console.log(`Lowest difficulty chain: ${minChain} with ${formattedMinDiff}`);
    } else {
        console.log('No chain found with difficulty');
    }
}

main();