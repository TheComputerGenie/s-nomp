/**
 * @fileoverview Miner Statistics Dashboard
 * This file manages the real-time display of mining statistics for individual miners
 * and their workers, including hashrate charts, performance metrics, and payment information.
 *
 * The dashboard provides:
 * - Real-time hashrate monitoring with interactive charts
 * - Worker-specific statistics and performance metrics
 * - Payment tracking (balance, immature, paid amounts)
 * - Mining luck calculations and difficulty tracking
 * - Live updates via Server-Sent Events (SSE)
 *
 * @author Mining Pool Software Team
 * @version 1.0
 */

/**
 * Chart data for worker hashrate visualization
 * @type {Array<Object>}
 */
let workerHashrateData;

/**
 * NVD3 line chart instance for displaying worker hashrates over time
 * @type {Object}
 */
let workerHashrateChart;

/**
 * Maximum number of historical data points to maintain for each worker
 * @type {number}
 * @default 160
 */
let workerHistoryMax = 160;

/**
 * Complete statistics data object received from the API
 * Contains worker stats, history, and pool information
 * @type {Object}
 */
let statData;

/**
 * Total hashrate across all workers for this miner
 * @type {number}
 */
let totalHash;

/**
 * Total immature balance (unconfirmed earnings)
 * @type {number}
 */
let totalImmature;

/**
 * Current confirmed balance ready for payout
 * @type {number}
 */
let totalBal;

/**
 * Total amount paid out to this miner historically
 * @type {number}
 */
let totalPaid;

/**
 * Total shares submitted by this miner in current round
 * @type {number}
 */
let totalShares;

/**
 * Set of current worker addresses for change detection
 * Used to track worker additions/removals more accurately than just counting
 * @type {Set<string>}
 */
let currentWorkerAddresses = new Set();

/**
 * Timestamp of the last full data fetch (including history)
 * Used to throttle expensive full data updates
 * @type {number}
 */
let lastFullDataFetch = 0;

/**
 * Interval for full data fetches in milliseconds
 * Full history data is only fetched at this interval to reduce bandwidth
 * @type {number}
 * @default 30000 (30 seconds)
 */
const FULL_DATA_FETCH_INTERVAL = 30000;

/**
 * Counter for SSE message events
 * Used to determine when to perform full vs lightweight updates
 * @type {number}
 */
let sseUpdateCounter = 0;

/**
 * Formats a timestamp into a readable time-of-day string for chart display
 *
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @returns {string} Formatted time string in 12-hour format (e.g., "2:30 PM")
 *
 * @example
 * timeOfDayFormat(1699123800000) // Returns "2:30 PM"
 * timeOfDayFormat(1699090800000) // Returns "5:20 AM"
 */
function timeOfDayFormat(timestamp) {
    // Use D3's time formatter to create 12-hour format with AM/PM
    let dStr = d3.time.format('%I:%M %p')(new Date(timestamp));

    // Remove leading zero from hour (e.g., "02:30 PM" becomes "2:30 PM")
    if (dStr.indexOf('0') === 0) {
        dStr = dStr.slice(1);
    }
    return dStr;
}

/**
 * Extracts the worker name from a full mining address
 * Mining addresses typically follow the format: "address.workername"
 *
 * @param {string} w - Full worker address (e.g., "t1abc...xyz.worker1")
 * @returns {string} Worker name or "noname" if no worker name is specified
 *
 * @example
 * getWorkerNameFromAddress("t1abc123.miner1") // Returns "miner1"
 * getWorkerNameFromAddress("t1abc123.")       // Returns "noname"
 * getWorkerNameFromAddress("t1abc123")        // Returns "noname"
 */
function getWorkerNameFromAddress(w) {
    let worker = w;

    // Check if the address contains a dot separator
    if (w.split('.').length > 1) {
        // Extract the part after the first dot
        worker = w.split('.')[1];

        // Use 'noname' if the worker name is empty or null
        if (worker == null || worker.length < 1) {
            worker = 'noname';
        }
    } else {
        // No worker name specified in address
        worker = 'noname';
    }
    return worker;
}

