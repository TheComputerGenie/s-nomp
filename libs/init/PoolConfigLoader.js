/**
 * @fileoverview PoolConfigLoader - load and validate pool configurations
 *
 * Discovers enabled pool JSON files under `configFiles/`, validates ports and
 * coin profiles, merges defaults from portal configuration, and returns the
 * resolved pool configurations object.
 *
 * @author ComputerGenieCo
 * @version 21.7.3
 * @copyright 2025
 */

const algos = require('../stratum/algoProperties.js');
const coinConstants = require('../coinConstants.js');
const fs = require('fs');
const path = require('path');

const { minify } = require('../utils/jsonMinify.js');

/**
 * PoolConfigLoader
 *
 * @class PoolConfigLoader
 */
class PoolConfigLoader {
    constructor(portalConfig, logger) {
        this.portalConfig = portalConfig;
        this.logger = logger;
    }

    load() {
        const configs = {};
        const configDir = 'configFiles/';
        const poolConfigFiles = [];

        fs.readdirSync(configDir).forEach((file) => {
            if (!fs.existsSync(configDir + file) || path.extname(configDir + file) !== '.json') {
                return;
            }
            const poolOptions = JSON.parse(minify(fs.readFileSync(configDir + file, { encoding: 'utf8' })));
            if (!poolOptions.enabled) {
                return;
            }
            poolOptions.fileName = file;
            if (typeof poolOptions.coin === 'string' && poolOptions.coin.length > 0) {
                poolOptions.coinName = poolOptions.coin.toLowerCase();
            } else if (typeof poolOptions.coinName === 'string' && poolOptions.coinName.length > 0) {
                poolOptions.coinName = poolOptions.coinName.toLowerCase();
            } else {
                try {
                    poolOptions.coinName = path.parse(file).name.toLowerCase();
                } catch (e) {
                    poolOptions.coinName = null;
                }
            }
            poolConfigFiles.push(poolOptions);
        });

        // Port conflict detection
        for (let i = 0; i < poolConfigFiles.length; i++) {
            const ports = Object.keys(poolConfigFiles[i].ports);
            for (let f = 0; f < poolConfigFiles.length; f++) {
                if (f === i) {
                    continue;
                }
                const portsF = Object.keys(poolConfigFiles[f].ports);
                for (let g = 0; g < portsF.length; g++) {
                    if (ports.indexOf(portsF[g]) !== -1) {
                        this.logger.error('Master', poolConfigFiles[f].fileName, `Has same configured port of ${portsF[g]} as ${poolConfigFiles[i].fileName}`);
                        process.exit(1);
                        return;
                    }
                }
            }
        }

        poolConfigFiles.forEach((poolOptions) => {
            const inferredCoinName = (poolOptions.coinName) ? poolOptions.coinName : (poolOptions.fileName ? path.parse(poolOptions.fileName).name : null);
            const coinProfileRaw = coinConstants.get(inferredCoinName);
            if (!coinProfileRaw) {
                this.logger.error('Master', poolOptions.fileName || '<unknown>', `Unsupported or unknown coin profile for "${inferredCoinName}"`);
                process.exit(1);
                return;
            }
            const coinProfile = { ...coinProfileRaw };
            poolOptions.coin = coinProfile;
            poolOptions.coin.name = poolOptions.coin.name.toLowerCase();
            poolOptions.coinName = poolOptions.coin.name;
            poolOptions.redis = this.portalConfig.redis;

            if (poolOptions.coin.name in configs) {
                this.logger.error('Master', poolOptions.fileName, `Pool has same configured coin name ${poolOptions.coin.name} as pool config ${configs[poolOptions.coin.name].fileName}`);
                process.exit(1);
                return;
            }

            for (const option in this.portalConfig.defaultPoolConfigs) {
                if (!(option in poolOptions)) {
                    const toCloneOption = this.portalConfig.defaultPoolConfigs[option];
                    let clonedOption;
                    try {
                        clonedOption = structuredClone(toCloneOption);
                    } catch (e) {
                        clonedOption = JSON.parse(JSON.stringify(toCloneOption));
                    }
                    poolOptions[option] = clonedOption;
                }
            }

            configs[poolOptions.coin.name] = poolOptions;

            if (!algos.hasAlgorithm(coinProfile.algorithm)) {
                this.logger.error('Master', coinProfile.name, `Cannot run a pool for unsupported algorithm "${coinProfile.algorithm}"`);
                delete configs[poolOptions.coin.name];
            }
        });

        return configs;
    }
}

module.exports = PoolConfigLoader;
