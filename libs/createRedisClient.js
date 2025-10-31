const redis = require('redis');

module.exports = function createRedisClient(redisConfig) {

    const bSocket = ((typeof redisConfig.socket !== 'undefined') && (redisConfig.socket != ''));
    const client = bSocket ?
        redis.createClient(redisConfig.socket) :
        redis.createClient(redisConfig.port, redisConfig.host);

    client.snompEndpoint = bSocket ? redisConfig.socket : `${redisConfig.host  }:${  redisConfig.port}`;

    return client;
};
