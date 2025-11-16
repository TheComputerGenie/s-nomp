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
    constructor(portalConfig, logger, selectedCoin, isPbaas) {
        this.portalConfig = portalConfig;
        this.logger = logger;
        this.selectedCoin = selectedCoin;
        this.isPbaas = isPbaas;
    }

    load() {
        const configs = {};
        const configDir = 'configFiles/';
        const coinProfile = coinConstants.get(this.selectedCoin);
        if (!coinProfile) {
            this.logger.error('Master', 'PoolConfigLoader', `Invalid selected coin: ${this.selectedCoin}`);
            process.exit(1);
        }
        const symbol = coinProfile.symbol;
        const configFile = `${symbol}.json`;
        const configPath = path.join(configDir, configFile);
        let poolOptions;
        if (fs.existsSync(configPath)) {
            poolOptions = JSON.parse(minify(fs.readFileSync(configPath, { encoding: 'utf8' })));
        } else {
            if (this.isPbaas) {
                const chipsPath = path.join(configDir, 'chips.json');
                if (fs.existsSync(chipsPath)) {
                    poolOptions = JSON.parse(minify(fs.readFileSync(chipsPath, { encoding: 'utf8' })));
                    this.logger.warn('Master', 'PoolConfigLoader', `Config file ${configFile} not found, falling back to chips.json`);
                } else {
                    this.logger.error('Master', 'PoolConfigLoader', `Config file ${configFile} not found, and fallback chips.json not found`);
                    process.exit(1);
                }
            } else {
                this.logger.error('Master', 'PoolConfigLoader', `Config file ${configFile} not found`);
                process.exit(1);
            }
        }
        poolOptions.enabled = true; // force enable
        poolOptions.fileName = poolOptions.fileName || configFile;

        // Process coin name
        if (typeof poolOptions.coin === 'string' && poolOptions.coin.length > 0) {
            poolOptions.coinName = poolOptions.coin.toLowerCase();
        } else if (typeof poolOptions.coinName === 'string' && poolOptions.coinName.length > 0) {
            poolOptions.coinName = poolOptions.coinName.toLowerCase();
        } else {
            poolOptions.coinName = symbol.toLowerCase();
        }

        const inferredCoinName = poolOptions.coinName;
        const coinProfileRaw = coinConstants.get(inferredCoinName);
        if (!coinProfileRaw) {
            this.logger.error('Master', poolOptions.fileName, `Unsupported or unknown coin profile for "${inferredCoinName}"`);
            process.exit(1);
        }
        const coinProfileFinal = { ...coinProfileRaw };
        poolOptions.coin = coinProfileFinal;
        poolOptions.coin.name = poolOptions.coin.name.toLowerCase();
        poolOptions.coinName = poolOptions.coin.name;
        poolOptions.redis = this.portalConfig.redis;

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

        if (!algos.hasAlgorithm(coinProfileFinal.algorithm)) {
            this.logger.error('Master', coinProfileFinal.name, `Cannot run a pool for unsupported algorithm "${coinProfileFinal.algorithm}"`);
            delete configs[poolOptions.coin.name];
        }

        return configs;
    }
}

module.exports = PoolConfigLoader;
