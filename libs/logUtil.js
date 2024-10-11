Reset = "\x1b[0m"
Underscore = "\x1b[4m"
Bright = "\x1b[1m"
Ital = "\x1b[3m"
Dim = "\x1b[2m"
FgRed = "\x1b[31m"
FgGreen = "\x1b[32m"
FgYellow = "\x1b[33m"
FgBlue = "\x1b[34m"
FgCyan = "\x1b[36m"
FgWhite = "\x1b[37m"
FgGray = "\x1b[90m"

var severityToColor = function(severity) {
    switch(severity) {
        case 'special':
            return Underscore+FgCyan;
        case 'debug':
            return FgGreen;
        case 'warning':
            return FgYellow;
        case 'error':
            return FgRed;
        default:
            console.log("Unknown severity " + severity);
            return FgBlue;
    }
};

var severityValues = {
    'debug': 1,
    'warning': 2,
    'error': 3,
    'special': 4
};

function timestamp() {
    var date = new Date;
    var timestamp = "20" + ("0" + (date.getYear())).slice(-2) + "-" +
                    ("0" + (date.getMonth() + 1)).slice(-2) + "-" +
                    ("0" + date.getDate()).slice(-2) + " " +
                    ("0" + date.getHours()).slice(-2) + ":" +
                    ("0" + date.getMinutes()).slice(-2) + ":" +
                    ("0" + date.getSeconds()).slice(-2);
    return timestamp;
}

var PoolLogger = function (configuration) {

    var logLevelInt = severityValues[configuration.logLevel];
    var logColors = configuration.logColors;
    var log = function(severity, system, component, text, subcat) {

        if (severityValues[severity] < logLevelInt) return;

        if (subcat){
            var realText = subcat;
            var realSubCat = text;
            text = realText;
            subcat = realSubCat;
        }

        var entryDesc = timestamp() + ' [' + system + ']\t';
        if (logColors) {
            entryDesc = Dim + FgGreen + entryDesc + Reset;

            var logString = entryDesc + Ital+ FgWhite + ('[' + component + '] ' + Reset);

            if (subcat) { 
                logString += Dim + FgWhite + ('(' + subcat + ') ') + Reset + severityToColor(severity) + text + Reset; 
            } else {
                logString += severityToColor(severity) + text + Reset;
            };

            //logString += text + Reset;
        }
        else {
            var logString = entryDesc + '[' + component + '] ';

            if (subcat) { logString += '(' + subcat + ') '; };

            logString += text;
        }
        console.log(logString);

    };

    // public

    var _this = this;
    Object.keys(severityValues).forEach(function(logType){
        _this[logType] = function(){
            var args = Array.prototype.slice.call(arguments, 0);
            args.unshift(logType);
            log.apply(this, args);
        };
    });
};

module.exports = PoolLogger;