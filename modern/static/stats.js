/**
 * @fileoverview Pool Statistics Page - Frontend statistics display
 *
 * Provides the frontend logic for displaying pool statistics, including hashrate
 * charts, real-time updates via Server-Sent Events (SSE), and UI updates for
 * various pool metrics such as miners, workers, luck, and network statistics.
 *
 * @author ComputerGenieCo
 * @version 21.7.3
 * @copyright 2025
 */

/**
 * Pool Statistics Page
 *
 * Manages the display of pool statistics on the frontend, including historical
 * and real-time data visualization, chart rendering, and UI updates. Handles
 * Server-Sent Events for live updates and maintains chart data for multiple pools.
 *
 * @class PoolStatsPage
 */
class PoolStatsPage {
    /**
     * Creates a new PoolStatsPage instance, initializes data structures,
     * and attaches Server-Sent Events listener.
     */
    constructor() {
        this.poolHashrateData = [];
        this.poolHashrateChart = null;
        this.statData = [];
        this.poolKeys = [];
        this.poolMultipliers = {};
        this.isInitialized = false;
        this.rebuildingCharts = false;
        this.sseBuffer = [];
        this.attachSseListener();
    }

    /**
     * Initializes the page by fetching historical and current pool statistics,
     * building chart data, updating the UI, and displaying charts.
     * @returns {void}
     */
    init() {
        $.when(
            $.getJSON('/api/pool_stats'),
            $.getJSON('/api/stats')
        ).done((historicalResp, currentResp) => {
            const historical = (historicalResp && historicalResp[0]) || [];
            const current = (currentResp && currentResp[0]) ? currentResp[0] : null;
            this.statData = historical;
            if (current && current.pools) {
                Object.keys(current.pools).forEach((pool) => {
                    const p = current.pools[pool];
                    if (p && typeof p.displayMultiplier === 'number') {
                        this.poolMultipliers[pool] = p.displayMultiplier;
                    } else if (p && p.algorithm) {
                        const algoMul = (window.algoDisplayMultipliers && window.algoDisplayMultipliers[p.algorithm]);
                        this.poolMultipliers[pool] = algoMul;
                    }
                });
            }
            this.buildChartData();
            if (current) {
                this.updatePoolStatsUI(current);
            } else if (this.statData.length) {
                this.updatePoolStatsUI(this.statData[this.statData.length - 1]);
            }
            this.displayCharts();
            this.isInitialized = true;
            if (this.sseBuffer.length) {
                this.sseBuffer.forEach((evt) => this.processSse(evt));
                this.sseBuffer = [];
            }
        });
    }

    /**
     * Builds chart data from historical statistics, organizing hashrate data
     * by pool and applying display multipliers.
     * @returns {void}
     */
    buildChartData() {
        const rawSeriesMap = {};
        this.poolKeys = [];
        for (const entry of this.statData) {
            if (!entry || !entry.pools) {
                continue;
            }
            for (const pool in entry.pools) {
                if (this.poolKeys.indexOf(pool) === -1) {
                    this.poolKeys.push(pool);
                }
            }
        }
        this.statData.forEach((entry) => {
            if (!entry || !entry.pools) {
                return;
            }
            const time = entry.time * 1000;
            this.poolKeys.forEach((pName) => {
                const seriesObj = rawSeriesMap[pName] = (rawSeriesMap[pName] || { rawValues: [] });
                const hashrateRaw = entry.pools[pName] ? entry.pools[pName].hashrate : 0;
                seriesObj.rawValues.push([time, hashrateRaw]);
            });
        });
        this.poolHashrateData = Object.keys(rawSeriesMap).map((pool) => {
            const multiplier = this.getPoolMultiplier(pool);
            const rawValues = rawSeriesMap[pool].rawValues;
            return {
                key: pool,
                rawValues: rawValues.slice(0),
                values: rawValues.map(([t, v]) => [t, v * multiplier]),
                multiplier
            };
        });
        this.poolHashrateData.forEach((series) => this.renderAverage(series.key));
    }