/**
 * Builds the initial chart data structure from historical statistics
 * Processes worker history data and prepares it for NVD3 line chart visualization
 *
 * This function:
 * - Groups historical data by worker name
 * - Converts timestamps to milliseconds for chart compatibility
 * - Determines which workers should be visible by default (first 4 workers)
 * - Updates the maximum history length if needed
 *
 * @global {Object} statData - Contains historical data for all workers
 * @global {Array} workerHashrateData - Output array formatted for NVD3 charts
 * @global {number} workerHistoryMax - Maximum history points to maintain
 */
function buildChartData() {
    const workers = {};

    // Process each worker's historical data
    for (const w in statData.history) {
        const worker = getWorkerNameFromAddress(w);

        // Initialize worker data structure if it doesn't exist
        const a = workers[worker] = (workers[worker] || {
            hashrate: []
        });

        // Convert each history point to chart format [timestamp, hashrate]
        for (const wh in statData.history[w]) {
            // Convert timestamp from seconds to milliseconds for JavaScript Date compatibility
            a.hashrate.push([statData.history[w][wh].time * 1000, statData.history[w][wh].hashrate]);
        }

        // Update maximum history length if this worker has more data points
        if (a.hashrate.length > workerHistoryMax) {
            workerHistoryMax = a.hashrate.length;
        }
    }

    // Build the final chart data array for NVD3
    let i = 0;
    workerHashrateData = [];
    for (const worker in workers) {
        workerHashrateData.push({
            key: worker,                                                    // Worker name for legend
            disabled: (i > Math.min((_workerCount - 1), 3)),              // Hide workers beyond the first 4
            values: workers[worker].hashrate                               // Array of [timestamp, hashrate] pairs
        });
        i++;
    }
}

/**
 * Updates existing chart data with new statistics from live updates
 * Maintains a rolling window of historical data and handles new workers
 *
 * @returns {boolean} True if a new worker was added (requiring display rebuild), false otherwise
 *
 * This function:
 * - Adds new data points to existing workers
 * - Maintains the history window by removing old data when limit is reached
 * - Detects and adds new workers that weren't in the original dataset
 * - Triggers chart refresh to display updated data
 */
function updateChartData() {
    const workers = {};

    // Process each worker's updated history
    for (const w in statData.history) {
        const worker = getWorkerNameFromAddress(w);

        // Get reference to the latest worker history entry
        // Safely obtain the last key from the history object (handles non-array keyed objects)
        let wh;
        if (statData.history[w]) {
            const keys = Object.keys(statData.history[w]);
            if (keys.length > 0) {
                wh = keys[keys.length - 1];
            }
        }

        let foundWorker = false;

        // Search for existing worker in chart data
        for (let i = 0; i < workerHashrateData.length; i++) {
            if (workerHashrateData[i].key === worker) {
                foundWorker = true;

                // Remove oldest data point if we've reached the maximum history length
                if (workerHashrateData[i].values.length >= workerHistoryMax) {
                    workerHashrateData[i].values.shift();
                }

                // Add the new data point [timestamp in ms, hashrate]
                workerHashrateData[i].values.push([statData.history[w][wh].time * 1000, statData.history[w][wh].hashrate]);
                break;
            }
        }

        // Handle new worker that wasn't in the original dataset
        if (!foundWorker) {
            const hashrate = [];
            if (wh && statData.history[w] && statData.history[w][wh]) {
                hashrate.push([statData.history[w][wh].time * 1000, statData.history[w][wh].hashrate]);
            }

            // Add new worker to chart data
            workerHashrateData.push({
                key: worker,
                values: hashrate
            });

            // Rebuild the worker display to include the new worker
            rebuildWorkerDisplay();
            return true; // Indicate that a rebuild occurred
        }
    }

    // Update the chart with new data
    triggerChartUpdates();
    return false; // No new workers added
}

/**
 * Calculates the average hashrate for a specific worker or all workers combined
 *
 * @param {string|null} worker - Specific worker name to calculate average for, or null for all workers
 * @returns {number} Average hashrate value
 *
 * @example
 * calculateAverageHashrate("worker1")  // Returns average for specific worker
 * calculateAverageHashrate(null)       // Returns overall average across all workers
 */
