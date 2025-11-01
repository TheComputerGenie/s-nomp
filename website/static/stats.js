let poolHashrateData;
let poolHashrateChart;

let statData;
let poolKeys;

function buildChartData() {
    const pools = {};

    poolKeys = [];
    for (let i = 0; i < statData.length; i++) {
        for (const pool in statData[i].pools) {
            if (poolKeys.indexOf(pool) === -1) {
                poolKeys.push(pool);
            }
        }
    }

    for (let i = 0; i < statData.length; i++) {
        const time = statData[i].time * 1000;
        for (let f = 0; f < poolKeys.length; f++) {
            const pName = poolKeys[f];
            const a = pools[pName] = (pools[pName] || {
                hashrate: []
            });
            if (pName in statData[i].pools) {
                a.hashrate.push([time, statData[i].pools[pName].hashrate]);
            } else {
                a.hashrate.push([time, 0]);
            }
        }
    }

    poolHashrateData = [];
    for (const pool in pools) {
        poolHashrateData.push({
            key: pool,
            values: pools[pool].hashrate
        });
        $(`#statsHashrateAvg${pool}`).text(getReadableHashRateString(calculateAverageHashrate(pool)));
    }
}

function calculateAverageHashrate(pool) {
    let count = 0;
    let total = 1;
    let avg = 0;
    for (let i = 0; i < poolHashrateData.length; i++) {
        count = 0;
        for (let ii = 0; ii < poolHashrateData[i].values.length; ii++) {
            if (pool == null || poolHashrateData[i].key === pool) {
                count++;
                avg += parseFloat(poolHashrateData[i].values[ii][1]);
            }
        }
        if (count > total) {
            total = count;
        }
    }
    avg = avg / total;
    return avg;
}

function getReadableHashRateString(hashrate) {
    hashrate = (hashrate * 2);
    if (hashrate < 1000000) {
        return `${(Math.round(hashrate / 1000) / 1000).toFixed(2)} H/s`;
    }
    const byteUnits = [' H/s', ' KH/s', ' MH/s', ' GH/s', ' TH/s', ' PH/s'];
    const i = Math.floor((Math.log(hashrate / 1000) / Math.log(1000)) - 1);
    hashrate = (hashrate / 1000) / Math.pow(1000, i + 1);
    return hashrate.toFixed(2) + byteUnits[i];
}

function timeOfDayFormat(timestamp) {
    let dStr = d3.time.format('%I:%M %p')(new Date(timestamp));
    if (dStr.indexOf('0') === 0) {
        dStr = dStr.slice(1);
    }
    return dStr;
}

function displayCharts() {
    nv.addGraph(() => {
        poolHashrateChart = nv.models.lineChart()
            .margin({ left: 80, right: 30 })
            .x((d) => {
                return d[0];
            })
            .y((d) => {
                return d[1];
            })
            .useInteractiveGuideline(true);

        poolHashrateChart.xAxis.tickFormat(timeOfDayFormat);

        poolHashrateChart.yAxis.tickFormat((d) => {
            return getReadableHashRateString(d);
        });

        d3.select('#poolHashrate').datum(poolHashrateData).call(poolHashrateChart);

        return poolHashrateChart;
    });
}

function triggerChartUpdates() {
    poolHashrateChart.update();
}

nv.utils.windowResize(triggerChartUpdates);

$.getJSON('/api/pool_stats', (data) => {
    statData = data;
    buildChartData();
    displayCharts();
});

statsSource.addEventListener('message', (e) => {
    const stats = JSON.parse(e.data);
    statData.push(stats);

    const newPoolAdded = (function () {
        for (const p in stats.pools) {
            if (poolKeys.indexOf(p) === -1) {
                return true;
            }
        }
        return false;
    })();

    if (newPoolAdded || Object.keys(stats.pools).length > poolKeys.length) {
        buildChartData();
        displayCharts();
    } else {
        const time = stats.time * 1000;
        for (let f = 0; f < poolKeys.length; f++) {
            const pool = poolKeys[f];
            for (let i = 0; i < poolHashrateData.length; i++) {
                if (poolHashrateData[i].key === pool) {
                    poolHashrateData[i].values.shift();
                    poolHashrateData[i].values.push([time, pool in stats.pools ? stats.pools[pool].hashrate : 0]);
                    $(`#statsHashrateAvg${pool}`).text(getReadableHashRateString(calculateAverageHashrate(pool)));
                    break;
                }
            }
        }
        triggerChartUpdates();
    }
});