    /**
     * Calculates the average hashrate for a given pool from historical data.
     * @param {string} pool - The pool name.
     * @returns {number} The average raw hashrate.
     */
    calculateAverageHashrate(pool) {
        const data = this.poolHashrateData.find((p) => p.key === pool);
        if (!data || !data.rawValues || data.rawValues.length === 0) {
            return 0;
        }
        const totalRaw = data.rawValues.reduce((sum, value) => sum + parseFloat(value[1]), 0);
        return totalRaw / data.rawValues.length;
    }

    /**
     * Retrieves the display multiplier for a pool, caching it for future use.
     * @param {string} pool - The pool name.
     * @returns {number} The display multiplier.
     */
    getPoolMultiplier(pool) {
        const m = this.poolMultipliers[pool];
        if (typeof m === 'number') {
            return m;
        }
        this.poolMultipliers[pool] = m;
        const series = this.poolHashrateData.find(s => s.key === pool);
        if (series) {
            series.multiplier = m;
        }
        return m;
    }

    /**
     * Renders the average hashrate for a pool in the UI.
     * @param {string} pool - The pool name.
     * @returns {void}
     */
    renderAverage(pool) {
        const avgRaw = this.calculateAverageHashrate(pool);
        const m = this.getPoolMultiplier(pool);
        $(`#statsHashrateAvg${pool}`).text(getReadableHashRateString(avgRaw, m));
    }

    /**
     * Formats a timestamp as a time of day string (e.g., "1:23 PM").
     * @param {number} timestamp - The timestamp in milliseconds.
     * @returns {string} The formatted time string.
     */
    timeOfDayFormat(timestamp) {
        let dStr = d3.time.format('%I:%M %p')(new Date(timestamp));
        if (dStr.startsWith('0')) {
            dStr = dStr.slice(1);
        }
        return dStr;
    }

    /**
     * Displays the hashrate charts using NVD3 library.
     * @returns {void}
     */
    displayCharts() {
        const container = document.getElementById('poolHashrate');
        if (container) {
            $(container).empty();
        }

        nv.addGraph(() => {
            this.poolHashrateChart = nv.models.lineChart()
                .margin({ left: 80, right: 30 })
                .x((d) => d[0])
                .y((d) => d[1])
                .useInteractiveGuideline(true);

            this.poolHashrateChart.xAxis.tickFormat(this.timeOfDayFormat);
            this.poolHashrateChart.yAxis.tickFormat((v) => getReadableHashRateString(v, 1));
            this.poolHashrateChart.interactiveLayer.tooltip.headerFormatter((d) => this.timeOfDayFormat(d));
            this.poolHashrateChart.interactiveLayer.tooltip.valueFormatter((v, i) => {
                return getReadableHashRateString(v, 1);
            });

            d3.select('#poolHashrate').append('svg')
                .datum(this.poolHashrateData.map(series => ({
                    key: series.key,
                    values: series.values
                })))
                .call(this.poolHashrateChart);

            nv.utils.windowResize(() => this.poolHashrateChart.update());
            return this.poolHashrateChart;
        });
    }

    /**
     * Attaches a Server-Sent Events listener for real-time updates.
     * @returns {void}
     */
    attachSseListener() {
        const setup = () => {
            if (window.statsSource && window.statsSource.addEventListener && !this._sseAttached) {
                window.statsSource.addEventListener('message', (e) => this.processSse(e));
                this._sseAttached = true;
                return true;
            }
            return false;
        };
        if (!setup()) {
            let attempts = 0;
            const poll = setInterval(() => {
                if (setup() || ++attempts >= 10) {
                    clearInterval(poll);
                }
            }, 200);
        }
    }

    /**
     * Processes incoming Server-Sent Events messages.
     * @param {Event} e - The SSE event.
     * @returns {void}
     */
    processSse(e) {
        if (!this.isInitialized) {
            this.sseBuffer.push(e);
            return;
        }
        this.handleSseMessage(e);
    }

