/**
 * @file Pool statistics visualization and real-time data management
 * @description This module handles the display and real-time updates of mining pool statistics,
 * including hashrate charts and pool performance metrics. It uses D3.js and NVD3 for data
 * visualization and Server-Sent Events for live data updates.
 * @author v-nomp Pool Software
 * @version 1.0.0
 */

/**
 * @typedef {Object} PoolData
 * @property {string} key - Pool identifier/name
 * @property {Array<Array<number>>} values - Array of [timestamp, hashrate] pairs
 */

/**
 * @typedef {Object} StatDataEntry
 * @property {number} time - Unix timestamp
 * @property {Object.<string, PoolStats>} pools - Pool statistics by pool name
 */

/**
 * @typedef {Object} PoolStats
 * @property {number} hashrate - Pool hashrate in H/s
 */

/**
 * Global chart data for pool hashrate visualization
 * @type {Array<PoolData>}
 * @global
 */
let poolHashrateData;

/**
 * NVD3 line chart instance for displaying pool hashrate over time
 * @type {Object}
 * @global
 */
let poolHashrateChart;

/**
 * Array of historical statistics data entries
 * @type {Array<StatDataEntry>}
 * @global
 */
let statData;

/**
 * Array of unique pool identifiers/names
 * @type {Array<string>}
 * @global
 */
let poolKeys;

/**
 * Processes raw statistics data and builds chart-ready data structures
 * @description This function transforms the historical statistics data into a format suitable
 * for NVD3 line charts. It extracts unique pool names, organizes hashrate data by timestamp,
 * and updates the UI with average hashrate values for each pool.
 * @function buildChartData
 * @returns {void}
 */
function buildChartData() {
    // Temporary object to organize pool data during processing
    const pools = {};

    // Extract unique pool names from all historical data entries
    poolKeys = [];
    for (let i = 0; i < statData.length; i++) {
        // Iterate through each pool in the current time entry
        for (const pool in statData[i].pools) {
            // Add pool to keys array if not already present
            if (poolKeys.indexOf(pool) === -1) {
                poolKeys.push(pool);
            }
        }
    }

    // Build time-series data for each pool
    for (let i = 0; i < statData.length; i++) {
        // Convert Unix timestamp to milliseconds for JavaScript Date compatibility
        const time = statData[i].time * 1000;

        // Process each known pool for this time entry
        for (let f = 0; f < poolKeys.length; f++) {
            const pName = poolKeys[f];

            // Initialize pool data structure if it doesn't exist
            const a = pools[pName] = (pools[pName] || {
                hashrate: []
            });

            // Add hashrate data point for this timestamp
            if (pName in statData[i].pools) {
                // Pool has data for this timestamp
                a.hashrate.push([time, statData[i].pools[pName].hashrate]);
            } else {
                // Pool has no data for this timestamp, use 0
                a.hashrate.push([time, 0]);
            }
        }
    }

    // Convert processed data to NVD3-compatible format
    poolHashrateData = [];
    for (const pool in pools) {
        poolHashrateData.push({
            key: pool,
            values: pools[pool].hashrate
        });

        // Update UI element with calculated average hashrate for this pool
        $(`#statsHashrateAvg${pool}`).text(getReadableHashRateString(calculateAverageHashrate(pool)));
    }
}

/**
 * Calculates the average hashrate for a specific pool or all pools
 * @description Computes the mean hashrate value across all data points for the specified pool.
 * If no pool is specified (null), it calculates across all pools. The calculation uses the
 * maximum number of data points available to ensure accurate averaging.
 * @function calculateAverageHashrate
 * @param {string|null} pool - Pool identifier to calculate average for, or null for all pools
 * @returns {number} The calculated average hashrate in H/s
 */
function calculateAverageHashrate(pool) {
    let count = 0;          // Counter for current pool's data points
    let total = 1;          // Maximum number of data points found across all pools
    let avg = 0;            // Running sum for average calculation

    // Iterate through all pool data sets
    for (let i = 0; i < poolHashrateData.length; i++) {
        count = 0;

        // Sum hashrate values for the specified pool or all pools
        for (let ii = 0; ii < poolHashrateData[i].values.length; ii++) {
            if (pool == null || poolHashrateData[i].key === pool) {
                count++;
                // Add hashrate value (second element of [timestamp, hashrate] pair)
                avg += parseFloat(poolHashrateData[i].values[ii][1]);
            }
        }

        // Track the maximum number of data points for proper averaging
        if (count > total) {
            total = count;
        }
    }

    // Calculate final average by dividing sum by total data points
    avg = avg / total;
    return avg;
}

// getReadableHashRateString provided by /static/js/utils.js

/**
 * Formats timestamp for chart x-axis display
 * @description Converts a JavaScript timestamp to a readable time format (HH:MM AM/PM)
 * for use in chart axis labels. Removes leading zero from hours for cleaner display.
 * @function timeOfDayFormat
 * @param {number} timestamp - JavaScript timestamp in milliseconds
 * @returns {string} Formatted time string in 12-hour format (e.g., "2:30 PM")
 * @example
 * timeOfDayFormat(1635789600000) // Returns "2:00 PM"
 * timeOfDayFormat(1635717600000) // Returns "10:00 AM"
 */