function calculateAverageHashrate(worker) {
    let count = 0;      // Number of data points processed
    let total = 1;      // Total number of data points (minimum 1 to avoid division by zero)
    let avg = 0;        // Sum of all hashrate values

    // Iterate through all workers in the chart data
    for (let i = 0; i < workerHashrateData.length; i++) {
        count = 0;

        // Sum hashrate values for matching worker(s)
        for (let ii = 0; ii < workerHashrateData[i].values.length; ii++) {
            // Include this data point if we want all workers (worker == null) or specific worker matches
            if (worker == null || workerHashrateData[i].key === worker) {
                count++;
                // Add the hashrate value (second element in [timestamp, hashrate] pair)
                avg += parseFloat(workerHashrateData[i].values[ii][1]);
            }
        }

        // Track the maximum number of data points found
        if (count > total) {
            total = count;
        }
    }

    // Calculate and return the average
    avg = avg / total;
    return avg;
}

/**
 * Triggers a visual update of the hashrate chart
 * Called after data changes to refresh the chart display
 *
 * @global {Object} workerHashrateChart - NVD3 chart instance to update
 */
function triggerChartUpdates() {
    workerHashrateChart.update();
}

/**
 * Detects changes in the worker set by comparing current workers with previous state
 * This provides more accurate change detection than simple count comparison
 *
 * @param {Object} workers - Current workers object from statData
 * @returns {Object} Object containing change detection results
 * @returns {boolean} returns.hasChanges - True if any workers were added or removed
 * @returns {Array<string>} returns.added - Array of newly added worker addresses
 * @returns {Array<string>} returns.removed - Array of removed worker addresses
 * @returns {Set<string>} returns.currentSet - Set of current worker addresses
 */
function detectWorkerChanges(workers) {
    // Get current worker addresses
    const newWorkerAddresses = new Set(Object.keys(workers));

    // Find added workers (in new set but not in current set)
    const added = [...newWorkerAddresses].filter(worker => !currentWorkerAddresses.has(worker));

    // Find removed workers (in current set but not in new set)
    const removed = [...currentWorkerAddresses].filter(worker => !newWorkerAddresses.has(worker));

    // Determine if there are any changes
    const hasChanges = added.length > 0 || removed.length > 0;

    return {
        hasChanges,
        added,
        removed,
        currentSet: newWorkerAddresses
    };
}

/**
 * Determines if a full data fetch (including history) is needed
 * Uses timing and update patterns to optimize data fetching frequency
 *
 * @returns {boolean} True if full history data should be fetched
 */
function shouldFetchFullData() {
    const now = Date.now();
    const timeSinceLastFull = now - lastFullDataFetch;

    // Always fetch full data on first update or after the interval
    if (lastFullDataFetch === 0 || timeSinceLastFull >= FULL_DATA_FETCH_INTERVAL) {
        return true;
    }

    // Fetch full data every 10th update for chart responsiveness
    if (sseUpdateCounter % 10 === 0) {
        return true;
    }

    return false;
}

/**
 * Note: The processLightweightStats function has been removed since we now
 * have a dedicated backend endpoint /api/miner_live_stats that provides
 * optimized data without history, eliminating the need for client-side processing.
 *//**
* Initializes and displays the NVD3 line chart for worker hashrates
* Sets up chart configuration, axes formatting, and binds data to the DOM element
*
* Chart features:
* - Interactive guidelines for precise data reading
* - Time-formatted X-axis showing time of day
* - Human-readable hashrate formatting on Y-axis
* - Responsive margins for proper label display
*
* @global {Array} workerHashrateData - Chart data array formatted for NVD3
* @global {Object} workerHashrateChart - Chart instance stored for future updates
*/
function displayCharts() {
    nv.addGraph(() => {
        // Create line chart with configured margins
        workerHashrateChart = nv.models.lineChart()
            .margin({ left: 80, right: 30 })            // Extra left margin for Y-axis labels
            .x((d) => {
                return d[0];                             // X-axis: timestamp (first array element)
            })
            .y((d) => {
                return d[1];                             // Y-axis: hashrate (second array element)
            })
            .useInteractiveGuideline(true);              // Enable hover tooltips and guidelines

        // Format X-axis to show readable time (e.g., "2:30 PM")
        workerHashrateChart.xAxis.tickFormat(timeOfDayFormat);

        // Format Y-axis to show human-readable hashrates (e.g., "1.50 MH/s")
        workerHashrateChart.yAxis.tickFormat((d) => {
            return getReadableHashRateString(d);
        });

        // Bind chart data to DOM element and render
        d3.select('#workerHashrate').append('svg').datum(workerHashrateData).call(workerHashrateChart);
        return workerHashrateChart;
    });
}