    /**
     * Handles parsed SSE message data, updating multipliers, stats, and UI.
     * @param {Event} e - The SSE event.
     * @returns {void}
     */
    handleSseMessage(e) {
        let stats;
        try {
            stats = JSON.parse(e.data);
        } catch (err) {
            return;
        }
        if (!stats || !stats.pools) {
            return;
        }
        Object.keys(stats.pools).forEach((p) => {
            if (typeof stats.pools[p].displayMultiplier === 'number') {
                this.poolMultipliers[p] = stats.pools[p].displayMultiplier;
            }
        });
        const minimal = { time: stats.time, pools: {} };
        Object.keys(stats.pools).forEach((p) => {
            minimal.pools[p] = { hashrate: stats.pools[p].hashrate };
        });
        this.statData.push(minimal);

        const newPoolAdded = Object.keys(stats.pools).some(p => this.poolKeys.indexOf(p) === -1);
        if (newPoolAdded && !this.rebuildingCharts) {
            this.rebuildingCharts = true;
            this.buildChartData();
            this.displayCharts();
            this.rebuildingCharts = false;
        } else if (!newPoolAdded) {
            this.updateChartIncrementally(minimal);
        }
        this.updatePoolStatsUI(stats);
    }

    /**
     * Updates chart data incrementally with new stats without rebuilding.
     * @param {Object} stats - The new statistics data.
     * @returns {void}
     */
    updateChartIncrementally(stats) {
        const time = stats.time * 1000;
        this.poolKeys.forEach((pool) => {
            const series = this.poolHashrateData.find((d) => d.key === pool);
            if (!series) {
                return;
            }
            const hashrateRaw = stats.pools[pool] ? stats.pools[pool].hashrate : 0;
            if (series.rawValues.length) {
                series.rawValues.shift();
            }
            if (series.values.length) {
                series.values.shift();
            }
            series.rawValues.push([time, hashrateRaw]);
            if (stats.pools[pool] && typeof stats.pools[pool].displayMultiplier === 'number') {
                series.multiplier = stats.pools[pool].displayMultiplier;
                this.poolMultipliers[pool] = stats.pools[pool].displayMultiplier;
            }
            const effectiveMultiplier = this.getPoolMultiplier(pool);
            series.values.push([time, hashrateRaw * effectiveMultiplier]);
            this.renderAverage(pool);
        });
        if (this.poolHashrateChart) {
            this.poolHashrateChart.update();
        }
    }

    /**
     * Updates the pool statistics UI elements with current data.
     * @param {Object} stats - The statistics data to display.
     * @returns {void}
     */
    updatePoolStatsUI(stats) {
        for (const pool in stats.pools) {
            if (!Object.prototype.hasOwnProperty.call(stats.pools, pool)) {
                continue;
            }
            const poolStats = stats.pools[pool];
            const multiplier = this.getPoolMultiplier(pool);
            $(`#statsMiners${pool}`).text(poolStats.minerCount);
            $(`#statsWorkers${pool}`).text(poolStats.workerCount);
            const currentRaw = typeof poolStats.hashrate === 'number' ? poolStats.hashrate : 0;
            $(`#statsHashrate${pool}`).text(getReadableHashRateString(currentRaw, multiplier));
            this.renderAverage(pool);
            if (typeof poolStats.luckDays !== 'undefined' && parseFloat(poolStats.luckDays) < 1) {
                const hours = (typeof poolStats.luckHours !== 'undefined') ? parseFloat(poolStats.luckHours) : (parseFloat(poolStats.luckDays) * 24);
                $(`#statsLuckDays${pool}`).text(hours.toFixed(3));
                $(`#statsLuckUnit${pool}`).text('Hours');
            } else {
                $(`#statsLuckDays${pool}`).text(poolStats.luckDays);
                $(`#statsLuckUnit${pool}`).text('Days');
            }
            if (poolStats.poolStats) {
                $(`#statsValidBlocks${pool}`).text(poolStats.poolStats.validBlocks);
                $(`#statsTotalPaid${pool}`).text(parseFloat(poolStats.poolStats.totalPaid).toFixed(8));
                $(`#statsNetworkBlocks${pool}`).text(poolStats.poolStats.networkBlocks);
                $(`#statsNetworkDiff${pool}`).text(poolStats.poolStats.networkDiff);
                $(`#statsNetworkSols${pool}`).text(getReadableNetworkHashRateString(poolStats.poolStats.networkSols));
                $(`#statsNetworkConnections${pool}`).text(poolStats.poolStats.networkConnections);
            }
        }
    }
}

$(() => {
    const statsPage = new PoolStatsPage();
    statsPage.init();
});
