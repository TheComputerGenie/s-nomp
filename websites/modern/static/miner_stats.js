class MinerStatsPage {
    constructor(miner) {
        this.workerHashrateData = [];
        this.workerHashrateChart = null;
        this.workerHistoryMax = 160;
        this.statData = null;
        this.totalHash = 0;
        this.totalImmature = 0;
        this.totalBal = 0;
        this.totalPaid = 0;
        this.totalShares = 0;
        this.currentWorkerAddresses = new Set();
        this.lastFullDataFetch = 0;
        this.FULL_DATA_FETCH_INTERVAL = 30000;
        this.sseUpdateCounter = 0;
        this.miner = miner;
        this.sseBuffer = [];
        this._sseAttached = false;
        nv.utils.windowResize(() => {
            if (this.workerHashrateChart) {
                this.workerHashrateChart.update();
            }
        });
        this.attachSseListener();
    }

    timeOfDayFormat(timestamp) {
        let dStr = d3.time.format('%I:%M %p')(new Date(timestamp));
        if (dStr.indexOf('0') === 0) {
            dStr = dStr.slice(1);
        }
        return dStr;
    }

    getWorkerNameFromAddress(w) {
        let worker = w;
        if (w.split('.').length > 1) {
            worker = w.split('.')[1];
            if (worker == null || worker.length < 1) {
                worker = 'noname';
            }
        } else {
            worker = 'noname';
        }
        return worker;
    }

    getMultiplierForWorker(workerAddr) {
        if (this.statData && this.statData.workers && this.statData.workers[workerAddr] && typeof this.statData.workers[workerAddr].displayMultiplier === 'number') {
            return this.statData.workers[workerAddr].displayMultiplier;
        }
        if (window && window.algoDisplayMultipliers && typeof window.algoDisplayMultipliers === 'object') {
            const keys = Object.keys(window.algoDisplayMultipliers);
            if (keys.length === 1) {
                return window.algoDisplayMultipliers[keys[0]];
            }
        }
        return 2;
    }

    getDefaultMultiplier() {
        if (window && window.algoDisplayMultipliers && typeof window.algoDisplayMultipliers === 'object') {
            const keys = Object.keys(window.algoDisplayMultipliers);
            if (keys.length === 1) {
                return window.algoDisplayMultipliers[keys[0]];
            }
        }
        return 2;
    }

    buildChartData() {
        const workers = {};
        if (!this.statData || !this.statData.history) {
            return;
        }
        for (const w in this.statData.history) {
            const worker = this.getWorkerNameFromAddress(w);
            const a = workers[worker] = (workers[worker] || { hashrate: [] });
            for (const wh in this.statData.history[w]) {
                a.hashrate.push([this.statData.history[w][wh].time * 1000, this.statData.history[w][wh].hashrate]);
            }
            if (a.hashrate.length > this.workerHistoryMax) {
                this.workerHistoryMax = a.hashrate.length;
            }
        }
        let i = 0;
        this.workerHashrateData = [];
        for (const worker in workers) {
            this.workerHashrateData.push({ key: worker, disabled: (i > Math.min((this._workerCount - 1), 3)), values: workers[worker].hashrate });
            i++;
        }
    }

    updateChartData() {
        if (!this.statData || !this.statData.history) {
            return false;
        }
        for (const w in this.statData.history) {
            const worker = this.getWorkerNameFromAddress(w);
            let wh;
            if (this.statData.history[w]) {
                const keys = Object.keys(this.statData.history[w]);
                if (keys.length > 0) {
                    wh = keys[keys.length - 1];
                }
            }
            let found = false;
            for (let i = 0; i < this.workerHashrateData.length; i++) {
                if (this.workerHashrateData[i].key === worker) {
                    found = true;
                    if (this.workerHashrateData[i].values.length >= this.workerHistoryMax) {
                        this.workerHashrateData[i].values.shift();
                    }
                    this.workerHashrateData[i].values.push([this.statData.history[w][wh].time * 1000, this.statData.history[w][wh].hashrate]);
                    break;
                }
            }
            if (!found) {
                const hashrate = [];
                if (wh && this.statData.history[w] && this.statData.history[w][wh]) {
                    hashrate.push([this.statData.history[w][wh].time * 1000, this.statData.history[w][wh].hashrate]);
                }
                this.workerHashrateData.push({ key: worker, values: hashrate });
                this.rebuildWorkerDisplay();
                return true;
            }
        }
        this.triggerChartUpdates();
        return false;
    }

    calculateAverageHashrate(worker) {
        let count = 0, total = 1, avg = 0;
        for (let i = 0; i < this.workerHashrateData.length; i++) {
            count = 0;
            for (let ii = 0; ii < this.workerHashrateData[i].values.length; ii++) {
                if (worker == null || this.workerHashrateData[i].key === worker) {
                    count++; avg += parseFloat(this.workerHashrateData[i].values[ii][1]);
                }
            }
            if (count > total) {
                total = count;
            }
        }
        avg = avg / total;
        return avg;
    }

    triggerChartUpdates() {
        if (this.workerHashrateChart) {
            this.workerHashrateChart.update();
        }
    }

    detectWorkerChanges(workers) {
        const newWorkerAddresses = new Set(Object.keys(workers));
        const added = [...newWorkerAddresses].filter(worker => !this.currentWorkerAddresses.has(worker));
        const removed = [...this.currentWorkerAddresses].filter(worker => !newWorkerAddresses.has(worker));
        const hasChanges = added.length > 0 || removed.length > 0;
        return { hasChanges, added, removed, currentSet: newWorkerAddresses };
    }

    shouldFetchFullData() {
        const now = Date.now();
        const timeSinceLastFull = now - this.lastFullDataFetch;
        if (this.lastFullDataFetch === 0 || timeSinceLastFull >= this.FULL_DATA_FETCH_INTERVAL) {
            return true;
        }
        if (this.sseUpdateCounter % 10 === 0) {
            return true;
        }
        return false;
    }

    displayCharts() {
        nv.addGraph(() => {
            this.workerHashrateChart = nv.models.lineChart().margin({ left: 80, right: 30 }).x((d) => d[0]).y((d) => d[1]).useInteractiveGuideline(true);
            this.workerHashrateChart.xAxis.tickFormat((d) => this.timeOfDayFormat(d));
            this.workerHashrateChart.yAxis.tickFormat((d) => getReadableHashRateString(d, this.getDefaultMultiplier()));
            d3.select('#workerHashrate').append('svg').datum(this.workerHashrateData).call(this.workerHashrateChart);
            return this.workerHashrateChart;
        });
    }

    updateStats() {
        if (!this.statData) {
            return;
        }
        this.totalHash = this.statData.totalHash;
        this.totalPaid = this.statData.paid;
        this.totalBal = this.statData.balance;
        this.totalImmature = this.statData.immature;
        this.totalShares = this.statData.totalShares;
        const _blocktime = 55;
        const _networkHashRate = parseFloat(this.statData.networkSols) * 1.2;
        const _myHashRate = (this.totalHash / 1000000) * this.getDefaultMultiplier();
        const luckDaysCalc = ((_networkHashRate / _myHashRate * _blocktime) / (24 * 60 * 60));
        const luckHoursCalc = ((_networkHashRate / _myHashRate * _blocktime) / (60 * 60));
        const luckDays = (typeof this.statData.luckDays !== 'undefined') ? parseFloat(this.statData.luckDays) : parseFloat(luckDaysCalc.toFixed(3));
        const luckHours = (typeof this.statData.luckHours !== 'undefined') ? parseFloat(this.statData.luckHours) : parseFloat(luckHoursCalc.toFixed(3));
        $('#statsHashrate').text(getReadableHashRateString(this.totalHash, this.getDefaultMultiplier()));
        $('#statsHashrateAvg').text(getReadableHashRateString(this.calculateAverageHashrate(null), this.getDefaultMultiplier()));
        if (luckDays < 1) {
            $('#statsLuckDays').text(luckHours.toFixed(3)); $('#statsLuckUnit').text('Hours');
        } else {
            $('#statsLuckDays').text(luckDays.toFixed(3)); $('#statsLuckUnit').text('Days');
        }
        $('#statsTotalImmature').text(this.totalImmature);
        $('#statsTotalBal').text(this.totalBal);
        $('#statsTotalPaid').text(this.totalPaid);
        $('#statsTotalShares').text((typeof this.totalShares === 'number' && !isNaN(this.totalShares)) ? Math.floor(this.totalShares) : 0);
    }

    updateWorkerStats() {
        if (!this.statData || !this.statData.workers) {
            return;
        }
        for (const w in this.statData.workers) {
            const htmlSafeWorkerName = w.split('.').join('_').replace(/[^\w\s]/gi, '');
            const saneWorkerName = this.getWorkerNameFromAddress(w);
            const workerObj = this.statData.workers[w];
            const mul = (typeof workerObj.displayMultiplier === 'number') ? workerObj.displayMultiplier : this.getMultiplierForWorker(w);
            $(`#statsHashrate${htmlSafeWorkerName}`).text(getReadableHashRateString(workerObj.hashrate, mul));
            $(`#statsHashrateAvg${htmlSafeWorkerName}`).text(getReadableHashRateString(this.calculateAverageHashrate(saneWorkerName), mul));
            const workerLuckDays = (typeof workerObj.luckDays !== 'undefined') ? parseFloat(workerObj.luckDays) : null;
            const workerLuckHours = (typeof workerObj.luckHours !== 'undefined') ? parseFloat(workerObj.luckHours) : null;
            if (workerLuckDays !== null && workerLuckDays < 1) {
                const displayHours = (workerLuckHours !== null) ? workerLuckHours : (workerLuckDays * 24); $(`#statsLuckDays${htmlSafeWorkerName}`).text(displayHours.toFixed(3)); $(`#statsLuckUnit${htmlSafeWorkerName}`).text('Hours');
            } else if (workerLuckDays !== null) {
                $(`#statsLuckDays${htmlSafeWorkerName}`).text(workerLuckDays.toFixed(3)); $(`#statsLuckUnit${htmlSafeWorkerName}`).text('Days');
            } else {
                $(`#statsLuckDays${htmlSafeWorkerName}`).text('N/A'); $(`#statsLuckUnit${htmlSafeWorkerName}`).text('');
            }
            $(`#statsPaid${htmlSafeWorkerName}`).text(workerObj.paid);
            $(`#statsBalance${htmlSafeWorkerName}`).text(workerObj.balance);
            $(`#statsShares${htmlSafeWorkerName}`).text((typeof workerObj.currRoundShares === 'number' && !isNaN(workerObj.currRoundShares)) ? Math.floor(workerObj.currRoundShares) : 0);
            $(`#statsDiff${htmlSafeWorkerName}`).text(workerObj.diff);
            const lastShareTime = Math.floor(((new Date().getTime()) - (new Date(Math.round(workerObj.lastShare)).getTime())) / 1000);
            $(`#statsLastShare${htmlSafeWorkerName}`).text(lastShareTime);
        }
    }

    addWorkerToDisplay(name, htmlSafeName, workerObj) {
        const mul = (typeof workerObj.displayMultiplier === 'number') ? workerObj.displayMultiplier : this.getMultiplierForWorker(htmlSafeName);
        const htmlToAdd = `
        <div class="col-md-4 mb-4">
            <div class="card h-100">
                <div class="card-header">${htmlSafeName.indexOf('_') >= 0 ? htmlSafeName.substr(htmlSafeName.indexOf('_') + 1) : 'noname'}</div>
                <div class="card-body">
                    <p><i class="fa fa-tachometer"></i> <span id="statsHashrate${htmlSafeName}">${getReadableHashRateString(workerObj.hashrate, mul)}</span> (Now)</p>
                    <p><i class="fa fa-tachometer"></i> <span id="statsHashrateAvg${htmlSafeName}">${getReadableHashRateString(this.calculateAverageHashrate(name), mul)}</span> (Avg)</p>
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
                const displayHours = (workerLuckHoursInit !== null) ? workerLuckHoursInit : (workerLuckDaysInit * 24); luckDisplay = displayHours.toFixed(3); luckUnit = 'Hours';
            } else {
                luckDisplay = workerLuckDaysInit.toFixed(3); luckUnit = 'Days';
            }
        }
        $(`#statsLuckDays${htmlSafeName}`).text(luckDisplay);
        $(`#statsLuckUnit${htmlSafeName}`).text(luckUnit);
        const lastShareTime = Math.floor(((new Date().getTime()) - (new Date(Math.round(workerObj.lastShare)).getTime())) / 1000);
        $(`#statsLastShare${htmlSafeName}`).text(lastShareTime);
    }

    rebuildWorkerDisplay() {
        $('#boxesWorkers').html('');
        for (const w in this.statData.workers) {
            const htmlSafeWorkerName = w.split('.').join('_').replace(/[^\w\s]/gi, '');
            const saneWorkerName = this.getWorkerNameFromAddress(w);
            this.addWorkerToDisplay(saneWorkerName, htmlSafeWorkerName, this.statData.workers[w]);
        }
    }

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

    processSse(e) {
        if (!this._initialized) {
            this.sseBuffer.push(e); return;
        } this.handleSseMessage(e);
    }

    handleSseMessage(e) {
        let data;
        try {
            data = JSON.parse(e.data);
        } catch (err) {
            return;
        }
        if (!data || !data.workers && !data.totalHash) {
            return;
        }
        this.sseUpdateCounter++;
        const needsFull = this.shouldFetchFullData();
        if (needsFull) {
            $.getJSON(`/api/worker_stats?${this.miner}`, (d) => {
                this.statData = d;
                this.lastFullDataFetch = Date.now();
                const workerChanges = this.detectWorkerChanges(this.statData.workers);
                let rebuilt = false;
                if (workerChanges.hasChanges) {
                    this.rebuildWorkerDisplay(); rebuilt = true; this.currentWorkerAddresses = workerChanges.currentSet; this._workerCount = this.currentWorkerAddresses.size;
                }
                rebuilt = (rebuilt || this.updateChartData());
                this.updateStats();
                if (!rebuilt) {
                    this.updateWorkerStats();
                }
            });
        } else {
            $.getJSON(`/api/miner_live_stats?${this.miner}`, (d) => {
                const prevHistory = (this.statData && this.statData.history) ? this.statData.history : {};
                this.statData = { ...d, history: prevHistory };
                const workerChanges = this.detectWorkerChanges(this.statData.workers);
                let rebuilt = false;
                if (workerChanges.hasChanges) {
                    this.lastFullDataFetch = 0; this.rebuildWorkerDisplay(); rebuilt = true; this.currentWorkerAddresses = workerChanges.currentSet; this._workerCount = this.currentWorkerAddresses.size;
                }
                this.updateStats();
                if (!rebuilt) {
                    this.updateWorkerStats();
                }
            });
        }
    }

    init() {
        $.getJSON(`/api/worker_stats?${this.miner}`, (data) => {
            this.statData = data;
            this.currentWorkerAddresses = new Set(Object.keys(this.statData.workers));
            this._workerCount = this.currentWorkerAddresses.size;
            this.lastFullDataFetch = Date.now();
            this.sseUpdateCounter = 0;
            this.buildChartData();
            this.displayCharts();
            this.rebuildWorkerDisplay();
            this.updateStats();
            this._initialized = true;
            if (this.sseBuffer.length) {
                this.sseBuffer.forEach((evt) => this.processSse(evt)); this.sseBuffer = [];
            }
        });
    }
}

$(() => {
    const minerPage = new MinerStatsPage(_miner); minerPage.init();
});