/**
 * Updates the main miner statistics display with current data
 * Calculates derived metrics like mining luck and updates all summary statistics
 *
 * This function:
 * - Extracts totals from the latest statistics data
 * - Calculates expected time to find a block (luck days)
 * - Updates all DOM elements with formatted values
 *
 * @global {Object} statData - Contains current statistics from API
 */
function updateStats() {
    // Extract total values from statistics data
    totalHash = statData.totalHash;
    totalPaid = statData.paid;
    totalBal = statData.balance;
    totalImmature = statData.immature;
    totalShares = statData.totalShares;

    // Calculate mining luck (expected days to find a block)
    const _blocktime = 55;                                      // Average block time in seconds
    const _networkHashRate = parseFloat(statData.networkSols) * 1.2;  // Network hashrate with adjustment factor
    const _myHashRate = (totalHash / 1000000) * 2;              // Convert to MH/s and apply multiplier

    // Calculate expected time to find a block in days and hours (fallback)
    const luckDaysCalc = ((_networkHashRate / _myHashRate * _blocktime) / (24 * 60 * 60));
    const luckHoursCalc = ((_networkHashRate / _myHashRate * _blocktime) / (60 * 60));

    // Prefer server-provided fields if present; otherwise use calculated values
    const luckDays = (typeof statData.luckDays !== 'undefined') ? parseFloat(statData.luckDays) : parseFloat(luckDaysCalc.toFixed(3));
    const luckHours = (typeof statData.luckHours !== 'undefined') ? parseFloat(statData.luckHours) : parseFloat(luckHoursCalc.toFixed(3));

    // Update DOM elements with formatted statistics
    $('#statsHashrate').text(getReadableHashRateString(totalHash));                    // Current hashrate
    $('#statsHashrateAvg').text(getReadableHashRateString(calculateAverageHashrate(null))); // Average hashrate
    if (luckDays < 1) {
        $('#statsLuckDays').text(luckHours.toFixed(3));
        $('#statsLuckUnit').text('Hours');
    } else {
        $('#statsLuckDays').text(luckDays.toFixed(3));
        $('#statsLuckUnit').text('Days');
    }
    $('#statsTotalImmature').text(totalImmature);                                     // Unconfirmed balance
    $('#statsTotalBal').text(totalBal);                                               // Confirmed balance
    $('#statsTotalPaid').text(totalPaid);                                             // Total paid out
    $('#statsTotalShares').text((typeof totalShares === 'number' && !isNaN(totalShares)) ? Math.floor(totalShares) : 0);                              // Current round shares (truncated to whole number)
}
/**
 * Updates statistics for individual workers in their respective display boxes
 * Processes each worker's current performance metrics and updates DOM elements
 *
 * For each worker, updates:
 * - Current and average hashrate
 * - Mining luck, payments, and balance
 * - Share count and difficulty
 * - Time since last submitted share
 *
 * @global {Object} statData - Contains worker-specific statistics
 */
