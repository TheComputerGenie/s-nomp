const redis = require('redis');
const Stratum = require('./stratum');
const CreateRedisClient = require('./createRedisClient.js');



/*
This module deals with handling shares when in internal payment processing mode. It connects to a redis
database and inserts shares with the database structure of:

key: coin_name + ':' + block_height
value: a hash with..
        key:

 */



module.exports = function (logger, poolConfig) {

    const redisConfig = poolConfig.redis;
    const coin = poolConfig.coin.name;


    const forkId = process.env.forkId;
    const logSystem = 'Pool';
    const logComponent = coin;
    const logSubCat = `Thread ${parseInt(forkId) + 1}`;

    const connection = CreateRedisClient(redisConfig);
    if (redisConfig.password) {
        connection.auth(redisConfig.password);
    }
    connection.on('ready', () => {
        logger.debug(logSystem, logComponent, logSubCat, `Share processing setup with redis (${connection.snompEndpoint})`);
    });
    connection.on('error', (err) => {
        logger.error(logSystem, logComponent, logSubCat, `Redis client had an error: ${JSON.stringify(err)}`);
    });
    connection.on('end', () => {
        logger.error(logSystem, logComponent, logSubCat, 'Connection to redis database has been ended');
    });
    connection.info((error, response) => {
        if (error) {
            logger.error(logSystem, logComponent, logSubCat, 'Redis version check failed');
            return;
        }
        const parts = response.split('\r\n');
        let version;
        let versionString;
        for (let i = 0; i < parts.length; i++) {
            if (parts[i].indexOf(':') !== -1) {
                const valParts = parts[i].split(':');
                if (valParts[0] === 'redis_version') {
                    versionString = valParts[1];
                    version = parseFloat(versionString);
                    break;
                }
            }
        }
        if (!version) {
            logger.error(logSystem, logComponent, logSubCat, 'Could not detect redis version - but be super old or broken');
        } else if (version < 2.6) {
            logger.error(logSystem, logComponent, logSubCat, `You're using redis version ${versionString} the minimum required version is 2.6. Follow the damn usage instructions...`);
        }
    });

    this.handleShare = function (isValidShare, isValidBlock, shareData) {

        const redisCommands = [];
        const dateNow = Date.now();

        if (isValidShare) {
            redisCommands.push(['hincrbyfloat', `${coin}:shares:pbaasCurrent`, shareData.worker, shareData.difficulty]);
            redisCommands.push(['hincrbyfloat', `${coin}:shares:roundCurrent`, shareData.worker, shareData.difficulty]);
            redisCommands.push(['hincrby', `${coin}:stats`, 'validShares', 1]);
            redisCommands.push(['hset', `${coin}:lastSeen`, shareData.worker, dateNow]);
        } else {
            redisCommands.push(['hincrby', `${coin}:stats`, 'invalidShares', 1]);
        }

        /* Stores share diff, worker, and unique value with a score that is the timestamp. Unique value ensures it
           doesn't overwrite an existing entry, and timestamp as score lets us query shares from last X minutes to
           generate hashrate for each worker and pool. */
        const hashrateData = [isValidShare ? shareData.difficulty : -shareData.difficulty, shareData.worker, dateNow];
        redisCommands.push(['zadd', `${coin}:hashrate`, dateNow / 1000 | 0, hashrateData.join(':')]);

        if (isValidBlock) {
            // track potential pbaas blocks ( need lookup and processing )
            redisCommands.push(['sadd', `${coin}:pbaasPending`, [shareData.blockHash, shareData.worker, dateNow].join(':')]);
            // track main chain blocks
            if (!shareData.blockOnlyPBaaS) {
                redisCommands.push(['rename', `${coin}:shares:roundCurrent`, `${coin}:shares:round${shareData.height}`]);
                redisCommands.push(['rename', `${coin}:shares:timesCurrent`, `${coin}:shares:times${shareData.height}`]);
                redisCommands.push(['sadd', `${coin}:blocksPending`, [shareData.blockHash, shareData.txHash, shareData.height, shareData.worker, dateNow].join(':')]);
                redisCommands.push(['hincrby', `${coin}:stats`, 'validBlocks', 1]);
            }
        } else if (shareData.blockHash) {
            redisCommands.push(['hincrby', `${coin}:stats`, 'invalidBlocks', 1]);
        }

        connection.multi(redisCommands).exec((err, replies) => {
            if (err) {
                logger.error(logSystem, logComponent, logSubCat, `Error with share processor multi ${JSON.stringify(err)}`);
            }
        });
    };

};
