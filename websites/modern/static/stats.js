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
        this.pieCharts = {};
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
            // Initialize pie charts with initial data
            Object.keys(window.initialBlocksComb || {}).forEach(pool => {
                this.updatePieChart(pool, window.initialBlocksComb[pool]);
            });
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
     * @param {number|Array|Object|Date} timestamp - The timestamp (ms or sec), or an array/object containing it.
     * @returns {string} The formatted time string, or empty string if input can't be parsed.
     */
    timeOfDayFormat(timestamp) {
        // Accept a variety of input shapes: number (ms or seconds), Date, [x, y], {x: <ts>} or objects from nvd3
        let t = timestamp;

        // If an array (e.g. [x, y]) take the first element
        if (Array.isArray(t) && t.length) {
            t = t[0];
        }

        // If an object with an x property (nvd3 sometimes passes {x:..., y:...})
        if (t && typeof t === 'object' && !(t instanceof Date)) {
            if (typeof t.x !== 'undefined') {
                t = t.x;
            } else if (typeof t.value !== 'undefined') {
                t = t.value;
            }
        }

        // If already a Date object, format directly
        if (t instanceof Date) {
            let dStr = d3.time.format('%I:%M %p')(t);
            if (dStr.startsWith('0')) {
                dStr = dStr.slice(1);
            }
            return dStr;
        }

        // Try to coerce to number. If Number() fails, try valueOf() for moment-like objects.
        let num = Number(t);
        if (!isFinite(num)) {
            try {
                if (t && typeof t.valueOf === 'function') {
                    num = Number(t.valueOf());
                }
            } catch (err) {
                num = NaN;
            }
        }
        if (!isFinite(num)) {
            // As a last resort, if t is an object with nested x (e.g., [{x:...}]) try to extract it
            if (Array.isArray(timestamp) && timestamp.length && typeof timestamp[0] === 'object') {
                const first = timestamp[0];
                if (first && typeof first.x !== 'undefined') {
                    num = Number(first.x);
                }
            }
        }
        if (!isFinite(num)) {
            return String(timestamp);
        }

        // Detect seconds vs milliseconds: if it's less than 1e12 assume seconds and convert
        let ms = num;
        if (ms < 1e12) {
            ms = ms * 1000;
        }

        const d = new Date(ms);
        if (Number.isNaN(d.getTime())) {
            return String(timestamp);
        }

        let dStr = d3.time.format('%I:%M %p')(d);
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
     * Re-bind the current poolHashrateData to the chart's SVG and force an update.
     * NVD3 can sometimes cache its internal data; re-binding the datum ensures the
     * chart uses the latest arrays/references.
     */
    refreshChartData() {
        if (!this.poolHashrateChart) {
            return;
        }
        const container = d3.select('#poolHashrate');
        if (container.empty()) {
            return;
        }
        const data = this.poolHashrateData.map(series => ({ key: series.key, values: series.values }));
        let svg = container.select('svg');
        if (svg.empty()) {
            // No svg yet, create one and bind
            svg = container.append('svg');
        }
        svg.datum(data).call(this.poolHashrateChart);
        try {
            this.poolHashrateChart.update();
        } catch (err) {
            // Fall back to safe re-render: recreate the chart
            try {
                this.displayCharts();
            } catch (e) {
                // swallow - avoid throwing in UI
            }
        }
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
            // Re-bind and update to ensure NVD3 picks up the modified arrays
            this.refreshChartData();
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
            // Update blocks list and pie chart if blocks data is present
            if (poolStats.pending || poolStats.confirmed) {
                this.updateBlocksList(pool, stats);
            }
        }
    }

    /**
     * Updates the blocks found list for a pool.
     * @param {string} pool - The pool name.
     * @param {Object} stats - The statistics data.
     * @returns {void}
     */
    updateBlocksList(pool, stats) {
        const poolData = stats.pools[pool];
        if (!poolData) {
            return;
        }
        const explorer = window.explorerURLs[pool];
        const minConfVal = window.minConfVals[pool];
        let html = '';
        const blockscomb = [];
        // Pending blocks
        if (poolData.pending && poolData.pending.blocks) {
            for (const b in poolData.pending.blocks) {
                const block = poolData.pending.blocks[b].split(':');
                blockscomb.push(block);
                html += `<div class="list-group-item">
                    <i class="fa fa-bars"></i>
                    <small>Block:</small>
                    ${explorer ? `<a href="${explorer}${block[0]}" target="_blank">${block[2]}</a>` : block[2]}
                    <small class="ml-3" id="time_${block[2]}"></small>
                    <script>document.getElementById("time_${block[2]}").innerHTML = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'long' }).format(${block[4]} * 1000);</script>`;
                if (poolData.pending.confirms) {
                    if (poolData.pending.confirms[block[0]]) {
                        const rawConf = parseInt(poolData.pending.confirms[block[0]]);
                        const showConf = (rawConf > minConfVal) ? minConfVal : rawConf;
                        html += `<span class="float-right text-danger"><small>${showConf} of ${minConfVal}</small></span>`;
                    } else {
                        html += `<span class="float-right text-danger"><small>*PENDING*</small></span>`;
                    }
                } else {
                    html += `<span class="float-right text-danger"><small>*PENDING*</small></span>`;
                }
                html += `<div><i class="fa fa-gavel"></i><small>Mined By:</small> <a href="/workers/${block[3].split('.')[0]}">${block[3]}</a></div>
                </div>`;
            }
        }
        // Confirmed blocks, collect all for pie, but show only last 8 in list
        if (poolData.confirmed && poolData.confirmed.blocks) {
            let i = 0;
            for (const b in poolData.confirmed.blocks) {
                const block = poolData.confirmed.blocks[b].split(':');
                blockscomb.push(block); // Include all for pie
                if (i >= 8) {
                    continue;
                } // But only show first 8 in HTML
                i++;
                html += `<div class="list-group-item">
                    <i class="fa fa-bars"></i>
                    <small>Block:</small>
                    ${explorer ? `<a href="${explorer}${block[0]}" target="_blank">${block[2]}</a>` : block[2]}
                    <small class="ml-3" id="time_${block[2]}"></small>
                    <script>document.getElementById("time_${block[2]}").innerHTML = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'long' }).format(${block[4]} * 1000);</script>
                    <span class="float-right text-success"><small>*CREDITED*</small></span>
                    <div><i class="fa fa-gavel"></i><small>Mined By:</small> <a href="/workers/${block[3].split('.')[0]}">${block[3]}</a></div>
                </div>`;
            }
        }
        $(`#blocksList${pool}`).html(html);
        // Sort blockscomb by timestamp descending (most recent first) and cap at 10 for pie chart
        blockscomb.sort((a, b) => parseInt(b[4]) - parseInt(a[4]));
        blockscomb = blockscomb.slice(0, 10);
        // Update header
        $(`#blocksHeader${pool}`).text(`Finders of the last ${blockscomb.length} blocks`);
        // Update pie chart
        this.updatePieChart(pool, blockscomb);
    }

    /**
     * Updates the pie chart for finders of blocks.
     * @param {string} pool - The pool name.
     * @param {Array} blockscomb - Array of block data.
     * @returns {void}
     */
    updatePieChart(pool, blockscomb) {
        const data = [];
        const groupedByFinder = {};
        for (let i = 0; i < blockscomb.length; i++) {
            const finder = blockscomb[i][3];
            if (!(finder in groupedByFinder)) {
                groupedByFinder[finder] = [];
            }
            groupedByFinder[finder].push(blockscomb[i]);
        }
        Object.keys(groupedByFinder).forEach(key => {
            data.push({ label: key, value: groupedByFinder[key].length });
        });
        nv.addGraph(() => {
            const chart = nv.models.pieChart()
                .x(d => d.label)
                .y(d => d.value)
                .showLabels(true)
                .labelType('percent')
                .donut(true)
                .donutRatio(0.35);
            d3.select(`#blocksPie${pool}`).selectAll('svg').remove();
            d3.select(`#blocksPie${pool}`)
                .append('svg')
                .datum(data)
                .transition().duration(350)
                .call(chart);
            return chart;
        });
    }
}

$(() => {
    const statsPage = new PoolStatsPage();
    statsPage.init();
});