function updateWorkerStats() {
    let i = 0;

    // Iterate through each worker in the statistics data
    for (const w in statData.workers) {
        i++;

        // Create HTML-safe worker name for DOM element IDs
        // Replace dots with underscores and remove special characters
        const htmlSafeWorkerName = w.split('.').join('_').replace(/[^\w\s]/gi, '');

        // Extract readable worker name for average calculations
        const saneWorkerName = getWorkerNameFromAddress(w);

        // Update all worker-specific DOM elements with current statistics
        $(`#statsHashrate${htmlSafeWorkerName}`).text(getReadableHashRateString(statData.workers[w].hashrate));
        $(`#statsHashrateAvg${htmlSafeWorkerName}`).text(getReadableHashRateString(calculateAverageHashrate(saneWorkerName)));
        // Worker luck: if less than 1 day, show hours instead
        const workerLuckDays = (typeof statData.workers[w].luckDays !== 'undefined') ? parseFloat(statData.workers[w].luckDays) : null;
        const workerLuckHours = (typeof statData.workers[w].luckHours !== 'undefined') ? parseFloat(statData.workers[w].luckHours) : null;
        if (workerLuckDays !== null && workerLuckDays < 1) {
            // prefer server-provided hours when available
            const displayHours = (workerLuckHours !== null) ? workerLuckHours : (workerLuckDays * 24);
            $(`#statsLuckDays${htmlSafeWorkerName}`).text(displayHours.toFixed(3));
            $(`#statsLuckUnit${htmlSafeWorkerName}`).text('Hours');
        } else if (workerLuckDays !== null) {
            $(`#statsLuckDays${htmlSafeWorkerName}`).text(workerLuckDays.toFixed(3));
            $(`#statsLuckUnit${htmlSafeWorkerName}`).text('Days');
        } else {
            $(`#statsLuckDays${htmlSafeWorkerName}`).text('N/A');
            $(`#statsLuckUnit${htmlSafeWorkerName}`).text('');
        }
        $(`#statsPaid${htmlSafeWorkerName}`).text(statData.workers[w].paid);
        $(`#statsBalance${htmlSafeWorkerName}`).text(statData.workers[w].balance);
        $(`#statsShares${htmlSafeWorkerName}`).text((typeof statData.workers[w].currRoundShares === 'number' && !isNaN(statData.workers[w].currRoundShares)) ? Math.floor(statData.workers[w].currRoundShares) : 0);
        $(`#statsDiff${htmlSafeWorkerName}`).text(statData.workers[w].diff);

        // Calculate and display time since last share submission
        const lastShareTime = Math.floor(((new Date().getTime()) - (new Date(Math.round(statData.workers[w].lastShare)).getTime())) / 1000);
        $(`#statsLastShare${htmlSafeWorkerName}`).text(lastShareTime);
    }
}
/**
 * Creates and adds a worker statistics display box to the DOM
 * Generates a complete HTML structure for displaying individual worker metrics
 *
 * @param {string} name - Clean worker name for calculations
 * @param {string} htmlSafeName - HTML-safe worker name for DOM element IDs
 * @param {Object} workerObj - Worker statistics object containing all metrics
 * @param {number} workerObj.hashrate - Current worker hashrate
 * @param {number} workerObj.diff - Mining difficulty
 * @param {number} workerObj.currRoundShares - Shares submitted in current round
 * @param {number} workerObj.luckDays - Expected days to find a block
 * @param {number} workerObj.balance - Current confirmed balance
 * @param {number} workerObj.paid - Total amount paid to this worker
 * @param {number} workerObj.lastShare - Timestamp of last share submission
 */
