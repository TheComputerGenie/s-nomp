const request = require('request');
const nonce   = require('nonce');

module.exports = function() {
    'use strict';

    // Module dependencies

    // Constants
    const version         = '0.1.0',
        PUBLIC_API_URL  = 'https://api.mintpal.com/v2/market',
        PRIVATE_API_URL  = 'https://api.mintpal.com/v2/market',
        USER_AGENT      = 'nomp/node-open-mining-portal';

    // Constructor
    function Mintpal(key, secret){
        // Generate headers signed by this user's key and secret.
        // The secret is encapsulated and never exposed
        this._getPrivateHeaders = function(parameters){
            let paramString, signature;

            if (!key || !secret){
                throw 'Mintpal: Error. API key and secret required';
            }

            // Sort parameters alphabetically and convert to `arg1=foo&arg2=bar`
            paramString = Object.keys(parameters).sort().map((param) =>{
                return `${encodeURIComponent(param)  }=${  encodeURIComponent(parameters[param])}`;
            }).join('&');

            signature = crypto.createHmac('sha512', secret).update(paramString).digest('hex');

            return {
                Key: key,
                Sign: signature
            };
        };
    }

    // If a site uses non-trusted SSL certificates, set this value to false
    Mintpal.STRICT_SSL = true;

    // Helper methods
    function joinCurrencies(currencyA, currencyB){
        return `${currencyA  }_${  currencyB}`;
    }

    // Prototype
    Mintpal.prototype = {
        constructor: Mintpal,

        // Make an API request
        _request: function(options, callback){
            if (!('headers' in options)){
                options.headers = {};
            }

            options.headers['User-Agent'] = USER_AGENT;
            options.json = true;
            options.strictSSL = Mintpal.STRICT_SSL;

            request(options, (err, response, body) => {
                callback(err, body);
            });

            return this;
        },

        // Make a public API request
        _public: function(parameters, callback){
            const options = {
                method: 'GET',
                url: PUBLIC_API_URL,
                qs: parameters
            };

            return this._request(options, callback);
        },

        // Make a private API request
        _private: function(parameters, callback){
            let options;

            parameters.nonce = nonce();
            options = {
                method: 'POST',
                url: PRIVATE_API_URL,
                form: parameters,
                headers: this._getPrivateHeaders(parameters)
            };

            return this._request(options, callback);
        },


        /////


        // PUBLIC METHODS

        getTicker: function(callback){
            const options = {
                method: 'GET',
                url: `${PUBLIC_API_URL  }/summary`,
                qs: null
            };

            return this._request(options, callback);
        },

        getBuyOrderBook: function(currencyA, currencyB, callback){
            const options = {
                method: 'GET',
                url: `${PUBLIC_API_URL  }/orders/${  currencyB  }/${  currencyA  }/BUY`,
                qs: null
            };

            return this._request(options, callback);
        },

        getOrderBook: function(currencyA, currencyB, callback){
            const parameters = {
                command: 'returnOrderBook',
                currencyPair: joinCurrencies(currencyA, currencyB)
            };

            return this._public(parameters, callback);
        },

        getTradeHistory: function(currencyA, currencyB, callback){
            const parameters = {
                command: 'returnTradeHistory',
                currencyPair: joinCurrencies(currencyA, currencyB)
            };

            return this._public(parameters, callback);
        },


        /////


        // PRIVATE METHODS

        myBalances: function(callback){
            const parameters = {
                command: 'returnBalances'
            };

            return this._private(parameters, callback);
        },

        myOpenOrders: function(currencyA, currencyB, callback){
            const parameters = {
                command: 'returnOpenOrders',
                currencyPair: joinCurrencies(currencyA, currencyB)
            };

            return this._private(parameters, callback);
        },

        myTradeHistory: function(currencyA, currencyB, callback){
            const parameters = {
                command: 'returnTradeHistory',
                currencyPair: joinCurrencies(currencyA, currencyB)
            };

            return this._private(parameters, callback);
        },

        buy: function(currencyA, currencyB, rate, amount, callback){
            const parameters = {
                command: 'buy',
                currencyPair: joinCurrencies(currencyA, currencyB),
                rate: rate,
                amount: amount
            };

            return this._private(parameters, callback);
        },

        sell: function(currencyA, currencyB, rate, amount, callback){
            const parameters = {
                command: 'sell',
                currencyPair: joinCurrencies(currencyA, currencyB),
                rate: rate,
                amount: amount
            };

            return this._private(parameters, callback);
        },

        cancelOrder: function(currencyA, currencyB, orderNumber, callback){
            const parameters = {
                command: 'cancelOrder',
                currencyPair: joinCurrencies(currencyA, currencyB),
                orderNumber: orderNumber
            };

            return this._private(parameters, callback);
        },

        withdraw: function(currency, amount, address, callback){
            const parameters = {
                command: 'withdraw',
                currency: currency,
                amount: amount,
                address: address
            };

            return this._private(parameters, callback);
        }
    };

    return Mintpal;
}();