function timeOfDayFormat(timestamp) {
    // Use D3 time formatter to create 12-hour time string with AM/PM
    let dStr = d3.time.format('%I:%M %p')(new Date(timestamp));

    // Remove leading zero from hour for cleaner display (e.g., "02:30" becomes "2:30")
    if (dStr.indexOf('0') === 0) {
        dStr = dStr.slice(1);
    }

    return dStr;
}

/**
 * Initializes and displays the NVD3 line chart for pool hashrate visualization
 * @description Creates a line chart using NVD3 library to display hashrate data over time.
 * Configures chart margins, axis formatters, and interactive features. The chart is
 * bound to the DOM element with ID 'poolHashrate'.
 * @function displayCharts
 * @returns {void}
 */
function displayCharts() {
    // Add chart to NVD3's graph queue for proper initialization
    nv.addGraph(() => {
        // Create line chart model with configuration
        poolHashrateChart = nv.models.lineChart()
            // Set chart margins (left: 80px for y-axis labels, right: 30px padding)
            .margin({ left: 80, right: 30 })
            // Define x-axis data accessor (timestamp from data point array)
            .x((d) => {
                return d[0];  // First element is timestamp
            })
            // Define y-axis data accessor (hashrate from data point array)
            .y((d) => {
                return d[1];  // Second element is hashrate value
            })
            // Enable interactive guidelines for better user experience
            .useInteractiveGuideline(true);

        // Configure x-axis to display formatted time labels
        poolHashrateChart.xAxis.tickFormat(timeOfDayFormat);

        // Configure y-axis to display human-readable hashrate values
        poolHashrateChart.yAxis.tickFormat((d) => {
            return getReadableHashRateString(d);
        });

        // Bind chart data to DOM element and render the chart
        d3.select('#poolHashrate').append('svg').datum(poolHashrateData).call(poolHashrateChart);

        // Return chart instance for NVD3's internal management
        return poolHashrateChart;
    });
}

/**
 * Triggers chart redraw and update
 * @description Forces the NVD3 chart to update its display with current data.
 * This function is typically called when new data is added or when the browser
 * window is resized to ensure proper chart rendering.
 * @function triggerChartUpdates
 * @returns {void}
 */
function triggerChartUpdates() {
    // Tell the chart to redraw with current data
    poolHashrateChart.update();
}

/**
 * Register window resize handler for responsive chart behavior
 * @description Attaches the chart update function to window resize events to ensure
 * the chart maintains proper proportions and layout when the browser window size changes.
 */
nv.utils.windowResize(triggerChartUpdates);

/**
 * Initialize application by fetching historical pool statistics
 * @description Makes an AJAX request to retrieve historical pool statistics data,
 * then processes the data and initializes the charts. This is the main entry point
 * for the statistics visualization system.
 */
$.getJSON('/api/pool_stats', (data) => {
    // Store the fetched historical data globally
    statData = data;

    // Process raw data into chart-ready format
    buildChartData();

    // Create and display the charts
    displayCharts();
});

/**
 * Handle real-time statistics updates via Server-Sent Events
 * @description Listens for live statistics updates from the server and updates the charts
 * and UI accordingly. Handles two scenarios: when new pools are added (full rebuild)
 * and when existing pools are updated (incremental update for performance).
 * @event message - Server-Sent Event containing JSON statistics data
 */
statsSource.addEventListener('message', (e) => {
    // Parse incoming JSON statistics data
    const stats = JSON.parse(e.data);

    // Add new statistics entry to the historical data array
    statData.push(stats);

    /**
     * Check if any new pools have been added since last update
     * @description Compares the incoming pool names with the currently known pools
     * to determine if a full chart rebuild is necessary.
     * @returns {boolean} True if new pools are detected, false otherwise
     */
    const newPoolAdded = (function () {
        // Iterate through all pools in the new statistics data
        for (const p in stats.pools) {
            // If we find a pool that's not in our known pool keys, it's new
            if (poolKeys.indexOf(p) === -1) {
                return true;
            }
        }
        return false;
    })();

    // Determine update strategy based on pool changes
    if (newPoolAdded || Object.keys(stats.pools).length > poolKeys.length) {
        /**
         * Full rebuild scenario: New pools detected
         * @description When new pools are added, we need to rebuild all chart data
         * and redisplay charts to accommodate the new data series.
         */
        buildChartData();
        displayCharts();
    } else {
        /**
         * Incremental update scenario: Only existing pools updated
         * @description For performance, when no new pools are added, we just update
         * the existing data points by removing the oldest and adding the newest.
         */

        // Convert timestamp to milliseconds for JavaScript Date compatibility
        const time = stats.time * 1000;

        // Update each known pool's data
        for (let f = 0; f < poolKeys.length; f++) {
            const pool = poolKeys[f];

            // Find the corresponding data series for this pool
            for (let i = 0; i < poolHashrateData.length; i++) {
                if (poolHashrateData[i].key === pool) {
                    // Remove oldest data point to maintain chart window size
                    poolHashrateData[i].values.shift();

                    // Add new data point (use 0 if pool not present in current stats)
                    poolHashrateData[i].values.push([time, pool in stats.pools ? stats.pools[pool].hashrate : 0]);

                    // Update the average hashrate display for this pool
                    $(`#statsHashrateAvg${pool}`).text(getReadableHashRateString(calculateAverageHashrate(pool)));

                    break; // Found the pool, no need to continue searching
                }
            }
        }

        // Trigger chart redraw with updated data
        triggerChartUpdates();
    }
});