function addWorkerToDisplay(name, htmlSafeName, workerObj) {
    const htmlToAdd = `
        <div class="col-md-4 mb-4">
            <div class="card h-100">
                <div class="card-header">${htmlSafeName.indexOf('_') >= 0 ? htmlSafeName.substr(htmlSafeName.indexOf('_') + 1) : 'noname'}</div>
                <div class="card-body">
                    <p><i class="fa fa-tachometer"></i> <span id="statsHashrate${htmlSafeName}">${getReadableHashRateString(workerObj.hashrate)}</span> (Now)</p>
                    <p><i class="fa fa-tachometer"></i> <span id="statsHashrateAvg${htmlSafeName}">${getReadableHashRateString(calculateAverageHashrate(name))}</span> (Avg)</p>
                    <p><i class="fa fa-shield"></i> <small>Diff:</small> <span id="statsDiff${htmlSafeName}">${workerObj.diff}</span></p>
                    <p><i class="fa fa-cog"></i> <small>Shares:</small> <span id="statsShares${htmlSafeName}">${(typeof workerObj.currRoundShares === 'number' && !isNaN(workerObj.currRoundShares)) ? Math.floor(workerObj.currRoundShares) : 0}</span></p>
                    <p><i class="fa fa-gavel"></i> <small>Luck <span id="statsLuckDays${htmlSafeName}"></span> <span id="statsLuckUnit${htmlSafeName}"></span></small></p>
                    <p><i class="fa fa-money"></i> <small>Bal: <span id="statsBalance${htmlSafeName}">${workerObj.balance}</span></small></p>
                    <p><i class="fa fa-money"></i> <small>Paid: <span id="statsPaid${htmlSafeName}">${workerObj.paid}</span></small></p>
                    <p><i class="fa fa-signal"></i> <small>Last share: <span id="statsLastShare${htmlSafeName}"></span>s ago</small></p>
                </div>
            </div>
        </div>
    `;

    $('#boxesWorkers').append(htmlToAdd);

    const workerLuckDaysInit = (typeof workerObj.luckDays !== 'undefined') ? parseFloat(workerObj.luckDays) : null;
    const workerLuckHoursInit = (typeof workerObj.luckHours !== 'undefined') ? parseFloat(workerObj.luckHours) : null;
    let luckDisplay = 'N/A';
    let luckUnit = '';
    if (workerLuckDaysInit !== null) {
        if (workerLuckDaysInit < 1) {
            const displayHours = (workerLuckHoursInit !== null) ? workerLuckHoursInit : (workerLuckDaysInit * 24);
            luckDisplay = displayHours.toFixed(3);
            luckUnit = 'Hours';
        } else {
            luckDisplay = workerLuckDaysInit.toFixed(3);
            luckUnit = 'Days';
        }
    }
    $(`#statsLuckDays${htmlSafeName}`).text(luckDisplay);
    $(`#statsLuckUnit${htmlSafeName}`).text(luckUnit);

    const lastShareTime = Math.floor(((new Date().getTime()) - (new Date(Math.round(workerObj.lastShare)).getTime())) / 1000);
    $(`#statsLastShare${htmlSafeName}`).text(lastShareTime);
}

/**
 * Completely rebuilds the worker display area from scratch
 * Clears existing worker boxes and recreates them with current data
 *
 * This function is called when:
 * - Initial page load after data is fetched
 * - New workers are detected that weren't in the original dataset
 * - Worker count changes significantly
 *
 * @global {Object} statData - Contains current worker statistics
 */
function rebuildWorkerDisplay() {
    // Clear the existing worker display area
    $('#boxesWorkers').html('');

    let i = 0;

    // Iterate through all workers and create their display boxes
    for (const w in statData.workers) {
        i++;

        // Generate HTML-safe worker name for DOM element IDs
        const htmlSafeWorkerName = w.split('.').join('_').replace(/[^\w\s]/gi, '');

        // Extract clean worker name for display and calculations
        const saneWorkerName = getWorkerNameFromAddress(w);

        // Create and add the worker display box
        addWorkerToDisplay(saneWorkerName, htmlSafeWorkerName, statData.workers[w]);
    }
}

/**
 * ========================================================================
 * INITIALIZATION AND EVENT HANDLERS
 * ========================================================================
 */

/**
 * Register chart resize handler for responsive design
 * Ensures charts maintain proper proportions when browser window is resized
 */
nv.utils.windowResize(triggerChartUpdates);

/**
 * Initial data loading and dashboard setup
 * Fetches worker statistics from API and initializes all display components
 *
 * Initialization sequence:
 * 1. Fetch initial statistics data
 * 2. Initialize worker tracking for change detection
 * 3. Build chart data structure
 * 4. Create and display charts
 * 5. Build worker display boxes
 * 6. Update summary statistics
 */
$.getJSON(`/api/worker_stats?${_miner}`, (data) => {
    statData = data;

    // Initialize worker tracking for change detection
    currentWorkerAddresses = new Set(Object.keys(statData.workers));
    _workerCount = currentWorkerAddresses.size;

    // Initialize timing for optimization system
    lastFullDataFetch = Date.now();
    sseUpdateCounter = 0;

    console.log('Initial dashboard load with full data');

    // Initialize the dashboard components in sequence
    buildChartData();           // Prepare data for chart visualization
    displayCharts();            // Create and render the hashrate chart
    rebuildWorkerDisplay();     // Build individual worker stat boxes
    updateStats();              // Update summary statistics
});

/**
 * Live statistics updates via Server-Sent Events (SSE)
 * Handles real-time updates with intelligent data fetching optimization
 *
 * Optimization strategy:
 * - Full data (with history): Uses /api/worker_stats - every 30 seconds or every 10th update
 * - Lightweight updates: Uses /api/miner_live_stats - current stats only, no history data
 * - Force full fetch: When worker changes are detected
 *
 * Update process:
 * 1. Receive SSE message trigger and increment counter
 * 2. Determine if full data fetch is needed based on timing/patterns
 * 3. Fetch from appropriate endpoint (worker_stats vs miner_live_stats)
 * 4. Detect worker changes and handle accordingly
 * 5. Update charts (full fetch) or stats only (lightweight)
 * 6. Refresh summary and worker-specific statistics
 *
 * Performance benefits:
 * - ~70% bandwidth reduction on routine updates
 * - Eliminates unnecessary historical data processing
 * - Maintains chart responsiveness with periodic full updates
 *
 * @listens {MessageEvent} SSE message from statsSource
 */
statsSource.addEventListener('message', (e) => {
    // Increment update counter for optimization logic
    sseUpdateCounter++;

    // Determine if we need full data (including history) or can use lightweight update
    const needsFullData = shouldFetchFullData();

    if (needsFullData) {
        // Fetch complete worker stats including history for chart updates
        $.getJSON(`/api/worker_stats?${_miner}`, (data) => {
            statData = data;
            lastFullDataFetch = Date.now();

            console.log(`Full data fetch #${sseUpdateCounter} (with history)`);

            // Detect worker changes using improved detection method
            const workerChanges = detectWorkerChanges(statData.workers);
            let rebuilt = false;

            // Handle worker changes (additions, removals, or both)
            if (workerChanges.hasChanges) {
                // Log the changes for debugging (can be removed in production)
                if (workerChanges.added.length > 0) {
                    console.log('Workers added:', workerChanges.added.map(w => getWorkerNameFromAddress(w)));
                }
                if (workerChanges.removed.length > 0) {
                    console.log('Workers removed:', workerChanges.removed.map(w => getWorkerNameFromAddress(w)));
                }

                // Always rebuild display when workers change
                rebuildWorkerDisplay();
                rebuilt = true;

                // Update the stored worker addresses
                currentWorkerAddresses = workerChanges.currentSet;
                _workerCount = currentWorkerAddresses.size;
            }

            // Update chart data (includes history processing)
            rebuilt = (rebuilt || updateChartData());

            // Update summary and worker statistics
            updateStats();
            if (!rebuilt) {
                updateWorkerStats();
            }
        });
    } else {
        // Lightweight update: use dedicated miner_live_stats endpoint (no history data)
        $.getJSON(`/api/miner_live_stats?${_miner}`, (data) => {
            // Preserve existing history data since the lightweight endpoint doesn't include it
            const previousHistory = statData.history;
            statData = { ...data, history: previousHistory };

            console.log(`Lightweight update #${sseUpdateCounter} (live stats endpoint)`);

            // Quick worker change detection (no chart updates)
            const workerChanges = detectWorkerChanges(statData.workers);
            let rebuilt = false;

            // Handle worker changes (force full data fetch on next update if workers changed)
            if (workerChanges.hasChanges) {
                console.log('Worker changes detected, scheduling full update');
                lastFullDataFetch = 0; // Force full fetch on next update

                rebuildWorkerDisplay();
                rebuilt = true;
                currentWorkerAddresses = workerChanges.currentSet;
                _workerCount = currentWorkerAddresses.size;
            }

            // Update only statistics (skip chart processing for performance)
            updateStats();
            if (!rebuilt) {
                updateWorkerStats();
            }
        });
    }
});
